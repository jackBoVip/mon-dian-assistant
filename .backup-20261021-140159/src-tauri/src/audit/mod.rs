//! 审计事件：只记录动作元数据与目标 ID。
//! 绝不写入密码、口令、Token、密钥、完整查询串或敏感 URL 参数。

use crate::db::Db;
use crate::error::Result;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: String,
    pub ts: String,
    pub actor_id: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub result: String,
    pub error_code: Option<String>,
    pub source: Option<String>,
}

pub fn record(
    db: &Db,
    actor_id: Option<&str>,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    result: &str,
    error_code: Option<&str>,
    source: Option<&str>,
) -> Result<()> {
    let conn = db.lock_conn();
    conn.execute(
        "INSERT INTO audit_events (id,ts,actor_id,action,target_type,target_id,result,error_code,source)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            uuid::Uuid::now_v7().to_string(),
            chrono::Utc::now().to_rfc3339(),
            actor_id,
            action,
            target_type,
            target_id,
            result,
            error_code,
            source
        ],
    )?;
    Ok(())
}

pub fn list(db: &Db, limit: i64) -> Result<Vec<AuditEvent>> {
    let conn = db.lock_conn();
    let mut stmt = conn.prepare(
        "SELECT id,ts,actor_id,action,target_type,target_id,result,error_code,source
         FROM audit_events ORDER BY ts DESC LIMIT ?1",
    )?;
    let v = stmt
        .query_map(params![limit], |r| {
            Ok(AuditEvent {
                id: r.get(0)?,
                ts: r.get(1)?,
                actor_id: r.get(2)?,
                action: r.get(3)?,
                target_type: r.get(4)?,
                target_id: r.get(5)?,
                result: r.get(6)?,
                error_code: r.get(7)?,
                source: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reads_back() {
        let db = Db::open_in_memory(&vec![31u8; 32]).unwrap();
        record(&db, Some("u1"), "accounts.copy_password", Some("vault_item"), Some("i1"), "success", None, Some("quick_launcher")).unwrap();
        let rows = list(&db, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "accounts.copy_password");
        assert_eq!(rows[0].source.as_deref(), Some("quick_launcher"));
    }

    #[test]
    fn audit_row_never_contains_secret_columns() {
        let db = Db::open_in_memory(&vec![32u8; 32]).unwrap();
        record(&db, Some("u1"), "vault.search", Some("vault_item"), Some("i1"), "success", None, Some("quick_launcher")).unwrap();
        let conn = db.lock_conn();
        let blob: String = conn
            .query_row("SELECT group_concat(id||ts||action||coalesce(metadata,''),'') FROM audit_events", [], |r| r.get(0))
            .unwrap();
        assert!(!blob.contains("Pa55w0rd"));
        let cols: Vec<String> = {
            let mut st = conn.prepare("SELECT name FROM pragma_table_info('audit_events')").unwrap();
            st.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<std::result::Result<Vec<_>, _>>().unwrap()
        };
        for forbidden in ["password", "secret", "query", "token"] {
            assert!(!cols.iter().any(|c| c.contains(forbidden)), "审计表不应有 {forbidden} 列");
        }
    }
}
