//! 源端极简 HTTP/1.1：三个 GET、无请求体、`Connection: close`。
//!
//! 不引 axum：这里要解析的只有一行请求行，与 `ipc.rs` 手写行式协议同一量级，
//! 引入异步运行时的成本远大于收益。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::lan::store::{is_sha256_hex, Share};

pub const DEFAULT_PORT: u16 = 8765;
const MAX_CONNECTIONS: usize = 4;
const MAX_REQUEST_LINE: u64 = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Health,
    Manifest,
    Package(String),
    BadRequest,
    MethodNotAllowed,
    NotFound,
}

/// 只做同源路径路由：拒绝绝对形式（`http://host/path`）与任何含 `..`/`\` 的目标。
pub fn parse_request_line(line: &str) -> Route {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() as u64 > MAX_REQUEST_LINE {
        return Route::BadRequest;
    }
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
    match path {
        "/health" => Route::Health,
        "/manifest" => Route::Manifest,
        _ => match path.strip_prefix("/package/") {
            Some(sha) if is_sha256_hex(sha) => Route::Package(sha.to_string()),
            Some(_) => Route::BadRequest,
            None => Route::NotFound,
        },
    }
}

pub struct ServeState {
    pub instance: String,
    pub share: Share,
}

/// 响应头。`Content-Length` 必须给：客户端据此算进度百分比。
pub fn response_head(status: &str, content_type: &str, len: u64) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    )
}

/// 非阻塞 accept + 100ms 轮询，停止只需置位 `stop`，不需要 shutdown hack。
pub fn serve_loop(listener: TcpListener, state: Arc<ServeState>, stop: Arc<AtomicBool>) {
    let active = Arc::new(AtomicUsize::new(0));
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, peer)) => {
                // 绑定在 0.0.0.0：机器上每块网卡都可达，包括公网与 VPN 网卡。
                // 对端必须是私网地址，否则直接断开。
                if !crate::lan::net::is_private_or_local(peer.ip()) {
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

    match parse_request_line(&line) {
        Route::Health => {
            let body = serde_json::json!({
                "instance": state.instance,
                "version": state.share.manifest.version,
            })
            .to_string();
            write_body(&mut stream, "200 OK", "application/json", body.as_bytes())
        }
        Route::Manifest => write_body(&mut stream, "200 OK", "application/json", &state.share.manifest_bytes),
        Route::Package(sha) => match state.share.package_path(&sha) {
            Some(path) => write_file(&mut stream, path),
            None => write_body(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"package not found"),
        },
        Route::BadRequest => write_body(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", b"bad request"),
        Route::MethodNotAllowed => {
            write_body(&mut stream, "405 Method Not Allowed", "text/plain; charset=utf-8", b"method not allowed")
        }
        Route::NotFound => write_body(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"not found"),
    }
}

fn write_body(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    stream.write_all(response_head(status, content_type, body.len() as u64).as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// 包体可能几百 MB，不读进内存：先回头部，再 copy。
fn write_file(stream: &mut TcpStream, path: &Path) -> std::io::Result<()> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return write_body(stream, "404 Not Found", "text/plain; charset=utf-8", b"package missing");
        }
    };
    let len = file.metadata()?.len();
    stream.write_all(response_head("200 OK", "application/octet-stream", len).as_bytes())?;
    std::io::copy(&mut file, stream)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn routes_are_parsed_strictly() {
        assert_eq!(parse_request_line("GET /health HTTP/1.1\r\n"), Route::Health);
        assert_eq!(parse_request_line("GET /manifest HTTP/1.1\r\n"), Route::Manifest);
        assert_eq!(
            parse_request_line(&format!("GET /package/{} HTTP/1.1\r\n", "a".repeat(64))),
            Route::Package("a".repeat(64))
        );
        // 查询串不影响路由
        assert_eq!(parse_request_line("GET /manifest?v=1 HTTP/1.1\r\n"), Route::Manifest);
    }

    #[test]
    fn traversal_and_absolute_targets_are_rejected() {
        for bad in [
            "GET /package/../../etc/passwd HTTP/1.1\r\n",
            "GET /../manifest HTTP/1.1\r\n",
            "GET /package\\..\\x HTTP/1.1\r\n",
            "GET http://evil.example/manifest HTTP/1.1\r\n",
            "GET manifest HTTP/1.1\r\n",
            "GET\r\n",
            "",
        ] {
            assert_eq!(parse_request_line(bad), Route::BadRequest, "{bad:?} 应判为坏请求");
        }
    }

    #[test]
    fn non_get_and_unknown_paths() {
        assert_eq!(parse_request_line("POST /manifest HTTP/1.1\r\n"), Route::MethodNotAllowed);
        assert_eq!(parse_request_line("GET /nope HTTP/1.1\r\n"), Route::NotFound);
        assert_eq!(parse_request_line("GET /package/xyz HTTP/1.1\r\n"), Route::BadRequest);
        // 大写 hex 不认：路由表以小写作键
        assert_eq!(
            parse_request_line(&format!("GET /package/{} HTTP/1.1\r\n", "A".repeat(64))),
            Route::BadRequest
        );
    }

    #[test]
    fn response_head_always_carries_length() {
        let head = response_head("200 OK", "application/json", 42);
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(head.contains("Content-Length: 42\r\n"));
        assert!(head.contains("Connection: close\r\n"));
        assert!(head.ends_with("\r\n\r\n"));
    }

    fn request(port: u16, req: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", port)).expect("应能连上测试服务");
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        c.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        out
    }

    /// 真 Socket 往返：验证 accept → 解析 → 响应这条链路，不只测纯函数。
    #[test]
    fn serves_health_manifest_and_rejects_bad_requests() {
        let state = Arc::new(ServeState {
            instance: "i-1".into(),
            share: Share::for_test(br#"{"version":"0.2.0"}"#.to_vec()),
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let st = state.clone();
        let sp = stop.clone();
        let handle = std::thread::spawn(move || serve_loop(listener, st, sp));

        let health = request(port, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(health.starts_with("HTTP/1.1 200"), "{health}");
        assert!(health.contains("\"instance\":\"i-1\""), "{health}");
        assert!(health.contains("\"version\":\"0.2.0\""), "{health}");

        let manifest = request(port, "GET /manifest HTTP/1.1\r\n\r\n");
        assert!(manifest.starts_with("HTTP/1.1 200"));
        assert!(manifest.ends_with(r#"{"version":"0.2.0"}"#), "清单必须原样下发：{manifest}");

        let traversal = request(port, "GET /package/../../etc/passwd HTTP/1.1\r\n\r\n");
        assert!(traversal.starts_with("HTTP/1.1 400"), "{traversal}");

        let unknown = request(port, &format!("GET /package/{} HTTP/1.1\r\n\r\n", "f".repeat(64)));
        assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");

        stop.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }
}
