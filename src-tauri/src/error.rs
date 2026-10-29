//! 统一错误码。对用户给出可读中文提示，对日志只写错误码与必要上下文，绝不写入秘密。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据库访问失败")]
    Db(#[from] rusqlite::Error),
    #[error("加密操作失败")]
    Crypto(#[from] crate::crypto::CryptoError),
    #[error("会话已锁定，请重新解锁")]
    Locked,
    #[error("会话已过期，请重新登录")]
    SessionExpired,
    #[error("未授权：当前使用者无权执行该操作")]
    Forbidden,
    #[error("记录不存在或不可见")]
    NotFound,
    #[error("主密码错误")]
    WrongPassword,
    #[error("尝试次数过多，请在稍后重试")]
    TooManyAttempts,
    #[error("保险库尚未初始化")]
    NotInitialized,
    #[error("保险库已初始化，请勿重复创建")]
    AlreadyInitialized,
    #[error("昵称不能为空")]
    NicknameRequired,
    #[error("昵称太长，最多 {} 个字", crate::auth::users::NICKNAME_MAX_CHARS)]
    /// 上限取自解锁页/顶栏下拉能站稳的那一行宽度：写进去再被省略号吃掉等于看不见。
    NicknameTooLong,
    #[error("角色标识不合法：只能用小写字母、数字、下划线或连字符（2–32 位，字母开头）")]
    RoleCodeInvalid,
    #[error("角色标识已存在")]
    RoleCodeTaken,
    #[error("内置角色的名称、说明、状态与标识不可修改，也不能删除；其权限仍可调整")]
    RoleBuiltinImmutable,
    #[error("该角色仍有使用者绑定，请先把这些使用者换到其他角色")]
    RoleInUse,
    #[error("该改动会让你失去系统管理入口，已取消")]
    SelfLockout,
    #[error("口令不满足要求")]
    /// 括号里是给界面看的具体要求，不含口令正文。两个生产者：主密码为空（L 轮起主密码只剩这一条
    /// 要求）、导出容器口令不满足强度判定。所以正文不能说"主密码"也不能说"密码策略"，
    /// 具体差在哪一项由 detail 这一层给界面。
    WeakPassword(String),
    #[error("参数不合法")]
    InvalidInput,
    #[error("菜单名称不能为空，最多 40 个字")]
    MenuLabelInvalid,
    #[error("落点页面不在可绑定范围内")]
    MenuPageUnknown,
    /// 守卫文案由领域层给出：内置菜单不能删、分组名固定、一级顺序固定、关键入口不能停用。
    #[error("{0}")]
    MenuProtected(String),
    /// 工具档的拒绝理由由领域层给出：路径不合法/本机不存在、固定两档不许删改。
    /// 正文只说清哪一项不合格，不含路径本身（审计与界面都不该把整条本机路径抄来抄去）。
    #[error("{0}")]
    ExternalToolRejected(String),
    #[error("目标与凭据不属于同一记录")]
    TargetCredentialMismatch,
    #[error("该凭据已停用，不能作为默认账号")]
    CredentialDisabled,
    #[error("未找到有效的默认账号，请先选择账号")]
    NoDefaultCredential,
    #[error("填充票据无效")]
    TicketInvalid,
    #[error("填充票据不存在或已被使用")]
    TicketUnknown,
    #[error("填充票据已过期")]
    TicketExpired,
    #[error("填充票据与本次请求的账号或网站不匹配")]
    TicketBindingMismatch,
    #[error("Origin 未授权，禁止自动填充")]
    OriginNotAllowed,
    #[error("该协议存在明文传输风险，默认禁用，需管理员显式启用")]
    InsecureProtocolDisabled,
    #[error("浏览器扩展未就绪，已降级为手动复制")]
    ExtensionUnavailable,
    #[error("快捷键注册失败：与系统或其他应用冲突")]
    ShortcutConflict,
    #[error("更新包签名校验失败")]
    UpdateSignatureInvalid,
    #[error("更新包平台或架构不匹配")]
    UpdatePlatformMismatch,
    #[error("更新源不可达")]
    UpdateSourceUnreachable,
    #[error("同一网段内没有发现可用的更新源")]
    LanSourceUnavailable,
    /// 审查 F14：原先清单 JSON 解析失败被映射成 `UpdateSourceUnreachable`——
    /// 源明明连上了，报出来的却是"连不上"，排障方向整个反了。
    #[error("更新清单无法解析：请核对 sourceUrl 指向的是本应用约定的 JSON 清单")]
    UpdateManifestInvalid,
    #[error("生产环境禁止使用明文 HTTP 更新源")]
    InsecureUpdateSource,
    #[error("查询语法错误：{0}")]
    QuerySyntax(String),
    #[error("该操作需要再次验证主密码")]
    ReauthRequired,
    #[error("导入文件过大")]
    FileTooLarge,
    #[error("导入文件格式不被识别或解析失败")]
    FileFormatInvalid,
    #[error("导入任务不存在或已过期")]
    ImportJobUnknown,
    #[error("加密容器无法打开：口令不正确，或文件已损坏/被篡改")]
    ContainerUnopenable,
    #[error("容器文件在预览之后被改动过（内容摘要与预览时不一致）：请重新预览确认后再导入")]
    ContainerStale,
    #[error("本地存储不可用，无法安全保存密钥材料")]
    KeyStoreUnavailable,
    /// 括号里只放行列号与原因码（解析器给出），题面正文一律不进错误链。
    #[error("题库文件解析失败")]
    QuizParseFailed(String),
    #[error("题库文件格式不受支持：仅接受 DOCX / TXT / XLSX / CSV")]
    QuizUnsupportedFormat,
    #[error("题库文件过大：单文件上限 32MiB，单次导入上限 20000 题")]
    QuizFileTooLarge,
    #[error("导入任务不存在或已过期")]
    QuizJobNotFound,
    #[error("导入任务已结束，不能再修改")]
    QuizJobClosed,
    /// 括号里只放行号/列号与原因码。
    #[error("有题目不合法，未能发布")]
    QuizRowInvalid(String),
    #[error("题库名称不能为空，最多 64 个字")]
    QuizLibraryNameInvalid,
    #[error("OCR 引擎不可用：模型缺失或推理失败")]
    QuizOcrUnavailable,
    /// 括号里只放失败环节与系统错误类型，不含截图内容。
    #[error("截屏失败")]
    QuizCaptureFailed(String),
    #[error("未获得屏幕录制权限")]
    QuizScreenPermissionDenied,
    #[error("当前系统环境不支持答题助手：Wayland 下无法截屏")]
    QuizUnsupportedPlatform,
    #[error("没有可检索的题库：请至少选择一份题库")]
    QuizScopeEmpty,
    #[error("系统安全存储不可用：需要操作者显式同意才能改用本机文件密钥")]
    DeviceKeyConsentRequired,
    /// 保险库文件在、设备密钥取不到。此时生成新密钥会让旧库永久无法解密，只能停下来说明情况。
    #[error("取不到数据库主密钥，且保险库文件已存在：不会生成新密钥（那会让已有数据永久无法解密）。请先确认本机 vault.device.key 是否被删；旧版本用系统安全存储建过库的，还要确认那一条密钥条目还在")]
    DeviceKeyLostVaultIntact,
    #[error("序列化失败")]
    Serde(#[from] serde_json::Error),
    #[error("内部错误")]
    Internal,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    /// 审查 F13 的收口点。`Internal` 的 Display 里没有 cause（这是刻意的：`safe_detail` 说明
    /// "可安全写入审计/日志的摘要，不含输入正文"，UI 也只拿中文 + 错误码），于是全项目 58 处
    /// `map_err(|_| AppError::Internal)` 把 errno 级别的原因全丢了——备份失败、密钥文件写失败、
    /// 下载失败，现场都只剩一句"内部错误"（本项目已经吃过一次"闪退查不到原因"的亏，
    /// 见 lib.rs 里 `AppStartupFailed` 那段说明）。
    ///
    /// 这个构造器把原因**只**写进日志，返回值仍是同一个 `Internal`：
    /// UI 文案、错误码、审计内容一字不变，改变的是运维能不能查到根因。
    pub fn internal(op: &str, cause: &impl std::fmt::Display) -> Self {
        log::warn!("{op} 失败：{cause}");
        Self::Internal
    }

    /// 稳定错误码，用于审计与前端提示映射。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Db(_) => "DB_ERROR",
            AppError::Crypto(_) => "CRYPTO_ERROR",
            AppError::Locked => "SESSION_LOCKED",
            AppError::SessionExpired => "SESSION_EXPIRED",
            AppError::Forbidden => "FORBIDDEN",
            AppError::NotFound => "NOT_FOUND",
            AppError::WrongPassword => "WRONG_PASSWORD",
            AppError::TooManyAttempts => "TOO_MANY_ATTEMPTS",
            AppError::NotInitialized => "VAULT_NOT_INITIALIZED",
            AppError::AlreadyInitialized => "VAULT_ALREADY_INITIALIZED",
            AppError::NicknameRequired => "NICKNAME_REQUIRED",
            AppError::NicknameTooLong => "NICKNAME_TOO_LONG",
            AppError::RoleCodeInvalid => "ROLE_CODE_INVALID",
            AppError::RoleCodeTaken => "ROLE_CODE_TAKEN",
            AppError::RoleBuiltinImmutable => "ROLE_BUILTIN_IMMUTABLE",
            AppError::RoleInUse => "ROLE_IN_USE",
            AppError::SelfLockout => "SELF_LOCKOUT",
            AppError::WeakPassword(_) => "WEAK_PASSWORD",
            AppError::InvalidInput => "INVALID_INPUT",
            AppError::MenuLabelInvalid => "MENU_LABEL_INVALID",
            AppError::MenuPageUnknown => "MENU_PAGE_UNKNOWN",
            AppError::MenuProtected(_) => "MENU_PROTECTED",
            AppError::ExternalToolRejected(_) => "EXTERNAL_TOOL_REJECTED",
            AppError::TargetCredentialMismatch => "TARGET_CREDENTIAL_MISMATCH",
            AppError::CredentialDisabled => "CREDENTIAL_DISABLED",
            AppError::NoDefaultCredential => "NO_DEFAULT_CREDENTIAL",
            AppError::TicketInvalid => "TICKET_INVALID",
            AppError::TicketUnknown => "TICKET_UNKNOWN",
            AppError::TicketExpired => "TICKET_EXPIRED",
            AppError::TicketBindingMismatch => "TICKET_BINDING_MISMATCH",
            AppError::OriginNotAllowed => "ORIGIN_NOT_ALLOWED",
            AppError::InsecureProtocolDisabled => "INSECURE_PROTOCOL_DISABLED",
            AppError::ExtensionUnavailable => "EXTENSION_UNAVAILABLE",
            AppError::ShortcutConflict => "SHORTCUT_CONFLICT",
            AppError::UpdateSignatureInvalid => "UPDATE_SIGNATURE_INVALID",
            AppError::UpdatePlatformMismatch => "UPDATE_PLATFORM_MISMATCH",
            AppError::UpdateSourceUnreachable => "UPDATE_SOURCE_UNREACHABLE",
            AppError::LanSourceUnavailable => "LAN_SOURCE_UNAVAILABLE",
            AppError::UpdateManifestInvalid => "UPDATE_MANIFEST_INVALID",
            AppError::InsecureUpdateSource => "INSECURE_UPDATE_SOURCE",
            AppError::QuerySyntax(_) => "QUERY_SYNTAX",
            AppError::ReauthRequired => "REAUTH_REQUIRED",
            AppError::FileTooLarge => "FILE_TOO_LARGE",
            AppError::FileFormatInvalid => "FILE_FORMAT_INVALID",
            AppError::ImportJobUnknown => "IMPORT_JOB_UNKNOWN",
            AppError::ContainerUnopenable => "CONTAINER_UNOPENABLE",
            AppError::ContainerStale => "CONTAINER_STALE",
            AppError::KeyStoreUnavailable => "KEYSTORE_UNAVAILABLE",
            AppError::QuizParseFailed(_) => "QUIZ_PARSE_FAILED",
            AppError::QuizUnsupportedFormat => "QUIZ_UNSUPPORTED_FORMAT",
            AppError::QuizFileTooLarge => "QUIZ_FILE_TOO_LARGE",
            AppError::QuizJobNotFound => "QUIZ_JOB_NOT_FOUND",
            AppError::QuizJobClosed => "QUIZ_JOB_CLOSED",
            AppError::QuizRowInvalid(_) => "QUIZ_ROW_INVALID",
            AppError::QuizLibraryNameInvalid => "QUIZ_LIBRARY_NAME_INVALID",
            AppError::QuizOcrUnavailable => "QUIZ_OCR_UNAVAILABLE",
            AppError::QuizCaptureFailed(_) => "QUIZ_CAPTURE_FAILED",
            AppError::QuizScreenPermissionDenied => "QUIZ_SCREEN_PERMISSION_DENIED",
            AppError::QuizUnsupportedPlatform => "QUIZ_UNSUPPORTED_PLATFORM",
            AppError::QuizScopeEmpty => "QUIZ_SCOPE_EMPTY",
            AppError::DeviceKeyConsentRequired => "DEVICE_KEY_CONSENT_REQUIRED",
            AppError::DeviceKeyLostVaultIntact => "DEVICE_KEY_LOST_VAULT_INTACT",
            AppError::Serde(_) => "SERDE",
            AppError::Internal => "INTERNAL",
        }
    }

    /// 可安全写入审计/日志的摘要，不含输入正文。
    pub fn safe_detail(&self) -> String {
        match self {
            AppError::QuerySyntax(_) => "QUERY_SYNTAX: 查询串解析失败（正文不记录）".to_string(),
            // 口令不满足哪一条要求（主密码为空 / 容器口令的位数、类别、常见弱密码），由判定算出，不含口令本身
            // 解析器只把位置与原因码放进括号，题面/答案正文不进错误链、不进审计
            AppError::WeakPassword(reason) => reason.clone(),
            AppError::QuizParseFailed(where_) | AppError::QuizRowInvalid(where_) => where_.clone(),
            // 只带失败环节与系统错误类型（例如「枚举显示器失败」），截图内容不在这条链上
            AppError::QuizCaptureFailed(where_) => where_.clone(),
            other => other.code().to_string(),
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = s.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("detail", &self.safe_detail())?;
        s.end()
    }
}
