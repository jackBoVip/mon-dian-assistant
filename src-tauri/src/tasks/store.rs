//! 任务中心配置的读写：`task_profiles`（非密的站点形状）与 `task_env_bindings`（凭据**引用**）。
//!
//! 两张表的分工就是安全边界：
//! - profile 里全是域名、region、字段名，落库前必须过 `EdasProfile::validate`；
//! - 绑定表只有 `credential_item_id`，指向保险库里的那枚凭据。密码永远留在保险库一侧，
//!   由适配器在 Rust 内存里经 `repo::item_payload` 取用。
//! - 绑定还要过记录级 ACL：不能把别人的凭据绑到发布任务上。

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::adapters::edas::profile::EdasProfile;
use super::{task_def, Env};
use crate::db::{repo, Db};
use crate::error::{AppError, Result};
use crate::settings;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRow {
    pub task_key: String,
    pub env: String,
    pub profile_json: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRow {
    pub task_key: String,
    pub env: String,
    /// 手动覆盖的登录地址。**空串表示"跟随这条凭据自己的登录地址"**（账号中心里
    /// 那条凭据的 `loginUrlOverride`，为空则退回它所属目标的地址）。
    pub login_url: String,
    pub credential_item_id: String,
    /// 解析"跟随凭据"时要用的目标 id（目标地址是加密存的，只有拿到 vk 才读得到）。
    pub credential_target_id: String,
    /// 只给账号别名：用户名与口令都不从这里出去。
    pub credential_label: Option<String>,
    pub updated_at: String,
}

fn env_key(env: Env) -> &'static str {
    env.as_str()
}

fn require_task(task_key: &str, env: Env) -> Result<()> {
    let def = task_def(task_key).ok_or(AppError::InvalidInput)?;
    if def.envs.contains(&env) {
        Ok(())
    } else {
        Err(AppError::InvalidInput)
    }
}

/// 校验手动填写的登录地址。空串是合法值，含义是"跟随这条凭据"——登录地址的
/// 唯一事实来源本来就在账号中心，任务侧不该再逼人抄一遍。
///
/// 明文 http 只看一条：管理员有没有在安全策略里开启「允许不安全协议」。
/// **不按环境写死**——内蒙电的生产控制台本身就是 http，把生产钉成 https 等于让这一页
/// 在真实环境里用不了；红线仍然在（开关默认关、关掉后已存下的明文地址立刻不再被使用）。
pub fn validate_login_url(raw: &str, db: &Db) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(trimmed).map_err(|_| AppError::InvalidInput)?;
    match url.scheme() {
        "https" => {}
        "http" => {
            if !settings::get_bool(db, "allow_insecure_protocols", false) {
                return Err(AppError::InsecureProtocolDisabled);
            }
        }
        _ => return Err(AppError::InvalidInput),
    }
    if url.host_str().unwrap_or_default().is_empty() {
        return Err(AppError::InvalidInput);
    }
    if !url.username().is_empty() || url.password().is_some() {
        // 凭据写进地址里等于把它交给访问日志与代理。
        return Err(AppError::InvalidInput);
    }
    Ok(trimmed.to_string())
}

pub fn get_profile(db: &Db, task_key: &str, env: Env) -> Result<Option<ProfileRow>> {
    require_task(task_key, env)?;
    let conn = db.lock_conn();
    Ok(conn
        .query_row(
            "SELECT task_key, env, profile_json, updated_at FROM task_profiles WHERE task_key=?1 AND env=?2",
            params![task_key, env_key(env)],
            |r| {
                Ok(ProfileRow {
                    task_key: r.get(0)?,
                    env: r.get(1)?,
                    profile_json: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            },
        )
        .optional()?)
}

/// 落库前就解析并校验：宁可不存，也不要运行时才发现"这份配置根本发不出去"。
pub fn put_profile(db: &Db, actor: &str, task_key: &str, env: Env, profile_json: &str) -> Result<EdasProfile> {
    require_task(task_key, env)?;
    let parsed = EdasProfile::from_json(profile_json)?;
    parsed.validate()?;
    let stored = parsed.to_json()?;
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO task_profiles (task_key,env,profile_json,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(task_key,env) DO UPDATE SET profile_json=excluded.profile_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
        params![task_key, env_key(env), stored, actor, repo::now()],
    )?;
    Ok(parsed)
}

/// 没配过的环境按出厂 profile 走，但界面要能分清"这是出厂值"（`is_configured`）。
pub fn profile_or_default(db: &Db, task_key: &str, env: Env) -> Result<EdasProfile> {
    match get_profile(db, task_key, env)? {
        Some(row) => EdasProfile::from_json(&row.profile_json),
        None => Ok(EdasProfile::default()),
    }
}

pub fn is_configured(db: &Db, task_key: &str, env: Env) -> Result<bool> {
    Ok(get_profile(db, task_key, env)?.is_some())
}

pub fn get_binding(db: &Db, task_key: &str, env: Env) -> Result<Option<BindingRow>> {
    require_task(task_key, env)?;
    let conn = db.lock_conn();
    Ok(conn
        .query_row(
            "SELECT b.task_key, b.env, b.login_url, b.credential_item_id,
                    i.account_alias, b.updated_at, i.target_id
               FROM task_env_bindings b
               JOIN vault_items i ON i.id = b.credential_item_id
              WHERE b.task_key=?1 AND b.env=?2",
            params![task_key, env_key(env)],
            |r| {
                Ok(BindingRow {
                    task_key: r.get(0)?,
                    env: r.get(1)?,
                    login_url: r.get(2)?,
                    credential_item_id: r.get(3)?,
                    credential_label: r.get(4)?,
                    updated_at: r.get(5)?,
                    credential_target_id: r.get(6)?,
                })
            },
        )
        .optional()?)
}

/// 绑定一枚保险库凭据。三道检查：记录可见、凭据可用、地址协议合格。
pub fn put_binding(db: &Db, actor: &str, task_key: &str, env: Env, login_url: &str, item_id: &str) -> Result<BindingRow> {
    require_task(task_key, env)?;
    let url = validate_login_url(login_url, db)?;
    let item_id = item_id.trim();
    // 没有凭据就没有"跟随"的来源，绑定这一行本身就没意义：地址与凭据必须至少给出凭据。
    if item_id.is_empty() {
        return Err(AppError::InvalidInput);
    }
    let conn = db.lock_conn();
    if !repo::can_access_item(&conn, actor, item_id)? {
        // 不可见时按"不存在"回，与台账侧的口径一致：不承认这枚 id 存在。
        return Err(AppError::NotFound);
    }
    let (status, deleted): (String, Option<String>) = conn
        .query_row("SELECT status, deleted_at FROM vault_items WHERE id=?1", params![item_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or(AppError::NotFound)?;
    if status != "active" || deleted.is_some() {
        return Err(AppError::CredentialDisabled);
    }
    conn.execute(
        "INSERT INTO task_env_bindings (task_key,env,login_url,credential_item_id,updated_by,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(task_key,env) DO UPDATE SET login_url=excluded.login_url,
              credential_item_id=excluded.credential_item_id, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
        params![task_key, env_key(env), url, item_id, actor, repo::now()],
    )?;
    drop(conn);
    get_binding(db, task_key, env)?.ok_or(AppError::Internal)
}

pub fn delete_binding(db: &Db, task_key: &str, env: Env) -> Result<()> {
    require_task(task_key, env)?;
    let conn = db.lock_conn();
    conn.execute("DELETE FROM task_env_bindings WHERE task_key=?1 AND env=?2", params![task_key, env_key(env)])?;
    Ok(())
}

/// 绑定是否齐备（缺绑定就没有"能执行的下一步"可说，界面要按这个禁用按钮）。
pub fn binding_ready(db: &Db, task_key: &str, env: Env) -> Result<bool> {
    Ok(get_binding(db, task_key, env)?.is_some())
}

/// 历史列表里的一行：运行状态 + 各档计数（计数在 SQL 里一次算完，不让前端逐条数）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunListItem {
    pub id: String,
    pub task_key: String,
    pub env: String,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub cancel_requested: bool,
    pub total: i64,
    pub ready: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub skipped: i64,
}

/// 最近若干次运行。`limit` 有硬上限：历史页是给人翻的，不是把整张表拖给前端。
pub fn list_runs(db: &Db, task_key: &str, env: Env, limit: i64) -> Result<Vec<RunListItem>> {
    require_task(task_key, env)?;
    let cap = limit.clamp(1, 200);
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT r.id, r.task_key, r.env, r.status, r.created_by, r.created_at, r.started_at, r.finished_at, r.cancel_requested,
                (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id),
                (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='ready'),
                (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='succeeded'),
                (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='failed'),
                (SELECT count(*) FROM task_run_items i WHERE i.run_id=r.id AND i.status='skipped')
           FROM task_runs r
          WHERE r.task_key=?1 AND r.env=?2
          ORDER BY r.created_at DESC
          LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![task_key, env_key(env), cap], |r| {
        Ok(RunListItem {
            id: r.get(0)?,
            task_key: r.get(1)?,
            env: r.get(2)?,
            status: r.get(3)?,
            created_by: r.get(4)?,
            created_at: r.get(5)?,
            started_at: r.get(6)?,
            finished_at: r.get(7)?,
            cancel_requested: r.get::<_, i64>(8)? != 0,
            total: r.get(9)?,
            ready: r.get(10)?,
            succeeded: r.get(11)?,
            failed: r.get(12)?,
            skipped: r.get(13)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub seq: i64,
    pub ts: String,
    pub level: String,
    pub item_key: Option<String>,
    pub message: String,
}

/// 运行日志。写入时已经统一脱敏（`tasks::redact`），这里只是按序号往后翻。
pub fn logs_after(db: &Db, run_id: &str, after_seq: i64, limit: i64) -> Result<Vec<LogRow>> {
    let cap = limit.clamp(1, 500);
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT seq, ts, level, item_key, message FROM task_run_logs WHERE run_id=?1 AND seq>?2 ORDER BY seq LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![run_id, after_seq, cap], |r| {
        Ok(LogRow {
            seq: r.get(0)?,
            ts: r.get(1)?,
            level: r.get(2)?,
            item_key: r.get(3)?,
            message: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    const NOW: &str = "2026-01-01T00:00:00Z";

    fn db_with_world() -> Db {
        let db = Db::open_in_memory(&[11u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            for id in ["u1", "u2", "u3"] {
                c.execute(
                    "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
                     VALUES (?1,?2,?3,'argon2id',X'00',X'00',4096,2,1,?4,?4)",
                    params![id, format!("GEN-{id}"), id, NOW],
                )
                .unwrap();
            }
            // u3 是系统管理员角色（can_access_item 的管理员分支靠它）
            c.execute("INSERT INTO user_roles (user_id, role_id) VALUES ('u3','r-admin')", []).unwrap();
            c.execute(
                "INSERT INTO vault_targets (id,target_type,display_name,created_by,created_at,updated_at) VALUES ('tg1','web','n','u1',?1,?1)",
                params![NOW],
            )
            .unwrap();
            for (id, owner) in [("it1", "u1"), ("it2", "u2"), ("it-off", "u1")] {
                c.execute(
                    "INSERT INTO vault_items (id,target_id,account_alias,item_type,status,created_by,created_at,updated_at)
                     VALUES (?1,'tg1',?2,'web','active',?3,?4,?4)",
                    params![id, format!("alias-{id}"), owner, NOW],
                )
                .unwrap();
            }
            c.execute("UPDATE vault_items SET status='disabled' WHERE id='it-off'", []).unwrap();
        }
        db
    }

    #[test]
    fn profile_round_trip_rejects_broken_json_before_writing() {
        let db = db_with_world();
        assert!(!is_configured(&db, "release", Env::Test).unwrap());
        assert!(get_profile(&db, "release", Env::Test).unwrap().is_none());

        let bad = r#"{"baseUrl":"not a url"}"#;
        let err = put_profile(&db, "u1", "release", Env::Test, bad).unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID");
        assert!(!is_configured(&db, "release", Env::Test).unwrap(), "校验不过不得落库");

        let good = EdasProfile {
            base_url: "https://edas.staging.internal".into(),
            ..Default::default()
        }
        .to_json()
        .unwrap();
        put_profile(&db, "u1", "release", Env::Test, &good).unwrap();
        let row = get_profile(&db, "release", Env::Test).unwrap().expect("已落库");
        assert!(row.profile_json.contains("edas.staging.internal"));
        assert!(is_configured(&db, "release", Env::Test).unwrap());
        // 生产环境没配过 → 取到的是出厂值，且 is_configured 如实说"没有"
        assert_eq!(profile_or_default(&db, "release", Env::Prod).unwrap().base_url, EdasProfile::default().base_url);
        assert!(!is_configured(&db, "release", Env::Prod).unwrap());

        // 再写一次是覆盖，不是新行；改动人跟着走
        put_profile(&db, "u2", "release", Env::Test, &good).unwrap();
        let c = db.lock_conn();
        let n: i64 = c
            .query_row("SELECT count(*) FROM task_profiles WHERE task_key='release' AND env='test'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let by: String = c
            .query_row("SELECT updated_by FROM task_profiles WHERE task_key='release' AND env='test'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(by, "u2");
    }

    #[test]
    fn unknown_task_or_env_is_rejected() {
        let db = db_with_world();
        assert!(put_profile(&db, "u1", "nope", Env::Test, "{}").is_err());
        let conn = db.lock_conn();
        // CHECK 约束把 dev 档挡在库外（界面也不该给出没有落点的开关）
        let err = conn.execute(
            "INSERT INTO task_env_bindings (task_key,env,login_url,credential_item_id,updated_at) VALUES ('release','dev','https://x','it1','t')",
            [],
        );
        assert!(err.is_err());
    }

    #[test]
    fn binding_stores_only_a_reference_and_only_for_visible_active_items() {
        let db = db_with_world();
        let row = put_binding(&db, "u1", "release", Env::Test, "https://login.example.com/sso", "it1").unwrap();
        assert_eq!(row.credential_label.as_deref(), Some("alias-it1"));
        // 表里没有任何口令列：能读回的只有引用与别名
        let cols: Vec<String> = {
            let c = db.lock_conn();
            let mut st = c.prepare("SELECT name FROM pragma_table_info('task_env_bindings')").unwrap();
            st.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Vec<_>>()
                .into_iter()
                .flatten()
                .collect()
        };
        for forbidden in ["password", "username", "secret", "token"] {
            assert!(!cols.iter().any(|col| col.to_ascii_lowercase().contains(forbidden)), "绑定表里不该有 {forbidden} 列：{cols:?}");
        }

        // it2 属于 u2：u1 既不可见也不该被承认存在
        let err = put_binding(&db, "u1", "release", Env::Test, "https://login.example.com/sso", "it2").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        // 管理员看得见全库，可以绑
        assert!(put_binding(&db, "u3", "release", Env::Test, "https://login.example.com/sso", "it2").is_ok());
        // 停用的凭据不能当登录账号
        let err = put_binding(&db, "u1", "release", Env::Test, "https://login.example.com/sso", "it-off").unwrap_err();
        assert_eq!(err.code(), "CREDENTIAL_DISABLED");
        // 不存在的 id
        assert!(put_binding(&db, "u1", "release", Env::Test, "https://x.com", "nope").is_err());
        assert!(!binding_ready(&db, "release", Env::Prod).unwrap());

        delete_binding(&db, "release", Env::Test).unwrap();
        assert!(get_binding(&db, "release", Env::Test).unwrap().is_none());
    }

    #[test]
    fn plain_http_follows_the_admin_switch_and_not_the_environment() {
        let db = db_with_world();
        settings::set(&db, "allow_insecure_protocols", "true", "security").unwrap();
        // 开关开着：测试与生产都允许明文（内蒙电的生产控制台本来就是 http，交付方 2026-10-31 点名）
        assert!(put_binding(&db, "u3", "release", Env::Test, "http://login.staging.internal/sso", "it1").is_ok());
        assert!(put_binding(&db, "u3", "release", Env::Prod, "http://login.prod.internal/sso", "it1").is_ok());

        settings::set(&db, "allow_insecure_protocols", "false", "security").unwrap();
        for env in [Env::Test, Env::Prod] {
            let err = put_binding(&db, "u3", "release", env, "http://login.internal/sso", "it1").unwrap_err();
            assert_eq!(err.code(), "INSECURE_PROTOCOL_DISABLED", "{env:?} 关掉开关后都不该放行明文");
        }
        // https 不受这个开关影响
        assert!(put_binding(&db, "u3", "release", Env::Test, "https://login.staging.internal/sso", "it1").is_ok());
    }

    #[test]
    fn login_url_shape_checks_and_empty_means_follow_the_credential() {
        let db = db_with_world();
        for bad in ["not-an-url", "ftp://x.com/a", "https://admin:pw@x.com", "https://"] {
            let err = put_binding(&db, "u1", "release", Env::Test, bad, "it1");
            assert!(err.is_err(), "{bad} 必须被拒");
        }
        // 空串是合法值：登录地址跟着凭据走，任务侧不再抄第二份
        let row = put_binding(&db, "u1", "release", Env::Test, "", "it1").unwrap();
        assert_eq!(row.login_url, "");
        assert_eq!(row.credential_target_id, "tg1", "解析目标地址要用得上这个 id");
        let c = db.lock_conn();
        let stored: String = c
            .query_row("SELECT login_url FROM task_env_bindings WHERE task_key='release' AND env='test'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, "");
    }
}
