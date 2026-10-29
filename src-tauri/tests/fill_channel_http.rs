//! 填充握手（桌面端这一半）的真实端到端：走 `ipc::start` 起的回环 TCP，
//! 请求形状与 `bin/mda_fill_host.rs` 逐字一致，因此 `origin_allowed` 与
//! `challenge` / `fill` 两条分支都是真跑出来的，不是函数级桩。
//!
//! 这一条专门守 2026-10-29 放开的那档：内网台账里确有 `http://` 系统，
//! 协议前缀不再限于 https；精确 Origin 逐字比对与票据一次性一个字没松。
//!
//! 所有数据都是合成凭据，不含任何真实口令。

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::Arc;

use mon_dian_assistant_lib::auth::session::{Session, VaultState};
use mon_dian_assistant_lib::auth::users;
use mon_dian_assistant_lib::commands::launcher::FillRequest;
use mon_dian_assistant_lib::crypto::{SecretBytes, SecretString};
use mon_dian_assistant_lib::db::{repo, Db};
use mon_dian_assistant_lib::ipc;
use mon_dian_assistant_lib::quick_launcher::{actions::issue_fill_ticket, search::SearchIndex};
use mon_dian_assistant_lib::state::AppCore;

const PASS: &str = "MengDian#2026x";
const HTTP_ORIGIN: &str = "http://10.0.0.8:8080";
const USER: &str = "ops-intranet";
const SECRET: &str = "Intranet#P@ss1";

struct Harness {
    core: Arc<AppCore>,
    item_id: String,
    uid: String,
    dir: std::path::PathBuf,
}

/// 建一套真的解了锁的库 + 一条 http 台账，并在回环上起好通道服务。
fn setup() -> Harness {
    let key = vec![61u8; 32];
    let db = Db::open_in_memory(&key).unwrap();
    let (uid, vk) = users::initialize(&db, "owner", PASS).unwrap();
    let target = repo::create_target(
        &db,
        &vk,
        &uid,
        &repo::NewTarget {
            target_type: "web".into(),
            display_name: "内网生产监控".into(),
            group_id: None,
            meta: repo::TargetSecretPayload {
                url: format!("{HTTP_ORIGIN}/login"),
                allowed_origin: HTTP_ORIGIN.into(),
                host: "10.0.0.8".into(),
                port: "8080".into(),
                protocol: "http".into(),
                ..Default::default()
            },
        },
    )
    .unwrap();
    let item_id = repo::create_item(
        &db,
        &vk,
        &uid,
        &repo::NewItem {
            target_id: target.clone(),
            account_alias: "运维".into(),
            tags: vec![],
            favorite: false,
            payload: repo::CredentialPayload {
                username: USER.into(),
                password: SecretString::new(SECRET),
                ..Default::default()
            },
            set_as_default: true,
        },
    )
    .unwrap();

    let dir = std::env::temp_dir().join(format!("mda-fill-http-{}-{}", std::process::id(), uuid()));
    std::fs::create_dir_all(&dir).unwrap();
    let core = Arc::new(AppCore::new(db, SecretBytes::new(key), dir.clone()));
    core.vault.unlock(
        Session { id: "sess-http".into(), user_id: uid.clone(), started_at: 0, last_activity: 0, reauth_at: None },
        Arc::new(vk),
        SearchIndex::new(vec![]),
    );
    // 通道服务起来才算真的把宿主那侧的入口准备好：它写 host-channel.json 并监听随机端口。
    ipc::start(core.clone()).unwrap();
    Harness { core, item_id, uid, dir }
}

fn uuid() -> String {
    let b = mon_dian_assistant_lib::crypto::random_bytes(6);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 完全按宿主的做派发一条请求：单行 JSON + 令牌，读完一行就断开。
fn call(port: u16, token: &str, payload: serde_json::Value) -> serde_json::Value {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    let mut req = payload;
    req["token"] = serde_json::Value::String(token.to_string());
    let mut line = req.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).unwrap();
    stream.flush().unwrap();
    let mut resp = String::new();
    BufReader::new(stream).read_line(&mut resp).unwrap();
    serde_json::from_str(resp.trim()).unwrap()
}

fn channel(h: &Harness) -> (u16, String) {
    let text = std::fs::read_to_string(ipc::channel_file(&h.dir)).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    (v["port"].as_u64().unwrap() as u16, v["token"].as_str().unwrap().to_string())
}

#[test]
fn http_origin_completes_challenge_and_fill_over_the_real_channel() {
    let h = setup();
    let (port, token) = channel(&h);

    // 宿主连进来即证明链路存在，安全页的"就绪"就是这么置起来的
    assert!(!h.core.extension_ready());
    call(port, &token, serde_json::json!({ "type": "hello" }));
    assert!(h.core.extension_ready(), "hello 之后必须报就绪");

    let (ticket, binding) = issue_fill_ticket(&h.core.db, &h.core.tickets, &h.core.vault, &h.uid, &h.item_id).unwrap();

    let challenge = call(port, &token, serde_json::json!({ "type": "challenge", "origin": HTTP_ORIGIN }));
    assert_eq!(challenge["ok"], serde_json::json!(true), "http 台账应拿到挑战：{challenge}");
    assert_eq!(challenge["grant"]["ticketId"], serde_json::json!(ticket.id));
    assert_eq!(challenge["grant"]["origin"], serde_json::json!(HTTP_ORIGIN));

    let fill = call(
        port,
        &token,
        serde_json::json!({
            "type": "fill",
            "request": {
                "ticketId": ticket.id,
                "ticketSecret": ticket.secret.to_string(),
                "targetId": binding.target_id,
                "credentialId": binding.credential_id,
                "origin": HTTP_ORIGIN,
            },
        }),
    );
    assert_eq!(fill["ok"], serde_json::json!(true), "凭票据应换回凭据：{fill}");
    assert_eq!(fill["username"], serde_json::json!(USER));
    assert_eq!(fill["password"], serde_json::json!(SECRET));
    assert_eq!(fill["submit"], serde_json::json!(false), "绝不自动提交表单");

    ipc::remove_channel_file(&h.dir);
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// 放开的只有协议前缀：Origin 仍然逐字比对，换协议、换主机、换端口都拿不到票据。
///
/// 两栏拒法要分清，因为界面与审计上是两条不同的原因：
/// - `ORIGIN_NOT_ALLOWED`：这台站点的 Origin 压根不在台账里（格式或逐字比对没过）；
/// - `NO_PENDING_GRANT`：格式过了、台账里也认得这个串，但**没有一张票绑的是它**。
///   把台账 Origin 后面接上路径就是这一档——`origin_allowed` 里 `m.url == origin`
///   那半句恰好认这个串（它是 `url` 栏的原文），而票绑的是 `allowed_origin` 栏。
///   所以精确 Origin 栏为空、只有带路径 url 的台账（导入来的常见形状），
///   扩展永远停在 `NO_PENDING_GRANT` 上静默不填充。
#[test]
fn http_relaxation_still_requires_the_exact_ledger_origin() {
    let h = setup();
    let (port, token) = channel(&h);
    call(port, &token, serde_json::json!({ "type": "hello" }));
    issue_fill_ticket(&h.core.db, &h.core.tickets, &h.core.vault, &h.uid, &h.item_id).unwrap();

    for (label, origin, code) in [
        ("同一主机换成 https", "https://10.0.0.8:8080", "ORIGIN_NOT_ALLOWED"),
        ("同协议换主机", "http://10.0.0.9:8080", "ORIGIN_NOT_ALLOWED"),
        ("同主机换端口", "http://10.0.0.8:9090", "ORIGIN_NOT_ALLOWED"),
        ("非 http 协议", "file:///etc/passwd", "ORIGIN_NOT_ALLOWED"),
        ("把台账 Origin 后面接上路径", "http://10.0.0.8:8080/login", "NO_PENDING_GRANT"),
    ] {
        let r = call(port, &token, serde_json::json!({ "type": "challenge", "origin": origin }));
        assert_eq!(r["ok"], serde_json::json!(false), "{label} 不许拿到挑战：{r}");
        assert_eq!(r["error"], serde_json::json!(code), "{label} 的拒因应当如实：{r}");
    }

    // 反面同屏：一字不差的精确 Origin 才是唯一能拿到挑战的那一个
    let ok = call(port, &token, serde_json::json!({ "type": "challenge", "origin": HTTP_ORIGIN }));
    assert_eq!(ok["ok"], serde_json::json!(true), "精确 Origin 应拿到挑战：{ok}");

    ipc::remove_channel_file(&h.dir);
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// 票据一次性这条也没有因为放开 http 而松动：同一张票第二次出示必被拒。
#[test]
fn http_ticket_is_consumed_once() {
    let h = setup();
    let (port, token) = channel(&h);
    call(port, &token, serde_json::json!({ "type": "hello" }));
    let (ticket, binding) = issue_fill_ticket(&h.core.db, &h.core.tickets, &h.core.vault, &h.uid, &h.item_id).unwrap();
    call(port, &token, serde_json::json!({ "type": "challenge", "origin": HTTP_ORIGIN }));

    let req = serde_json::json!({
        "type": "fill",
        "request": {
            "ticketId": ticket.id,
            "ticketSecret": ticket.secret.to_string(),
            "targetId": binding.target_id,
            "credentialId": binding.credential_id,
            "origin": HTTP_ORIGIN,
        },
    });
    assert_eq!(call(port, &token, req.clone())["ok"], serde_json::json!(true));
    let replay = call(port, &token, req);
    assert_eq!(replay["error"], serde_json::json!("TICKET_INVALID"), "重放必须被拒：{replay}");
    // 第二次消费不许再把口令吐出来
    assert!(replay.get("password").is_none(), "被拒的响应里不许带口令");

    ipc::remove_channel_file(&h.dir);
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// 令牌不对的请求在读完那一行就被挡掉，与协议无关。
#[test]
fn wrong_token_gets_nothing() {
    let h = setup();
    let (port, _) = channel(&h);
    call(port, "not-the-channel-token", serde_json::json!({ "type": "challenge", "origin": HTTP_ORIGIN }));
    let r = call(port, "not-the-channel-token", serde_json::json!({ "type": "hello" }));
    assert_eq!(r["error"], serde_json::json!("FORBIDDEN"));
    assert!(!h.core.extension_ready(), "没出示对令牌，不许把链路置成就绪");

    ipc::remove_channel_file(&h.dir);
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// 锁定会话后，即便令牌还有效也一律不下发：这条与 http 放开同屏，改动不许把它碰坏。
#[test]
fn locked_session_refuses_even_an_http_origin() {
    let h = setup();
    let (port, token) = channel(&h);
    h.core.vault.lock();
    let r = call(port, &token, serde_json::json!({ "type": "challenge", "origin": HTTP_ORIGIN }));
    assert_eq!(r["error"], serde_json::json!("SESSION_LOCKED"));

    ipc::remove_channel_file(&h.dir);
    let _ = std::fs::remove_dir_all(&h.dir);
}

/// `FillRequest` 是跨进程契约的一半（另一半在 extension/background.js 的转发字段）。
#[test]
fn fill_request_accepts_the_exact_fields_the_extension_forwards() {
    let v = serde_json::json!({
        "ticketId": "t", "ticketSecret": "s", "targetId": "g", "credentialId": "c", "origin": HTTP_ORIGIN,
    });
    let r: FillRequest = serde_json::from_value(v).unwrap();
    assert_eq!(r.credential_id, "c");
    assert_eq!(r.origin, HTTP_ORIGIN);
    // 少任何一枚都不许被当成合法请求
    let missing = serde_json::json!({ "ticketId": "t", "ticketSecret": "s", "targetId": "g", "origin": HTTP_ORIGIN });
    assert!(serde_json::from_value::<FillRequest>(missing).is_err());
}

/// 解了锁但没建任何通道时，`VaultState` 不该凭空有会话号——票据签发要绑会话，这条守住前置。
#[test]
fn ticket_needs_a_live_session() {
    let key = vec![62u8; 32];
    let db = Db::open_in_memory(&key).unwrap();
    let (uid, vk) = users::initialize(&db, "owner", PASS).unwrap();
    let state = VaultState::default();
    assert!(state.session_id().is_none());
    state.unlock(
        Session { id: "s".into(), user_id: uid.clone(), started_at: 0, last_activity: 0, reauth_at: None },
        Arc::new(vk),
        SearchIndex::new(vec![]),
    );
    assert_eq!(state.session_id().as_deref(), Some("s"));
}
