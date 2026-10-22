//! 迁移执行器：按版本号顺序应用内嵌 SQL，已应用的跳过。
//! 迁移前后可验证结构版本；失败必须中止启动而不是带着半套 schema 继续跑。

use super::Db;
use crate::error::{AppError, Result};
use rusqlite::OptionalExtension;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "0001_init", sql: include_str!("../../../migrations/0001_init.sql") },
    Migration { version: 2, name: "0002_seed", sql: include_str!("../../../migrations/0002_seed.sql") },
    Migration { version: 3, name: "0003_policy_defaults", sql: include_str!("../../../migrations/0003_policy_defaults.sql") },
    Migration { version: 4, name: "0004_extension_id_setting", sql: include_str!("../../../migrations/0004_extension_id_setting.sql") },
    Migration { version: 5, name: "0005_target_name_index", sql: include_str!("../../../migrations/0005_target_name_index.sql") },
    Migration { version: 6, name: "0006_theme_convergence", sql: include_str!("../../../migrations/0006_theme_convergence.sql") },
    Migration { version: 7, name: "0007_export_reauth_off", sql: include_str!("../../../migrations/0007_export_reauth_off.sql") },
    Migration { version: 8, name: "0008_copy_password_reauth_off", sql: include_str!("../../../migrations/0008_copy_password_reauth_off.sql") },
];

pub const LATEST_VERSION: i64 = 8;

pub fn run(db: &Db) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);",
    )?;

    for m in MIGRATIONS {
        let applied: Option<String> = conn
            .query_row("SELECT name FROM schema_migrations WHERE version=?1", rusqlite::params![m.version], |r| r.get(0))
            .optional()?;
        if applied.is_some() {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        // execute_batch 走 sqlite3_prepare 的 tail 机制，能正确处理触发器体内的分号
        tx.execute_batch(m.sql).map_err(|e| {
            log::error!("migration {} failed: {}", m.name, e);
            AppError::Db(e)
        })?;
        tx.execute(
            "INSERT INTO schema_migrations (version,name,applied_at) VALUES (?1,?2,?3)",
            rusqlite::params![m.version, m.name, chrono::Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
    }

    let current = version(&conn)?;
    if current < LATEST_VERSION {
        return Err(AppError::Internal);
    }
    Ok(())
}

pub fn version(conn: &rusqlite::Connection) -> Result<i64> {
    let v: Option<i64> = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))
        .optional()?;
    Ok(v.unwrap_or(0))
}

/// 供备份/诊断使用：结构版本，不含任何数据。
pub fn structure_report(db: &Db) -> Result<serde_json::Value> {
    let conn = db.lock_conn();
    let v = version(&conn)?;
    let mut stmt = conn.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")?;
    let objects: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(serde_json::json!({
        "schema_version": v,
        "expected_version": LATEST_VERSION,
        "object_count": objects.len(),
        "tables": objects.iter().filter(|(t, _)| t == "table").map(|(_, n)| n).collect::<Vec<_>>(),
        "triggers": objects.iter().filter(|(t, _)| t == "trigger").map(|(_, n)| n).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let db = Db::open_in_memory(&vec![1u8; 32]).unwrap();
        run(&db).unwrap();
        run(&db).unwrap();
        assert_eq!(version(&db.lock_conn()).unwrap(), LATEST_VERSION);
    }

    #[test]
    fn seed_creates_roles_and_permissions() {
        let db = Db::open_in_memory(&vec![2u8; 32]).unwrap();
        let c = db.lock_conn();
        let perms: i64 = c.query_row("SELECT count(*) FROM permissions", [], |r| r.get(0)).unwrap();
        let roles: i64 = c.query_row("SELECT count(*) FROM roles", [], |r| r.get(0)).unwrap();
        assert!(perms >= 20, "预置权限过少: {perms}");
        assert_eq!(roles, 3);
        let admin_all: i64 = c
            .query_row("SELECT count(*) FROM role_permissions WHERE role_id='r-admin'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(admin_all, perms);
        // 普通用户不得有系统管理菜单
        let forbidden: i64 = c
            .query_row(
                "SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
                 WHERE rp.role_id='r-user' AND p.permission_key IN ('menu.system','system.update.install','accounts.export')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(forbidden, 0);
    }

    /// 现场升级路径：库停在倒数第二版时，`run()` 只补最新那一条，已应用过的不得重放。
    /// 版本号一律由 `LATEST_VERSION` 与 `MIGRATIONS.last()` 推出来，以后再加迁移这条守卫不用跟着改。
    #[test]
    fn upgrading_applies_only_the_newest_migration() {
        let db = Db::open_in_memory(&vec![3u8; 32]).unwrap();
        let before: i64;
        {
            let c = db.lock_conn();
            before = c.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
            c.execute("DELETE FROM schema_migrations WHERE version=?1", rusqlite::params![LATEST_VERSION])
                .unwrap();
            assert_eq!(version(&c).unwrap(), LATEST_VERSION - 1, "回退后应停在倒数第二版");
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        assert_eq!(version(&c).unwrap(), LATEST_VERSION);
        let applied: String = c
            .query_row("SELECT name FROM schema_migrations WHERE version=?1", rusqlite::params![LATEST_VERSION], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, MIGRATIONS.last().unwrap().name, "最新一条登记的迁移名与 SQL 文件必须对得上");
        let after: i64 = c.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before, "只补那一条：已经应用过的迁移不能重放一遍");
    }

    /// 0007 那一档出厂值单独测：库停在它之前时，升级必须把闸门关掉，而不是只改新装库。
    #[test]
    fn export_reauth_gate_is_off_after_upgrading() {
        let db = Db::open_in_memory(&vec![3u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            let v: i64 = c
                .query_row("SELECT version FROM schema_migrations WHERE name='0007_export_reauth_off'", [], |r| r.get(0))
                .unwrap();
            // 先按出厂值把它改回"要二次认证"，模拟 10-18 之前建的那批库
            c.execute("UPDATE app_settings SET value='true' WHERE key='export_requires_reauth'", []).unwrap();
            c.execute("DELETE FROM schema_migrations WHERE version>=?1", rusqlite::params![v]).unwrap();
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        let value: String = c
            .query_row("SELECT value FROM app_settings WHERE key='export_requires_reauth'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "false", "已有库升级后也必须变成\"直接导出\"，否则这条改动只对新装库生效");
    }

    /// 0008 与 0007 同一档做法：已有库升级后也必须变成"直接复制"，否则这条改动只对新装库生效。
    #[test]
    fn copy_password_reauth_gate_is_off_after_upgrading() {
        let db = Db::open_in_memory(&vec![4u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            let v: i64 = c
                .query_row("SELECT version FROM schema_migrations WHERE name='0008_copy_password_reauth_off'", [], |r| r.get(0))
                .unwrap();
            c.execute("UPDATE app_settings SET value='true' WHERE key='copy_password_requires_reauth'", []).unwrap();
            c.execute("DELETE FROM schema_migrations WHERE version>=?1", rusqlite::params![v]).unwrap();
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        let value: String = c
            .query_row("SELECT value FROM app_settings WHERE key='copy_password_requires_reauth'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "false", "已有库升级后复制密码仍要再验主密码 ⇒ 这条改动只对新装库生效");
    }

    /// 0006 那笔主题收敛是数据清理：不回撤一份"旧形状"的数据它就真是空跑。
    /// 这里把三枚已删键与一枚旧主题名塞回去，再断言 `run()` 把它们收拾干净。
    #[test]
    fn theme_convergence_migration_cleans_the_obsolete_keys() {
        let db = Db::open_in_memory(&vec![3u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            let v: i64 = c
                .query_row("SELECT version FROM schema_migrations WHERE name='0006_theme_convergence'", [], |r| r.get(0))
                .unwrap();
            c.execute("DELETE FROM schema_migrations WHERE version>=?1", rusqlite::params![v]).unwrap();
            seed_old_theme_shape(&c);
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        assert_eq!(version(&c).unwrap(), LATEST_VERSION);
        assert_eq!(count_keys(&c, "app_settings"), 0, "已作废的外观键必须从安装级设置里消失");
        assert_eq!(count_keys(&c, "user_preferences"), 0, "已作废的外观键必须从个人偏好里消失");
        assert_eq!(theme_values(&c), vec!["glass".to_string()], "旧主题名必须归一到合法集里的那一枚");
    }

    /// 0006 之前的库长什么样：三枚没人再读的外观键 + 一枚不在合法集里的旧主题名，安装级与个人级各一份。
    fn seed_old_theme_shape(c: &rusqlite::Connection) {
        for (i, key) in OLD_THEME_KEYS.iter().enumerate() {
            c.execute(
                "INSERT INTO app_settings (key,value,scope,updated_at) VALUES (?1,'60','ui',?2)",
                rusqlite::params![key, format!("2026-01-0{i}T00:00:00Z")],
            )
            .unwrap();
        }
        c.execute(
            "UPDATE app_settings SET value='enterprise-blue' WHERE key='theme_style'",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO app_users
             (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,
              pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
             VALUES ('u-old','AC-OLD','旧主题使用者','argon2id','salt','hash',1,1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        for (i, key) in OLD_THEME_KEYS.iter().enumerate() {
            c.execute(
                "INSERT INTO user_preferences (app_user_id,key,value,updated_at) VALUES ('u-old',?1,'60',?2)",
                rusqlite::params![key, format!("2026-01-0{i}T00:00:00Z")],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO user_preferences (app_user_id,key,value,updated_at) VALUES ('u-old','theme_style','liquid-glass','2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }

    const OLD_THEME_KEYS: &[&str] = &["appearance_mode", "glass_enabled", "glass_intensity"];

    fn count_keys(c: &rusqlite::Connection, table: &str) -> i64 {
        c.query_row(
            &format!(
                "SELECT count(*) FROM {table} WHERE key IN ('appearance_mode','glass_enabled','glass_intensity')",
                table = table
            ),
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    }

    /// 两张表里所有 theme_style 的取值（去重、排序）：0006 之后只应剩 glass。
    fn theme_values(c: &rusqlite::Connection) -> Vec<String> {
        let mut stmt = c
            .prepare("SELECT DISTINCT value FROM (SELECT value FROM app_settings WHERE key='theme_style' UNION ALL SELECT value FROM user_preferences WHERE key='theme_style') ORDER BY value")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// 索引必须**真的被那条去重查询用上**。0001 起 `display_name` 一个索引都没有，
    /// 而建成普通列（`ON vault_targets(display_name)`）一样不会命中 `lower(display_name)=?1`，
    /// 所以要钉执行计划的读数，而不是只钉 sqlite_master 里有没有这个名字。
    #[test]
    fn the_dedupe_query_uses_the_expression_index() {
        let db = Db::open_in_memory(&vec![5u8; 32]).unwrap();
        let c = db.lock_conn();
        let mut stmt = c
            .prepare(&format!("EXPLAIN QUERY PLAN {}", crate::importexport::DEDUP_BY_NAME_SQL))
            .unwrap();
        let plan: Vec<String> = stmt
            // 那条 SQL 带 `?1` 占位，EXPLAIN 也要按它的元数绑定参数（列 3 是 detail）
            .query_map(["探针"], |r| r.get::<_, String>(3))
            .unwrap()
            .filter_map(|r| r.ok())
            .filter(|s| !s.trim().is_empty())
            .collect();
        assert!(
            plan.iter().any(|s| s.contains("idx_targets_name")),
            "去重查询没走名称索引，0005 的形状可能与查询漂移了：{plan:?}"
        );
        assert!(
            !plan.iter().any(|s| s.contains("SCAN vault_targets")),
            "去重查询仍在全表扫描：{plan:?}"
        );
    }

    /// 0004 那条出厂键单独守着：库里已经有 v5，只把 v4 撤掉重放，
    /// 既验证空串出厂值，也验证重放不会把更大的版本号拽回去。
    #[test]
    fn upgrading_from_v4_reseeds_the_extension_id_default() {
        let db = Db::open_in_memory(&vec![6u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            c.execute("DELETE FROM schema_migrations WHERE version=4", []).unwrap();
            c.execute("DELETE FROM app_settings WHERE key='extension_id'", []).unwrap();
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        assert_eq!(version(&c).unwrap(), LATEST_VERSION, "重放旧迁移不得把结构版本降级");
        let seeded: String = c
            .query_row("SELECT value FROM app_settings WHERE key='extension_id'", [], |r| r.get(0))
            .unwrap();
        assert!(seeded.is_empty(), "出厂值必须是空串：allowed_origins 精确到扩展 ID，猜一个等于错放");
    }

    /// 升级不得覆盖管理员已经配置好的值（0004 用的是 INSERT OR IGNORE，这里把它验证成契约）。
    #[test]
    fn upgrade_never_overwrites_an_administrator_value() {
        let db = Db::open_in_memory(&vec![4u8; 32]).unwrap();
        let configured = "a".repeat(32);
        {
            let c = db.lock_conn();
            c.execute(
                "UPDATE app_settings SET value=?1 WHERE key='extension_id'",
                rusqlite::params![configured],
            )
            .unwrap();
            c.execute("DELETE FROM schema_migrations WHERE version=4", []).unwrap();
        }
        run(&db).unwrap();
        let c = db.lock_conn();
        let now: String = c
            .query_row("SELECT value FROM app_settings WHERE key='extension_id'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(now, configured, "重放迁移不得把管理员配的扩展 ID 抹回空串");
    }
}
