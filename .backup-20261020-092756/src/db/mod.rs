//! SQLCipher 全库加密的数据库层。
//! 打开时先设置 `PRAGMA key`，任何未授权密钥的读取都必须失败（fail-closed）。

pub mod migrate;
pub mod repo;

use crate::error::{AppError, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

pub type Shared = Arc<Db>;

pub struct Db {
    conn: Arc<parking_lot::Mutex<Connection>>,
    pub path: String,
}

impl Db {
    /// 取连接锁。全库只有一个连接，锁不可重入：同线程重复加锁会永久挂死进程。
    /// 测试构建下把它变成显式 panic（带定位信息），而不是无声死锁。
    pub fn lock_conn(&self) -> parking_lot::MutexGuard<'_, Connection> {
        #[cfg(test)]
        if self.conn.is_locked() {
            panic!(
                "同线程重入锁定数据库连接（db/mod.rs::lock_conn）——会把进程永久挂死；\
                 请在加锁前读出所需数据，或用 {{ }} 收窄 guard 作用域"
            );
        }
        self.conn.lock()
    }

    fn from_connection(conn: Connection, path: String) -> Result<Self> {
        let db = Self { conn: Arc::new(parking_lot::Mutex::new(conn)), path };
        {
            let c = db.lock_conn();
            c.execute_batch(
                "PRAGMA foreign_keys=ON;
                 PRAGMA journal_mode=WAL;
                 PRAGMA secure_delete=ON;
                 PRAGMA auto_vacuum=FULL;",
            )?;
        }
        migrate::run(&db)?;
        Ok(db)
    }

    /// 以 SQLCipher 密钥打开（或创建）数据库。
    pub fn open(path: &Path, key: &[u8]) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| AppError::Internal)?;
        }
        let conn = Connection::open(path)?;
        Self::key_and_verify(&conn, key)?;
        Self::from_connection(conn, path.display().to_string())
    }

    pub fn open_in_memory(key: &[u8]) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::key_and_verify(&conn, key)?;
        Self::from_connection(conn, ":memory:".into())
    }

    fn key_and_verify(conn: &Connection, key: &[u8]) -> Result<()> {
        let hex = hex_key(key);
        conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";")).map_err(|_| AppError::Db(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(1), None)))?;
        // 立即触碰 schema：密钥错误时这里就会失败，而不是等到业务查询
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_r| Ok(()))
            .map_err(|_| AppError::Crypto(crate::crypto::CryptoError::AuthenticationFailed))?;
        Ok(())
    }

    /// 交出当前连接并在原位放一个占位内存连接：真实文件句柄随即关闭。
    fn take_conn(&self) -> Result<Connection> {
        let placeholder = Connection::open_in_memory()?;
        let mut g = self.lock_conn();
        Ok(std::mem::replace(&mut *g, placeholder))
    }

    /// 替换数据库文件前必须关闭全部连接，否则 rename 后仍在读旧 inode。
    pub fn dispose_connections(&self) {
        if let Ok(old) = self.take_conn() {
            drop(old);
        }
    }

    /// 数据库文件被整体替换（恢复备份）后，用同一主密钥重新打开并跑迁移。
    pub fn reopen(&self, key: &[u8]) -> Result<()> {
        let fresh = Self::open(Path::new(&self.path), key)?;
        let incoming = fresh.take_conn()?;
        drop(fresh);
        let mut g = self.lock_conn();
        let old = std::mem::replace(&mut *g, incoming);
        drop(old);
        Ok(())
    }
}

/// 静态加密证据：磁盘上的数据库文件不得含明文 SQLite 头 `SQLite format 3\0`。
pub fn probe_encrypted(db: &Db) -> bool {
    if db.path == ":memory:" {
        return true;
    }
    match std::fs::read(&db.path) {
        Ok(bytes) => {
            let header = b"SQLite format 3";
            !bytes.starts_with(header)
        }
        Err(_) => false,
    }
}

fn hex_key(key: &[u8]) -> String {
    let mut s = String::with_capacity(key.len() * 2);
    for b in key {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_key_cannot_read_schema() {
        let good = vec![7u8; 32];
        let bad = vec![9u8; 32];
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        {
            let db = Db::open(&path, &good).unwrap();
            db.lock_conn().execute_batch("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);").unwrap();
        }
        // 用错误密钥打开必须失败
        assert!(Db::open(&path, &bad).is_err());
        // 原始文件不得是明文 SQLite（SQLCipher 头部会被加密）
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(16).any(|w| w == b"SQLite format 3\0"), "数据库文件不得以明文 SQLite 头开始");
        assert!(!String::from_utf8_lossy(&raw).contains("vault_items"));
        // 正确密钥可正常读取
        let db = Db::open(&path, &good).unwrap();
        let v: i64 = db.lock_conn().query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 42);
    }

    #[test]
    fn migrations_create_expected_tables() {
        let db = Db::open_in_memory(&vec![3u8; 32]).unwrap();
        let names: Vec<String> = {
            let c = db.lock_conn();
            let mut st = c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").unwrap();
            let rows = st.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.collect::<std::result::Result<Vec<_>, _>>().unwrap()
        };
        for expected in [
            "app_users", "user_key_wrappers", "vault_targets", "vault_target_secrets",
            "vault_items", "vault_item_secrets", "vault_target_preferences", "roles",
            "permissions", "user_roles", "role_permissions", "audit_events", "app_settings",
            "import_jobs", "import_job_errors", "vault_groups", "vault_item_tags", "key_metadata",
        ] {
            assert!(names.iter().any(|n| n == expected), "缺少表 {expected}");
        }
    }

    #[test]
    fn default_credential_must_belong_to_same_target() {
        let db = Db::open_in_memory(&vec![5u8; 32]).unwrap();
        let c = db.lock_conn();
        let now = "2026-01-01T00:00:00Z";
        c.execute(
            "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES ('u1','GEN1','n','argon2id',X'00',X'00',4096,2,1,?1,?1)",
            rusqlite::params![now],
        )
        .unwrap();
        for (id, t) in [("tg1", "web"), ("tg2", "web")] {
            c.execute("INSERT INTO vault_targets (id,target_type,display_name,created_at,updated_at) VALUES (?1,?2,'n',?3,?3)", rusqlite::params![id, t, now]).unwrap();
        }
        for (id, tg) in [("it1", "tg1"), ("it2", "tg2")] {
            c.execute("INSERT INTO vault_items (id,target_id,account_alias,item_type,created_at,updated_at) VALUES (?1,?2,'a','web',?3,?3)", rusqlite::params![id, tg, now]).unwrap();
        }
        // it2 属于 tg2，把它设为 tg1 的默认账号必须被触发器拒绝
        let bad = c.execute(
            "INSERT INTO vault_target_preferences (app_user_id,target_id,default_vault_item_id,updated_at) VALUES ('u1','tg1','it2',?1)",
            rusqlite::params![now],
        );
        assert!(bad.is_err(), "跨目标默认账号必须被拒绝");
        let ok = c.execute(
            "INSERT INTO vault_target_preferences (app_user_id,target_id,default_vault_item_id,updated_at) VALUES ('u1','tg1','it1',?1)",
            rusqlite::params![now],
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn audit_log_is_append_only() {
        let db = Db::open_in_memory(&vec![6u8; 32]).unwrap();
        let c = db.lock_conn();
        c.execute("INSERT INTO audit_events (id,ts,actor_id,action,result) VALUES ('a','2026-01-01','u1','login','success')", []).unwrap();
        assert!(c.execute("UPDATE audit_events SET action='x' WHERE id='a'", []).is_err());
        assert!(c.execute("DELETE FROM audit_events WHERE id='a'", []).is_err());
    }
}
