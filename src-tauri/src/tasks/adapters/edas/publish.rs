//! 执行阶段：改镜像 → **有上限**地等生效。
//!
//! 原实现是 `loop { sleep(10s); if 变了 { break } }`：网关一抖、或者控制台回一个永远不变的时间，
//! 这条线程就永久挂在那里，人只能重启程序。这里把它变成"最多 N 次、每步都听取消"的轮询：
//! 超时报失败并留下可重试的事实，不假装成功。

use std::time::Duration;

use crate::error::{AppError, Result};
use crate::tasks::runner::{PublishOutcome, RunContext, RunItem, LOG_WARN};

use super::client::EdasClient;
use super::prepare::update_time_ms;
use super::profile::EdasProfile;
use super::session::CookieSession;

/// RFC3339 → 毫秒。解析不出来按 0：那等于"线上还没有过变更"，任何一次真实变更都能判成生效。
fn baseline_ms(stored: Option<&str>) -> i64 {
    let Some(text) = stored else { return 0 };
    chrono::DateTime::parse_from_rfc3339(text)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

pub fn push(
    ctx: &RunContext,
    client: &EdasClient,
    profile: &EdasProfile,
    session: &CookieSession,
    item: &RunItem,
) -> Result<PublishOutcome> {
    ctx.ensure_active()?;
    let app_id = item.app_id.clone().unwrap_or_default();
    let image_ref = item.image_ref.clone().unwrap_or_default();
    if app_id.is_empty() || image_ref.is_empty() {
        // 没读到 AppId 或镜像就点发布，是界面没拦住；这里如实拒绝，不发半截请求。
        return Err(AppError::TaskProfileInvalid(format!("「{}」还没有读到 AppId 与镜像，请先重新读取发布信息", item.item_key)));
    }

    let stamp = chrono::Utc::now().timestamp_millis().to_string();
    let url = profile.build_update_url(&stamp)?;
    let form = [
        (profile.endpoints.update_image.app_id_field.as_str(), app_id.as_str()),
        (profile.endpoints.update_image.image_field.as_str(), image_ref.as_str()),
    ];
    client.post_form(&url, &form, session)?;
    let baseline = baseline_ms(item.service_update_at.as_deref());
    ctx.mark_waiting(item);

    let interval = Duration::from_secs(profile.poll.interval_secs.max(1));
    let max_polls = profile.poll.max_polls.max(1);
    for round in 1..=max_polls {
        if !ctx.sleep(interval) {
            return Err(AppError::Cancelled);
        }
        let current = update_time_ms(client, profile, session, &app_id)?;
        if current > baseline {
            return Ok(PublishOutcome {
                ok: true,
                message: format!("线上变更时间已更新（第 {round} 次轮询）"),
                service_update_at: Some(super::profile::timestamp_to_rfc3339(current)),
            });
        }
    }
    ctx.log(
        LOG_WARN,
        Some(&item.item_key),
        &format!("{}：{max_polls} 次轮询后线上变更时间仍未变化", item.item_key),
    );
    Ok(PublishOutcome {
        ok: false,
        message: format!("等待生效超时：轮询 {max_polls} 次后线上变更时间仍是原值，可重试"),
        service_update_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::tasks::adapters::edas::session::{harvest, RawCookie};
    use crate::tasks::runner::{test_context, ITEM_WAITING};
    use rusqlite::params;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;
    use std::time::Duration as StdDuration;

    fn core() -> Arc<crate::state::AppCore> {
        Arc::new(crate::state::AppCore::new(
            Db::open_in_memory(&[41u8; 32]).unwrap(),
            crate::crypto::random_key(),
            std::env::temp_dir(),
        ))
    }

    fn session() -> CookieSession {
        let raw = vec![RawCookie { name: "c_csrf".into(), value: "tok".into(), domain: "127.0.0.1".into() }];
        harvest(&raw, &["127.0.0.1".to_string()], &[], StdDuration::from_secs(60)).unwrap()
    }

    /// 假控制台：`CoApplication.json` 第 `flip_after` 次之后才回新的变更时间。
    fn console(baseline: i64, updated: i64, flip_after: i64) -> (String, Arc<AtomicI64>, Arc<AtomicI64>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let posts = Arc::new(AtomicI64::new(0));
        let polls = Arc::new(AtomicI64::new(0));
        let (p, q) = (posts.clone(), polls.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                // 先把整个请求读干净（表单体在另一个 TCP 段上），再判定：
                // 只读第一个包会让"表单缺字段"变成随机结果。
                let mut raw: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(n) = stream.read(&mut chunk) else { break };
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    if let Some(split) = text.find("\r\n\r\n") {
                        let declared = text
                            .to_ascii_lowercase()
                            .split("content-length:")
                            .nth(1)
                            .and_then(|rest| rest.trim_start().split(|c: char| !c.is_ascii_digit()).next())
                            .and_then(|d| d.parse::<usize>().ok())
                            .unwrap_or(0);
                        if raw.len() >= split + 4 + declared {
                            break;
                        }
                    }
                    if raw.len() > 64 * 1024 {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&raw).to_string();
                let body = if head.contains("K8sApps.json") {
                    p.fetch_add(1, Ordering::SeqCst);
                    // 表单里该同时带上 appId 与镜像；缺一个就说明拼装错了
                    if head.contains("appId=app-77") && head.contains("image=harbor") {
                        r#"{"success":true}"#.to_string()
                    } else {
                        r#"{"success":false,"errorCode":"BadForm","message":"表单缺字段"}"#.to_string()
                    }
                } else if head.contains("CoApplication.json") {
                    let seen = q.fetch_add(1, Ordering::SeqCst) + 1;
                    let value = if seen >= flip_after { updated } else { baseline };
                    format!(r#"{{"success":true,"data":{{"app":{{"updateTime":{value}}}}}}}"#)
                } else {
                    r#"{"success":false,"errorCode":"NoRoute"}"#.to_string()
                };
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}").as_bytes(),
                );
                let _ = stream.flush();
            }
        });
        (addr.to_string(), posts, polls)
    }

    fn profile_with(addr: String, interval: u64, max: u32) -> EdasProfile {
        EdasProfile {
            base_url: format!("http://{addr}"),
            poll: super::super::profile::PollRule { interval_secs: interval, max_polls: max },
            ..Default::default()
        }
    }

    fn item(update: Option<&str>) -> RunItem {
        RunItem {
            id: "i1".into(),
            ordinal: 0,
            item_key: "order-service".into(),
            display_name: None,
            desired_tag: None,
            image_ref: Some("harbor/ns/order:20261030".into()),
            app_id: Some("app-77".into()),
            service_update_at: update.map(str::to_string),
            tag_update_at: None,
            status: "ready".into(),
            attempts: 1,
            message: None,
        }
    }

    #[test]
    fn push_posts_the_form_and_returns_when_the_update_time_moves() {
        let (addr, posts, polls) = console(1_700_000_000_000, 1_730_000_000_000, 2);
        let profile = profile_with(addr, 1, 5);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-p1", false);
        let outcome = push(&ctx, &client, &profile, &session(), &item(Some("2023-11-14T22:13:20+00:00"))).unwrap();
        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(outcome.service_update_at.as_deref(), Some("2024-10-27T03:33:20+00:00"));
        assert_eq!(posts.load(Ordering::SeqCst), 1, "镜像只该改一次");
        assert_eq!(polls.load(Ordering::SeqCst), 2, "第二次轮询就看到生效");
    }

    #[test]
    fn push_gives_up_after_the_poll_ceiling_instead_of_hanging() {
        let (addr, _, polls) = console(1_730_000_000_000, 1_730_000_000_000, 999);
        let profile = profile_with(addr, 1, 3);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-p2", false);
        let outcome = push(&ctx, &client, &profile, &session(), &item(Some("2024-10-27T03:33:20+00:00"))).unwrap();
        assert!(!outcome.ok, "时间没动就不能报成功");
        assert!(outcome.message.contains("轮询 3 次"), "{}", outcome.message);
        assert_eq!(polls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn cancel_during_the_wait_stops_immediately_and_remote_failures_are_not_silently_ignored() {
        // 取消：sleep 每 200ms 检查一次信号，轮询根本不该发生
        let (addr, _, polls) = console(1, 2, 1);
        let profile = profile_with(addr, 60, 10);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-p3", false);
        let cancel = ctx.cancel_handle_for_test();
        let worker_ctx = ctx.clone();
        let worker = std::thread::spawn(move || push(&worker_ctx, &client, &profile, &session(), &item(Some("2024-01-01T00:00:00+00:00"))));
        std::thread::sleep(StdDuration::from_millis(300));
        cancel.store(true, Ordering::SeqCst);
        let err = worker.join().unwrap().unwrap_err();
        assert_eq!(err.code(), "CANCELLED");
        assert!(polls.load(Ordering::SeqCst) <= 1, "取消后不该继续轮询：{}", polls.load(Ordering::SeqCst));

        // 表单缺字段 → 控制台回 success=false → 明确失败，不是"成功但没生效"
        let (addr, posts, _) = console(1, 2, 1);
        let profile = profile_with(addr, 1, 2);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-p4", false);
        let broken = RunItem { app_id: None, ..item(Some("2024-01-01T00:00:00+00:00")) };
        let err = push(&ctx, &client, &profile, &session(), &broken).unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID");
        assert_eq!(posts.load(Ordering::SeqCst), 0, "没读全就不该发出去");
    }

    fn core_with_user() -> Arc<crate::state::AppCore> {
        let db = Db::open_in_memory(&[42u8; 32]).unwrap();
        {
            let c = db.lock_conn();
            c.execute(
                "INSERT INTO app_users (id,generated_account_code,nickname,pwd_kdf_alg,pwd_verify_salt,pwd_verify_hash,pwd_kdf_m_kib,pwd_kdf_t,pwd_kdf_p,created_at,updated_at)
                 VALUES ('u1','GEN1','tester','argon2id',X'00',X'00',4096,2,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        Arc::new(crate::state::AppCore::new(db, crate::crypto::random_key(), std::env::temp_dir()))
    }

    #[test]
    fn waiting_is_written_after_an_accepted_post() {
        let (addr, posts, _) = console(1_700_000_000_000, 1_730_000_000_000, 1);
        let profile = profile_with(addr, 1, 2);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let core = core_with_user();
        let run_id = crate::tasks::runner::create_run(
            &core,
            "release",
            crate::tasks::Env::Test,
            "{}",
            &[crate::tasks::runner::NewRunItem { item_key: "order-service".into(), display_name: None, desired_tag: None }],
            "u1",
        )
        .unwrap();
        // 引擎在真正发布前会把这一行推到 publishing，这里照做一遍再验适配器的中间态
        {
            let c = core.db.lock_conn();
            c.execute(
                "UPDATE task_run_items SET status='publishing', app_id='app-77',
                        image_ref='harbor/ns/order:20261030', service_update_at='2023-11-14T22:13:20+00:00'
                  WHERE run_id=?1",
                params![run_id],
            )
            .unwrap();
        }
        let stored = crate::tasks::runner::load_items(&core, &run_id).unwrap().remove(0);
        let ctx = test_context(core.clone(), &run_id, false);
        let outcome = push(&ctx, &client, &profile, &session(), &stored).unwrap();
        assert!(outcome.ok, "{}", outcome.message);
        assert_eq!(posts.load(Ordering::SeqCst), 1);
        let after = crate::tasks::runner::load_items(&core, &run_id).unwrap();
        // 适配器只写中间态；终态（成功/失败）归引擎，发布历史不由站点代码自己盖章
        assert_eq!(after[0].status, ITEM_WAITING);
        assert!(after[0].service_update_at.is_some(), "准备阶段读到的时间要留着比较");
    }
}
