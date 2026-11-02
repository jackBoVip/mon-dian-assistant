//! EDAS profile：端点、环境参数、JSON 字段路径、登录脚本与超时轮询的声明式配置。
//!
//! 这份 JSON 存在 `task_profiles.profile_json` 里（非密：域名、region、字段名，没有凭据）。
//! 默认值是原实现实测过的 EDAS 控制台形态，现场一般只需要改 `baseUrl`、`params` 与
//! `login.authorizeUrl` 三类。
//!
//! 一条硬规则：这里**没有**"跳过证书校验"这一档。内网自签证书走 `caPemPath` 注入根证书，
//! 注入不了就让它验不过并如实报错——把整条链路的 TLS 校验关掉不是配置项。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::{AppError, Result};

fn default_true() -> bool {
    true
}

/// 一个读接口：路径 + 固定查询参数。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EndpointSpec {
    /// 以 `/` 开头时按 `baseUrl` 拼接；写成完整 `https://...` 时直接采用。
    pub path: String,
    /// 固定查询参数。值里的 `{名字}` 占位从 `EdasProfile.params` 取。
    pub query: BTreeMap<String, String>,
}

/// 改镜像那一发：POST 表单，字段名也可配（控制台改版时只动这里）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSpec {
    pub path: String,
    pub app_id_field: String,
    pub image_field: String,
    /// 表单值之外还要不要带固定查询参数（原实现只带时间戳）。
    pub query: BTreeMap<String, String>,
}

impl Default for UpdateSpec {
    fn default() -> Self {
        Self {
            path: "/json/v5/k8s/acs/K8sApps.json".to_string(),
            app_id_field: "appId".to_string(),
            image_field: "image".to_string(),
            query: BTreeMap::new(),
        }
    }
}

/// 动态查询参数的**名字**：值由适配器在运行时给出，名字属于站点协议。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParamNames {
    /// 每次请求附上的毫秒时间戳参数名（原实现用 `_t`，是控制台防缓存的写法）。
    pub timestamp: String,
    pub repo_name: String,
    pub repo_id: String,
    pub app_name: String,
    pub app_id: String,
    /// 服务名里的 `-` 要不要换成 `_` 再查仓库（EDAS 的镜像仓库命名用下划线）。
    pub repo_name_dashes_to_underscores: bool,
}

impl Default for ParamNames {
    fn default() -> Self {
        Self {
            timestamp: "_t".to_string(),
            repo_name: "repoName".to_string(),
            repo_id: "repoId".to_string(),
            app_name: "appname".to_string(),
            app_id: "appId".to_string(),
            repo_name_dashes_to_underscores: true,
        }
    }
}

/// 响应 JSON 的取值路径。点号分层，`[n]` 取数组下标。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FieldPaths {
    pub repo_id: String,
    pub public_url: String,
    /// tag 数组所在路径；元素内的字段名另给。
    pub tags: String,
    pub tag_name: String,
    /// tag 的构建时间字段（毫秒时间戳），用来挑最新镜像。
    pub tag_updated_ms: String,
    /// 应用列表数组路径，以及"按哪个字段匹配服务名""取哪个字段当 appId"。
    pub app_list: String,
    pub app_name_field: String,
    pub app_id_field: String,
    /// 服务的最近更新时间（毫秒时间戳）：发布后就是靠它判断生效的。
    pub app_update_ms: String,
    /// 控制台统一响应包里的成功位与说明位。
    pub success_flag: String,
    pub message_field: String,
    pub error_code_field: String,
}

impl Default for FieldPaths {
    fn default() -> Self {
        Self {
            repo_id: "data.repoId".to_string(),
            public_url: "data.publicUrl".to_string(),
            tags: "data.tags".to_string(),
            tag_name: "tag".to_string(),
            tag_updated_ms: "imageUpdate".to_string(),
            app_list: "data.result".to_string(),
            app_name_field: "appname".to_string(),
            app_id_field: "appId".to_string(),
            app_update_ms: "data.app.updateTime".to_string(),
            success_flag: "success".to_string(),
            message_field: "message".to_string(),
            error_code_field: "errorCode".to_string(),
        }
    }
}

/// CSRF 头：控制台把令牌放在一枚 Cookie 里，再要求同一枚值以请求头回传。
/// 原实现是硬编码 `c_csrf` → `Hcsrf`，这里做成配置。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsrfRule {
    pub enabled: bool,
    pub cookie_name: String,
    pub header_name: String,
}

impl Default for CsrfRule {
    fn default() -> Self {
        Self { enabled: true, cookie_name: "c_csrf".to_string(), header_name: "Hcsrf".to_string() }
    }
}

/// 会话判定与缓存。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionRule {
    /// 登录成功的判据：这些 Cookie 名字必须都出现（值不参与判断，也不落日志）。
    pub required_cookie_names: Vec<String>,
    /// 只收这些域后缀的 Cookie。留空时按 `baseUrl` 与 `login.authorizeUrl` 的主机名推导。
    pub cookie_host_suffixes: Vec<String>,
    /// 会话在内存里能用多久；超时重新静默登录一次。
    pub ttl_minutes: i64,
    /// 保险库锁定或用户手动退出登录时清缓存的开关位（默认清；留着是为了写审计时能说清事实）。
    pub clear_on_lock: bool,
}

impl Default for SessionRule {
    fn default() -> Self {
        Self {
            required_cookie_names: vec!["c_csrf".to_string()],
            cookie_host_suffixes: Vec::new(),
            ttl_minutes: 30,
            clear_on_lock: true,
        }
    }
}

/// 隐藏 WebView 里那段"填表并登录"的脚本参数。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoginRule {
    pub account_selector: String,
    pub password_selector: String,
    /// `enter`：在口令框上敲回车（原实现的做法）；`click`：点 `submitSelector`；`form`：提交所属表单。
    pub submit: String,
    pub submit_selector: String,
    /// 登录后还要去点一下的授权跳转页（阿里云 ASCM 的 jump 页）。留空则跳过。
    pub authorize_url: String,
    /// 授权页上要点的按钮；`xpath=` 前缀表示 XPath，否则按 CSS 选择器。
    pub authorize_selector: String,
    pub authorize_settle_ms: u64,
    /// 注入脚本的重试间隔与总超时：页面是异步渲染的，一次注入够不着就得等下一轮。
    pub inject_retry_ms: u64,
    pub timeout_ms: u64,
}

impl Default for LoginRule {
    /// 选择器是"这一代控制台的形状"，可以出厂带上；**授权页地址是站点值**，
    /// 和 baseUrl 一样留空，由现场填（交付方 2026-11-02：软件里不带内网域名与 region）。
    fn default() -> Self {
        Self {
            account_selector: "#account".to_string(),
            password_selector: "#password".to_string(),
            submit: "enter".to_string(),
            submit_selector: String::new(),
            authorize_url: String::new(),
            authorize_selector: "xpath=//*[@id=\"icestarkNode\"]/section/div/div[2]/div[3]/span/button".to_string(),
            authorize_settle_ms: 3000,
            inject_retry_ms: 500,
            timeout_ms: 60000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Timeouts {
    pub connect_ms: u64,
    pub read_ms: u64,
    pub write_ms: u64,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self { connect_ms: 8000, read_ms: 20000, write_ms: 20000 }
    }
}

/// 发布后等生效：**有上限**的轮询。原实现是 `for {}` 无限轮询，网关一抖线程就永久挂住。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PollRule {
    pub interval_secs: u64,
    pub max_polls: u32,
}

impl Default for PollRule {
    fn default() -> Self {
        Self { interval_secs: 10, max_polls: 60 }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EdasEndpoints {
    /// 镜像仓库信息：拿 `repoId` 与 `publicUrl`
    pub repository: EndpointSpec,
    /// tag 列表：挑最新镜像
    pub tags: EndpointSpec,
    /// 应用列表：拿 `appId`
    pub app_list: EndpointSpec,
    /// 应用详情：拿最近更新时间（发布生效的判据）
    pub app_detail: EndpointSpec,
    /// 改镜像
    pub update_image: UpdateSpec,
}

impl Default for EdasEndpoints {
    fn default() -> Self {
        let shared = || {
            let mut q = BTreeMap::new();
            q.insert("namespace".to_string(), "{namespace}".to_string());
            q.insert("containerRegistryId".to_string(), "{containerRegistryId}".to_string());
            q.insert("regionId".to_string(), "{regionId}".to_string());
            q.insert("instanceId".to_string(), "{instanceId}".to_string());
            q
        };
        Self {
            repository: EndpointSpec { path: "/json/v5/oam/cr/repository.json".to_string(), query: shared() },
            tags: EndpointSpec { path: "/json/v5/cr/tags.json".to_string(), query: shared() },
            app_list: EndpointSpec {
                path: "/json/queryAppListNew.json".to_string(),
                query: {
                    let mut q = BTreeMap::new();
                    q.insert("action".to_string(), "AppAction".to_string());
                    q.insert("eventSubmitDoQuery".to_string(), "1".to_string());
                    q.insert("physicalRegionId".to_string(), "{physicalRegionId}".to_string());
                    q.insert("resourceGroupId".to_string(), "{resourceGroupId}".to_string());
                    q
                },
            },
            app_detail: EndpointSpec {
                path: "/json/v5/changeorder/CoApplication.json".to_string(),
                query: {
                    let mut q = BTreeMap::new();
                    q.insert("regionId".to_string(), "{regionId}".to_string());
                    q
                },
            },
            update_image: UpdateSpec::default(),
        }
    }
}

/// 一份完整的环境配置。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EdasProfile {
    pub base_url: String,
    /// 站点参数（namespace / regionId / containerRegistryId / instanceId / physicalRegionId / resourceGroupId）。
    pub params: BTreeMap<String, String>,
    pub endpoints: EdasEndpoints,
    pub dynamic_params: ParamNames,
    pub paths: FieldPaths,
    pub csrf: CsrfRule,
    pub session: SessionRule,
    pub login: LoginRule,
    pub timeouts: Timeouts,
    pub poll: PollRule,
    /// 企业自签根证书的**本机路径**：字节不入库，只记路径，读不到就报错。
    pub ca_pem_path: String,
    /// 控制台返回体里出现这些串时按"登录失效"处理（原实现判的是 `ConsoleNeedLogin`）。
    pub session_expired_markers: Vec<String>,
    /// 是否要求 `success` 位为真才算接口成功。
    pub requires_success_flag: bool,
    /// 隐藏登录窗口用的视口尺寸：SSO 页面在小窗口下会折叠表单，选择器就找不到了。
    pub login_viewport: [u32; 2],
    /// 调试用：把注入脚本的返回状态写进运行日志（只有状态串，没有凭据）。
    pub trace_login: bool,
    /// 控制台会按 UA 判断"是不是浏览器在访问"，非浏览器 UA 直接被拒。原实现抄的是 Chrome。
    pub user_agent: String,
}

/// 出厂 profile 只带**协议形状**：端点路径、响应字段名、登录框选择器、超时与轮询上限。
///
/// 站点相关的值一律留空——`baseUrl`、六个 `params`（namespace / containerRegistryId /
/// regionId / instanceId / physicalRegionId / resourceGroupId）与授权页地址。
/// 交付方 2026-11-02 点名：安装包不该带内网域名与 region；留空也让"这份配置是谁填的"
/// 在环境配置里一眼看得出来。留空的代价是出厂值过不了 `validate`，
/// 也就是没配过的环境点「读取发布信息」会直接被拒并说清缺什么。
impl Default for EdasProfile {
    fn default() -> Self {
        let mut params = BTreeMap::new();
        for key in [
            "namespace",
            "containerRegistryId",
            "regionId",
            "instanceId",
            "physicalRegionId",
            "resourceGroupId",
        ] {
            params.insert(key.to_string(), String::new());
        }
        Self {
            base_url: String::new(),
            params,
            endpoints: EdasEndpoints::default(),
            dynamic_params: ParamNames::default(),
            paths: FieldPaths::default(),
            csrf: CsrfRule::default(),
            session: SessionRule::default(),
            login: LoginRule::default(),
            timeouts: Timeouts::default(),
            poll: PollRule::default(),
            ca_pem_path: String::new(),
            session_expired_markers: vec!["ConsoleNeedLogin".to_string()],
            requires_success_flag: default_true(),
            login_viewport: [1440, 900],
            trace_login: true,
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36".to_string(),
        }
    }
}

impl EdasProfile {
    pub fn from_json(raw: &str) -> Result<Self> {
        serde_json::from_str(raw).map_err(|e| AppError::TaskProfileInvalid(format!("profile 无法解析：{e}")))
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|e| AppError::internal("任务配置序列化", &e))
    }

    /// 落库前必须过这里：宁可存不进去，也不要运行时才发现"这配置根本发不了"。
    /// 正文只说哪一项不合格，不含参数值。
    pub fn validate(&self) -> Result<()> {
        let base = Self::parse_host(&self.base_url)?;
        for (name, spec) in [
            ("repository", &self.endpoints.repository),
            ("tags", &self.endpoints.tags),
            ("appList", &self.endpoints.app_list),
            ("appDetail", &self.endpoints.app_detail),
        ] {
            if spec.path.trim().is_empty() {
                return Err(AppError::TaskProfileInvalid(format!("{name} 端点路径为空")));
            }
            Self::check_endpoint_path(&base, name, &spec.path)?;
        }
        Self::check_endpoint_path(&base, "updateImage", &self.endpoints.update_image.path)?;
        if self.endpoints.update_image.app_id_field.trim().is_empty()
            || self.endpoints.update_image.image_field.trim().is_empty()
        {
            return Err(AppError::TaskProfileInvalid("改镜像表单的两个字段名不能为空".to_string()));
        }
        for (name, v) in [
            ("accountSelector", &self.login.account_selector),
            ("passwordSelector", &self.login.password_selector),
        ] {
            if v.trim().is_empty() || v.contains(';') || v.contains("</") {
                return Err(AppError::TaskProfileInvalid(format!("{name} 不合法")));
            }
        }
        if !matches!(self.login.submit.as_str(), "enter" | "click" | "form") {
            return Err(AppError::TaskProfileInvalid("login.submit 只能是 enter / click / form".to_string()));
        }
        if self.login.submit == "click" && self.login.submit_selector.trim().is_empty() {
            return Err(AppError::TaskProfileInvalid("submit=click 时必须给出 submitSelector".to_string()));
        }
        if !self.login.authorize_url.trim().is_empty() {
            Self::parse_host(&self.login.authorize_url)?;
            if self.login.authorize_selector.trim().is_empty() {
                return Err(AppError::TaskProfileInvalid("填了授权地址却没给授权按钮选择器".to_string()));
            }
        }
        if self.login.timeout_ms < 5_000 || self.login.inject_retry_ms == 0 {
            return Err(AppError::TaskProfileInvalid("登录超时至少要 5000 毫秒，注入重试要大于 0".to_string()));
        }
        if self.poll.interval_secs == 0 || self.poll.max_polls == 0 {
            return Err(AppError::TaskProfileInvalid("轮询间隔与次数都必须大于 0".to_string()));
        }
        if self.session.ttl_minutes <= 0 {
            return Err(AppError::TaskProfileInvalid("会话有效期必须大于 0 分钟".to_string()));
        }
        if self.timeouts.connect_ms == 0 || self.timeouts.read_ms == 0 {
            return Err(AppError::TaskProfileInvalid("连接与读取超时必须大于 0".to_string()));
        }
        // 会被拼进 HTTP 请求头的三项：混进换行就是请求头注入，一个字符都不许有。
        for (name, value) in [
            ("userAgent", &self.user_agent),
            ("csrf.headerName", &self.csrf.header_name),
            ("csrf.cookieName", &self.csrf.cookie_name),
        ] {
            if value.contains(['\r', '\n', '\0']) {
                return Err(AppError::TaskProfileInvalid(format!("{name} 里不得出现换行或空字符")));
            }
        }
        Ok(())
    }

    fn parse_host(raw: &str) -> Result<String> {
        if raw.trim().is_empty() {
            return Err(AppError::TaskProfileInvalid("还没填写站点地址：请到「环境配置」里填 baseUrl".to_string()));
        }
        let url = Url::parse(raw.trim()).map_err(|_| AppError::TaskProfileInvalid("地址无法解析".to_string()))?;
        match url.scheme() {
            "https" | "http" => {}
            other => {
                return Err(AppError::TaskProfileInvalid(format!("只允许 http/https，收到 {other}")));
            }
        }
        if url.username() != "" || url.password().is_some() {
            // 凭据写在 URL 里等于把它交给访问日志、代理与历史记录。
            return Err(AppError::TaskProfileInvalid("地址里不得携带用户名或口令".to_string()));
        }
        let host = url.host_str().unwrap_or_default().to_lowercase();
        if host.is_empty() {
            return Err(AppError::TaskProfileInvalid("地址缺少主机名".to_string()));
        }
        Ok(host)
    }

    fn check_endpoint_path(base_host: &str, name: &str, path: &str) -> Result<()> {
        let path = path.trim();
        if path.starts_with("http://") || path.starts_with("https://") {
            let host = Self::parse_host(path)?;
            // 端点指向别的主机是允许的（授权页就在另一个域），但必须能解析出主机名。
            let _ = base_host;
            let _ = host;
            return Ok(());
        }
        if !path.starts_with('/') {
            return Err(AppError::TaskProfileInvalid(format!("{name} 路径要以 / 开头，或写成完整地址")));
        }
        Ok(())
    }

    pub fn is_http(&self) -> bool {
        self.base_url.trim().to_ascii_lowercase().starts_with("http://")
    }

    /// 会话 Cookie 的域后缀：默认取主站与授权页的主机名。
    pub fn cookie_host_suffixes(&self) -> Vec<String> {
        if !self.session.cookie_host_suffixes.is_empty() {
            return self.session.cookie_host_suffixes.iter().map(|s| s.to_lowercase()).collect();
        }
        let mut out = Vec::new();
        for raw in [&self.base_url, &self.login.authorize_url] {
            if let Ok(u) = Url::parse(raw.trim()) {
                if let Some(h) = u.host_str() {
                    let h = h.to_lowercase();
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
            }
        }
        out
    }

    fn resolve_value(&self, value: &str) -> String {
        // `{name}` 占位：值来自 params；没配的名字按空串发出去（原实现也是这么发的）。
        let mut out = String::with_capacity(value.len());
        let mut rest = value;
        while let Some(start) = rest.find('{') {
            out.push_str(&rest[..start]);
            let tail = &rest[start + 1..];
            match tail.find('}') {
                Some(end) => {
                    let key = &tail[..end];
                    out.push_str(self.params.get(key).map(|s| s.as_str()).unwrap_or_default());
                    rest = &tail[end + 1..];
                }
                None => {
                    out.push('{');
                    rest = tail;
                }
            }
        }
        out.push_str(rest);
        out
    }

    fn join(base: &str, path: &str) -> Result<Url> {
        if path.starts_with("http://") || path.starts_with("https://") {
            return Url::parse(path).map_err(|_| AppError::TaskProfileInvalid("端点地址无法解析".to_string()));
        }
        let joined = format!("{}{}", base.trim_end_matches('/'), path);
        Url::parse(&joined).map_err(|_| AppError::TaskProfileInvalid("端点地址无法解析".to_string()))
    }

    /// 组装一个读接口地址。`extra` 是运行时才知道的参数（服务名、repoId、appId、时间戳），
    /// 键名来自 `dynamic_params`，值由调用方按站点要求预处理。
    pub fn build_url(&self, spec: &EndpointSpec, extra: &[(&str, &str)]) -> Result<String> {
        let mut url = Self::join(&self.base_url, spec.path.trim())?;
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in &spec.query {
                q.append_pair(k, &self.resolve_value(v));
            }
            for (k, v) in extra {
                q.append_pair(k, v);
            }
        }
        Ok(url.as_str().to_string())
    }

    pub fn build_update_url(&self, timestamp: &str) -> Result<String> {
        let spec = &self.endpoints.update_image;
        let mut url = Self::join(&self.base_url, spec.path.trim())?;
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in &spec.query {
                q.append_pair(k, &self.resolve_value(v));
            }
            if !self.dynamic_params.timestamp.is_empty() {
                q.append_pair(&self.dynamic_params.timestamp, timestamp);
            }
        }
        Ok(url.as_str().to_string())
    }

    /// 服务名 → 仓库查询用的 repoName（EDAS 的镜像仓库命名把 `-` 写成 `_`）。
    pub fn repo_name_for(&self, service_name: &str) -> String {
        if self.dynamic_params.repo_name_dashes_to_underscores {
            service_name.replace('-', "_")
        } else {
            service_name.to_string()
        }
    }
}

/// 取值：`data.result[0].appId` 这种写法够用，且不引入 JSONPath 依赖。
pub fn pick<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        if segment.is_empty() {
            continue;
        }
        let mut name = segment;
        let mut indices = Vec::new();
        if let Some(open) = segment.find('[') {
            name = &segment[..open];
            let rest = &segment[open..];
            let mut cursor = rest;
            while let Some(start) = cursor.find('[') {
                let tail = &cursor[start + 1..];
                let end = tail.find(']')?;
                indices.push(tail[..end].parse::<usize>().ok()?);
                cursor = &tail[end + 1..];
            }
        }
        if !name.is_empty() {
            current = current.get(name)?;
        }
        for index in indices {
            current = current.get(index)?;
        }
    }
    Some(current)
}

/// 毫秒时间戳 → RFC3339 UTC。控制台的更新时间是秒还是毫秒由调用方判位数。
pub fn ms_to_rfc3339(ms: i64) -> String {
    let secs = ms / 1000;
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs, ((ms % 1000).max(0) as u32) * 1_000_000)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

/// 秒/毫秒自适应：≥ 1e12 当毫秒，否则当秒。控制台两代接口给过不同单位。
pub fn timestamp_to_rfc3339(raw: i64) -> String {
    if raw >= 1_000_000_000_000 {
        ms_to_rfc3339(raw)
    } else {
        ms_to_rfc3339(raw * 1000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一份"现场填过站点值"的 profile：测试里要发请求、要过校验时用这一份。
    fn configured() -> EdasProfile {
        let mut p = EdasProfile::default();
        p.base_url = "https://edas.console.example.com".into();
        p.params.insert("namespace".into(), "nmdlyxcs".into());
        p.params.insert("containerRegistryId".into(), "aliyunCr_edas-reigster-id".into());
        p.params.insert("regionId".into(), "cn-huhhot-impc-d01:YXtest159357".into());
        p.params.insert("physicalRegionId".into(), "cn-huhhot-impc-d01".into());
        p.login.authorize_url = "https://one.console.example.com/ascm/jump/edas".into();
        p
    }

    /// 出厂值只带协议形状，站点值一律留空：没配过的环境必须被校验挡住，
    /// 而不是拿着一个看起来能用的假地址去撞网关。
    #[test]
    fn factory_profile_carries_no_site_values_and_is_rejected_until_filled() {
        let p = EdasProfile::default();
        assert_eq!(p.base_url, "");
        assert!(p.params.values().all(|v| v.is_empty()), "params 的出厂值必须全是空串");
        assert_eq!(p.login.authorize_url, "");
        let json = p.to_json().unwrap().to_ascii_lowercase();
        for forbidden in ["impc", "cn-huhhot", "nmdlyx", "aliyuncr_"] {
            assert!(!json.contains(forbidden), "出厂 profile 里不该出现站点值 {forbidden}");
        }
        let err = p.validate().unwrap_err();
        assert_eq!(err.code(), "TASK_PROFILE_INVALID");
        assert!(err.safe_detail().contains("还没填写站点地址"), "{}", err.safe_detail());

        // 协议形状仍然带着：现场只需要填地址与参数，不用照抄接口路径
        assert_eq!(p.endpoints.repository.path, "/json/v5/oam/cr/repository.json");
        assert_eq!(p.endpoints.update_image.path, "/json/v5/k8s/acs/K8sApps.json");
        assert_eq!(p.csrf.header_name, "Hcsrf");
        assert_eq!(p.paths.app_update_ms, "data.app.updateTime");
        assert_eq!(p.login.account_selector, "#account");
        assert_eq!(p.poll.max_polls, 60);

        // 整份 JSON 里也不该出现任何"键=口令值"的形态
        let lower = json.to_ascii_lowercase();
        for forbidden in ["\"password\":", "\"passwd\":", "\"token\":", "\"cookie\":", "username="] {
            assert!(!lower.contains(forbidden), "出厂 profile 里不该出现 {forbidden}");
        }

        let filled = configured();
        filled.validate().expect("填过站点值就能用");
        let back = EdasProfile::from_json(&filled.to_json().unwrap()).unwrap();
        assert_eq!(back, filled, "往返必须等价，界面改一个字段不会丢别的");
    }

    #[test]
    fn missing_or_unknown_fields_still_get_defaults() {
        let p = EdasProfile::from_json(r#"{"baseUrl":"https://edas.example.com"}"#).unwrap();
        assert_eq!(p.base_url, "https://edas.example.com");
        assert_eq!(p.paths.repo_id, "data.repoId", "缺哪块补哪块，不要求现场抄一整份");
        // 未知字段容忍：以后加一项旧库里的 JSON 不会解析失败
        let p = EdasProfile::from_json(r#"{"baseUrl":"https://e.com","futureField":1}"#).unwrap();
        assert_eq!(p.base_url, "https://e.com");
    }

    #[test]
    fn url_building_resolves_placeholders_and_encodes_values() {
        let p = configured();
        let url = p
            .build_url(
                &p.endpoints.repository,
                &[(&p.dynamic_params.timestamp.clone(), "1730000000000"), (&p.dynamic_params.repo_name.clone(), "svc_order")],
            )
            .unwrap();
        assert!(url.starts_with("https://edas.console.example.com/json/v5/oam/cr/repository.json?"), "{url}");
        assert!(url.contains("namespace=nmdlyxcs"), "{url}");
        // 没填的参数照样以空值发出去（与原实现一致），不至于拼出缺键的地址
        assert!(url.contains("instanceId="), "{url}");
        // regionId 里的冒号必须转义，否则查询串会被截断
        assert!(url.contains("regionId=cn-huhhot-impc-d01%3AYXtest159357"), "{url}");
        assert!(url.contains("_t=1730000000000"), "{url}");
        assert!(url.contains("repoName=svc_order"), "{url}");
        let u = p.build_update_url("1730000000001").unwrap();
        assert!(u.ends_with("_t=1730000000001"), "{u}");
    }

    #[test]
    fn repo_name_follows_the_registry_naming_rule() {
        let p = EdasProfile::default();
        assert_eq!(p.repo_name_for("biz-order-service"), "biz_order_service");
        let mut q = p.clone();
        q.dynamic_params.repo_name_dashes_to_underscores = false;
        assert_eq!(q.repo_name_for("biz-order-service"), "biz-order-service");
    }

    #[test]
    fn validate_rejects_dangerous_or_broken_profiles() {
        let cases: Vec<(&str, EdasProfile)> = vec![
            ("地址协议不对", {
                let mut p = configured();
                p.base_url = "ftp://x".into();
                p
            }),
            ("URL 里塞凭据", {
                let mut p = configured();
                p.base_url = "https://admin:pwd@x.com".into();
                p
            }),
            ("端点路径为空", {
                let mut p = configured();
                p.endpoints.tags.path = String::new();
                p
            }),
            ("端点路径没有前导斜杠", {
                let mut p = configured();
                p.endpoints.app_list.path = "json/queryAppListNew.json".into();
                p
            }),
            ("选择器里塞分号", {
                let mut p = configured();
                p.login.account_selector = "#a;alert(1)".into();
                p
            }),
            ("submit 取值不合法", {
                let mut p = configured();
                p.login.submit = "doubleclick".into();
                p
            }),
            ("轮询没有上限", {
                let mut p = configured();
                p.poll.max_polls = 0;
                p
            }),
            ("会话有效期为 0", {
                let mut p = configured();
                p.session.ttl_minutes = 0;
                p
            }),
            ("UA 里塞换行（请求头注入）", {
                let mut p = configured();
                p.user_agent = "Mozilla/5.0\r\nX-Evil: 1".into();
                p
            }),
            ("CSRF 头名里塞换行", {
                let mut p = configured();
                p.csrf.header_name = "Hcsrf\r\nCookie: a=b".into();
                p
            }),
        ];
        for (what, p) in cases {
            let err = p.validate().expect_err(&format!("{what} 必须被拒"));
            assert_eq!(err.code(), "TASK_PROFILE_INVALID", "{what}");
        }
    }

    #[test]
    fn cookie_host_suffixes_cover_console_and_authorize_hosts() {
        let p = configured();
        let hosts = p.cookie_host_suffixes();
        assert!(hosts.contains(&"edas.console.example.com".to_string()), "{hosts:?}");
        assert!(hosts.contains(&"one.console.example.com".to_string()), "{hosts:?}");
        // 没填地址时不该凭空长出域名后缀
        assert!(EdasProfile::default().cookie_host_suffixes().is_empty());
        let mut q = p.clone();
        q.session.cookie_host_suffixes = vec!["example.internal".into()];
        assert_eq!(q.cookie_host_suffixes(), vec!["example.internal".to_string()]);
    }

    #[test]
    fn pick_walks_objects_and_arrays() {
        let v: serde_json::Value = serde_json::json!({
            "data": {
                "repoId": "r-1",
                "publicUrl": "harbor/svc",
                "tags": [{ "tag": "20261029", "imageUpdate": 1 }, { "tag": "20261030", "imageUpdate": 2 }],
                "result": [{ "appname": "svc-a", "appId": "app-1" }],
                "app": { "updateTime": 1730000000000_i64 }
            }
        });
        assert_eq!(pick(&v, "data.repoId").and_then(|x| x.as_str()), Some("r-1"));
        assert_eq!(pick(&v, "data.tags[1].tag").and_then(|x| x.as_str()), Some("20261030"));
        assert_eq!(pick(&v, "data.result[0].appId").and_then(|x| x.as_str()), Some("app-1"));
        assert_eq!(pick(&v, "data.app.updateTime").and_then(|x| x.as_i64()), Some(1730000000000));
        assert!(pick(&v, "data.missing").is_none());
        assert!(pick(&v, "data.tags[9].tag").is_none());
        assert!(pick(&v, "data.repoId.nope").is_none());
    }

    #[test]
    fn timestamps_normalise_both_units() {
        // 13 位按毫秒、10 位按秒；两代接口给过两种单位，界面上必须都是同一个时刻。
        assert_eq!(timestamp_to_rfc3339(1_730_000_000_000), "2024-10-27T03:33:20+00:00");
        assert_eq!(timestamp_to_rfc3339(1_730_000_000), "2024-10-27T03:33:20+00:00");
        assert_eq!(ms_to_rfc3339(1_730_000_000_000), "2024-10-27T03:33:20+00:00");
        assert_eq!(ms_to_rfc3339(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(timestamp_to_rfc3339(-1), "1969-12-31T23:59:59+00:00");
        // 门槛取整：≥1e12 当毫秒，以下当秒。判据用等价式写，不猜公元三万年的日期字符串。
        assert_eq!(timestamp_to_rfc3339(999_999_999_999), ms_to_rfc3339(999_999_999_999 * 1000));
        assert_eq!(timestamp_to_rfc3339(1_000_000_000_000), ms_to_rfc3339(1_000_000_000_000));
    }
}
