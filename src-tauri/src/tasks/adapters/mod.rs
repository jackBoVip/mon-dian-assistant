//! 站点适配器。引擎只通过 [`crate::tasks::runner::TaskAdapter`] 与它们打交道，
//! 新增一个任务类型 = 新增一个目录（profile + prepare + publish）+ 注册进 `tasks::TASKS`。

pub mod edas;
