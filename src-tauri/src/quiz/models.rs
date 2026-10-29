//! 题库领域模型：题型、答案形状、解析产物与前端 DTO。
//!
//! 答案一律用枚举而不是一段原文：判断题的 "对/√/T/正确" 在题库里能出现七八种写法，
//! 存原文会让匹配层每次重新猜；枚举在**导入时**就裁定，后面只认 `true`/`false`。

use serde::{Deserialize, Serialize};

/// 题型。字符串值与 `quiz_questions.qtype` 的 CHECK 约束逐字一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QType {
    Single,
    Multiple,
    TrueFalse,
    FillBlank,
}

impl QType {
    pub fn as_str(self) -> &'static str {
        match self {
            QType::Single => "single",
            QType::Multiple => "multiple",
            QType::TrueFalse => "true_false",
            QType::FillBlank => "fill_blank",
        }
    }

    /// 解析题型标识。接受中英文别名，其余一律 None（交给调用方决定是报错还是推断）。
    pub fn parse(raw: &str) -> Option<QType> {
        let t = raw.trim().to_ascii_lowercase();
        match t.as_str() {
            "single" | "single_choice" | "单选" | "单选题" | "单项选择" | "单项选择题" => Some(QType::Single),
            "multiple" | "multi" | "multiple_choice" | "多选" | "多选题" | "多项选择" | "多项选择题" => {
                Some(QType::Multiple)
            }
            "true_false" | "judge" | "boolean" | "判断" | "判断题" | "是非题" => Some(QType::TrueFalse),
            "fill_blank" | "fill" | "blank" | "填空" | "填空题" => Some(QType::FillBlank),
            _ => None,
        }
    }
}

/// 选项：键固定为单个大写字母 A–H。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizOption {
    pub key: String,
    pub text: String,
}

/// 裁定后的答案。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuizAnswer {
    Choice { keys: Vec<String> },
    Bool { value: bool },
    Text { blanks: Vec<String> },
}

impl QuizAnswer {
    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 上屏与导出用的中文形式。匹配层不看它，只看 `norm()`。
    pub fn display(&self) -> String {
        match self {
            QuizAnswer::Choice { keys } => keys.join("、"),
            QuizAnswer::Bool { value } => (if *value { "正确" } else { "错误" }).to_string(),
            QuizAnswer::Text { blanks } => blanks.join("；"),
        }
    }

    /// 归一化答案：参与「文内重复」判定与匹配的答案一致性检查。
    pub fn norm(&self) -> String {
        match self {
            QuizAnswer::Choice { keys } => keys.join(""),
            QuizAnswer::Bool { value } => (if *value { "true" } else { "false" }).to_string(),
            QuizAnswer::Text { blanks } => crate::quiz::parse::normalize::normalize_text(&blanks.join(" ")),
        }
    }
}

/// 解析器交出来的一行题目（尚未落库）。`confidence` 与 `issues` 只描述这一行的可复核程度，
/// 不参与匹配打分。
#[derive(Debug, Clone)]
pub struct ParsedQuestion {
    pub qtype: QType,
    pub stem: String,
    pub options: Vec<QuizOption>,
    pub answer: QuizAnswer,
    pub tags: Vec<String>,
    pub confidence: f64,
    /// 问题码（`missing_answer` 这一套）。界面把它翻成中文，审计与日志只记数量不记正文。
    pub issues: Vec<String>,
    pub source_ref: Option<String>,
    /// 复核时的默认勾选状态。文内重复的题由解析器置 false，其余一律 true。
    pub include: bool,
}

/// 题库列表行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizLibraryDto {
    pub id: String,
    pub name: String,
    pub source_format: String,
    pub source_filename: String,
    pub question_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 题库详情里的一题。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizQuestionDto {
    pub id: String,
    pub library_id: String,
    pub seq: i64,
    pub qtype: String,
    pub stem: String,
    pub options: Vec<QuizOption>,
    pub answer_display: String,
    pub tags: Vec<String>,
    pub confidence: f64,
    pub issues: Vec<String>,
    pub source_ref: Option<String>,
}

/// 分页容器：与账号台账同一形状，界面复用同一套分页控件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: i64,
}

/// 导入任务摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobDto {
    pub id: String,
    pub library_name: String,
    pub source_format: String,
    pub source_filename: String,
    pub status: String,
    pub total_rows: i64,
    pub included_rows: i64,
    pub issue_rows: i64,
    pub error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub published_library_id: Option<String>,
}

/// 复核表里的一行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowDto {
    pub id: String,
    pub seq: i64,
    pub qtype: String,
    pub stem: String,
    pub options: Vec<QuizOption>,
    pub answer_display: String,
    pub tags: Vec<String>,
    pub confidence: f64,
    pub issues: Vec<String>,
    pub source_ref: Option<String>,
    pub include: bool,
    pub edited: bool,
}

/// `quiz_import_job` 的返回体：摘要 + 当前页的行。
///
/// 复核表按页取。整表一次铺开在 4,341 行的任务上实测要 3.7–4.5s 才画完一屏，
/// 勾一行重画整表也是这个量级；`rows` 只带当前页，`total` 是**当前筛选**下的行数
/// （任务总行数看 `job.total_rows`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobDetail {
    pub job: ImportJobDto,
    pub rows: Vec<ImportRowDto>,
    pub total: i64,
}

/// 单行编辑的结果：改后的那行 + 摘要（计数已刷新）。
///
/// 界面拿这一行就地替换缓存：当前页只有几十行，但「这一改是不是还落在筛选项里」
/// （只看有问题时问题码被清空）只有拿到改后的行才判得了。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowUpdated {
    pub row: ImportRowDto,
    pub job: ImportJobDto,
}

/// 逐行编辑的补丁。字段全部可选：只改传了的那些。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowPatch {
    pub qtype: Option<String>,
    pub stem: Option<String>,
    pub options: Option<Vec<QuizOption>>,
    /// 答案按用户看到的文本交回（"A"、"AC"、"正确"、"北京；上海"），服务端重新裁定。
    pub answer_text: Option<String>,
    pub tags: Option<Vec<String>>,
    pub include: Option<bool>,
}
