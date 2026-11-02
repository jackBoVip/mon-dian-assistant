//! 任务中心：通用运行引擎 + 站点适配器。
//!
//! 边界只有两句话：
//! - 引擎（`runner`）不认识任何站点：落库、有界并发、取消、事件、重试上限都在这里；
//! - 适配器只实现 `prepare` / `publish` 两个方法，不碰数据库、不碰事件总线。
//!
//! 安全约束在本层的体现：
//! - 运行日志落库前统一过 [`redact`]，Cookie / Authorization / 口令字段一律不留下值；
//! - 任务侧只存凭据**引用**（`task_env_bindings.credential_item_id`），密码由适配器在
//!   Rust 内存里经 `repo::item_payload` 取用，绝不回到前端、绝不落库；
//! - 保险库一锁定，所有在跑的运行立即被要求停下（见 `commands::vault` 与 `state::lock_down`）。

pub mod adapters;
pub mod runner;
pub mod store;

use serde::Serialize;

/// 环境：测试 / 生产。与 `task_env_bindings.env` 的 CHECK 约束同值。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Test,
    Prod,
}

impl Env {
    pub const ALL: [Env; 2] = [Env::Test, Env::Prod];

    pub fn as_str(self) -> &'static str {
        match self {
            Env::Test => "test",
            Env::Prod => "prod",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "test" => Some(Env::Test),
            "prod" => Some(Env::Prod),
            _ => None,
        }
    }

    pub fn is_prod(self) -> bool {
        matches!(self, Env::Prod)
    }
}

/// 一个任务类型的静态定义。换站点改的是 `profile_json`，不是这里。
#[derive(Debug, Clone, Copy)]
pub struct TaskDef {
    pub key: &'static str,
    pub label: &'static str,
    pub envs: &'static [Env],
    /// 准备阶段并发（读线上状态，偏保守）
    pub prepare_concurrency: usize,
    /// 执行阶段并发（硬上限见 `runner::MAX_CONCURRENCY`）
    pub publish_concurrency: usize,
    /// 改完镜像后每项的轮询间隔与上限：宁可判失败让用户重试，也不无限挂着。
    pub poll_interval_secs: u64,
    pub max_wait_polls: u32,
}

/// 微服务发布：从发布说明里读出服务与目标镜像，先取线上版本，再逐项改镜像。
pub const TASK_RELEASE: TaskDef = TaskDef {
    key: "release",
    label: "微服务发布",
    envs: &[Env::Test, Env::Prod],
    prepare_concurrency: 5,
    publish_concurrency: 10,
    poll_interval_secs: 10,
    max_wait_polls: 60,
};

pub const TASKS: &[TaskDef] = &[TASK_RELEASE];

pub fn task_def(key: &str) -> Option<&'static TaskDef> {
    TASKS.iter().find(|t| t.key == key)
}

/// 给界面渲染任务选择与环境开关用；不含任何凭据或站点地址。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub key: &'static str,
    pub label: &'static str,
    pub envs: Vec<&'static str>,
    pub prepare_concurrency: usize,
    pub publish_concurrency: usize,
    /// 尝试次数上限也由后端说一句话：界面不能自己抄一份数字（抄了就会漂移）。
    pub max_attempts: i64,
}

pub fn summaries() -> Vec<TaskSummary> {
    TASKS
        .iter()
        .map(|t| TaskSummary {
            key: t.key,
            label: t.label,
            envs: t.envs.iter().map(|e| e.as_str()).collect(),
            prepare_concurrency: t.prepare_concurrency,
            publish_concurrency: t.publish_concurrency,
            max_attempts: runner::MAX_ATTEMPTS,
        })
        .collect()
}

/// 浮层全局搜索用：按任务名与任务键匹配定义，命中的每一档环境各成一行。
///
/// 只有定义、没有运行历史（交付方 2026-11-02 定的口径）。分成两行是因为 `ReleasePage` 的环境是
/// 单选开关——跳过去要落到哪一档必须在浮层这一行就说死，不能到了页面再让人自己切。
/// 名字匹配的是 `label` 与 `key`：环境中文名（测试/生产）只活在前端 `ENVS` 里，
/// 这里不复述一份，免得两处标签漂移。
pub fn search_defs(q: &str) -> Vec<(&'static TaskDef, Env)> {
    let needle = q.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    TASKS
        .iter()
        .flat_map(|t| t.envs.iter().map(move |e| (t, *e)))
        .filter(|(t, _)| {
            t.label.to_lowercase().contains(&needle) || t.key.to_lowercase().contains(&needle)
        })
        .collect()
}

/// 日志里需要抹掉值的字段名（大小写不敏感，按词边界匹配，`token_count` 不算）。
const SENSITIVE_KEYS: &[&str] = &[
    "cookie",
    "set-cookie",
    "authorization",
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
];

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn find_sensitive_key(lower: &str, from: usize) -> Option<usize> {
    let bytes = lower.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        if lower.is_char_boundary(i) && (i == 0 || !is_word_byte(bytes[i - 1])) {
            for key in SENSITIVE_KEYS {
                if lower[i..].starts_with(key) {
                    let end = i + key.len();
                    if end >= bytes.len() || !is_word_byte(bytes[end]) {
                        return Some(i);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// 日志/消息落库前的最后一道脱敏：`Cookie:`、`Authorization:`、`password=` 这类字段的值
/// 一律替换成 `***`。它是兜底，不是许可证——调用方本来就不该把秘密拼进日志。
pub fn redact(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;
    let mut guard = 0usize;
    while let Some(start) = find_sensitive_key(&lower, cursor) {
        guard += 1;
        if guard > 64 {
            // 输入里塞满敏感字段名时也不让循环失控：剩下的原样截断，不再尝试匹配。
            out.push_str(&input[cursor..]);
            return out;
        }
        let key = SENSITIVE_KEYS
            .iter()
            .find(|k| lower[start..].starts_with(**k))
            .copied()
            .unwrap_or_default();
        let key_end = start + key.len();
        let mut j = key_end;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            j += 1;
        }
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        if j >= bytes.len() || (bytes[j] != b':' && bytes[j] != b'=') {
            // 只是提到了这个字段名，没有值可抹：原样保留，继续往后找。
            out.push_str(&input[cursor..key_end]);
            cursor = key_end;
            continue;
        }
        j += 1;
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            j += 1;
        }
        out.push_str(&input[cursor..j]);
        out.push_str("***");
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            let quote = bytes[j];
            j += 1;
            while j < bytes.len() && bytes[j] != quote {
                j += 1;
            }
            if j < bytes.len() {
                j += 1;
            }
        } else {
            // 不把空格当分隔符：`Authorization: Bearer <token>` 的值本身带空格，
            // 停在空格上就会把令牌的正文漏出去。宁可多抹，不可少抹。
            while j < bytes.len()
                && !matches!(bytes[j], b';' | b'&' | b',' | b'\n' | b'\r' | b'"' | b'\'')
            {
                j += 1;
            }
        }
        cursor = j;
    }
    out.push_str(&input[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_cookie_and_authorization_values() {
        let s = redact("Cookie: SESSION=abc123; theme=dark");
        assert!(s.contains("***"), "{s}");
        assert!(!s.contains("abc123"), "{s}");
        assert!(s.contains("theme=dark"), "只抹值，不动后面的其它字段：{s}");
        let s = redact("Authorization: Bearer eyJhbGciOi");
        assert!(!s.contains("eyJhbGciOi"), "{s}");
    }

    #[test]
    fn redact_masks_json_and_form_passwords() {
        assert_eq!(redact(r#"{"password":"hunter2"}"#), r#"{"password":***}"#);
        assert!(!redact("pwd=Secret#1&user=zhang").contains("Secret#1"));
        assert!(!redact("Set-Cookie: a=b").contains("a=b"));
    }

    #[test]
    fn redact_leaves_ordinary_text_alone() {
        for s in [
            "开始读取发布信息：3 项",
            "token_count=5",       // 词边界：不是 token 字段
            "密码没有出现在这里",   // 中文说明不该被误伤
            "https://edas.example/api?x=1",
        ] {
            assert_eq!(redact(s), s);
        }
    }

    #[test]
    fn task_registry_is_consistent() {
        assert!(task_def("release").is_some());
        assert!(task_def("nope").is_none());
        let t = task_def("release").unwrap();
        assert!(t.envs.contains(&Env::Test) && t.envs.contains(&Env::Prod));
        assert!(t.prepare_concurrency <= runner::MAX_CONCURRENCY);
        assert!(t.publish_concurrency <= runner::MAX_CONCURRENCY);
        assert!(t.max_wait_polls > 0 && t.poll_interval_secs > 0);
        assert_eq!(Env::parse("prod"), Some(Env::Prod));
        assert_eq!(Env::parse("PROD"), None);
        // 界面显示的尝试上限必须由后端说一句话
        let summaries = summaries();
        assert_eq!(summaries.len(), TASKS.len());
        assert_eq!(summaries[0].max_attempts, runner::MAX_ATTEMPTS);
        assert_eq!(summaries[0].envs, vec!["test", "prod"]);
    }
}
