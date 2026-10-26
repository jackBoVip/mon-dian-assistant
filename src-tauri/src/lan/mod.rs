//! 局域网更新通道：组播发现、内容寻址托管、私网地址边界。
//!
//! 与 `update` 模块的分工：本模块只负责「找到谁有包」与「把包送出去」，
//! 版本比较、清单验签、SHA-256 校验全部复用 `update`，不另写一套。
//!
//! 运行时只有两个常驻线程：一个收宣告（始终在跑），一个发宣告 + 一个 TCP accept
//! （仅在管理员开启「本机作为更新源」时启动）。锁定保险库不暂停它们——托管的是
//! 公开的签名包，不含任何秘密。

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::settings;
use crate::state::AppCore;

pub mod discovery;
pub mod http;
pub mod net;
pub mod store;

static STATE: OnceLock<Arc<LanState>> = OnceLock::new();

pub struct LanState {
    /// 进程实例号：区分「同一台机器重启后的新源」与「旧宣告被重放」。
    pub instance: String,
    pub started_at: u64,
    pub started: Instant,
    stop: AtomicBool,
    sources: Mutex<discovery::SourceTable>,
    discovery_error: Mutex<Option<String>>,
    discovery_stop: Mutex<Option<Arc<AtomicBool>>>,
    serve_error: Mutex<Option<String>>,
    serve: Mutex<Option<ServeRuntime>>,
}

struct ServeRuntime {
    stop: Arc<AtomicBool>,
    port: u16,
    dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub discovery_enabled: bool,
    pub discovery_error: Option<String>,
    /// 发现线程已运行时长：界面据此区分「还在扫描」与「确实没有源」。
    pub elapsed_ms: u64,
    pub sources: Vec<LanSourceView>,
    pub serving: bool,
    pub serve_port: Option<u16>,
    pub serve_dir: Option<String>,
    pub serve_error: Option<String>,
    pub manual_source: Option<String>,
    pub local_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSourceView {
    pub instance: String,
    pub host: String,
    pub ip: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub port: u16,
    /// 源版本是否高于本机。低于本机的源仍然展示，但界面必须禁用「从局域网更新」。
    pub newer_than_local: bool,
}

/// 装配发现线程，并按库里的设置决定是否开启托管。重复调用无副作用。
pub fn start(core: &AppCore) {
    let state = Arc::new(LanState {
        instance: new_instance_id(),
        started_at: now_unix(),
        started: Instant::now(),
        stop: AtomicBool::new(false),
        sources: Mutex::new(discovery::SourceTable::new()),
        discovery_error: Mutex::new(None),
        discovery_stop: Mutex::new(None),
        serve_error: Mutex::new(None),
        serve: Mutex::new(None),
    });
    if STATE.set(state.clone()).is_err() {
        return;
    }
    sync(core);
}

/// 进程退出时停掉所有常驻线程。托管服务不需要落盘状态，直接丢就行。
pub fn stop() {
    let Some(state) = STATE.get() else { return };
    state.stop.store(true, Ordering::Relaxed);
    if let Ok(mut guard) = state.discovery_stop.lock() {
        if let Some(s) = guard.take() {
            s.store(true, Ordering::Relaxed);
        }
    }
    if let Ok(mut guard) = state.serve.lock() {
        if let Some(rt) = guard.take() {
            rt.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// 让两个常驻线程与库里的设置对齐。
///
/// 设置页里的开关写库后立即调用这里，所以「关掉发现」必须当场停止监听并清空源表，
/// 而不是等下次启动——文案说的是「开启后监听」，关掉就得真的不再监听。
pub fn sync(core: &AppCore) {
    sync_discovery(core);
    sync_serve(core);
}

fn sync_discovery(core: &AppCore) {
    let Some(state) = STATE.get() else { return };
    let enabled = settings::get_bool(&core.db, "lan_discovery_enabled", true);
    let Ok(mut guard) = state.discovery_stop.lock() else { return };
    match (enabled, guard.as_ref()) {
        (true, None) => {
            let stop = Arc::new(AtomicBool::new(false));
            *guard = Some(stop.clone());
            spawn_receiver(state.clone(), stop);
        }
        (false, Some(_)) => {
            if let Some(s) = guard.take() {
                s.store(true, Ordering::Relaxed);
            }
            if let Ok(mut table) = state.sources.lock() {
                table.clear();
            }
            if let Ok(mut e) = state.discovery_error.lock() {
                *e = None;
            }
        }
        _ => {}
    }
}

/// 让运行中的托管服务与库里的设置对齐。设置变了就重启，自检失败就记录原因而不启动。
pub fn sync_serve(core: &AppCore) {
    let Some(state) = STATE.get() else { return };
    let enabled = settings::get_bool(&core.db, "lan_serve_enabled", false);
    let dir = settings::get(&core.db, "lan_serve_dir")
        .ok()
        .flatten()
        .unwrap_or_default();
    let dir = dir.trim().to_string();
    let should_run = enabled && !dir.is_empty();

    let Ok(mut guard) = state.serve.lock() else { return };
    let needs_change = match guard.as_ref() {
        Some(rt) => !should_run || rt.dir != Path::new(&dir),
        None => should_run,
    };
    if !needs_change {
        return;
    }
    if let Some(rt) = guard.take() {
        rt.stop.store(true, Ordering::Relaxed);
    }
    if !should_run {
        if let Ok(mut e) = state.serve_error.lock() {
            *e = None;
        }
        return;
    }
    match start_serve(state, Path::new(&dir)) {
        Ok(rt) => {
            if let Ok(mut e) = state.serve_error.lock() {
                *e = None;
            }
            *guard = Some(rt);
        }
        Err(e) => {
            if let Ok(mut slot) = state.serve_error.lock() {
                *slot = Some(e.to_string());
            }
        }
    }
}

pub fn status(core: &AppCore) -> LanStatus {
    let local_version = env!("CARGO_PKG_VERSION").to_string();
    let discovery_enabled = settings::get_bool(&core.db, "lan_discovery_enabled", true);
    let serve_dir = settings::get(&core.db, "lan_serve_dir")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());
    let manual_source = settings::get(&core.db, "lan_manual_source")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty());

    let Some(state) = STATE.get() else {
        return LanStatus {
            discovery_enabled,
            discovery_error: None,
            elapsed_ms: 0,
            sources: Vec::new(),
            serving: false,
            serve_port: None,
            serve_dir,
            serve_error: None,
            manual_source,
            local_version,
        };
    };

    let sources = state
        .sources
        .lock()
        .map(|mut t| {
            t.sources(Instant::now())
                .into_iter()
                .map(|s| LanSourceView {
                    newer_than_local: crate::update::is_newer(&s.announce.version, &local_version),
                    instance: s.announce.instance,
                    host: s.announce.host,
                    ip: s.addr.to_string(),
                    version: s.announce.version,
                    platform: s.announce.platform,
                    arch: s.announce.arch,
                    port: s.announce.port,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let (serving, serve_port) = match state.serve.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(rt) => (true, Some(rt.port)),
            None => (false, None),
        },
        Err(_) => (false, None),
    };

    LanStatus {
        discovery_enabled,
        discovery_error: state.discovery_error.lock().ok().and_then(|g| g.clone()),
        elapsed_ms: state.started.elapsed().as_millis() as u64,
        sources,
        serving,
        serve_port,
        serve_dir,
        serve_error: state.serve_error.lock().ok().and_then(|g| g.clone()),
        manual_source,
        local_version,
    }
}

/// 选定的更新源：`base` 是可直接拼路径的 `http://ip:port`。
pub struct ResolvedSource {
    pub base: String,
    /// 展示用名字（发现到的主机名，或手填的地址）
    pub host: String,
    /// 源宣告的清单版本；手填源未知时为 None
    pub version: Option<String>,
}

/// 决定从哪台机器拉清单：指定实例 → 手填地址 → 最优发现源 → 设置里的手填源 → 无源。
///
/// 指定实例找不到时不会静默退回"最优源"：用户点了某一行，就应该从那一行取，
/// 否则界面显示 A、实际拉了 B。
pub fn resolve_source(core: &AppCore, hint: Option<&str>) -> Result<ResolvedSource> {
    let hint = hint.map(str::trim).filter(|s| !s.is_empty());
    if let Some(h) = hint {
        if let Some(s) = state()
            .and_then(|st| st.sources.lock().ok().and_then(|mut t| t.sources(Instant::now()).into_iter().find(|s| s.announce.instance == h)))
        {
            return Ok(from_discovered(&s));
        }
        return from_manual(h).ok_or(AppError::LanSourceUnavailable);
    }
    if let Some(s) = state().and_then(|st| st.sources.lock().ok().and_then(|mut t| t.best(Instant::now()))) {
        return Ok(from_discovered(&s));
    }
    let manual = settings::get(&core.db, "lan_manual_source")
        .ok()
        .flatten()
        .unwrap_or_default();
    from_manual(&manual).ok_or(AppError::LanSourceUnavailable)
}

/// 包的内容寻址地址：局域网模式下清单里的 `url` 不参与取包，只认 sha256。
pub fn package_url(base: &str, sha256: &str) -> Result<String> {
    let sha = sha256.trim().to_ascii_lowercase();
    if !store::is_sha256_hex(&sha) {
        return Err(AppError::UpdateManifestInvalid);
    }
    Ok(format!("{}/package/{sha}", base.trim_end_matches('/')))
}

fn state() -> Option<&'static Arc<LanState>> {
    STATE.get()
}

fn from_discovered(s: &discovery::Source) -> ResolvedSource {
    let addr = std::net::SocketAddr::new(s.addr, s.announce.port);
    ResolvedSource {
        base: format!("http://{addr}"),
        host: s.announce.host.clone(),
        version: Some(s.announce.version.clone()),
    }
}

fn from_manual(raw: &str) -> Option<ResolvedSource> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let base = crate::update::normalize_lan_source(raw)?;
    let host = url::Url::parse(&base).ok()?.host_str()?.to_string();
    Some(ResolvedSource { base, host, version: None })
}

fn start_serve(state: &Arc<LanState>, dir: &Path) -> Result<ServeRuntime> {
    // 先自检再开端口：清单验不过就不该让任何客户端连上来。
    let share = store::load(dir)?;
    let version = share.manifest.version.clone();
    let listener = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, http::DEFAULT_PORT))
        .or_else(|_| std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)))
        .map_err(|e| AppError::internal("局域网更新源", &e))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::internal("局域网更新源", &e))?
        .port();
    let stop = Arc::new(AtomicBool::new(false));

    let serve_state = Arc::new(http::ServeState { instance: state.instance.clone(), share });
    {
        let st = serve_state.clone();
        let sp = stop.clone();
        std::thread::spawn(move || http::serve_loop(listener, st, sp));
    }
    {
        let st = state.clone();
        let sp = stop.clone();
        std::thread::spawn(move || announce_loop(st, version, port, sp));
    }
    Ok(ServeRuntime { stop, port, dir: dir.to_path_buf() })
}

/// 宣告的是**清单版本**而不是本机版本：客户端要判断的是「源上有什么」，不是「源自己跑什么」。
fn announce_loop(state: Arc<LanState>, version: String, port: u16, stop: Arc<AtomicBool>) {
    let sock = match discovery::sender_socket() {
        Ok(s) => s,
        Err(e) => {
            if let Ok(mut slot) = state.serve_error.lock() {
                *slot = Some(format!("组播发送失败：{e}"));
            }
            return;
        }
    };
    let host = host_label();
    let mut seq = 0u64;
    while !stop.load(Ordering::Relaxed) {
        seq += 1;
        let announce = discovery::Announce {
            app: discovery::APP_ID.into(),
            proto: discovery::PROTO,
            instance: state.instance.clone(),
            host: host.clone(),
            version: version.clone(),
            platform: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            port,
            started_at: state.started_at,
            seq,
        };
        if let Some(bytes) = discovery::encode(&announce) {
            discovery::broadcast_announce(&sock, &bytes);
        }
        sleep_interruptible(&stop, discovery::ANNOUNCE_INTERVAL);
    }
}

fn spawn_receiver(state: Arc<LanState>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let sock = match discovery::listener_socket() {
            Ok(s) => s,
            Err(e) => {
                if let Ok(mut slot) = state.discovery_error.lock() {
                    *slot = Some(format!("组播监听失败：{e}"));
                }
                return;
            }
        };
        let _ = sock.set_read_timeout(Some(Duration::from_secs(1)));
        let mut buf = [0u8; 2048];
        while !state.stop.load(Ordering::Relaxed) && !stop.load(Ordering::Relaxed) {
            match sock.recv_from(&mut buf) {
                Ok((n, peer)) => {
                    // 绑 0.0.0.0 时公网/VPN 网卡也能收到包，来源必须是私网。
                    if !net::is_private_or_local(peer.ip()) {
                        continue;
                    }
                    let Some(announce) = discovery::decode(&buf[..n]) else { continue };
                    if announce.instance == state.instance {
                        continue;
                    }
                    if let Ok(mut table) = state.sources.lock() {
                        table.upsert(announce, peer.ip(), Instant::now());
                    }
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue
                }
                Err(_) => std::thread::sleep(Duration::from_secs(1)),
            }
        }
    });
}

fn sleep_interruptible(stop: &AtomicBool, total: Duration) {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < total && !stop.load(Ordering::Relaxed) {
        std::thread::sleep(step);
        waited += step;
    }
}

fn host_label() -> String {
    let raw = crate::commands::vault::device_label();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn new_instance_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
