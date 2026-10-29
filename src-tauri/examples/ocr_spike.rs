//! P0 探针：量一次 OCR 的冷启动、两次推理耗时与进程内存。
//!
//! 用法：`cargo run --release --example ocr_spike -- <模型目录> <图片> [更多图片…]`
//! 模型目录下需有 `det/` 与 `rec/`，各自含 `inference.onnx` + `inference.yml`
//! （由 `node scripts/prepare-ocr-models.mjs` 下载）。
//!
//! 这个 example 不进安装包，只用于开发机上的可行性验证与后续调参对账。

use std::path::{Path, PathBuf};
use std::time::Instant;

use pure_onnx_ocr::OcrEngineBuilder;

fn rss_mib() -> Option<f64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kib: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kib / 1024.0)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let model_dir: PathBuf = args.next().map(PathBuf::from).ok_or("缺少模型目录参数")?;
    let images: Vec<PathBuf> = args.map(PathBuf::from).collect();
    if images.is_empty() {
        return Err("缺少数张图片参数".into());
    }

    let started = Instant::now();
    let engine = OcrEngineBuilder::new()
        .det_model_dir(model_dir.join("det"))
        .rec_model_dir(model_dir.join("rec"))
        .inference_threads(std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2))
        .build()?;
    println!("build: {:?}", started.elapsed());

    let warmup = Instant::now();
    engine.warmup(760, 132)?;
    println!("warmup(760x132): {:?}", warmup.elapsed());

    for image_path in &images {
        let image = image::open(image_path)?;
        println!("\n== {} ({}x{}) ==", image_path.display(), image.width(), image.height());
        for round in 1..=2 {
            let t = Instant::now();
            let results = engine.run_from_image(&image)?;
            println!("run #{round}: {:?} · {} 行", t.elapsed(), results.len());
            if round == 2 {
                for r in &results {
                    println!("  [{:.3}] {}", r.confidence, r.text);
                }
            }
        }
        if let Some(mib) = rss_mib() {
            println!("rss: {mib:.1} MiB");
        }
    }
    println!("\nmodel dir: {}", Path::new(&model_dir).display());
    Ok(())
}
