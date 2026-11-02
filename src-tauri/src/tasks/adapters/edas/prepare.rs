//! 准备阶段：服务名 → 仓库信息 → tag 列表 → appId → 线上更新时间。
//!
//! 这五步全是**读**，不改任何东西，且每一步之间都听取消信号。原实现把这些塞进一个
//! `getServiceDetails`，所有失败统一压成"失败"，现场分不清是仓库没有、tag 是空的、
//! 还是应用列表里根本没这个服务。这里每种失败各给一句话，直接落进 `task_run_items.message`。
//!
//! 「要发哪个 tag」的优先级在建运行时就已经定下来并写进 `desired_tag`：
//! 清单的「指定镜像」列 > 「镜像」列自带的 `:tag` > 空（= 由这里取最新）。

use crate::error::{AppError, Result};
use crate::tasks::runner::{Prepared, RunContext, RunItem, LOG_INFO};

use super::client::EdasClient;
use super::image_ref::{choose, with_tag, TagCandidate};
use super::profile::{pick, timestamp_to_rfc3339, EdasProfile};
use super::session::CookieSession;

/// 一个 tag 及其构建时间（毫秒）。缺时间字段的按 0 处理——它排到最后，不会顶掉真正的新构建。
fn tag_candidates(root: &serde_json::Value, profile: &EdasProfile) -> Vec<TagCandidate> {
    let Some(items) = pick(root, &profile.paths.tags).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|row| {
            let tag = row.get(&profile.paths.tag_name).and_then(|v| v.as_str()).unwrap_or("").trim();
            if tag.is_empty() {
                return None;
            }
            let updated = row.get(&profile.paths.tag_updated_ms).and_then(|v| v.as_i64()).unwrap_or(0);
            Some(TagCandidate { tag: tag.to_string(), updated_ms: updated })
        })
        .collect()
}

fn stamp() -> String {
    chrono::Utc::now().timestamp_millis().to_string()
}

/// 仓库信息：`repoId`（查 tag 用）与 `publicUrl`（拼镜像全名用）。
fn repository_info(client: &EdasClient, profile: &EdasProfile, session: &CookieSession, service: &str) -> Result<(String, String)> {
    let repo_name = profile.repo_name_for(service);
    let t = stamp();
    let url = profile.build_url(
        &profile.endpoints.repository,
        &[(&profile.dynamic_params.timestamp, &t), (&profile.dynamic_params.repo_name, &repo_name)],
    )?;
    let value = client.get_json(&url, session)?;
    let repo_id = pick(&value, &profile.paths.repo_id).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let public_url = pick(&value, &profile.paths.public_url).and_then(|v| v.as_str()).unwrap_or("").to_string();
    if repo_id.is_empty() || public_url.is_empty() {
        return Err(AppError::TaskRemote(format!("镜像仓库里没有「{service}」：repoId 或 publicUrl 为空")));
    }
    Ok((repo_id, public_url))
}

fn choose_tag(
    client: &EdasClient,
    profile: &EdasProfile,
    session: &CookieSession,
    service: &str,
    repo_id: &str,
    designated: Option<&str>,
) -> Result<TagCandidate> {
    let repo_name = profile.repo_name_for(service);
    let t = stamp();
    let url = profile.build_url(
        &profile.endpoints.tags,
        &[
            (&profile.dynamic_params.timestamp, &t),
            (&profile.dynamic_params.repo_id, repo_id),
            (&profile.dynamic_params.repo_name, &repo_name),
        ],
    )?;
    let value = client.get_json(&url, session)?;
    match choose(&tag_candidates(&value, profile), designated) {
        super::image_ref::Choice::Latest(tag) | super::image_ref::Choice::Designated(tag) => Ok(tag),
        super::image_ref::Choice::Empty => Err(AppError::TaskRemote(format!("「{service}」的镜像仓库里没有任何 tag"))),
        super::image_ref::Choice::DesignatedNotFound(tag) => {
            Err(AppError::TaskRemote(format!("指定的镜像 {tag} 不在「{service}」的仓库里")))
        }
    }
}

fn app_id(client: &EdasClient, profile: &EdasProfile, session: &CookieSession, service: &str) -> Result<String> {
    let t = stamp();
    let url = profile.build_url(
        &profile.endpoints.app_list,
        &[(&profile.dynamic_params.timestamp, &t), (&profile.dynamic_params.app_name, service)],
    )?;
    let value = client.get_json(&url, session)?;
    let found = pick(&value, &profile.paths.app_list)
        .and_then(|v| v.as_array())
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get(&profile.paths.app_name_field).and_then(|v| v.as_str()) == Some(service))
        })
        .and_then(|row| row.get(&profile.paths.app_id_field).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    if found.is_empty() {
        return Err(AppError::TaskRemote(format!("应用列表里找不到「{service}」的 AppId")));
    }
    Ok(found)
}

/// 线上最近一次变更时间（毫秒）。取不到按 0：发布后的比较仍然成立（任何变化都算生效）。
pub fn update_time_ms(client: &EdasClient, profile: &EdasProfile, session: &CookieSession, app_id: &str) -> Result<i64> {
    let t = stamp();
    let url = profile.build_url(
        &profile.endpoints.app_detail,
        &[(&profile.dynamic_params.timestamp, &t), (&profile.dynamic_params.app_id, app_id)],
    )?;
    let value = client.get_json(&url, session)?;
    Ok(pick(&value, &profile.paths.app_update_ms).and_then(|v| v.as_i64()).unwrap_or(0))
}

pub fn resolve(ctx: &RunContext, client: &EdasClient, profile: &EdasProfile, session: &CookieSession, item: &RunItem) -> Result<Prepared> {
    ctx.ensure_active()?;
    let service = item.item_key.as_str();
    let (repo_id, public_url) = repository_info(client, profile, session, service)?;

    let designated = item.desired_tag.as_deref().filter(|t| !t.trim().is_empty());
    let tag = choose_tag(client, profile, session, service, &repo_id, designated)?;
    let image_ref = with_tag(&public_url, &tag.tag);
    ctx.log(
        LOG_INFO,
        Some(service),
        &format!("{service}：仓库 {repo_id}，目标 {}（构建于 {}）", tag.tag, timestamp_to_rfc3339(tag.updated_ms)),
    );

    ctx.ensure_active()?;
    let app = app_id(client, profile, session, service)?;
    let online_ms = update_time_ms(client, profile, session, &app)?;

    Ok(Prepared {
        image_ref: Some(image_ref),
        app_id: Some(app),
        service_update_at: Some(timestamp_to_rfc3339(online_ms)),
        tag_update_at: Some(timestamp_to_rfc3339(tag.updated_ms)),
        message: Some(format!("目标 tag {}", tag.tag)),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::tasks::adapters::edas::session::{harvest, RawCookie};
    use crate::tasks::runner::test_context;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// 一台按路径分派响应的假控制台。`updates` 记下每个接口被打了几次，用于断言调用次数。
    fn console(responses: &[(&str, &str)]) -> (String, Arc<AtomicI64>) {
        let table: Vec<(String, String)> = responses.iter().map(|(m, b)| (m.to_string(), b.to_string())).collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicI64::new(0));
        let counter = hits.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                counter.fetch_add(1, Ordering::SeqCst);
                let body = table
                    .iter()
                    .find(|(marker, _)| head.contains(marker.as_str()))
                    .map(|(_, body)| body.as_str())
                    .unwrap_or(r#"{"success":false,"errorCode":"NoRoute","message":"no such endpoint"}"#);
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}").as_bytes(),
                );
                let _ = stream.flush();
            }
        });
        (addr.to_string(), hits)
    }

    fn session() -> CookieSession {
        let raw = vec![RawCookie { name: "c_csrf".into(), value: "tok".into(), domain: "127.0.0.1".into() }];
        harvest(&raw, &["127.0.0.1".to_string()], &[], Duration::from_secs(60)).unwrap()
    }

    fn item(key: &str, desired: Option<&str>) -> RunItem {
        RunItem {
            id: format!("id-{key}"),
            ordinal: 0,
            item_key: key.to_string(),
            display_name: None,
            desired_tag: desired.map(str::to_string),
            image_ref: None,
            app_id: None,
            service_update_at: None,
            tag_update_at: None,
            status: "pending".into(),
            attempts: 0,
            message: None,
        }
    }

    fn core() -> std::sync::Arc<crate::state::AppCore> {
        std::sync::Arc::new(crate::state::AppCore::new(
            Db::open_in_memory(&[31u8; 32]).unwrap(),
            crate::crypto::random_key(),
            std::env::temp_dir(),
        ))
    }

    const REPO: &str = r#"{"success":true,"data":{"repoId":"r-9","publicUrl":"harbor/ns/order"}}"#;
    // tag 的构建时间是 13 位毫秒：控制台的字段就是毫秒，测试数据要照实写
    const TAGS: &str = r#"{"success":true,"data":{"tags":[{"tag":"20261028","imageUpdate":1730000000000},{"tag":"20261030","imageUpdate":1730100000000}]}}"#;
    const APPS: &str = r#"{"success":true,"data":{"totalSize":1,"result":[{"appname":"order-service","appId":"app-77"}]}}"#;
    const DETAIL: &str = r#"{"success":true,"data":{"app":{"updateTime":1730000000000}}}"#;

    fn profile_with(addr: String) -> EdasProfile {
        EdasProfile { base_url: format!("http://{addr}"), ..Default::default() }
    }

    #[test]
    fn resolve_walks_the_five_reads_and_fills_the_item() {
        let (addr, hits) = console(&[
            ("repository.json", REPO),
            ("tags.json", TAGS),
            ("queryAppListNew.json", APPS),
            ("CoApplication.json", DETAIL),
        ]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-1", false);

        let prepared = resolve(&ctx, &client, &profile, &session(), &item("order-service", None)).expect("五步读应全部走通");
        assert_eq!(prepared.image_ref.as_deref(), Some("harbor/ns/order:20261030"), "默认取最新构建");
        assert_eq!(prepared.app_id.as_deref(), Some("app-77"));
        assert_eq!(prepared.service_update_at.as_deref(), Some("2024-10-27T03:33:20+00:00"));
        assert_eq!(prepared.tag_update_at.as_deref(), Some("2024-10-28T07:20:00+00:00"));
        assert_eq!(hits.load(Ordering::SeqCst), 4, "恰好四次读，不多打");
    }

    #[test]
    fn designated_tag_is_matched_exactly_and_reported_when_absent() {
        let (addr, _hits) = console(&[
            ("repository.json", REPO),
            ("tags.json", TAGS),
            ("queryAppListNew.json", APPS),
            ("CoApplication.json", DETAIL),
        ]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-2", false);

        let prepared = resolve(&ctx, &client, &profile, &session(), &item("order-service", Some("20261028"))).unwrap();
        assert_eq!(prepared.image_ref.as_deref(), Some("harbor/ns/order:20261028"), "点名要发的那个不能被换成最新");

        // 指定不命中：在 tag 这一步就停，不该继续去读应用列表与详情
        let (addr, hits) = console(&[("repository.json", REPO), ("tags.json", TAGS), ("queryAppListNew.json", APPS), ("CoApplication.json", DETAIL)]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let err = resolve(&ctx, &client, &profile, &session(), &item("order-service", Some("20261029"))).unwrap_err();
        assert_eq!(err.code(), "TASK_REMOTE");
        assert!(err.safe_detail().contains("指定的镜像 20261029"), "{}", err.safe_detail());
        assert_eq!(hits.load(Ordering::SeqCst), 2, "只该打仓库与 tag 两发");
    }

    #[test]
    fn missing_service_or_empty_repo_says_which_one_is_missing() {
        let (addr, _) = console(&[("repository.json", r#"{"success":true,"data":{}}"#)]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-3", false);
        let err = resolve(&ctx, &client, &profile, &session(), &item("ghost-service", None)).unwrap_err();
        assert!(err.safe_detail().contains("镜像仓库里没有「ghost-service」"), "{}", err.safe_detail());

        // 仓库有、应用列表没有
        let (addr, _) = console(&[("repository.json", REPO), ("tags.json", TAGS), ("queryAppListNew.json", r#"{"success":true,"data":{"totalSize":0,"result":[]}}"#)]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let err = resolve(&ctx, &client, &profile, &session(), &item("order-service", None)).unwrap_err();
        assert!(err.safe_detail().contains("找不到「order-service」的 AppId"), "{}", err.safe_detail());
    }

    #[test]
    fn a_cancelled_context_stops_before_the_first_request() {
        let (addr, hits) = console(&[("repository.json", REPO)]);
        let profile = profile_with(addr);
        let client = EdasClient::new(profile.clone(), true).unwrap();
        let ctx = test_context(core(), "run-4", true);
        let err = resolve(&ctx, &client, &profile, &session(), &item("order-service", None)).unwrap_err();
        assert_eq!(err.code(), "CANCELLED");
        assert_eq!(hits.load(Ordering::SeqCst), 0, "取消之后一个请求都不该发出去");
    }
}
