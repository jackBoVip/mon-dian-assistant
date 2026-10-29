//! OCR 引擎：进程内单例 + 专属推理线程。
//!
//! 推理是 CPU 密集的（实测 760×180 一次 ~42ms），放在命令线程里会把整个 webview 卡住；
//! 这里让 `mda-quiz-ocr` 线程独占 `OcrEngine`，命令线程只发图和收结果。
//! 同一时刻最多排队一串请求，引擎内部不再并发——悬停线程自己会做「一次在飞」抑制。
//!
//! 生命周期：第一次识别时才加载模型（构建 53ms + warmup 80ms）；模型缺失或加载失败时
//! 状态停在 `unavailable/failed`，后续请求**立刻**回错误而不是让调用方白等超时。
//!
//! 截图文本只在内存里过一遍：这里不写日志、不落盘，连行数以外的内容都不进日志。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use image::DynamicImage;
use parking_lot::Mutex;
use pure_onnx_ocr::{OcrEngine, OcrEngineBuilder};
use serde::Serialize;

use crate::error::{AppError, Result};

/// 低于这个置信度的行直接丢弃：PP-OCR 在纯色背景上会凭空「认」出单个字符。
pub const MIN_CONFIDENCE: f32 = 0.5;

/// 单次识别最多等这么久。冷启动（首次加载模型）也在其中。
///
/// release 实测 760×180 ≈ 42ms、1520×400 ≈ 150ms，8 秒是给 debug 构建留的余量：
/// 未优化 + tract 首次编译计算图，同一张 1520×400 的图实测 3.7s。
/// 悬停线程不靠这个兜底——它有自己的「慢结果直接丢」判断（见 assistant.rs 的 P6 部分）。
pub const RECOGNIZE_TIMEOUT: Duration = Duration::from_secs(8);

/// 模型目录里的固定布局：`det/inference.onnx|yml` + `rec/inference.onnx|yml`。
pub const MODEL_SUBDIR: &str = "ocr/ppocrv5";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OcrState {
    /// 还没被用到过，模型未加载。
    Idle,
    Loading,
    Ready,
    /// 模型在，但加载或推理失败。
    Failed,
    /// 找不到模型文件。
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStatus {
    pub state: OcrState,
    /// 给界面看的一句话；不含任何截图内容。
    pub detail: Option<String>,
    /// 实际加载的模型目录（排障用，不是秘密）。
    pub model_dir: Option<String>,
}

impl OcrStatus {
    fn idle() -> Self {
        Self { state: OcrState::Idle, detail: None, model_dir: None }
    }
}

/// 一行识别结果。坐标单位是**截图像素**，左上原点。
#[derive(Clone, Debug)]
pub struct OcrLine {
    pub text: String,
    pub confidence: f32,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl OcrLine {
    pub fn width(&self) -> f64 {
        (self.right - self.left).max(0.0)
    }

    pub fn height(&self) -> f64 {
        (self.bottom - self.top).max(0.0)
    }

    pub fn center_y(&self) -> f64 {
        (self.top + self.bottom) / 2.0
    }
}

/// 把整段截图的行按从上到下、从左到右接成一段文本。
pub fn join_text(lines: &[OcrLine]) -> String {
    lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n")
}

enum Job {
    Image(DynamicImage, Sender<Result<Vec<OcrLine>>>),
}

struct Handle {
    tx: Sender<Job>,
    status: Arc<Mutex<OcrStatus>>,
}

impl Clone for Handle {
    fn clone(&self) -> Self {
        Self { tx: self.tx.clone(), status: self.status.clone() }
    }
}

static WORKER: Mutex<Option<Handle>> = Mutex::new(None);

/// 当前引擎状态。未启动过引擎时是 `idle`（而不是「不可用」）。
pub fn status() -> OcrStatus {
    match WORKER.lock().as_ref() {
        Some(h) => h.status.lock().clone(),
        None => OcrStatus::idle(),
    }
}

/// 停掉推理线程。锁库/退出时调用；下一次识别会自动重新拉起并加载模型。
pub fn shutdown() {
    // 丢掉 sender 后工作线程读完队列就会退出，`OcrEngine` 随之释放。
    let _ = WORKER.lock().take();
}

/// 解析模型目录。
///
/// 顺序：`MDA_OCR_MODEL_DIR`（自测/离线安装）→ 安装包资源目录 → 开发态源码目录。
/// 前两者任一命中即可；开发态那一档只在 debug 构建里编进去，免得发布包带着构建机路径。
pub fn resolve_model_dir() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("MDA_OCR_MODEL_DIR") {
        let dir = PathBuf::from(raw);
        if has_models(&dir) {
            return Some(dir);
        }
    }
    if let Some(core) = crate::state::try_core() {
        if let Some(app) = core.app_handle() {
            use tauri::Manager;
            if let Ok(dir) = app.path().resolve(MODEL_SUBDIR, tauri::path::BaseDirectory::Resource) {
                if has_models(&dir) {
                    return Some(dir);
                }
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(MODEL_SUBDIR);
        if has_models(&dev) {
            return Some(dev);
        }
    }
    None
}

fn has_models(dir: &Path) -> bool {
    ["det", "rec"].iter().all(|part| {
        let d = dir.join(part);
        d.join("inference.onnx").is_file() && d.join("inference.yml").is_file()
    })
}

/// 在专属线程里识别一张图。失败一律是 `QUIZ_OCR_UNAVAILABLE`，具体原因看 `status().detail`。
pub fn recognize(image: &DynamicImage) -> Result<Vec<OcrLine>> {
    let handle = ensure_worker()?;
    let (tx, rx) = mpsc::channel();
    if handle.tx.send(Job::Image(image.clone(), tx)).is_err() {
        // 线程意外退出：下一次调用会重新拉起。
        let _ = WORKER.lock().take();
        return Err(AppError::QuizOcrUnavailable);
    }
    match rx.recv_timeout(RECOGNIZE_TIMEOUT) {
        Ok(result) => result,
        // 超时后工作线程仍会把这一次跑完（结果没人收），下一次请求排在它后面——
        // 悬停线程的「一次在飞」抑制保证不会积压，见 assistant.rs。
        Err(_) => Err(AppError::QuizOcrUnavailable),
    }
}

fn ensure_worker() -> Result<Handle> {
    let mut guard = WORKER.lock();
    if let Some(handle) = guard.as_ref() {
        return match handle.status.lock().state {
            OcrState::Failed | OcrState::Unavailable => Err(AppError::QuizOcrUnavailable),
            _ => Ok(handle.clone()),
        };
    }

    let Some(model_dir) = resolve_model_dir() else {
        let mut status = OcrStatus::idle();
        status.state = OcrState::Unavailable;
        status.detail = Some("没有找到 OCR 模型目录（ocr/ppocrv5），答题助手不可用".to_string());
        *guard = Some(Handle { tx: mpsc::channel().0, status: Arc::new(Mutex::new(status)) });
        return Err(AppError::QuizOcrUnavailable);
    };

    let status = Arc::new(Mutex::new(OcrStatus {
        state: OcrState::Loading,
        detail: None,
        model_dir: Some(model_dir.display().to_string()),
    }));
    let (tx, rx) = mpsc::channel();
    let worker_status = status.clone();
    std::thread::Builder::new()
        .name("mda-quiz-ocr".into())
        .spawn(move || run_worker(rx, model_dir, worker_status))
        .map_err(|_| AppError::QuizOcrUnavailable)?;

    let handle = Handle { tx, status };
    *guard = Some(handle.clone());
    Ok(handle)
}

fn run_worker(rx: Receiver<Job>, model_dir: PathBuf, status: Arc<Mutex<OcrStatus>>) {
    let engine = match build_engine(&model_dir) {
        Ok(engine) => engine,
        Err(detail) => {
            *status.lock() = OcrStatus {
                state: OcrState::Failed,
                detail: Some(detail),
                model_dir: Some(model_dir.display().to_string()),
            };
            // 失败后仍要把排队中的请求逐个回掉，不能让调用方各等满 5 秒。
            for job in rx {
                let Job::Image(_, reply) = job;
                let _ = reply.send(Err(AppError::QuizOcrUnavailable));
            }
            return;
        }
    };

    *status.lock() = OcrStatus {
        state: OcrState::Ready,
        detail: None,
        model_dir: Some(model_dir.display().to_string()),
    };

    for job in rx {
        let Job::Image(image, reply) = job;
        let started = std::time::Instant::now();
        let result = run_once(&engine, &image);
        match &result {
            Ok(lines) => log::debug!(
                "quiz ocr: {} 行 · {}ms · {}x{}",
                lines.len(),
                started.elapsed().as_millis(),
                image.width(),
                image.height()
            ),
            Err(_) => log::warn!("quiz ocr: 推理失败 · {}ms", started.elapsed().as_millis()),
        }
        let _ = reply.send(result);
    }
    // 队列关闭（shutdown 或进程退出）：引擎在这里释放。
}

fn build_engine(dir: &Path) -> std::result::Result<OcrEngine, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2);
    let engine = OcrEngineBuilder::new()
        .det_model_dir(dir.join("det"))
        .rec_model_dir(dir.join("rec"))
        .inference_threads(threads)
        .build()
        .map_err(|e| format!("模型加载失败：{e}"))?;
    // warmup 只是预编译常用形状，失败不代表推理不可用，交给第一次真实请求去暴露。
    let band_w = crate::quiz::capture::BAND_WIDTH as u32;
    let band_h = (crate::quiz::capture::BAND_ABOVE + crate::quiz::capture::BAND_BELOW) as u32;
    if let Err(e) = engine.warmup(band_w, band_h) {
        log::warn!("quiz ocr: warmup 失败（忽略）：{e}");
    }
    Ok(engine)
}

fn run_once(engine: &OcrEngine, image: &DynamicImage) -> Result<Vec<OcrLine>> {
    let results = engine.run_from_image(image).map_err(|e| {
        // 只记错误类型，不记识别内容。
        log::warn!("quiz ocr: {e}");
        AppError::QuizOcrUnavailable
    })?;

    let mut lines: Vec<OcrLine> = results
        .into_iter()
        .filter(|r| r.confidence >= MIN_CONFIDENCE && !r.text.trim().is_empty())
        .map(|r| {
            let points = &r.bounding_box.exterior().0;
            let (mut left, mut top, mut right, mut bottom) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in points {
                left = left.min(p.x);
                right = right.max(p.x);
                top = top.min(p.y);
                bottom = bottom.max(p.y);
            }
            OcrLine {
                text: r.text.trim().to_string(),
                confidence: r.confidence,
                left,
                top,
                right,
                bottom,
            }
        })
        .collect();
    // 检测框顺序不保证从上到下；题干块拼装依赖这个顺序。
    lines.sort_by(|a, b| a.center_y().partial_cmp(&b.center_y()).unwrap_or(std::cmp::Ordering::Equal));
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_text_keeps_one_line_per_ocr_line() {
        let line = |text: &str, top: f64| OcrLine {
            text: text.to_string(),
            confidence: 0.9,
            left: 0.0,
            top,
            right: 10.0,
            bottom: top + 10.0,
        };
        let lines = vec![line("第一行", 0.0), line("第二行", 12.0)];
        assert_eq!(join_text(&lines), "第一行\n第二行");
        assert_eq!(lines[1].center_y(), 17.0);
    }

    /// 模型缺失时必须停在 `unavailable` 并立刻回错误，而不是让调用方等满 5 秒。
    /// 只在测试进程里没有装模型的前提下成立；装了模型的开发机会从资源目录命中，跳过该断言。
    #[test]
    fn missing_models_report_unavailable_without_waiting_for_timeout() {
        if resolve_model_dir().is_some() {
            return;
        }
        let started = std::time::Instant::now();
        assert!(matches!(recognize(&DynamicImage::new_rgb8(8, 8)), Err(AppError::QuizOcrUnavailable)));
        assert!(started.elapsed() < RECOGNIZE_TIMEOUT, "模型缺失不该等到超时");
        assert_eq!(status().state, OcrState::Unavailable);
        shutdown();
    }

    /// 真模型端到端探针：把一整张图送进专属线程，确认「加载 → 识别 → 回传」这条链路。
    /// 模型与图片都是本机资源，所以默认忽略；开发机手动跑：
    /// `MDA_OCR_TEST_IMAGE=/tmp/ocr-spike.png cargo test --lib quiz::ocr -- --ignored --nocapture`
    #[test]
    #[ignore = "需要 OCR 模型与一张截图：设 MDA_OCR_TEST_IMAGE 后加 --ignored 运行"]
    fn recognizes_a_real_image_end_to_end() {
        let path = std::env::var("MDA_OCR_TEST_IMAGE").expect("缺少 MDA_OCR_TEST_IMAGE");
        let image = image::open(&path).expect("读图失败");
        let started = std::time::Instant::now();
        let lines = recognize(&image).expect("识别失败");
        println!("识别 {} 行 · 用时 {:?}", lines.len(), started.elapsed());
        for line in &lines {
            println!("  [{:.3}] {}", line.confidence, line.text);
        }
        assert!(!lines.is_empty(), "一张有字的图不该一行都认不出来");
        assert_eq!(status().state, OcrState::Ready);
        shutdown();
    }
}
