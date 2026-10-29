//! 台账批量导入 / 导出。
//!
//! 导入：先预览（逐行校验、错误定位到行号、冲突检测），确认后落库。
//! 预览与提交之间用文件内容摘要绑定：文件被改动过必须重新预览。
//! 错误信息只写行号、字段和错误码含义，绝不把单元格原文（可能是口令）复制进库或日志。
//!
//! 导出：三个出口，由 `format` 选。
//! - `container`（旧默认，含秘密时的缺省值）：产物是 AES-256-GCM 容器（口令经 Argon2id 派生密钥），
//!   不落明文，是跨设备迁移秘密的推荐形状。
//! - `csv` / `xlsx`：直接可读。列形状由 `shape` 选：`ledger` 是本台账的 18 列，
//!   `browser` 是 Chrome / Edge 口令管理器那五列（`name,url,username,password,note`）。
//!   **交付方 2026-10-18 指定"导出保持和谷歌浏览器和 Edge 浏览器一样"**，因此这两个出口在
//!   勾选含秘密时写出**明文口令**——文件本身没有任何保护，这是有意接受的偏离
//!   （登记见 docs/交付状态与验收.md §9）。闸门不变：仍过二次认证门，审计仍只记文件名与摘要。
//!
//! 容器的另一半在 `open_container`/`container_commit`：口令独立派生密钥，与设备密钥无关，
//! 所以它是"设备密钥丢失后唯一还能把台账重建出来"的产物（`.mdbak` 的密钥是从设备密钥派生的，
//! 那种情况下一起打不开）。导入容器复用与 CSV 完全相同的逐行落库路径，
//! 秘密在本机重新用当前保险库密钥加密——容器里的口令不会原样进库，也不进日志。

use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::crypto::kdf::{self, KdfParams};
use crate::crypto::vault_key::VaultKey;
use crate::db::{repo, Db};
use crate::error::{AppError, Result};

/// 导入模板列（中文表头）。英文别名在导入时同样接受。
pub const IMPORT_COLUMNS: &[&str] = &[
    "目标名称", "目标类型", "地址", "精确Origin", "协议", "主机", "端口", "分组",
    "账号别名", "标签", "用户名", "密码", "令牌", "私钥", "私钥口令", "认证方式", "备注", "设为默认",
];

const HEADER_ALIASES: &[(&str, &str)] = &[
    ("display_name", "目标名称"), ("name", "目标名称"),
    ("target_type", "目标类型"), ("type", "目标类型"),
    ("url", "地址"), ("address", "地址"),
    ("allowed_origin", "精确Origin"), ("origin", "精确Origin"),
    ("protocol", "协议"), ("host", "主机"), ("port", "端口"), ("group", "分组"),
    ("account_alias", "账号别名"), ("alias", "账号别名"), ("tags", "标签"),
    ("username", "用户名"), ("password", "密码"), ("token", "令牌"),
    ("private_key", "私钥"), ("passphrase", "私钥口令"),
    ("auth_method", "认证方式"), ("note", "备注"), ("set_default", "设为默认"),
];

const COLUMN_ORDER: &[&str] = &[
    "目标名称", "目标类型", "地址", "精确Origin", "协议", "主机", "端口", "分组",
    "账号别名", "标签", "用户名", "密码", "令牌", "私钥", "私钥口令", "认证方式", "备注", "设为默认",
];

/// 浏览器口令管理器（Chrome / Edge）导出的那五列。保持英文表头是有意的：
/// `HEADER_ALIASES` 已经把这一组映射到内部列，所以一份真的从 Chrome 导出的文件
/// 能原样导进本台账，反向导出也能被 Chrome 认出来。
const BROWSER_COLUMNS: &[&str] = &["name", "url", "username", "password", "note"];

/// 导出产物格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Csv,
    Xlsx,
    Container,
}

impl ExportFormat {
    /// 缺省沿用旧语义：含秘密走容器、不含走 CSV。未传 `format` 的调用方（导入导出页）
    /// 产物因此逐字节不变，包括"含秘密时不可能拿到明文"这条旧保证。
    pub fn resolve(v: Option<&str>, include_secrets: bool) -> Result<ExportFormat> {
        let fmt = match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") => {
                if include_secrets {
                    ExportFormat::Container
                } else {
                    ExportFormat::Csv
                }
            }
            Some("csv") => ExportFormat::Csv,
            Some("xlsx") => ExportFormat::Xlsx,
            Some("container") | Some("mdaexport") => ExportFormat::Container,
            Some(_) => return Err(AppError::InvalidInput),
        };
        // 不含秘密的容器打不开也没意义：容器必须由口令派生密钥才能解。
        if fmt == ExportFormat::Container && !include_secrets {
            return Err(AppError::InvalidInput);
        }
        Ok(fmt)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::Xlsx => "xlsx",
            ExportFormat::Container => "mdaexport",
        }
    }
}

/// 导出列形状。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportShape {
    /// 本台账全量列（默认）
    Ledger,
    /// Chrome / Edge 那五列
    Browser,
}

impl ExportShape {
    pub fn resolve(v: Option<&str>) -> Result<ExportShape> {
        match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("ledger") | Some("app") => Ok(ExportShape::Ledger),
            Some("browser") | Some("chrome") | Some("edge") => Ok(ExportShape::Browser),
            Some(_) => Err(AppError::InvalidInput),
        }
    }

    /// 预览如实报出将要写出的列名。浏览器形状五列都在，未勾选明文口令时 `password` 是空值
    /// ——列集合保持稳定比"看着更安全"更有利于往返与核对。
    pub fn columns(self, include_secrets: bool) -> Vec<String> {
        match self {
            ExportShape::Browser => BROWSER_COLUMNS.iter().map(|s| s.to_string()).collect(),
            ExportShape::Ledger => {
                let mut cols: Vec<String> = COLUMN_ORDER.iter().map(|s| s.to_string()).collect();
                if !include_secrets {
                    for secret in ["密码", "令牌", "私钥", "私钥口令"] {
                        cols.retain(|c| c != secret);
                    }
                    cols.retain(|c| c != "用户名");
                }
                cols
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ImportRow {
    pub display_name: String,
    pub target_type: String,
    pub url: String,
    pub allowed_origin: String,
    pub protocol: String,
    pub host: String,
    pub port: String,
    pub group: String,
    pub account_alias: String,
    pub tags: String,
    pub username: String,
    pub password: String,
    pub token: String,
    pub private_key: String,
    pub passphrase: String,
    pub auth_method: String,
    pub note: String,
    pub set_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    pub row_no: usize,
    pub code: String,
    pub message: String,
    pub field: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub job_id: String,
    pub filename: String,
    /// 按内容识别出来的来源格式（csv / xlsx），界面那句"已识别为 …"要说真话
    pub file_format: String,
    pub total_rows: usize,
    pub valid_rows: usize,
    pub error_rows: usize,
    pub conflict_rows: usize,
    pub new_targets: usize,
    pub columns: Vec<String>,
    pub errors: Vec<RowError>,
    /// 冲突摘要：只给行号与目标名，不给凭据内容
    pub conflicts: Vec<ConflictHint>,
    pub truncated: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictHint {
    pub row_no: usize,
    pub target_name: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub job_id: String,
    pub imported_rows: usize,
    pub created_targets: usize,
    pub created_items: usize,
    pub skipped_rows: usize,
    pub conflict_rows: usize,
    pub errors: Vec<RowError>,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub targets: usize,
    pub items: usize,
    pub include_secrets: bool,
    pub format: String,
    pub columns: Vec<String>,
    pub warning: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: usize,
    pub items: usize,
    pub format: String,
    pub encrypted: bool,
    pub sha256: String,
    pub message: String,
}

const MAX_REPORTED_ERRORS: usize = 200;

fn normalize_header(h: &str) -> String {
    let key = h.trim().to_string();
    for (alias, cn) in HEADER_ALIASES {
        if key.eq_ignore_ascii_case(alias) {
            return (*cn).to_string();
        }
    }
    key
}

/// 一行的来源形状。浏览器口令管理器导出的文件没有"目标类型"和"账号别名"两列，
/// 这两项在导入时由地址前缀与用户名推断出来（见 `apply_browser_shape`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportShape {
    Ledger,
    Browser,
}

impl ImportShape {
    fn required_columns(self) -> &'static [&'static str] {
        match self {
            ImportShape::Ledger => &["目标名称", "目标类型", "账号别名"],
            // 浏览器形状只要求认得出地址与用户名，其余列可缺
            ImportShape::Browser => &["目标名称", "地址"],
        }
    }
}

/// 表头判定。认成浏览器形状的条件刻意收得窄：**类型列与别名列同时缺席**、且地址与用户名两列在场。
/// 只缺别名列的台账文件因此照旧报 `MISSING_COLUMN`，不会因为形状识别而绕过必需列闸门。
fn import_shape_of(headers: &[String]) -> ImportShape {
    let has = |n: &str| headers.iter().any(|h| h == n);
    if !has("目标类型") && !has("账号别名") && has("地址") && has("用户名") {
        ImportShape::Browser
    } else {
        ImportShape::Ledger
    }
}

/// 一行网格：要么是单元格，要么是"这一行本身读不出来"（CSV 的引号不成对等）。
enum GridRow {
    Cells(Vec<String>),
    Malformed,
}

/// 表头 + 网格 → 结构行与逐行校验结果。CSV 与 xlsx 共用这一份，
/// 保证两种来源的必需列判定、`'` 前缀还原、行号起算与冲突语义完全一致。
/// 列数不足时按空串处理（`get_raw` 越界返回 ""），与 CSV 的 `flexible(true)` 同口径。
fn build_rows(raw_headers: &[String], rows: Vec<GridRow>) -> std::result::Result<(Vec<(ImportRow, Vec<RowError>)>, Vec<String>), RowError> {
    let headers: Vec<String> = raw_headers.iter().map(|h| normalize_header(h.trim())).collect();
    let shape = import_shape_of(&headers);
    for required in shape.required_columns() {
        if !headers.iter().any(|h| h == required) {
            return Err(RowError {
                row_no: 0,
                code: "MISSING_COLUMN".into(),
                message: format!("缺少必需列「{required}」"),
                field: Some(required.to_string()),
            });
        }
    }
    let mut out = Vec::new();
    for (idx, rec) in rows.into_iter().enumerate() {
        let row_no = idx + 2; // 表头占第 1 行
        let cells: Vec<String> = match rec {
            GridRow::Cells(c) => c,
            GridRow::Malformed => {
                out.push((
                    ImportRow::default(),
                    vec![RowError { row_no, code: "BAD_ROW".into(), message: "该行字段数量与表头不一致，已跳过".into(), field: None }],
                ));
                continue;
            }
        };
        let cells = cells.as_slice();
        let get_raw = |name: &str| -> String {
            headers
                .iter()
                .position(|h| h == name)
                .and_then(|i| cells.get(i))
                .map(String::as_str)
                .unwrap_or("")
                .to_string()
        };
        // 导出侧会给以 = + - @ 等开头的非秘密单元格加 `'` 前缀防公式注入；
        // 导入时按列还原。秘密列绝不还原——真实口令本身可能以引号开头。
        let get = |name: &str| -> String {
            let v = get_raw(name);
            if matches!(name, "密码" | "令牌" | "私钥" | "私钥口令") {
                v
            } else {
                v.strip_prefix('\'').map(str::to_string).unwrap_or(v)
            }
        };
        let mut row = ImportRow {
            display_name: get("目标名称"),
            target_type: get("目标类型"),
            url: get("地址"),
            allowed_origin: get("精确Origin"),
            protocol: get("协议"),
            host: get("主机"),
            port: get("端口"),
            group: get("分组"),
            account_alias: get("账号别名"),
            tags: get("标签"),
            username: get("用户名"),
            password: get("密码"),
            token: get("令牌"),
            private_key: get("私钥"),
            passphrase: get("私钥口令"),
            auth_method: get("认证方式"),
            note: get("备注"),
            set_default: matches!(get("设为默认").as_str(), "是" | "true" | "1" | "yes" | "Y" | "y"),
        };
        if shape == ImportShape::Browser {
            apply_browser_shape(&mut row);
        }
        let errors = validate_row(row_no, &row);
        out.push((row, errors));
    }
    Ok((out, headers))
}

/// 浏览器形状的行补齐内部必填项：类型从地址前缀推断、别名取用户名、名称缺失时用主机名兜底。
/// 三项都是从文件里已有的内容推出来的，不是凭空造的凭据。
/// Chrome 的 `url` 列是 `https://host/` 这种带尾部斜杠的形式，与库里的存法不冲突（地址不是唯一键）。
fn apply_browser_shape(row: &mut ImportRow) {
    let addr = row.url.trim().to_string();
    if !addr.is_empty() {
        let scheme = addr.split(':').next().unwrap_or("").to_ascii_lowercase();
        match scheme.as_str() {
            "https" | "http" => row.target_type = "web".into(),
            "ssh" | "sftp" | "ftp" | "telnet" | "rdp" | "vnc" => row.target_type = "terminal".into(),
            "mysql" | "postgresql" | "oracle" | "sqlserver" | "jdbc" => row.target_type = "database".into(),
            // 没有协议前缀（`10.0.0.22:22` 这类裸主机）：整列当主机用，否则 validate_row
            // 会把 `10.0.0.22` 当协议名拒绝。地址列清空，让"地址与主机至少填一项"由主机满足。
            _ => {
                let (host, port) = match addr.rsplit_once(':') {
                    Some((h, p)) if !h.is_empty() && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
                    _ => (addr.as_str(), None),
                };
                row.host = host.to_string();
                if let Some(p) = port {
                    row.port = p.to_string();
                }
                row.url = String::new();
                row.target_type = "terminal".into();
            }
        }
    } else if !row.host.trim().is_empty() {
        row.target_type = "terminal".into();
    }
    if row.account_alias.trim().is_empty() {
        row.account_alias = if row.username.trim().is_empty() {
            "默认账号".to_string()
        } else {
            row.username.trim().to_string()
        };
    }
    if row.display_name.trim().is_empty() {
        row.display_name = host_label(&addr);
    }
}

/// 从地址取一个能当目标名的主机标签；推不出来时返回空串，交给 `MISSING_DISPLAY_NAME` 报错。
fn host_label(addr: &str) -> String {
    let rest = addr.split_once("://").map(|(_, r)| r).unwrap_or(addr);
    let cut = rest.find(['/', ':']).unwrap_or(rest.len());
    rest[..cut].trim().to_string()
}

/// 解析 CSV 文本为结构行 + 逐行校验结果。不落库，可安全反复调用。
pub fn parse_csv(text: &str) -> std::result::Result<(Vec<(ImportRow, Vec<RowError>)>, Vec<String>), RowError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let raw_headers: Vec<String> = rdr
        .headers()
        .map_err(|_| RowError { row_no: 0, code: "BAD_HEADER".into(), message: "表头无法解析：请使用模板首行".into(), field: None })?
        .iter()
        .map(String::from)
        .collect();
    let rows = rdr
        .records()
        .map(|r| match r {
            Ok(rec) => GridRow::Cells(rec.iter().map(String::from).collect()),
            Err(_) => GridRow::Malformed,
        })
        .collect();
    build_rows(&raw_headers, rows)
}

fn bad_sheet(message: &str) -> RowError {
    RowError { row_no: 0, code: "BAD_SHEET".into(), message: message.to_string(), field: None }
}

/// 解析 xlsx 字节为结构行：只读第一个工作表，只取字符串。
/// 数字走 `Data` 的 Display（端口 3306 读成 `3306`），公式单元格取不到计算值时按空串处理，
/// 因此**带公式的表格请先在 Excel 里转成值再导**——本应用不解释公式，也不执行公式。
pub fn parse_xlsx(bytes: &[u8]) -> std::result::Result<(Vec<(ImportRow, Vec<RowError>)>, Vec<String>), RowError> {
    use calamine::Reader as _;
    let mut wb = calamine::Xlsx::new(std::io::Cursor::new(bytes)).map_err(|_| bad_sheet("xlsx 无法读取：请用 Excel/WPS 另存为标准 .xlsx 后再导入"))?;
    let range = wb
        .worksheet_range_at(0)
        .ok_or_else(|| bad_sheet("工作簿里没有工作表"))?
        .map_err(|_| bad_sheet("第一个工作表读取失败"))?;
    if range.is_empty() {
        return Err(bad_sheet("第一个工作表是空的：至少需要一行表头"));
    }
    let mut grid: Vec<Vec<String>> = range.rows().map(|row| row.iter().map(cell_text).collect()).collect();
    let raw_headers = grid.remove(0);
    build_rows(&raw_headers, grid.into_iter().map(GridRow::Cells).collect())
}

fn cell_text(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::Empty => String::new(),
        other => other.to_string().trim().to_string(),
    }
}

fn validate_row(row_no: usize, r: &ImportRow) -> Vec<RowError> {
    let mut errs = Vec::new();
    if r.display_name.trim().is_empty() {
        errs.push(RowError { row_no, code: "MISSING_DISPLAY_NAME".into(), message: "目标名称不能为空".into(), field: Some("目标名称".into()) });
    }
    if r.display_name.chars().count() > 120 {
        errs.push(RowError { row_no, code: "DISPLAY_NAME_TOO_LONG".into(), message: "目标名称超过 120 个字符".into(), field: Some("目标名称".into()) });
    }
    if !repo::ALL_TYPES.contains(&r.target_type.as_str()) {
        errs.push(RowError {
            row_no,
            code: "UNKNOWN_TYPE".into(),
            message: format!("目标类型「{}」不在允许列表内", if r.target_type.is_empty() { "（空）" } else { &r.target_type }),
            field: Some("目标类型".into()),
        });
    }
    if r.url.trim().is_empty() && r.host.trim().is_empty() {
        errs.push(RowError { row_no, code: "NO_ADDRESS".into(), message: "地址与主机至少填一项".into(), field: Some("地址".into()) });
    }
    if !r.url.trim().is_empty() {
        let scheme = r.url.split(':').next().unwrap_or("").to_lowercase();
        if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "sftp" | "ftp" | "telnet" | "rdp" | "vnc" | "mysql" | "postgresql" | "oracle" | "sqlserver" | "jdbc") {
            errs.push(RowError { row_no, code: "BAD_SCHEME".into(), message: "地址前缀不是可识别的协议".into(), field: Some("地址".into()) });
        }
    }
    if !r.allowed_origin.trim().is_empty() && !r.allowed_origin.starts_with("https://") && !r.allowed_origin.starts_with("http://") {
        errs.push(RowError { row_no, code: "BAD_ORIGIN".into(), message: "自动填充 Origin 必须是 http:// 或 https:// 开头的精确 Origin".into(), field: Some("精确Origin".into()) });
    }
    if r.account_alias.trim().is_empty() {
        errs.push(RowError { row_no, code: "EMPTY_ALIAS".into(), message: "账号别名不能为空（同一地址允许多个账号，靠别名区分）".into(), field: Some("账号别名".into()) });
    }
    if r.port.trim().is_empty() {
        // 端口可空；给了值必须是数字
    } else if r.port.parse::<u16>().is_err() {
        errs.push(RowError { row_no, code: "BAD_PORT".into(), message: "端口必须是 1-65535 的数字".into(), field: Some("端口".into()) });
    }
    if !r.password.is_empty() && r.password.chars().count() > 512 {
        errs.push(RowError { row_no, code: "SECRET_TOO_LONG".into(), message: "口令长度超出允许范围".into(), field: Some("密码".into()) });
    }
    errs
}

fn job_id_for(path: &Path, bytes: &[u8]) -> String {
    let _ = path;
    format!("imp_{}", &crate::backup::sha256_hex(bytes)[..16])
}

/// 名称查重那条 SQL。它是**契约面**，不是实现细节：
/// `migrations/0005_target_name_index.sql` 建的表达式索引只对这条查询的形状有效（比较的是 `lower(display_name)`），
/// 改了文案而忘了同步索引，代价是每次导入退化成全表扫描，而且没有任何测试会红。
/// 所以 `db::migrate` 的守卫测试与 `tests/import_scale.rs` 都引用这里，不再各自复制一份。
pub const DEDUP_BY_NAME_SQL: &str =
    "SELECT id FROM vault_targets WHERE lower(display_name)=?1 AND status='active' AND deleted_at IS NULL LIMIT 1";

/// 已有目标的查重表。地址在库中是加密列，因此地址查重依赖调用方传入的
/// 解密后的内存索引（由 commands 层从 SearchIndex 构造），名称查重走 SQL。
#[derive(Default)]
pub struct TargetLookup {
    by_addr: std::collections::HashMap<String, String>,
}

impl TargetLookup {
    /// docs: (target_id, address, host)
    pub fn new(rows: impl IntoIterator<Item = (String, String, String)>) -> Self {
        let mut by_addr = std::collections::HashMap::new();
        for (id, addr, host) in rows {
            let a = normalize_addr(&addr);
            if !a.is_empty() {
                by_addr.entry(a).or_insert_with(|| id.clone());
            }
            let h = normalize_addr(&host);
            if !h.is_empty() {
                by_addr.entry(h).or_insert_with(|| id.clone());
            }
        }
        Self { by_addr }
    }

    fn find(db: &Db, lk: &Self, name: &str, url: &str, host: &str) -> Result<Option<String>> {
        let norm_name = name.trim().to_lowercase();
        if !norm_name.is_empty() {
            let by_name: Option<String> = db.lock_conn()
                .query_row(DEDUP_BY_NAME_SQL, params![norm_name], |r| r.get(0))
                .unwrap_or(None);
            if by_name.is_some() {
                return Ok(by_name);
            }
        }
        let needle = if !url.trim().is_empty() { normalize_addr(url) } else { normalize_addr(host) };
        if needle.is_empty() {
            return Ok(None);
        }
        Ok(lk.by_addr.get(&needle).cloned())
    }
}

/// 预览：解析 + 冲突检测 + 把任务与错误写入 import_jobs / import_job_errors（可追溯）。
/// 按内容识别来源格式（交付方要求"导入自动识别格式"）：`PK\x03\x04` 是 xlsx 的 zip 容器头，
/// OLE 复合文档头是旧版 .xls（calamine 读得了，但界面只承诺 CSV/XLSX，所以给出可执行的指引），
/// 其余按 UTF-8 文本走 CSV。以内容为准而不是以后缀名为准：改名、压缩包解出来的临时文件
/// 都会让后缀说谎，而"预览说能导入、提交时炸掉"是最难解释的失败。
fn parse_upload(bytes: &[u8]) -> Result<(Vec<(ImportRow, Vec<RowError>)>, Vec<String>, &'static str)> {
    if bytes.starts_with(b"PK\x03\x04") {
        let (rows, headers) = parse_xlsx(bytes).map_err(|e| AppError::QuerySyntax(e.message))?;
        return Ok((rows, headers, "xlsx"));
    }
    if bytes.starts_with(b"\xd0\xcf\x11\xe0") {
        return Err(AppError::FileFormatInvalid);
    }
    let raw = String::from_utf8(bytes.to_vec()).map_err(|_| AppError::FileFormatInvalid)?;
    let (rows, headers) = parse_csv(strip_bom(&raw)).map_err(|e| AppError::QuerySyntax(e.message))?;
    Ok((rows, headers, "csv"))
}

pub fn import_preview(db: &Db, actor: &str, path: &Path, lk: &TargetLookup) -> Result<ImportPreview> {
    let bytes = std::fs::read(path).map_err(|_| AppError::InvalidInput)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(AppError::InvalidInput);
    }
    let (rows, headers, file_format) = parse_upload(&bytes)?;
    let job_id = job_id_for(path, &bytes);
    let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    let mut errors: Vec<RowError> = Vec::new();
    let mut conflicts: Vec<ConflictHint> = Vec::new();
    let mut valid = 0usize;
    let mut new_targets = std::collections::HashSet::new();
    let mut seen_aliases = std::collections::HashSet::new();
    // 审查 F3 的预览那一半：判据与 write_import_row 里的完全同一个函数，
    // 目的是别让"预览说 12 行可导入、提交却少了 3 行"这种事发生。
    let allow_weak = crate::settings::get_bool(db, "allow_insecure_protocols", false);

    for (idx, (row, row_errs)) in rows.iter().enumerate() {
        let row_no = idx + 2;
        if !row_errs.is_empty() {
            errors.extend(row_errs.iter().cloned());
            continue;
        }
        if !allow_weak && repo::is_insecure_protocol(&resolved_type(row, None), &row.protocol) {
            errors.push(row_reject(
                row_no,
                "INSECURE_PROTOCOL",
                "该行协议是明文协议，需先在「系统管理 · 安全策略」里显式允许后才能导入",
                Some("协议"),
            ));
            continue;
        }
        // 同一文件内 (目标名称, 账号别名) 重复视为冲突
        let key = format!("{}::{}", row.display_name.trim().to_lowercase(), row.account_alias.trim().to_lowercase());
        if !seen_aliases.insert(key) {
            conflicts.push(ConflictHint {
                row_no,
                target_name: row.display_name.clone(),
                reason: "文件内同一目标下出现重复账号别名".to_string(),
            });
        }
        // 与库中已有目标比较：名称相同或规范化地址相同
        if TargetLookup::find(db, lk, &row.display_name, &row.url, &row.host)?.is_some() {
            conflicts.push(ConflictHint {
                row_no,
                target_name: row.display_name.clone(),
                reason: "台账中已存在同名或同地址目标；可选择复用该目标继续导入凭据".to_string(),
            });
        } else {
            new_targets.insert(row.display_name.trim().to_lowercase());
        }
        valid += 1;
    }
    let conflict_rows = conflicts.len();
    let error_rows = distinct_error_rows(&errors);
    let truncated = error_rows > MAX_REPORTED_ERRORS;
    let reported: Vec<RowError> = errors.iter().take(MAX_REPORTED_ERRORS).cloned().collect();

    let conn = db.lock_conn();
    let now = repo::now();
    conn.execute(
        "INSERT OR REPLACE INTO import_jobs (id,created_by,filename,file_format,status,conflict_policy,total_rows,valid_rows,error_rows,conflict_rows,imported_rows,created_at)
         VALUES (?1,?2,?3,?9,'preview','skip',?4,?5,?6,?7,0,?8)",
        params![job_id, actor, format!("{}|{}", filename, path.display()), rows.len() as i64, valid as i64, error_rows as i64, conflict_rows as i64, now, file_format],
    )?;
    conn.execute("DELETE FROM import_job_errors WHERE job_id=?1", params![job_id])?;
    for e in &reported {
        conn.execute(
            "INSERT INTO import_job_errors (id,job_id,row_no,code,message,field) VALUES (?1,?2,?3,?4,?5,?6)",
            params![uuid::Uuid::now_v7().to_string(), job_id, e.row_no as i64, e.code, e.message, e.field],
        )?;
    }
    drop(conn);

    Ok(ImportPreview {
        job_id,
        filename,
        file_format: file_format.to_string(),
        total_rows: rows.len(),
        valid_rows: valid,
        error_rows,
        conflict_rows,
        new_targets: new_targets.len(),
        columns: headers,
        errors: reported,
        conflicts,
        truncated,
        message: format!(
            "共 {} 行：可导入 {} 行，错误 {} 行，冲突 {} 行。错误已定位到行号；确认无误后再执行导入。",
            rows.len(),
            valid,
            error_rows,
            conflict_rows
        ),
    })
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn existing_target(db: &Db, lk: &TargetLookup, name: &str, url: &str, host: &str) -> Result<Option<String>> {
    TargetLookup::find(db, lk, name, url, host)
}

fn normalize_addr(s: &str) -> String {
    let mut v = s.trim().to_lowercase();
    for prefix in ["https://", "http://", "ssh://", "sftp://", "ftp://", "rdp://", "vnc://"] {
        if let Some(rest) = v.strip_prefix(prefix) {
            v = rest.to_string();
            break;
        }
    }
    for cut in ['/', '?', '#'] {
        if let Some(i) = v.find(cut) {
            v.truncate(i);
        }
    }
    v
}

/// 提交导入。conflict_policy：skip=跳过冲突行 / update=复用已有目标 / abort=有冲突即整体中止。
/// 一行落库的结果。CSV 导入与加密容器导入共用这一条写入路径，
/// 两条路必须给出完全相同的默认账号/分组/标签语义，所以不各写一份。
pub(crate) enum RowOutcome {
    /// 凭据已写入。`new_target` 表示这一行顺带新建了目标；
    /// `conflicted` 表示这一行复用的是**本次导入开始之前**就已在台账里的目标
    /// （预览阶段把它算作冲突，所以提交侧必须同样算，只是照常写入）。
    /// 本次运行内自己刚建出来的目标不算冲突——见 `RunTargets`。
    Written { new_target: bool, conflicted: bool },
    /// 目标已存在（或文件内别名重复）且冲突策略是 skip
    ConflictSkipped,
    /// 同上，冲突策略是 abort（调用方负责把任务标成中止）
    ConflictAbort,
    /// 这一行被拒绝（类型不在允许列表、或写入返回错误），带行级错误
    Rejected(RowError),
}

/// 本次导入运行内的两张备忘录：已经建出来/解析出来的目标，以及本运行内写过的 (目标, 别名)。
///
/// 为什么必须有它：一个目标挂多条凭据是台账的正常形态（错误文案里就写着"同一地址允许多个账号，
/// 靠别名区分"），而 `existing_target` 查的是**实时库**——从第 2 行起，它会查到第 1 行刚刚建出来的
/// 那个目标，于是这一行被当成"与台账冲突"，在 skip 下被丢弃、在 abort 下让整次导入停在第 2 行。
/// 预览阶段并不这么判（它只把"文件内重复别名"与"导入前已存在的目标"算冲突），
/// 两边口径不一致的后果是：预览报"1000 行全部有效、0 冲突"，提交却只写进 200 条。
#[derive(Default)]
pub(crate) struct RunTargets {
    by_name: std::collections::HashMap<String, String>,
    aliases: std::collections::HashSet<String>,
}

impl RunTargets {
    fn name_key(name: &str) -> String {
        name.trim().to_lowercase()
    }
    fn alias_key(name: &str, alias: &str) -> String {
        format!("{}::{}", Self::name_key(name), alias.trim().to_lowercase())
    }
    fn target_of(&self, name: &str) -> Option<&str> {
        self.by_name.get(&Self::name_key(name)).map(|s| s.as_str())
    }
    fn remember_target(&mut self, name: &str, target_id: &str) {
        self.by_name
            .entry(Self::name_key(name))
            .or_insert_with(|| target_id.to_string());
    }
    /// 首次出现返回 false 并登记；已出现过返回 true（=文件内重复别名）。
    fn note_alias(&mut self, name: &str, alias: &str) -> bool {
        !self.aliases.insert(Self::alias_key(name, alias))
    }
}

/// "错误 N 行"必须按**行**数，不是按错误条数：一行可以同时缺名称和别名（两个 RowError），
/// 原先各处直接 `errors.len()`，于是界面上"共 10 行：可导入 8 行，错误 3 行"这种对不上的账会出现。
/// （审查 F27/B12。`MAX_REPORTED_ERRORS` 那一档判的是"列出来几条"，与行数无关，保持原样。）
fn distinct_error_rows(errors: &[RowError]) -> usize {
    errors.iter().map(|e| e.row_no).collect::<std::collections::HashSet<_>>().len()
}

fn row_reject(row_no: usize, code: &str, message: &str, field: Option<&str>) -> RowError {
    RowError { row_no, code: code.to_string(), message: message.to_string(), field: field.map(|f| f.to_string()) }
}

/// 一行的形态校验（名称 / 别名 / 类型）。CSV 在 parse 阶段已经做过同样的判定，
/// 但容器里的行来自外部 JSON，没有 parse 阶段——所以落库前两条路都要过这一份判定，
/// 免得多出一份"绕过校验的写入路径"。
fn row_shape_errors(row_no: usize, row: &ImportRow, default_type: Option<&str>) -> Vec<RowError> {
    let mut errs = Vec::new();
    if row.display_name.trim().is_empty() {
        errs.push(row_reject(row_no, "MISSING_DISPLAY_NAME", "目标名称不能为空", Some("目标名称")));
    }
    if row.account_alias.trim().is_empty() {
        errs.push(row_reject(row_no, "EMPTY_ALIAS", "账号别名不能为空（同一地址允许多个账号，靠别名区分）", Some("账号别名")));
    }
    let target_type = resolved_type(row, default_type);
    if !repo::ALL_TYPES.contains(&target_type.as_str()) {
        errs.push(row_reject(row_no, "UNKNOWN_TYPE", "目标类型不在允许列表内", Some("目标类型")));
    }
    errs
}

fn resolved_type(row: &ImportRow, default_type: Option<&str>) -> String {
    if row.target_type.is_empty() { default_type.unwrap_or("web").to_string() } else { row.target_type.clone() }
}

/// 写一行：解析类型 → 找/建目标 → 建凭据。行号只用于错误定位（容器导入从 1 起算，CSV 从 2 起算）。
pub(crate) fn write_import_row(
    db: &Db,
    vk: &VaultKey,
    actor: &str,
    row: &ImportRow,
    conflict_policy: &str,
    default_type: Option<&str>,
    lk: &TargetLookup,
    run: &mut RunTargets,
) -> Result<RowOutcome> {
    if let Some(first) = row_shape_errors(0, row, default_type).into_iter().next() {
        return Ok(RowOutcome::Rejected(first));
    }
    let target_type = resolved_type(row, default_type);
    // 审查 F3：`allow_insecure_protocols` 这道闸门原先**只在交互新建/编辑目标时判**
    // （commands/accounts.rs 的两处），导入这条路直接建目标——写着 `telnet` / `ftp` 的一份
    // CSV 或容器，能在策略关闭的情况下把明文协议目标灌进台账。判据与交互侧必须是同一个函数，
    // 而这里就是唯一的写入闸门：CSV 提交与容器提交都经过本函数，一处收口两条路。
    if !crate::settings::get_bool(db, "allow_insecure_protocols", false)
        && repo::is_insecure_protocol(&target_type, &row.protocol)
    {
        return Ok(RowOutcome::Rejected(row_reject(
            0,
            "INSECURE_PROTOCOL",
            "该行协议是明文协议，需先在「系统管理 · 安全策略」里显式允许后才能导入",
            Some("协议"),
        )));
    }
    // 先登记这一行的 (目标, 别名)：返回 true 表示**同一个文件里**这一对已经出现过，
    // 这正是预览阶段报"文件内同一目标下出现重复账号别名"的那一行。
    let dup_in_file = run.note_alias(&row.display_name, &row.account_alias);
    // 再判断这个目标的来路。本次运行内刚建出来的目标不算"与台账冲突"，
    // 否则一个目标就只能导进一条账号（见 `RunTargets` 的说明）。
    enum Found {
        ThisRun(String),
        Preexisting(String),
        Absent,
    }
    let found = match run.target_of(&row.display_name) {
        Some(id) => Found::ThisRun(id.to_string()),
        None => match existing_target(db, lk, &row.display_name, &row.url, &row.host)? {
            Some(id) => Found::Preexisting(id),
            None => Found::Absent,
        },
    };
    let (target_id, new_target, conflicted) = match found {
        Found::ThisRun(id) => (id, false, false),
        Found::Preexisting(id) => (id, false, true),
        Found::Absent => (String::new(), true, false),
    };
    let (target_id, new_target, conflicted) = if new_target {
        // 台账里没有、本次也没建过 → 这一行负责建目标
        let group_id = if row.group.trim().is_empty() {
            None
        } else {
            Some(find_or_create_group(db, actor, row.group.trim())?)
        };
        let meta = repo::TargetSecretPayload {
            url: row.url.clone(),
            allowed_origin: row.allowed_origin.clone(),
            protocol: row.protocol.clone(),
            host: row.host.clone(),
            port: row.port.clone(),
            ..Default::default()
        };
        let nt = repo::NewTarget {
            target_type: target_type.clone(),
            display_name: row.display_name.clone(),
            group_id,
            meta,
        };
        let id = repo::create_target(db, vk, actor, &nt)?;
        run.remember_target(&row.display_name, &id);
        (id, true, false)
    } else if conflicted || dup_in_file {
        // 冲突策略在这里生效：目标是导入前就有的，或这一对 (目标, 别名) 在文件里重复
        match conflict_policy {
            "skip" => return Ok(RowOutcome::ConflictSkipped),
            "abort" => return Ok(RowOutcome::ConflictAbort),
            _ => (target_id, false, conflicted), // update：复用已有目标，只新增凭据
        }
    } else {
        (target_id, false, false)
    };

    let payload = repo::CredentialPayload {
        username: row.username.clone(),
        password: crate::crypto::SecretString::new(row.password.clone()),
        token: crate::crypto::SecretString::new(row.token.clone()),
        private_key: crate::crypto::SecretString::new(row.private_key.clone()),
        passphrase: crate::crypto::SecretString::new(row.passphrase.clone()),
        auth_method: row.auth_method.clone(),
        note: row.note.clone(),
        confirm_before_fill: true,
        ..Default::default()
    };
    let tags: Vec<String> = row.tags.split([',', '，']).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let item = repo::NewItem {
        target_id,
        account_alias: row.account_alias.clone(),
        tags,
        favorite: false,
        payload,
        set_as_default: row.set_default,
    };
    match repo::create_item(db, vk, actor, &item) {
        Ok(_) => Ok(RowOutcome::Written { new_target, conflicted }),
        Err(e) => Ok(RowOutcome::Rejected(row_reject(0, e.code(), "该行写入失败（原因已记入审计）", None))),
    }
}

pub fn import_commit(db: &Db, vk: &VaultKey, actor: &str, job_id: &str, path_hint: Option<&str>, conflict_policy: &str, default_type: Option<&str>, lk: &TargetLookup) -> Result<ImportCommitResult> {
    if !matches!(conflict_policy, "skip" | "update" | "abort") {
        return Err(AppError::InvalidInput);
    }
    let conn = db.lock_conn();
    let (stored_file, status): (String, String) = conn
        .query_row("SELECT filename, status FROM import_jobs WHERE id=?1", params![job_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| AppError::NotFound)?;
    if status == "running" {
        return Err(AppError::InvalidInput);
    }
    drop(conn);
    // filename 列存 "显示名|完整路径"；路径由预览时的用户选择记录
    let path = match path_hint {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(stored_file.split_once('|').map(|(_, p)| p).unwrap_or(stored_file.as_str())),
    };
    let bytes = std::fs::read(&path).map_err(|_| AppError::InvalidInput)?;
    if job_id_for(&path, &bytes) != job_id {
        return Err(AppError::InvalidInput); // 文件已变更，必须重新预览
    }
    // 提交侧必须与预览侧用同一套来源识别：预览认出的是 xlsx，这里却只按 CSV 读的话，
    // 一份合法的 xlsx 会在"确认导入"这一步炸掉，而界面上刚显示过"可以导入 3 行"。
    let (rows, _, _) = parse_upload(&bytes)?;

    let started = std::time::Instant::now();
    let mut created_targets = 0usize;
    let mut created_items = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;
    let mut errors: Vec<RowError> = Vec::new();
    let now_ts = repo::now();
    {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE import_jobs SET status='running', conflict_policy=?2, started_at=?3 WHERE id=?1",
            params![job_id, conflict_policy, now_ts],
        );
    }

    // 逐行写入。行级错误记进 errors 继续跑；非行级错误（建组/建目标失败）必须把任务标成
    // failed 再返回——否则任务永远停在 running，同一份文件既不能重试，界面也看不到失败原因。
    let mut early_abort: Option<ImportCommitResult> = None;
    let mut run = RunTargets::default();
    let loop_result = (|| -> Result<()> {
        for (idx, (row, row_errs)) in rows.iter().enumerate() {
            let row_no = idx + 2;
            if !row_errs.is_empty() {
                errors.extend(row_errs.iter().map(|e| RowError { row_no, ..e.clone() }));
                skipped += 1;
                continue;
            }
            match write_import_row(db, vk, actor, row, conflict_policy, default_type, lk, &mut run)? {
                RowOutcome::Written { new_target, conflicted } => {
                    if new_target {
                        created_targets += 1;
                    } else if conflicted {
                        conflicts += 1; // 复用导入前已有的目标（update 策略）也是冲突，只是照常写入
                    }
                    created_items += 1;
                }
                RowOutcome::ConflictSkipped => {
                    conflicts += 1;
                    skipped += 1;
                }
                RowOutcome::ConflictAbort => {
                    conflicts += 1;
                    abort_job(db, job_id, "导入中止：文件与台账中存在冲突目标，未写入任何后续行".to_string(), skipped, created_items, conflicts as usize)?;
                    early_abort = Some(ImportCommitResult {
                        job_id: job_id.to_string(),
                        imported_rows: created_items,
                        created_targets,
                        created_items,
                        skipped_rows: skipped,
                        conflict_rows: conflicts,
                        errors: errors.clone(),
                        message: "导入因冲突而中止；前面已写入的行不会自动回滚，请检查后重新导入".to_string(),
                    });
                    return Ok(());
                }
                RowOutcome::Rejected(e) => {
                    errors.push(RowError { row_no, ..e });
                    skipped += 1;
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = loop_result {
        fail_job(db, job_id, &errors, created_items, skipped, conflicts);
        return Err(e);
    }
    if let Some(r) = early_abort {
        return Ok(r);
    }

    let summary = format!(
        "导入完成：新建目标 {created_targets} 个，写入凭据 {created_items} 条，跳过 {skipped} 行，冲突 {conflicts} 行，用时 {} 毫秒。",
        started.elapsed().as_millis()
    );
    {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE import_jobs SET status='success', total_rows=?2, valid_rows=?3, error_rows=?4, conflict_rows=?5, imported_rows=?6, finished_at=?7 WHERE id=?1",
            params![job_id, (created_items + skipped) as i64, created_items as i64, distinct_error_rows(&errors) as i64, conflicts as i64, created_items as i64, repo::now()],
        );
        let _ = conn.execute("DELETE FROM import_job_errors WHERE job_id=?1", params![job_id]);
        for e in errors.iter().take(MAX_REPORTED_ERRORS) {
            let _ = conn.execute(
                "INSERT INTO import_job_errors (id,job_id,row_no,code,message,field) VALUES (?1,?2,?3,?4,?5,?6)",
                params![uuid::Uuid::now_v7().to_string(), job_id, e.row_no as i64, e.code, e.message, e.field],
            );
        }
    }
    Ok(ImportCommitResult {
        job_id: job_id.to_string(),
        imported_rows: created_items,
        created_targets,
        created_items,
        skipped_rows: skipped,
        conflict_rows: conflicts,
        errors: errors.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        message: summary,
    })
}

/// 循环里冒出非行级错误后的善后：任务落 failed 并保留已收集到的行错误。
/// 关键是状态不能留在 running——import_commit 见到 running 会直接拒绝，同一任务就永久卡死。
/// 日志只写任务号与已写入行数，不含文件名、单元格内容或口令。
fn fail_job(db: &Db, job_id: &str, errors: &[RowError], imported: usize, skipped: usize, conflicts: usize) {
    let conn = db.lock_conn();
    let _ = conn.execute(
        "UPDATE import_jobs SET status='failed', total_rows=?2, valid_rows=?3, error_rows=?4, conflict_rows=?5, imported_rows=?6, finished_at=?7 WHERE id=?1",
        params![job_id, (imported + skipped) as i64, imported as i64, errors.len() as i64, conflicts as i64, imported as i64, repo::now()],
    );
    let _ = conn.execute("DELETE FROM import_job_errors WHERE job_id=?1", params![job_id]);
    for e in errors.iter().take(MAX_REPORTED_ERRORS) {
        let _ = conn.execute(
            "INSERT INTO import_job_errors (id,job_id,row_no,code,message,field) VALUES (?1,?2,?3,?4,?5,?6)",
            params![uuid::Uuid::now_v7().to_string(), job_id, e.row_no as i64, e.code, e.message, e.field],
        );
    }
    drop(conn);
    log::error!("import job {job_id} failed；已写入 {imported} 条，跳过 {skipped} 行，未写入的行需重新导入");
}

fn abort_job(db: &Db, job_id: &str, reason: String, _skipped: usize, _items: usize, _conflicts: usize) -> Result<()> {    let conn = db.lock_conn();
    let _ = conn.execute("UPDATE import_jobs SET status='failed', finished_at=?2 WHERE id=?1", params![job_id, repo::now()]);
    drop(conn);
    log::warn!("import job {job_id} aborted: {}", reason.replace(['\n', '\r'], " "));
    Ok(())
}

fn find_or_create_group(db: &Db, actor: &str, name: &str) -> Result<String> {
    let conn = db.lock_conn();
    if let Ok(id) = conn.query_row("SELECT id FROM vault_groups WHERE name=?1 LIMIT 1", params![name], |r| r.get::<_, String>(0)) {
        return Ok(id);
    }
    drop(conn);
    repo::create_group(db, actor, name, None)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRow {
    pub target_name: String,
    pub target_type: String,
    pub url: String,
    pub allowed_origin: String,
    pub protocol: String,
    pub host: String,
    pub port: String,
    pub group: String,
    pub account_alias: String,
    pub tags: String,
    pub auth_method: String,
    pub note: String,
    pub set_default: bool,
    pub username: String,
    pub password: String,
    pub token: String,
    /// 私钥与私钥口令曾经不在导出列里——用容器做迁移时会静默丢掉密钥类凭据的正文，
    /// 而导出的完成文案声称"已导出"。补齐这两列，并在容器导入测试里断言它们真的回来了。
    pub private_key: String,
    pub passphrase: String,
}

/// 收集导出行。地址/主机属于目标加密列，因此任何导出都要求已解锁；
/// 但 include_secrets=false 时绝不解密任何凭据载荷。
pub fn collect_rows(db: &Db, vk: &VaultKey, user_id: &str, include_secrets: bool, target_ids: Option<&[String]>) -> Result<Vec<ExportRow>> {
    let targets = repo::list_targets(db)?;
    let groups: Vec<(String, String)> = {
        let g = db.lock_conn();
        let mut st = g.prepare("SELECT id, name FROM vault_groups")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut out = Vec::new();
    for t in targets {
        if let Some(ids) = target_ids {
            if !ids.iter().any(|i| i == &t.id) {
                continue;
            }
        }
        let meta = repo::target_meta(vk, db, &t.id).unwrap_or_default();
        let group_name = t
            .group_id
            .as_ref()
            .and_then(|gid| groups.iter().find(|(id, _)| id == gid).map(|(_, n)| n.clone()))
            .unwrap_or_default();
        for it in repo::list_items_for_target(db, &t.id, user_id)? {
            let (username, password, token, private_key, passphrase, auth_method, note) = if include_secrets {
                let p = repo::item_payload(vk, db, &it.id)?;
                (
                    p.username.clone(),
                    p.password.expose().to_string(),
                    p.token.expose().to_string(),
                    p.private_key.expose().to_string(),
                    p.passphrase.expose().to_string(),
                    p.auth_method.clone(),
                    p.note.clone(),
                )
            } else {
                (String::new(), String::new(), String::new(), String::new(), String::new(), String::new(), String::new())
            };
            out.push(ExportRow {
                target_name: t.display_name.clone(),
                target_type: t.target_type.clone(),
                url: meta.url.clone(),
                allowed_origin: meta.allowed_origin.clone(),
                protocol: meta.protocol.clone(),
                host: meta.host.clone(),
                port: meta.port.clone(),
                group: group_name.clone(),
                account_alias: it.account_alias.clone(),
                tags: it.tags.join(","),
                auth_method,
                note,
                set_default: it.is_default_for_current_user,
                username,
                password,
                token,
                private_key,
                passphrase,
            });
        }
    }
    Ok(out)
}

pub fn export_preview(
    db: &Db,
    vk: &VaultKey,
    user_id: &str,
    include_secrets: bool,
    target_ids: Option<&[String]>,
    format: Option<&str>,
    shape: Option<&str>,
) -> Result<ExportPreview> {
    let fmt = ExportFormat::resolve(format, include_secrets)?;
    let shape = ExportShape::resolve(shape)?;
    let rows = collect_rows(db, vk, user_id, include_secrets, target_ids)?;
    let columns = shape.columns(include_secrets);
    let label = match fmt {
        ExportFormat::Container => "mdaexport (AES-256-GCM 容器)".to_string(),
        ExportFormat::Csv => "csv".to_string(),
        ExportFormat::Xlsx => "xlsx (Excel)".to_string(),
    };
    let warning = match (fmt, include_secrets, shape) {
        (ExportFormat::Container, _, _) => {
            "含秘密导出：产物为口令加密容器，不落明文；口令丢失无法恢复，导出文件请自行妥善保管".to_string()
        }
        (_, true, _) => format!(
            "含明文口令导出：{label} 里的 password/密码 列是可读文本，这份文件本身没有任何保护，拿到文件就等于拿到全部口令。请用安全渠道传递，核对完立即删除"
        ),
        (_, false, ExportShape::Browser) => {
            "不含秘密的浏览器形状导出：name / url / note 有值，username 与 password 两列留空；列与 Chrome、Edge 的导出文件同形".to_string()
        }
        (_, false, ExportShape::Ledger) => "不含秘密导出：仅结构与地址信息，可直接用于核对与迁移".to_string(),
    };
    Ok(ExportPreview {
        targets: rows.iter().map(|r| r.target_name.clone()).collect::<std::collections::HashSet<_>>().len(),
        items: rows.len(),
        include_secrets,
        format: label,
        columns,
        warning,
    })
}



pub fn export_commit(
    db: &Db,
    vk: &VaultKey,
    user_id: &str,
    path: &Path,
    include_secrets: bool,
    passphrase: Option<&str>,
    target_ids: Option<&[String]>,
    format: Option<&str>,
    shape: Option<&str>,
) -> Result<ExportResult> {
    let fmt = ExportFormat::resolve(format, include_secrets)?;
    let shape = ExportShape::resolve(shape)?;
    check_extension(path, fmt)?;
    let rows = collect_rows(db, vk, user_id, include_secrets, target_ids)?;
    if fmt == ExportFormat::Container {
        let pw = passphrase.filter(|p| !p.is_empty()).ok_or(AppError::InvalidInput)?;
        let assess = crate::auth::policy::assess_with(pw, crate::auth::policy::min_length(db));
        if !assess.acceptable {
            return Err(AppError::WeakPassword(format!(
                "导出容器口令要求：不少于 {} 个字符，混合至少三类字符，且不是常见弱密码。{}",
                crate::auth::policy::min_length(db),
                assess.hint
            )));
        }
        let body = serde_json::to_vec(&rows).map_err(|e| AppError::internal("导入导出", &e))?;
        let salt = crate::crypto::random_bytes(16);
        let params = KdfParams { m_kib: kdf::DEFAULT_M_KIB, t: kdf::DEFAULT_T, p: kdf::DEFAULT_P };
        let key = kdf::derive(pw, &salt, b"mda/export-container-v1", &params)?;
        let aad = b"mda-export-v1";
        let (ct, nonce) = crate::crypto::aead::encrypt(key.as_ref(), &body, aad).map_err(|e| AppError::internal("导入导出", &e))?;
        let mut file = Vec::with_capacity(4 + salt.len() + nonce.len() + ct.len());
        file.extend_from_slice(b"MDAX1");
        file.extend_from_slice(&salt);
        file.extend_from_slice(&nonce);
        file.extend_from_slice(&ct);
        write_all(path, &file)?;
        let digest = crate::backup::sha256_hex(&file);
        return Ok(ExportResult {
            path: path.display().to_string(),
            bytes: file.len(),
            items: rows.len(),
            format: "mdaexport".to_string(),
            encrypted: true,
            sha256: digest,
            message: "已导出口令加密容器；请通过另一条安全渠道把口令交给接收方".to_string(),
        });
    }
    // 可读出口（CSV / xlsx）：列集合只从 `shape.columns()` 这一处来，单元格按同一份列名取值，
    // 保证预览报给界面的列与实际写出的列不可能不一致。
    let columns = shape.columns(include_secrets);
    let cells: Vec<Vec<String>> = match shape {
        ExportShape::Browser => rows.iter().map(browser_cells).collect(),
        ExportShape::Ledger => rows.iter().map(|r| ledger_cells(r, &columns)).collect(),
    };
    let bytes = match fmt {
        ExportFormat::Csv => {
            let mut wtr = csv::Writer::from_path(path).map_err(|e| AppError::internal("导入导出", &e))?;
            wtr.write_record(&columns).map_err(|e| AppError::internal("导入导出", &e))?;
            for rec in &cells {
                wtr.write_record(rec).map_err(|e| AppError::internal("导入导出", &e))?;
            }
            wtr.flush().map_err(|e| AppError::internal("导入导出", &e))?;
            std::fs::read(path).unwrap_or_default()
        }
        ExportFormat::Xlsx => {
            let buf = write_xlsx(&columns, &cells)?;
            write_all(path, &buf)?;
            buf
        }
        ExportFormat::Container => Vec::new(), // 上面已 return
    };
    let digest = crate::backup::sha256_hex(&bytes);
    Ok(ExportResult {
        path: path.display().to_string(),
        bytes: bytes.len(),
        items: rows.len(),
        format: fmt.as_str().to_string(),
        encrypted: false,
        sha256: digest,
        message: match (include_secrets, shape) {
            (true, ExportShape::Browser) => "已导出浏览器形状文件（含明文口令）：请核对后立即删除".to_string(),
            (true, ExportShape::Ledger) => "已导出含明文口令的台账文件：请核对后立即删除".to_string(),
            (false, ExportShape::Browser) => "已导出不含口令的浏览器形状文件".to_string(),
            (false, ExportShape::Ledger) => "已导出不含秘密的台账文件".to_string(),
        },
    })
}

/// 台账形状的一行单元格，按预览报出的列名逐个取值。
/// 秘密列不加 `'` 注入前缀：导入侧对秘密列从不还原前缀，加了就把口令本身改错一个字符。
/// 代价是明文口令若以 `= + - @` 开头，用电子表格打开这份文件时可能被当公式执行——
/// 这是"勾选含明文口令"这个动作自带的后果，与 Chrome / Edge 自己的导出相同，
/// 不勾选时秘密列根本不进文件。
fn ledger_cells(r: &ExportRow, columns: &[String]) -> Vec<String> {
    columns
        .iter()
        .map(|c| {
            let v = ledger_value(r, c);
            if matches!(c.as_str(), "密码" | "令牌" | "私钥" | "私钥口令") {
                v.to_string()
            } else {
                csv_safe(v)
            }
        })
        .collect()
}

fn ledger_value<'a>(r: &'a ExportRow, col: &str) -> &'a str {
    match col {
        "目标名称" => &r.target_name,
        "目标类型" => &r.target_type,
        "地址" => &r.url,
        "精确Origin" => &r.allowed_origin,
        "协议" => &r.protocol,
        "主机" => &r.host,
        "端口" => &r.port,
        "分组" => &r.group,
        "账号别名" => &r.account_alias,
        "标签" => &r.tags,
        "用户名" => &r.username,
        "密码" => &r.password,
        "令牌" => &r.token,
        "私钥" => &r.private_key,
        "私钥口令" => &r.passphrase,
        "认证方式" => &r.auth_method,
        "备注" => &r.note,
        "设为默认" => {
            if r.set_default {
                "是"
            } else {
                ""
            }
        }
        _ => "",
    }
}

/// 浏览器形状（Chrome / Edge 那五列）的一行。文本列沿用 `csv_safe`，
/// username / password 原样写出，这样"导出→再导入"往返不会改字符。
fn browser_cells(r: &ExportRow) -> Vec<String> {
    vec![
        csv_safe(&r.target_name),
        csv_safe(&browser_addr(r)),
        csv_safe(&r.username),
        r.password.clone(),
        csv_safe(&r.note),
    ]
}

/// 地址列优先取 URL；终端/数据库没有 URL 时拼出 `[协议://]主机[:端口]`，
/// 让这一列在浏览器形状里仍然能定位到系统（Chrome 只有网站，没有主机/端口两列）。
fn browser_addr(r: &ExportRow) -> String {
    let url = r.url.trim();
    if !url.is_empty() {
        return url.to_string();
    }
    let host = r.host.trim();
    if host.is_empty() {
        return String::new();
    }
    let proto = r.protocol.trim();
    let port = r.port.trim();
    let head = if proto.is_empty() { host.to_string() } else { format!("{proto}://{host}") };
    if port.is_empty() {
        head
    } else {
        format!("{head}:{port}")
    }
}

/// xlsx 出口：每个单元格都走 `write_string`，写进共享字符串表。
/// 电子表格只对被标成"公式"的单元格求值，而 write_string 产不出公式单元格，
/// 所以 CSV 那条 `'` 前缀防线在这里由类型本身承担，不需要再往文本里塞前缀
/// （塞了反而破坏往返——导入侧按字符串原样读回）。
fn write_xlsx(columns: &[String], rows: &[Vec<String>]) -> Result<Vec<u8>> {
    let mut wb = rust_xlsxwriter::Workbook::new();
    {
        let ws = wb.add_worksheet();
        for (c, head) in columns.iter().enumerate() {
            ws.write_string(0, c as u16, head).map_err(|e| AppError::internal("导入导出", &e))?;
        }
        for (idx, cells) in rows.iter().enumerate() {
            let row_no = (idx + 1) as u32;
            for (c, v) in cells.iter().enumerate() {
                ws.write_string(row_no, c as u16, v).map_err(|e| AppError::internal("导入导出", &e))?;
            }
        }
    }
    wb.save_to_buffer().map_err(|e| AppError::internal("导入导出", &e))
}

/// 扩展名必须与所选格式一致：导入侧是按内容识别的，导出一份叫 `.csv` 的 xlsx
/// 只会让接收方用错程序打开，也会让"导出→再导入"的自检失去意义。
fn check_extension(path: &Path, fmt: ExportFormat) -> Result<()> {
    let want = match fmt {
        ExportFormat::Csv => "csv",
        ExportFormat::Xlsx => "xlsx",
        ExportFormat::Container => "mdaexport",
    };
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(want)) == Some(true) {
        Ok(())
    } else {
        Err(AppError::InvalidInput)
    }
}

fn write_all(path: &Path, bytes: &[u8]) -> Result<()> {
    // 审查 F12：报告/导出文件可能含明文口令，创建即 0600 并回读校验（见 secfile 模块说明）。
    crate::secfile::write_private(path, bytes)
}

// —— 加密容器的读取侧 ——

const CONTAINER_MAGIC: &[u8; 5] = b"MDAX1";
const CONTAINER_CTX: &[u8] = b"mda/export-container-v1";
const CONTAINER_AAD: &[u8] = b"mda-export-v1";
const CONTAINER_SALT_LEN: usize = 16;
const CONTAINER_NONCE_LEN: usize = 12;
/// 最短合法容器：魔数 + 盐 + nonce + 至少一个 GCM 标签（16 字节）。
const CONTAINER_MIN_LEN: usize = 5 + CONTAINER_SALT_LEN + CONTAINER_NONCE_LEN + 16;

/// 口令错与"被人改动过"都只回同一个错误：能区分两者就等于给了外部一个
/// 判断"这份口令对不对"的 oracle，而两种情况下我们手上也没有任何明文可以回显。
fn decode_container(bytes: &[u8], passphrase: &str) -> Result<Vec<ExportRow>> {
    if bytes.len() < CONTAINER_MIN_LEN || &bytes[..CONTAINER_MAGIC.len()] != CONTAINER_MAGIC {
        return Err(AppError::FileFormatInvalid);
    }
    let salt = &bytes[5..5 + CONTAINER_SALT_LEN];
    let nonce = &bytes[5 + CONTAINER_SALT_LEN..5 + CONTAINER_SALT_LEN + CONTAINER_NONCE_LEN];
    let ct = &bytes[5 + CONTAINER_SALT_LEN + CONTAINER_NONCE_LEN..];
    if salt.len() != CONTAINER_SALT_LEN || nonce.len() != CONTAINER_NONCE_LEN {
        return Err(AppError::FileFormatInvalid);
    }
    let params = KdfParams { m_kib: kdf::DEFAULT_M_KIB, t: kdf::DEFAULT_T, p: kdf::DEFAULT_P };
    let key = kdf::derive(passphrase, salt, CONTAINER_CTX, &params)?;
    let body = crate::crypto::aead::decrypt(key.as_ref(), ct, nonce, CONTAINER_AAD)
        .map_err(|_| AppError::ContainerUnopenable)?;
    serde_json::from_slice(&body).map_err(|_| AppError::FileFormatInvalid)
}

impl From<&ExportRow> for ImportRow {
    fn from(r: &ExportRow) -> Self {
        ImportRow {
            display_name: r.target_name.clone(),
            target_type: r.target_type.clone(),
            url: r.url.clone(),
            allowed_origin: r.allowed_origin.clone(),
            protocol: r.protocol.clone(),
            host: r.host.clone(),
            port: r.port.clone(),
            group: r.group.clone(),
            account_alias: r.account_alias.clone(),
            tags: r.tags.clone(),
            username: r.username.clone(),
            password: r.password.clone(),
            token: r.token.clone(),
            private_key: r.private_key.clone(),
            passphrase: r.passphrase.clone(),
            auth_method: r.auth_method.clone(),
            note: r.note.clone(),
            set_default: r.set_default,
        }
    }
}

fn row_carries_secret(r: &ExportRow) -> bool {
    [r.username.as_str(), r.password.as_str(), r.token.as_str(), r.private_key.as_str(), r.passphrase.as_str()]
        .iter()
        .any(|v| !v.is_empty())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPreview {
    pub filename: String,
    /// 整个文件的内容摘要。容器没有 CSV 那样的 import_jobs 任务行，预览与提交之间就靠它绑定：
    /// 提交时重算，不一致说明用户在看过预览之后换过文件或改过口令，必须重新预览。
    pub fingerprint: String,
    pub total_rows: usize,
    pub valid_rows: usize,
    pub error_rows: usize,
    pub conflict_rows: usize,
    pub new_targets: usize,
    /// 只回答"这份容器里有没有秘密列"，绝不回显任何内容
    pub contains_secrets: bool,
    pub errors: Vec<RowError>,
    pub conflicts: Vec<ConflictHint>,
    pub truncated: bool,
    pub message: String,
}

pub fn container_preview(db: &Db, path: &Path, passphrase: &str, lk: &TargetLookup) -> Result<ContainerPreview> {
    let bytes = std::fs::read(path).map_err(|_| AppError::InvalidInput)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(AppError::FileTooLarge);
    }
    let rows = decode_container(&bytes, passphrase)?;
    let filename = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

    let mut errors: Vec<RowError> = Vec::new();
    let mut conflicts: Vec<ConflictHint> = Vec::new();
    let mut new_targets = std::collections::HashSet::new();
    let mut seen_aliases = std::collections::HashSet::new();
    let mut contains_secrets = false;
    let mut valid = 0usize;
    // 审查 F3：容器预览也要过同一道闸门（判据来自 write_import_row 那一处）。
    let allow_weak = crate::settings::get_bool(db, "allow_insecure_protocols", false);

    for (idx, r) in rows.iter().enumerate() {
        let row_no = idx + 1;
        contains_secrets |= row_carries_secret(r);
        let row = ImportRow::from(r);
        let shape = row_shape_errors(row_no, &row, None);
        if !shape.is_empty() {
            errors.extend(shape);
            continue;
        }
        // 审查 F3：容器与 CSV 同一判据（见 write_import_row 与 import_preview 的说明）。
        if !allow_weak && repo::is_insecure_protocol(&resolved_type(&row, None), &row.protocol) {
            errors.push(row_reject(
                row_no,
                "INSECURE_PROTOCOL",
                "该行协议是明文协议，需先在「系统管理 · 安全策略」里显式允许后才能导入",
                Some("协议"),
            ));
            continue;
        }
        let key = format!("{}::{}", row.display_name.trim().to_lowercase(), row.account_alias.trim().to_lowercase());
        if !seen_aliases.insert(key) {
            conflicts.push(ConflictHint {
                row_no,
                target_name: row.display_name.clone(),
                reason: "容器内同一目标下出现重复账号别名".to_string(),
            });
        }
        if TargetLookup::find(db, lk, &row.display_name, &row.url, &row.host)?.is_some() {
            conflicts.push(ConflictHint {
                row_no,
                target_name: row.display_name.clone(),
                reason: "台账中已存在同名或同地址目标；可选择复用该目标继续导入凭据".to_string(),
            });
        } else {
            new_targets.insert(row.display_name.trim().to_lowercase());
        }
        valid += 1;
    }
    let truncated = errors.len() > MAX_REPORTED_ERRORS;
    let reported = errors.iter().take(MAX_REPORTED_ERRORS).cloned().collect();
    let conflict_count = conflicts.len();

    Ok(ContainerPreview {
        fingerprint: crate::backup::sha256_hex(&bytes),
        filename,
        total_rows: rows.len(),
        valid_rows: valid,
        error_rows: distinct_error_rows(&errors),
        conflict_rows: conflict_count,
        new_targets: new_targets.len(),
        contains_secrets,
        errors: reported,
        conflicts,
        truncated,
        message: format!(
            "容器共 {} 行：可导入 {} 行，错误 {} 行，冲突 {} 行。{}秘密字段只在提交时用本机保险库密钥重新加密后落库，不会出现在预览里。",
            rows.len(),
            valid,
            errors.len(),
            conflict_count,
            if contains_secrets { "含" } else { "不含" },
        ),
    })
}

/// 提交容器导入。与 CSV 共用 `write_import_row`，所以默认账号、分组、标签、冲突策略的语义完全一致；
/// 差别只有两处：行号从 1 起算，以及不写 import_jobs 任务行（容器文件由口令保护，
/// 把解密后的行摘要存进库等于凭空多一份半明文副本）。
pub fn container_commit(
    db: &Db,
    vk: &VaultKey,
    actor: &str,
    path: &Path,
    passphrase: &str,
    fingerprint: &str,
    conflict_policy: &str,
    lk: &TargetLookup,
) -> Result<ImportCommitResult> {
    if !matches!(conflict_policy, "skip" | "update" | "abort") {
        return Err(AppError::InvalidInput);
    }
    let bytes = std::fs::read(path).map_err(|_| AppError::InvalidInput)?;
    if crate::backup::sha256_hex(&bytes) != fingerprint {
        return Err(AppError::ContainerStale);
    }
    let rows = decode_container(&bytes, passphrase)?;
    let started = std::time::Instant::now();

    let mut created_targets = 0usize;
    let mut created_items = 0usize;
    let mut skipped = 0usize;
    let mut conflicts = 0usize;
    let mut errors: Vec<RowError> = Vec::new();
    let mut run = RunTargets::default();

    for (idx, r) in rows.iter().enumerate() {
        let row_no = idx + 1;
        match write_import_row(db, vk, actor, &ImportRow::from(r), conflict_policy, None, lk, &mut run)? {
            RowOutcome::Written { new_target, conflicted } => {
                if new_target {
                    created_targets += 1;
                } else if conflicted {
                    conflicts += 1;
                }
                created_items += 1;
            }
            RowOutcome::ConflictSkipped => {
                conflicts += 1;
                skipped += 1;
            }
            RowOutcome::ConflictAbort => {
                conflicts += 1;
                return Ok(ImportCommitResult {
                    job_id: fingerprint.to_string(),
                    imported_rows: created_items,
                    created_targets,
                    created_items,
                    skipped_rows: skipped,
                    conflict_rows: conflicts,
                    errors: errors.clone().into_iter().take(MAX_REPORTED_ERRORS).collect(),
                    message: "导入因冲突而中止；前面已写入的行不会自动回滚，请检查后重新导入".to_string(),
                });
            }
            RowOutcome::Rejected(e) => {
                errors.push(RowError { row_no, ..e });
                skipped += 1;
            }
        }
    }

    let summary = format!(
        "容器导入完成：新建目标 {created_targets} 个，写入凭据 {created_items} 条，跳过 {skipped} 行，冲突 {conflicts} 行，用时 {} 毫秒。",
        started.elapsed().as_millis()
    );
    Ok(ImportCommitResult {
        job_id: fingerprint.to_string(),
        imported_rows: created_items,
        created_targets,
        created_items,
        skipped_rows: skipped,
        conflict_rows: conflicts,
        errors: errors.into_iter().take(MAX_REPORTED_ERRORS).collect(),
        message: summary,
    })
}

/// CSV 公式注入防护：Excel/WPS 会把以 `= + - @`（以及制表/回车）开头的单元格当公式执行，
/// 台账里的目标名称、别名、备注都是用户可自由填写的文本，导出前必须做中和处理。
/// 前缀单引号让它退化为纯文本；导入侧（parse_csv 的 get）按列还原。
pub(crate) fn csv_safe(cell: &str) -> String {
    let trimmed = cell.trim_start_matches([' ', '\u{feff}']);
    match trimmed.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => {
            let mut out = String::with_capacity(cell.len() + 1);
            out.push('\'');
            out.push_str(cell);
            out
        }
        Some(_) => cell.to_string(),
        None => String::new(),
    }
}

/// 生成空白模板（表头 + 一行说明用途的示例值，示例值不是任何真实凭据）。
pub fn template_csv() -> String {
    let header = COLUMN_ORDER.join(",");
    let note_row = vec![
        "示例：营销系统（请勿直接上传真实口令到不受信渠道）", "web", "https://example.internal/login", "https://example.internal",
        "https", "example.internal", "", "", "示例别名", "示例,标签", "示例用户名", "", "", "", "", "password", "示例备注", "否",
    ];
    let mut escaped: Vec<String> = Vec::new();
    for cell in &note_row {
        let cell = csv_safe(cell);
        if cell.contains(',') || cell.contains('"') {
            escaped.push(format!("\"{}\"", cell.replace('"', "\"\"")));
        } else {
            escaped.push(cell);
        }
    }
    format!("{header}\n{}\n", escaped.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 审查 F27/B12：一行可以同时"缺目标名称"和"缺账号别名"，界面上说的是"错误 N **行**"。
    /// 原先各计数点直接 `errors.len()`，于是"共 3 行：可导入 1 行，错误 3 行"这种账会出现。
    #[test]
    fn error_rows_count_distinct_rows_not_error_messages() {
        let e = |row_no: usize, code: &str| RowError {
            row_no,
            code: code.to_string(),
            message: "x".to_string(),
            field: None,
        };
        let errs = vec![e(2, "MISSING_DISPLAY_NAME"), e(2, "EMPTY_ALIAS"), e(4, "BAD_PORT")];
        assert_eq!(distinct_error_rows(&errs), 2, "第 2 行有两条错误，仍然只算一行");
        assert_eq!(errs.len(), 3, "错误条数仍然是 3——界面上「列出前 5 条」用的是这个数");
        assert_eq!(distinct_error_rows(&[]), 0);
    }

    #[test]
    fn template_header_matches_columns() {
        let t = template_csv();
        let first = t.lines().next().unwrap();
        assert_eq!(first, COLUMN_ORDER.join(","));
        assert_eq!(COLUMN_ORDER.len(), IMPORT_COLUMNS.len());
    }

    /// 导出必须中和 CSV 公式注入；导入对文本列还原前缀，秘密列一律原样保留。
    #[test]
    fn export_neutralizes_formula_cells_and_import_restores_text_columns() {
        assert_eq!(csv_safe("=1+1"), "'=1+1");
        assert_eq!(csv_safe("+8613800000000"), "'+8613800000000");
        assert_eq!(csv_safe("-2 号线运维"), "'-2 号线运维");
        assert_eq!(csv_safe("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(csv_safe("营销系统"), "营销系统");
        assert_eq!(csv_safe(""), "");
        assert!(!template_csv().lines().nth(1).unwrap().contains("'"), "模板示例值不应带注入前缀");

        let text = "目标名称,目标类型,地址,账号别名,用户名,密码\n'-2 号线运维,web,https://a.example/x,ops1,u1,'p1\n";
        let (rows, _) = parse_csv(text).unwrap();
        let r = &rows[0].0;
        assert_eq!(r.display_name, "-2 号线运维", "文本列应还原公式前缀");
        assert_eq!(r.password, "'p1", "秘密列绝不能被改动：真实口令可能以引号开头");
    }


    #[test]
    fn parses_english_and_chinese_headers() {        let cn = "目标名称,目标类型,地址,账号别名,用户名,密码\n营销系统,web,https://a.example/x,ops1,u1,p1\n";
        let en = "display_name,target_type,url,account_alias,username,password\n营销系统,web,https://a.example/x,ops1,u1,p1\n";
        for text in [cn, en] {
            let (rows, _) = parse_csv(text).unwrap();
            assert_eq!(rows.len(), 1);
            assert!(rows[0].1.is_empty(), "合法行不应报错：{:?}", rows[0].1);
            assert_eq!(rows[0].0.account_alias, "ops1");
        }
    }

    #[test]
    fn flags_bad_rows_with_codes() {
        let text = "目标名称,目标类型,地址,账号别名\n,web,https://a,ops1\n好名字,spaceship,https://a,ops1\n好名字2,web,,\n好名字3,web,https://a,ok\n";
        let (rows, _) = parse_csv(text).unwrap();
        assert!(rows[0].1.iter().any(|e| e.code == "MISSING_DISPLAY_NAME"));
        assert!(rows[1].1.iter().any(|e| e.code == "UNKNOWN_TYPE"));
        assert!(rows[2].1.iter().any(|e| e.code == "NO_ADDRESS"));
        assert!(rows[2].1.iter().any(|e| e.code == "EMPTY_ALIAS"));
        assert!(rows[3].1.is_empty());
        // 行号从 2 开始（表头是第 1 行）
        assert_eq!(rows[0].1[0].row_no, 2);
    }

    /// 精确 Origin 认 http 与 https（内网台账确有明文 http 系统），其余协议前缀仍然拒。
    #[test]
    fn rejects_non_http_origin_and_bad_port() {
        let text = "目标名称,目标类型,地址,账号别名,精确Origin,端口\nT,web,https://a,ops1,ftp://a,99999\n";
        let (rows, _) = parse_csv(text).unwrap();
        assert!(rows[0].1.iter().any(|e| e.code == "BAD_ORIGIN"));
        assert!(rows[0].1.iter().any(|e| e.code == "BAD_PORT"));
    }

    #[test]
    fn accepts_http_allowed_origin_for_intranet_sites() {
        let text = "目标名称,目标类型,地址,账号别名,精确Origin\nT,web,http://10.0.0.8:8080/login,ops1,http://10.0.0.8:8080\n";
        let (rows, _) = parse_csv(text).unwrap();
        assert!(rows[0].1.is_empty(), "http 站点是台账里的正常一档，不该报错：{:?}", rows[0].1);
    }

    #[test]
    fn missing_required_column_is_fatal() {
        let e = parse_csv("目标名称,目标类型\nA,web\n").unwrap_err();
        assert_eq!(e.code, "MISSING_COLUMN");
    }

    #[test]
    fn address_normalization_ignores_scheme_and_path() {
        assert_eq!(normalize_addr("https://A.example/x?y=1"), "a.example");
        assert_eq!(normalize_addr("a.example"), "a.example");
        assert_eq!(normalize_addr("ssh://10.0.0.1:22"), "10.0.0.1:22");
    }
}
