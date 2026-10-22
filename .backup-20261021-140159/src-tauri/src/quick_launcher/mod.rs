//! 全局快捷启动器后端：查询解析、内存索引、快捷动作鉴权。
//! 所有动作必须复用与主界面完全相同的 Rust 后端授权接口，不得存在特权旁路。

pub mod actions;
pub mod parser;
pub mod query;
pub mod search;
pub mod shortcut;

pub use parser::{parse, Condition, Field, ParsedQuery};
pub use query::QuickAction;
pub use search::{MatchKind, SearchDoc, SearchIndex};
pub use shortcut::{validate_accelerator, DEFAULT_ACCELERATORS, MODIFIER_TOKENS};
