//! 页面库的回环供页服务：只有一条 GET，内容按请求现场解密。
//!
//! 为什么不让主窗直接 `srcDoc`：预览要能跑脚本、能加载 CDN，就不能和主窗同一个来源，
//! 否则页面里的脚本与主窗处在同一个执行环境里。所以两个消费端（右栏嵌入块、运行脚本窗口）
//! 都从这条回环地址取内容——对 Tauri 是 remote origin，拿不到本应用任何命令。
//! 服务本身给最小的一种：绑 127.0.0.1 的随机端口 + 进程内随机令牌，正文原样输出。
//!
//! 每次请求都重新鉴权（`peek_session` 不续期 + `html.page.read`）：令牌只是"别让同机随便一个
//! 网页猜到地址"，不是权限。锁库后同一个地址会变成 401，两个消费端也会被 `AppCore::lock_down` 关掉。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use constant_time_eq::constant_time_eq;

use crate::error::{AppError, Result};
use crate::html_pages::store;
use crate::rbac::{self, perm};
use crate::state::SharedCore;

const MAX_CONNECTIONS: usize = 2;
const MAX_REQUEST_LINE: u64 = 4 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 预览页自己的 CSP：脚本、样式、图、字体、媒体都放开到 https（用户要求允许 CDN），
/// 但表单提交、嵌套框架里的自我导航与 `base` 改写一律关掉——这页的职责是"看"，不是"交出去"。
pub const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; \
style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; \
media-src https: data: blob:; connect-src https:; frame-src https:; worker-src blob:; \
form-action 'none'; base-uri 'none'; object-src 'none'";

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Content(String),
    BadRequest,
    MethodNotAllowed,
    NotFound,
}

/// 只认 `GET /s/<令牌>/<页面 id>`。令牌比对失败一律 404：不确认路径存在，也不给暴力试探留信号。
pub fn route(line: &str, token: &str) -> Route {
    let line = line.trim_end_matches(['\r', '\n']);
    let mut parts = line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Route::BadRequest;
    };
    if method != "GET" {
        return Route::MethodNotAllowed;
    }
    if !target.starts_with('/') || target.contains("..") || target.contains('\\') {
        return Route::BadRequest;
    }
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() != 4 || segments[0] != "" || segments[1] != "s" {
        return Route::NotFound;
    }
    if !constant_time_eq(segments[2].as_bytes(), token.as_bytes()) {
        return Route::NotFound;
    }
    let id = segments[3];
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Route::BadRequest;
    }
    Route::Content(id.to_string())
}

/// 响应头。`Content-Length` 必须给：浏览器的加载进度与断流判定都靠它。
pub fn head(status: &str, content_type: &str, len: usize) -> String {
    let mut s = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
    );
    if content_type.starts_with("text/html") {
        s.push_str(&format!("Content-Security-Policy: {PREVIEW_CSP}\r\n"));
    }
    s.push_str("Connection: close\r\n\r\n");
    s
}

pub fn start(core: SharedCore) -> Result<()> {
    if super::server_started() {
        return Ok(());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| {
        log::warn!("页面预览服务绑定 127.0.0.1 失败：{e}");
        AppError::PreviewUnavailable
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| {
            log::warn!("页面预览服务读取本地端口失败：{e}");
            AppError::PreviewUnavailable
        })?
        .port();
    let token: String = crate::crypto::random_bytes(32)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !super::remember(port, token.clone()) {
        return Ok(());
    }
    log::info!("页面预览服务已就绪：127.0.0.1:{port}");
    // 与 `ipc::start` 一样常驻到进程结束：没有"中途停掉预览"这个状态，
    // 锁定态由每个请求的 401 表达，端口不必跟着关。
    std::thread::spawn(move || serve_loop(listener, core, token));
    Ok(())
}

struct ServeState {
    core: SharedCore,
    token: String,
}

/// 非阻塞 accept + 100ms 轮询：没有停止开关，靠进程退出收尾（与 `ipc.rs` 同档）。
fn serve_loop(listener: TcpListener, core: SharedCore, token: String) {
    let state = Arc::new(ServeState { core, token });
    let active = Arc::new(AtomicUsize::new(0));
    let _ = listener.set_nonblocking(true);
    loop {
        match listener.accept() {
            Ok((stream, peer)) => {
                // 只绑了回环，对端理论上就是本机；拦住非回环地址是防监听配置被改坏。
                if !peer.ip().is_loopback() {
                    drop(stream);
                    continue;
                }
                if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    drop(stream);
                    continue;
                }
                let st = state.clone();
                let counter = active.clone();
                std::thread::spawn(move || {
                    let _ = handle(stream, &st);
                    counter.fetch_sub(1, Ordering::AcqRel);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
}

fn handle(mut stream: TcpStream, state: &ServeState) -> std::io::Result<()> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;

    let mut line = String::new();
    {
        let mut reader = BufReader::new((&stream).take(MAX_REQUEST_LINE));
        reader.read_line(&mut line)?;
    }
    if line.is_empty() {
        return Ok(());
    }

    let (status, body) = match route(&line, &state.token) {
        Route::BadRequest => ("400 Bad Request", "请求不合法。".to_string()),
        Route::MethodNotAllowed => ("405 Method Not Allowed", "只接受 GET。".to_string()),
        Route::NotFound => ("404 Not Found", "没有这个页面。".to_string()),
        Route::Content(id) => match resolve(&state.core, &id) {
            Ok(html) => {
                let head = head("200 OK", "text/html; charset=utf-8", html.len());
                stream.write_all(head.as_bytes())?;
                stream.write_all(html.as_bytes())?;
                return stream.flush();
            }
            Err(e) => match e {
                AppError::Locked | AppError::SessionExpired => {
                    ("401 Unauthorized", "保险库已锁定：请回到主窗口解锁后再预览。".to_string())
                }
                AppError::Forbidden => ("403 Forbidden", "当前使用者无权查看这个页面。".to_string()),
                _ => ("404 Not Found", "没有这个页面。".to_string()),
            },
        },
    };

    let head = head(status, "text/plain; charset=utf-8", body.len());
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn resolve(core: &SharedCore, id: &str) -> Result<String> {
    // peek_session 只判不续期：预览页反复刷新不能把空闲计时一直往后推。
    let user = core.peek_session()?;
    rbac::require(&core.db, &user, perm::HTML_PAGE_READ)?;
    store::content(&core.db, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "abc123";

    #[test]
    fn routes_the_only_shape_we_serve() {
        let id = "0192f0aa-1111-7abc-8def-0123456789ab";
        assert_eq!(
            route(&format!("GET /s/{T}/{id} HTTP/1.1\r\n"), T),
            Route::Content(id.to_string())
        );
        // 查询串只是为了强制刷新（`?v=…`），不参与路由
        assert_eq!(
            route(&format!("GET /s/{T}/{id}?v=2 HTTP/1.1\r\n"), T),
            Route::Content(id.to_string())
        );
    }

    #[test]
    fn rejects_wrong_method_scheme_and_traversal() {
        assert_eq!(route(&format!("POST /s/{T}/x HTTP/1.1"), T), Route::MethodNotAllowed);
        assert_eq!(route(&format!("GET http://127.0.0.1/s/{T}/x"), T), Route::BadRequest);
        assert_eq!(route(&format!("GET /s/{T}/../../vault.db"), T), Route::BadRequest);
        assert_eq!(route(&format!("GET /s/{T}/a\\b"), T), Route::BadRequest);
        assert_eq!(route("garbage", T), Route::BadRequest);
    }

    #[test]
    fn bad_token_is_indistinguishable_from_missing_page() {
        assert_eq!(route("GET /s/wrong/x HTTP/1.1", T), Route::NotFound);
        assert_eq!(route("GET /s/x HTTP/1.1", T), Route::NotFound);
        assert_eq!(route("GET /other/x HTTP/1.1", T), Route::NotFound);
        // 令牌对了，但 id 不是 uuid 的形状 → 仍然是「参数不合法」，不落到查库
        assert_eq!(route(&format!("GET /s/{T}/../x HTTP/1.1"), T), Route::BadRequest);
        assert_eq!(route(&format!("GET /s/{T}/{} HTTP/1.1", "a".repeat(65)), T), Route::BadRequest);
    }

    #[test]
    fn html_head_carries_its_own_csp_and_never_caches() {
        let h = head("200 OK", "text/html; charset=utf-8", 7);
        assert!(h.contains("Content-Length: 7"));
        assert!(h.contains("Cache-Control: no-store"));
        assert!(h.contains("X-Content-Type-Options: nosniff"));
        assert!(h.contains("Referrer-Policy: no-referrer"));
        assert!(h.contains(&format!("Content-Security-Policy: {PREVIEW_CSP}")));
        assert!(PREVIEW_CSP.contains("script-src 'unsafe-inline' 'unsafe-eval' https:"), "脚本与 CDN 是这一页存在的前提");
        assert!(PREVIEW_CSP.contains("form-action 'none'"), "表单提交不放开");

        // 纯文本错误页不带 CSP：它没有可执行内容，多一条头只会误导排障
        let p = head("404 Not Found", "text/plain; charset=utf-8", 3);
        assert!(!p.contains("Content-Security-Policy"));
    }
}
