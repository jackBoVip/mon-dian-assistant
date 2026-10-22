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
    #[error("口令不满足要求")]
    /// 括号里是给界面看的具体要求，不含口令正文。两个生产者：主密码为空（L 轮起主密码只剩这一条
    /// 要求）、导出容器口令不满足强度判定。所以正文不能说"主密码"也不能说"密码策略"，
    /// 具体差在哪一项由 detail 这一层给界面。
    WeakPassword(String),
    #[error("参数不合法")]
    InvalidInput,
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
            AppError::WeakPassword(_) => "WEAK_PASSWORD",
            AppError::InvalidInput => "INVALID_INPUT",
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
            AppError::InsecureUpdateSource => "INSECURE_UPDATE_SOURCE",
            AppError::QuerySyntax(_) => "QUERY_SYNTAX",
            AppError::ReauthRequired => "REAUTH_REQUIRED",
            AppError::FileTooLarge => "FILE_TOO_LARGE",
            AppError::FileFormatInvalid => "FILE_FORMAT_INVALID",
            AppError::ImportJobUnknown => "IMPORT_JOB_UNKNOWN",
            AppError::ContainerUnopenable => "CONTAINER_UNOPENABLE",
            AppError::ContainerStale => "CONTAINER_STALE",
            AppError::KeyStoreUnavailable => "KEYSTORE_UNAVAILABLE",
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
            AppError::WeakPassword(reason) => reason.clone(),
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
