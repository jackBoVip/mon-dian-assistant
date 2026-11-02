//! 页面库：使用者粘贴进来的 HTML 片段与整页，按标题存、按更新时间列。
//!
//! 这一层只认「内容怎么存、怎么算合法」；能不能跑、在哪儿跑由 `preview` 决定：
//! 右栏是一块嵌进主窗的子 webview（能跑脚本、能联网），「运行脚本」是独立窗口；
//! 两者内容都来自回环服务，对 Tauri 是 remote origin，没有 remote capability 就拿不到任何命令。

pub mod store;
