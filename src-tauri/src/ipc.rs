//! 桌面应用 ↔ Native Messaging 宿主之间的本机通道。
//!
//! 设计：宿主是浏览器拉起的独立进程，无法直接读应用内存，因此应用在本机回环地址
//! 上监听一个随机端口，并把 `端口 + 一次性通道令牌` 写入 0600 权限的文件；
//! 宿主必须出示令牌才被服务。所有请求/响应都是单行 JSON。
//!
//! 边界与限制（如实说明）：
//! - 通道只绑定 127.0.0.1，不出机器；但同机其他进程若能读取令牌文件即可伪造请求，
//!   因此文件权限 0600，且令牌随应用重启更换。
//! - 页面 Origin 由扩展提供，桌面端把它与票据绑定的精确 Origin 严格比对；
//!   Origin 不符直接拒绝，绝不下发凭据。
//! - 凭据只在一次请求内返回，不缓存到扩展侧。

use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::AtomicUsize;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use crate::commands::launcher::{complete_fill, challenge_for_origin, FillRequest};
use crate::error::{AppError, Result};
use crate::state::AppCore;

pub fn channel_file(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("host-channel.json")
}

/// 启动本机通道服务；返回可供宿主读取的令牌文件路径。
pub fn start(core: std::sync::Arc<AppCore>) -> Result<PathBuf> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| AppError::internal("本机填充通道", &e))?;
    let port = listener.local_addr().map_err(|e| AppError::internal("本机填充通道", &e))?.port();
    let token = crate::crypto::b64_encode(&crate::crypto::random_bytes(32));
    let file = channel_file(&core.data_dir);
    let body = serde_json::json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "startedAt": chrono::Utc::now().timestamp(),
        "protocol": "mda-fill/1",
    });
    let json = body.to_string();
    crate::secfile::write_private(&file, json.as_bytes())?;
    // 审查 F11：原先每来一条连接就裸 spawn 线程，且在比对令牌之前 `read_line` 没有长度上限——
    // 同一台机器上的任意进程（还不需要令牌）就能用海量连接或一条超长行把应用拖垮。
    // 信任边界确实是"同用户进程"，但这条通道里流的是凭据，所以按"未认证也要有界"处理。
    let live = std::sync::Arc::new(AtomicUsize::new(0));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => {
                    if live.load(Ordering::Relaxed) >= MAX_CONCURRENT_CONNECTIONS {
                        // 超限直接断开：不排队、不起线程，也不回任何业务信息
                        drop(s);
                        continue;
                    }
                    live.fetch_add(1, Ordering::Relaxed);
                    let c = core.clone();
                    let t = token.clone();
                    let guard = ConnectionGuard { live: live.clone() };
                    std::thread::spawn(move || {
                        let _ = handle(s, c, &t);
                        drop(guard);
                    });
                }
                Err(_) => break,
            }
        }
    });
    Ok(file)
}

/// 未认证连接也有界：单行 JSON 请求的上限。超过就断开，绝不等读完。
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// 同时处理的连接数上限：本机通道只有一个宿主会用，留足余量即可。
const MAX_CONCURRENT_CONNECTIONS: usize = 8;

/// 计数守卫：线程无论正常返回还是 panic，都把在跑的连接数减回去。
struct ConnectionGuard {
    live: std::sync::Arc<AtomicUsize>,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::Relaxed);
    }
}

fn handle(mut stream: TcpStream, core: std::sync::Arc<AppCore>, token: &str) -> Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();
    let line = {
        let mut r = BufReader::new(stream.try_clone().map_err(|e| AppError::internal("本机填充通道", &e))?);
        let mut buf = String::new();
        // take() 就是"这一行最多读这么多"：没有上限时，未鉴权的对端可以用一条无限长的行先把内存
        // 吃掉——令牌根本还没比对过。读满上限还没换行的请求，下面按非法 JSON 直接拒。
        std::io::Read::take(&mut r, MAX_REQUEST_BYTES)
            .read_line(&mut buf)
            .map_err(|e| AppError::internal("本机填充通道", &e))?;
        buf
    };
    let req: serde_json::Value = serde_json::from_str(line.trim()).map_err(|_| AppError::InvalidInput)?;
    let presented = req.get("token").and_then(|v| v.as_str()).unwrap_or("");
    // 常量时间比较令牌
    if presented.len() != token.len() || !constant_time_eq::constant_time_eq(presented.as_bytes(), token.as_bytes()) {
        return respond(&mut stream, serde_json::json!({ "ok": false, "error": "FORBIDDEN" }));
    }
    // 令牌校验通过即证明宿主+扩展这一链路存在，与解锁状态无关；
    // extension_ready 只影响 UI 是否列出「打开并填充」入口，锁定会话下依旧无法签发票据。
    core.set_extension_ready(true);
    // 会话必须处于解锁状态：锁定后不得下发任何凭据
    if !core.vault.is_unlocked() {
        return respond(&mut stream, serde_json::json!({ "ok": false, "error": "SESSION_LOCKED" }));
    }
    let kind = req.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "hello" => {
            core.extension_ready.store(true, Ordering::Relaxed);
            let _ = crate::audit::record(&core.db, core.vault.active_user().as_deref(), "extension.hello", Some("channel"), None, "success", None, Some("extension"));
            respond(
                &mut stream,
                serde_json::json!({
                    "ok": true,
                    "protocol": "mda-fill/1",
                    "unlocked": true,
                    "confirmBeforeFillDefault": true,
                }),
            )
        }
        "challenge" => {
            let origin = req.get("origin").and_then(|v| v.as_str()).unwrap_or("");
            let allowed = origin_allowed(&core, origin);
            if !allowed {
                let _ = crate::audit::record(&core.db, core.vault.active_user().as_deref(), "extension.challenge.denied", Some("origin"), Some(origin), "denied", Some("ORIGIN_NOT_ALLOWED"), Some("extension"));
                return respond(&mut stream, serde_json::json!({ "ok": false, "error": "ORIGIN_NOT_ALLOWED" }));
            }
            match challenge_for_origin(&core, origin) {
                Some(g) => respond(&mut stream, serde_json::json!({ "ok": true, "grant": g })),
                None => respond(&mut stream, serde_json::json!({ "ok": false, "error": "NO_PENDING_GRANT" })),
            }
        }
        "fill" => {
            let fr: FillRequest = serde_json::from_value(req.get("request").cloned().unwrap_or(serde_json::Value::Null)).map_err(|_| AppError::InvalidInput)?;
            match complete_fill(&core, &fr) {
                Some((username, password)) => respond(
                    &mut stream,
                    serde_json::json!({ "ok": true, "username": username, "password": password, "autofill": true, "submit": false }),
                ),
                None => {
                    let _ = crate::audit::record(&core.db, core.vault.active_user().as_deref(), "extension.fill.denied", Some("item"), Some(&fr.credential_id), "denied", Some("TICKET_INVALID"), Some("extension"));
                    respond(&mut stream, serde_json::json!({ "ok": false, "error": "TICKET_INVALID" }))
                }
            }
        }
        _ => respond(&mut stream, serde_json::json!({ "ok": false, "error": "INVALID_REQUEST" })),
    }
}

/// Origin 允许清单：只能是台账中明确绑定过的精确 Origin。
/// http 与 https 都放行（内网台账确有明文 http 系统）；放开的只是协议前缀这一道格式判定，
/// 逐字比对与票据一次性这两条没有松动。
fn origin_allowed(core: &AppCore, origin: &str) -> bool {
    if !origin.starts_with("https://") && !origin.starts_with("http://") {
        return false;
    }
    let Ok(targets) = crate::db::repo::list_targets(&core.db) else {
        return false;
    };
    targets.iter().any(|t| {
        core.vault
            .with_vk(|vk| crate::db::repo::target_meta(vk, &core.db, &t.id).map(|m| m.allowed_origin == origin || m.url == origin))
            .unwrap_or(false)
    })
}

fn respond(stream: &mut TcpStream, value: serde_json::Value) -> Result<()> {
    let mut s = stream.try_clone().map_err(|e| AppError::internal("本机填充通道", &e))?;
    let mut line = value.to_string();
    line.push('\n');
    s.write_all(line.as_bytes()).map_err(|e| AppError::internal("本机填充通道", &e))?;
    s.flush().map_err(|e| AppError::internal("本机填充通道", &e))?;
    Ok(())
}

/// 应用退出/锁定时清理通道文件，避免陈旧端口与令牌残留。
pub fn remove_channel_file(data_dir: &std::path::Path) {
    let _ = std::fs::remove_file(channel_file(data_dir));
}
