//! Native Messaging 宿主（独立可执行文件，由浏览器按扩展清单拉起）。
//!
//! 协议（stdin/stdout，长度前缀 JSON，Chrome Native Messaging 规范）：
//! 请求 `{"type":"hello"|"challenge"|"fill","origin":"https://oa.example.cn","request":{...}}`
//! 响应 `{"ok":true,...}` 或 `{"ok":false,"error":"CODE"}`
//!
//! 宿主自身不持有任何密钥、不缓存凭据：它读取本机通道文件里的 端口+令牌，
//! 用回环 TCP 把请求转发给正在运行的桌面应用，并把应用返回的一次结果原样交给扩展。
//! 若应用未运行 / 已锁定，返回明确错误，绝不静默失败或返回旧凭据。

use std::io::{BufRead, Read, Write};

fn read_exact_u32<R: Read>(r: &mut R) -> Option<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).ok()?;
    let len = u32::from_ne_bytes(len_buf) as usize;
    if len > 1_048_576 {
        return None;
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn write_frame<W: Write>(w: &mut W, bytes: &[u8]) -> std::io::Result<()> {
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}

fn channel_dir() -> Option<std::path::PathBuf> {
    // 与桌面应用的数据目录一致：环境变量优先，其次平台默认目录
    if let Ok(d) = std::env::var("MDA_DATA_DIR") {
        return Some(std::path::PathBuf::from(d));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        return Some(std::path::PathBuf::from(home).join("Library/Application Support/com.mda.assistant"));
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        return Some(std::path::PathBuf::from(appdata).join("com.mda.assistant"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = std::env::var("XDG_DATA_HOME").ok().unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{home}/.local/share")
        });
        return Some(std::path::PathBuf::from(data).join("com.mda.assistant"));
    }
}

fn forward(payload: &serde_json::Value) -> serde_json::Value {
    let dir = match channel_dir() {
        Some(d) => d,
        None => return serde_json::json!({ "ok": false, "error": "CHANNEL_MISSING" }),
    };
    let file = dir.join("host-channel.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) => return serde_json::json!({ "ok": false, "error": "APP_NOT_RUNNING" }),
    };
    let info: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return serde_json::json!({ "ok": false, "error": "CHANNEL_CORRUPT" }),
    };
    let port = info.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
    let token = info.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if port == 0 || token.is_empty() {
        return serde_json::json!({ "ok": false, "error": "CHANNEL_CORRUPT" });
    }
    let addr = format!("127.0.0.1:{port}");
    let mut stream = match std::net::TcpStream::connect(&addr) {
        Ok(s) => s,
        Err(_) => return serde_json::json!({ "ok": false, "error": "APP_NOT_RUNNING" }),
    };
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(8)))
        .ok();
    let mut req = payload.clone();
    req["token"] = serde_json::Value::String(token);
    let mut line = req.to_string();
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return serde_json::json!({ "ok": false, "error": "APP_WRITE_FAILED" });
    }
    // 单次请求 → 单行响应；读完立即断开，不保持任何会话状态
    let mut resp_line = String::new();
    let mut reader = std::io::BufReader::new(stream);
    match reader.read_line(&mut resp_line) {
        Ok(0) | Err(_) => return serde_json::json!({ "ok": false, "error": "APP_READ_FAILED" }),
        Ok(_) => {}
    }
    match serde_json::from_str(resp_line.trim()) {
        Ok(v) => v,
        Err(_) => serde_json::json!({ "ok": false, "error": "APP_BAD_RESPONSE" }),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    while let Some(raw) = read_exact_u32(&mut stdin) {
        let req: serde_json::Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(_) => {
                let _ = write_frame(&mut stdout, br#"{"ok":false,"error":"INVALID_REQUEST"}"#);
                continue;
            }
        };
        let resp = forward(&req);
        let _ = write_frame(&mut stdout, resp.to_string().as_bytes());
    }
}
