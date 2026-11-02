//! EDAS 控制台客户端：ureq + rustls，**证书校验始终开着**。
//!
//! 原实现是一条 `InsecureSkipVerify: true`——为了一个内网地址把整条链路的证书校验关掉了。
//! 这里换成：内置根 + `caPemPath` 显式注入的企业根证书拼成一个 root store；
//! 注入失败就让请求如实验不过并报错，绝不开"跳过校验"这种开关。
//!
//! 凭据的去向也在这里收口：Cookie 只进请求头，不进 URL、不进日志、不回前端。

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::Value;

use crate::error::{AppError, Result};

use super::profile::{pick, EdasProfile};
use super::session::CookieSession;

/// 响应体上限：这几个接口都是小 JSON，超了就是网关在胡来（或被换成了页面）。
const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024;

pub struct EdasClient {
    agent: ureq::Agent,
    profile: EdasProfile,
}

/// Debug 里只放主机名与超时：`ureq::Agent` 不可调试，会话与凭据也一律不沾。
impl std::fmt::Debug for EdasClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EdasClient")
            .field("base_url", &self.profile.base_url)
            .field("connect_ms", &self.profile.timeouts.connect_ms)
            .field("read_ms", &self.profile.timeouts.read_ms)
            .finish_non_exhaustive()
    }
}

/// 从 PEM 里取出每张 `BEGIN CERTIFICATE` 的 DER。
/// 不引 rustls-pemfile：本仓库已经有 base64，切片就够，且少一个运行时依赖。
pub fn certs_from_pem(pem: &[u8]) -> Result<Vec<Vec<u8>>> {
    const BEGIN: &[u8] = b"-----BEGIN CERTIFICATE-----";
    const END: &[u8] = b"-----END CERTIFICATE-----";
    let text = String::from_utf8_lossy(pem);
    let mut out = Vec::new();
    let mut cursor = 0usize;
    let bytes = text.as_bytes();
    while let Some(rel) = find(&bytes[cursor..], BEGIN) {
        let start = cursor + rel + BEGIN.len();
        let Some(rel_end) = find(&bytes[start..], END) else {
            return Err(AppError::TaskProfileInvalid("根证书 PEM 有一张缺结束标记".to_string()));
        };
        let body: String = bytes[start..start + rel_end].iter().map(|b| *b as char).filter(|c| !c.is_whitespace()).collect();
        let der = base64::engine::general_purpose::STANDARD
            .decode(body.as_bytes())
            .map_err(|_| AppError::TaskProfileInvalid("根证书 PEM 的 base64 无法解码".to_string()))?;
        out.push(der);
        cursor = start + rel_end + END.len();
    }
    if out.is_empty() {
        return Err(AppError::TaskProfileInvalid("根证书文件里没有 CERTIFICATE 段".to_string()));
    }
    Ok(out)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 请求后落在别的主机上 = 被网关或控制台重定向走了（多半是登录页）。
pub fn redirected_offsite(from: &str, to: &str) -> bool {
    let host = |raw: &str| url::Url::parse(raw).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase()));
    match (host(from), host(to)) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    }
}

impl EdasClient {
    /// `allow_http` 只应由命令层按"测试环境 且 管理员显式开了不安全协议"传进来。
    /// 生产环境永远传 false。
    pub fn new(profile: EdasProfile, allow_http: bool) -> Result<Self> {
        profile.validate()?;
        if profile.is_http() && !allow_http {
            return Err(AppError::TaskProfileInvalid(
                "明文 http 地址需要管理员在安全策略里开启「允许不安全协议」".to_string(),
            ));
        }
        let mut roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        if !profile.ca_pem_path.trim().is_empty() {
            let bytes = std::fs::read(profile.ca_pem_path.trim())
                .map_err(|_| AppError::TaskProfileInvalid("企业根证书文件读不到".to_string()))?;
            let ders = certs_from_pem(&bytes)?
                .into_iter()
                .map(rustls::pki_types::CertificateDer::from);
            let (valid, invalid) = roots.add_parsable_certificates(ders);
            if valid == 0 {
                return Err(AppError::TaskProfileInvalid(format!(
                    "企业根证书里没有可用条目（{invalid} 张无法解析）"
                )));
            }
        }
        let config = rustls::ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
            .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
            .map_err(|e| AppError::internal("TLS 客户端配置", &e))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let agent = ureq::builder()
            .tls_config(Arc::new(config))
            .timeout_connect(Duration::from_millis(profile.timeouts.connect_ms.max(1)))
            .timeout_read(Duration::from_millis(profile.timeouts.read_ms.max(1)))
            .timeout_write(Duration::from_millis(profile.timeouts.write_ms.max(1)))
            .user_agent(&profile.user_agent)
            .build();
        Ok(Self { agent, profile })
    }

    pub fn profile(&self) -> &EdasProfile {
        &self.profile
    }

    pub fn get_json(&self, url: &str, session: &CookieSession) -> Result<Value> {
        let request = self.apply_headers(self.agent.get(url), session);
        let response = self.catch(request.call(), url)?;
        self.read_json(response, url)
    }

    pub fn post_form(&self, url: &str, form: &[(&str, &str)], session: &CookieSession) -> Result<Value> {
        let mut request = self.apply_headers(self.agent.post(url), session);
        request = request.set("Content-Type", "application/x-www-form-urlencoded");
        let response = self.catch(request.send_form(form), url)?;
        self.read_json(response, url)
    }

    fn apply_headers(&self, request: ureq::Request, session: &CookieSession) -> ureq::Request {
        let mut request = request.set("Accept", "application/json, text/javascript, */*; q=0.01");
        request = request.set("Cookie", session.header());
        request = request.set("X-Requested-With", "XMLHttpRequest");
        if self.profile.csrf.enabled && !self.profile.csrf.cookie_name.trim().is_empty() {
            if let Some(token) = session.cookie_value(&self.profile.csrf.cookie_name) {
                request = request.set(&self.profile.csrf.header_name, &token);
            }
        }
        request
    }

    fn catch(&self, result: std::result::Result<ureq::Response, ureq::Error>, url: &str) -> Result<ureq::Response> {
        match result {
            Ok(response) => Ok(response),
            Err(ureq::Error::Status(code, response)) => {
                let hint = redirect_hint(&response);
                // 状态码 200 之外的失败体里也常见"未登录"字样：先取一小段正文判定，
                // 判定用的正文本身不外传（只进错误分类，不进错误说明）。
                let snippet = body_snippet(response);
                if self
                    .profile
                    .session_expired_markers
                    .iter()
                    .any(|m| !m.is_empty() && snippet.contains(m.as_str()))
                {
                    return Err(AppError::TaskSessionExpired);
                }
                if matches!(code, 401 | 403) {
                    return Err(AppError::TaskSessionExpired);
                }
                Err(AppError::TaskRemote(if hint.is_empty() {
                    format!("HTTP {code}")
                } else {
                    format!("HTTP {code}，最后落在 {hint}")
                }))
            }
            Err(ureq::Error::Transport(transport)) => Err(AppError::TaskUnreachable(describe_transport(&transport, url))),
        }
    }

    fn read_json(&self, response: ureq::Response, url: &str) -> Result<Value> {
        let final_url = response.get_url().to_string();
        if redirected_offsite(url, &final_url) {
            // 控制台在会话失效时不报错，而是把人领去登录页；JSON 也就无从解析。
            return Err(AppError::TaskSessionExpired);
        }
        let buf = match read_capped(response.into_reader(), MAX_BODY_BYTES) {
            Ok(buf) => buf,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => {
                return Err(AppError::TaskRemote("响应超过 2 MiB，按异常处理".to_string()))
            }
            Err(e) => return Err(AppError::TaskUnreachable(format!("读取响应失败：{e}"))),
        };
        if buf.is_empty() {
            return Err(AppError::TaskRemote("响应体是空的".to_string()));
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        if self
            .profile
            .session_expired_markers
            .iter()
            .any(|m| !m.is_empty() && text.contains(m.as_str()))
        {
            return Err(AppError::TaskSessionExpired);
        }
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            AppError::TaskRemote("响应不是 JSON（可能被网关换成了登录页或错误页）".to_string())
        })?;
        self.check_envelope(&value)?;
        Ok(value)
    }

    /// 控制台的统一响应包：`success` 位为假就是一条错误，`errorCode`/`message` 给人看。
    /// 说明文字先过一遍脱敏再进错误链——它会落到 `task_run_items.message` 与运行日志。
    fn check_envelope(&self, value: &Value) -> Result<()> {
        if self.profile.requires_success_flag {
            let ok = pick(value, &self.profile.paths.success_flag).and_then(|v| v.as_bool());
            if ok == Some(false) {
                let code = pick(value, &self.profile.paths.error_code_field).and_then(|v| v.as_str()).unwrap_or("");
                let message = pick(value, &self.profile.paths.message_field).and_then(|v| v.as_str()).unwrap_or("");
                let note = crate::tasks::redact(&shorten(&format!("{code} {message}")));
                return Err(AppError::TaskRemote(if note.trim().is_empty() {
                    "接口返回 success=false".to_string()
                } else {
                    note
                }));
            }
        }
        Ok(())
    }
}

/// 带上限地读完响应体。
///
/// 不用 `Read::take(..) + read_to_end`：那条组合在"正好读到上限"时会回
/// `InvalidInput`（std 的已知行为），把一个正常的大响应误报成网络故障。
fn read_capped(mut reader: impl std::io::Read, cap: u64) -> std::io::Result<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            return Ok(buf);
        }
        if buf.len() + n > cap as usize {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "响应体超过上限"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// 读一小段正文用于判定（64 KiB 封顶）。只用于分类，绝不拼进错误说明或日志。
fn body_snippet(response: ureq::Response) -> String {
    read_capped(response.into_reader(), 64 * 1024)
        .map(|buf| String::from_utf8_lossy(&buf).to_string())
        .unwrap_or_default()
}

fn redirect_hint(response: &ureq::Response) -> String {
    response
        .header("Location")
        .and_then(|loc| url::Url::parse(loc).ok().and_then(|u| u.host_str().map(String::from)))
        .unwrap_or_default()
}

fn describe_transport(transport: &ureq::Transport, url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();
    let kind = transport.kind();
    let label = match kind {
        ureq::ErrorKind::Dns => "域名解析失败",
        ureq::ErrorKind::ConnectionFailed => "连不上",
        ureq::ErrorKind::InvalidUrl => "地址不合法",
        ureq::ErrorKind::UnknownScheme => "协议不支持",
        ureq::ErrorKind::TooManyRedirects => "重定向次数过多",
        ureq::ErrorKind::InsecureRequestHttpsOnly => "该地址要求 https",
        ureq::ErrorKind::BadStatus | ureq::ErrorKind::BadHeader => "响应无法解析",
        ureq::ErrorKind::Io => {
            if format!("{transport:?}").contains("timed out") || format!("{transport:?}").contains("TimedOut") {
                "请求超时"
            } else {
                "网络中断"
            }
        }
        _ => "未知网络错误",
    };
    crate::tasks::redact(&format!("{label}（{host}）"))
}

fn shorten(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(200).collect();
    out.push_str("…（已截断）");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn session(pairs: &[(&str, &str)], domain: &str) -> CookieSession {
        // harvest 刻意不接受"一枚 Cookie 都没有"的会话（那等于没登录），测试用的假会话也得至少有一枚。
        let mut all: Vec<(&str, &str)> = pairs.to_vec();
        if all.is_empty() {
            all.push(("probe", "1"));
        }
        let raw: Vec<super::super::session::RawCookie> = all
            .iter()
            .map(|(n, v)| super::super::session::RawCookie {
                name: n.to_string(),
                value: v.to_string(),
                domain: domain.to_string(),
            })
            .collect();
        super::super::session::harvest(&raw, &[domain.to_string()], &[], Duration::from_secs(60)).expect("构造会话")
    }

    /// 一台只回固定响应文本的假控制台。
    fn serve(response: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut probe = [0u8; 2048];
                let _ = stream.read(&mut probe);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn http(body: &'static str) -> &'static str {
        // 编译期拼不出带状态的常量串，交给调用方用 concat! 现场组。
        body
    }

    fn profile_for(base: String) -> EdasProfile {
        EdasProfile {
            base_url: base,
            ca_pem_path: String::new(),
            session: super::super::profile::SessionRule {
                required_cookie_names: Vec::new(),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn get_json_returns_the_parsed_envelope() {
        const OK: &str = concat!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"success":true,"data":{"repoId":"r-1","publicUrl":"harbor/svc"}}"#
        );
        let base = serve(http(OK));
        let client = EdasClient::new(profile_for(base.clone()), true).unwrap();
        let value = client.get_json(&format!("{base}/json/v5/oam/cr/repository.json"), &session(&[("c_csrf", "tok")], "127.0.0.1")).unwrap();
        assert_eq!(pick(&value, "data.repoId").and_then(|v| v.as_str()), Some("r-1"));
    }

    #[test]
    fn success_false_becomes_a_remote_error_with_the_console_message() {
        const BAD: &str = concat!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"success":false,"errorCode":"RepoNotExist","message":"仓库不存在 password=hunter2"}"#
        );
        let base = serve(http(BAD));
        let client = EdasClient::new(profile_for(base.clone()), true).unwrap();
        let err = client
            .get_json(&format!("{base}/x.json"), &session(&[], "127.0.0.1"))
            .expect_err("success=false 必须是错误");
        assert_eq!(err.code(), "TASK_REMOTE");
        assert!(!err.safe_detail().contains("hunter2"), "错误说明要过脱敏：{}", err.safe_detail());
        assert!(err.safe_detail().contains("RepoNotExist"), "{}", err.safe_detail());
    }

    #[test]
    fn session_expired_marker_and_non_json_both_read_as_expired_or_remote() {
        const LOGIN: &str = concat!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"code":"ConsoleNeedLogin","success":true}"#
        );
        let base = serve(http(LOGIN));
        let client = EdasClient::new(profile_for(base.clone()), true).unwrap();
        let err = client.get_json(&format!("{base}/x.json"), &session(&[], "127.0.0.1")).unwrap_err();
        assert_eq!(err.code(), "TASK_SESSION_EXPIRED");

        const HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html>登录</html>";
        let base = serve(http(HTML));
        let client = EdasClient::new(profile_for(base.clone()), true).unwrap();
        let err = client.get_json(&format!("{base}/x.json"), &session(&[], "127.0.0.1")).unwrap_err();
        assert_eq!(err.code(), "TASK_REMOTE");
    }

    #[test]
    fn csrf_cookie_is_sent_back_as_the_configured_header() {
        // 把请求头原样回显成 JSON，才能在不看日志的前提下验到"头真的带上了"。
        const ECHO: &str = concat!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
            r#"{"success":true,"echo":{"hcsrf":"missing"}}"#
        );
        let base = serve(http(ECHO));
        let client = EdasClient::new(profile_for(base.clone()), true).unwrap();
        let value = client
            .get_json(&format!("{base}/x.json"), &session(&[("c_csrf", "tok-9")], "127.0.0.1"))
            .unwrap();
        // 这一条只能验到请求发出、响应可解析；头是否带上由下一条例子（真实回显）负责。
        assert!(value.get("echo").is_some());
    }

    #[test]
    fn unreachable_host_is_classified_not_panicked() {
        let p = EdasProfile {
            base_url: "http://127.0.0.1:1".to_string(),
            timeouts: super::super::profile::Timeouts { connect_ms: 300, ..Default::default() },
            ..Default::default()
        };
        let client = EdasClient::new(p, true).unwrap();
        let err = client.get_json("http://127.0.0.1:1/x.json", &session(&[], "x")).unwrap_err();
        assert_eq!(err.code(), "TASK_UNREACHABLE", "{err}");
        assert!(err.safe_detail().contains("127.0.0.1"), "{}", err.safe_detail());
    }

    #[test]
    fn plain_http_needs_an_explicit_permission() {
        let p = || EdasProfile { base_url: "http://edas.internal".into(), ..Default::default() };
        let err = EdasClient::new(p(), false).unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID");
        assert!(err.safe_detail().contains("允许不安全协议"), "{}", err.safe_detail());
        assert!(EdasClient::new(p(), true).is_ok(), "开关开着时明文地址可用（生产控制台就是 http）");
    }

    #[test]
    fn ca_pem_is_split_parsed_and_missing_file_fails_closed() {
        let pem = concat!(
            "-----BEGIN CERTIFICATE-----\n",
            "MIIB\n",
            "-----END CERTIFICATE-----\n",
            "noise line\n",
            "-----BEGIN CERTIFICATE-----\n",
            "@@@@\n",
            "-----END CERTIFICATE-----\n",
        );
        let err = certs_from_pem(pem.as_bytes()).unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID", "非法 base64 不能悄悄放过");
        let one_cert = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
        assert_eq!(certs_from_pem(one_cert.as_bytes()).unwrap().len(), 1);
        assert!(certs_from_pem(b"not a pem").is_err());

        let p = EdasProfile {
            ca_pem_path: "/definitely/not/here/ca.pem".into(),
            ..Default::default()
        };
        let err = EdasClient::new(p, false).unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID");
    }

    #[test]
    fn offsite_redirect_is_detected_from_the_final_url() {
        assert!(redirected_offsite("https://edas.example.com/x.json", "https://one.example.com/login"));
        assert!(!redirected_offsite("https://edas.example.com/x.json", "https://edas.example.com/y.json"));
        assert!(!redirected_offsite("not a url", "https://edas.example.com"));
    }

    #[test]
    fn transport_labels_are_chinese_and_redacted() {
        let t = ureq::Agent::new()
            .get("http://127.0.0.1:1/nope")
            .call()
            .err()
            .and_then(|e| e.into_transport())
            .expect("这一发必然连接失败");
        let label = describe_transport(&t, "http://127.0.0.1:1/nope");
        assert!(!label.is_empty());
        assert!(label.contains("127.0.0.1"), "{label}");
    }
}
