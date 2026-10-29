//! 题库领域：导入解析、复核任务、题库存储，以及后续的检索与取词助手。
//!
//! 这一层不碰 Tauri，也不碰会话/RBAC——那些在 `commands/quiz.rs` 里做；
//! 这里只保证「给的参数合法、写进库里的东西能被读回来」。

pub mod assistant;
pub mod capture;
pub mod matcher;
pub mod models;
pub mod ocr;
pub mod parse;
pub mod store;
pub mod tip;

/// 浮层事件：悬停线程只发这一条，载荷是匹配结果或「隐藏」。
pub const EVENT_TIP: &str = "quiz://tip";
