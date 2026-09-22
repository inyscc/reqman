//! 存储层与网络层共用的数据模型。
//!
//! 字段刻意留出了 `rodemap` 后续能力（Postman 往返、脚本位、参数启用标记、
//! 条目顺序、可继承的认证）需要的槽位，即使本变更还没有完整的使用者——
//! 见 design.md Context 中的说明。

use crate::secrets::StoredValue;
use serde::de::MapAccess;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use std::fmt;

pub type Id = String;

// ---------------------------------------------------------------------------
// 变量作用域
// ---------------------------------------------------------------------------

/// 变量作用域。声明顺序即解析优先级（`Local` 最高）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Local,
    Data,
    Environment,
    Collection,
    Global,
}

impl Scope {
    /// 解析顺序：local > data > environment > collection > global。
    pub const RESOLUTION_ORDER: [Scope; 5] = [
        Scope::Local,
        Scope::Data,
        Scope::Environment,
        Scope::Collection,
        Scope::Global,
    ];

    /// 越小优先级越高。
    pub fn rank(self) -> u8 {
        Self::RESOLUTION_ORDER
            .iter()
            .position(|s| *s == self)
            .expect("作用域必在解析顺序中") as u8
    }

    /// 是否落盘。local 与 data 只在单次执行期间有效。
    pub fn is_persisted(self) -> bool {
        matches!(self, Scope::Environment | Scope::Collection | Scope::Global)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Local => "local",
            Scope::Data => "data",
            Scope::Environment => "environment",
            Scope::Collection => "collection",
            Scope::Global => "global",
        }
    }

    pub fn parse(value: &str) -> Option<Scope> {
        match value {
            "local" => Some(Scope::Local),
            "data" => Some(Scope::Data),
            "environment" => Some(Scope::Environment),
            "collection" => Some(Scope::Collection),
            "global" => Some(Scope::Global),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// 工作区 / 集合 / 文件夹 / 请求
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: Id,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collection {
    pub id: Id,
    pub workspace_id: Id,
    pub name: String,
    /// 可选描述。不参与请求发送，仅随条目往返（spec: 条目描述持久化）。
    pub description: Option<String>,
    pub auth: AuthConfig,
    pub pre_request_script: Option<String>,
    pub test_script: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: Id,
    pub collection_id: Id,
    pub parent_folder_id: Option<Id>,
    pub name: String,
    /// 可选描述。不参与请求发送，仅随条目往返（spec: 条目描述持久化）。
    pub description: Option<String>,
    pub auth: AuthConfig,
    pub pre_request_script: Option<String>,
    pub test_script: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedRequest {
    pub id: Id,
    pub collection_id: Id,
    pub folder_id: Option<Id>,
    pub name: String,
    /// 可选描述。不参与请求发送，仅随条目往返（spec: 条目描述持久化）。
    pub description: Option<String>,
    pub method: String,
    pub url: String,
    pub params: Vec<KeyValue>,
    pub headers: Vec<KeyValue>,
    pub body: RequestBody,
    pub auth: AuthConfig,
    pub settings: RequestSettings,
    pub pre_request_script: Option<String>,
    pub test_script: Option<String>,
    pub sort_order: i64,
}

/// 可启用/禁用的键值对，用于查询参数与请求头。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub description: Option<String>,
}

impl KeyValue {
    pub fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
            enabled: true,
            description: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyKind {
    None,
    Raw,
    FormData,
    UrlEncoded,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RawLanguage {
    Json,
    Xml,
    Html,
    Text,
    Javascript,
}

impl RawLanguage {
    pub fn content_type(self) -> &'static str {
        match self {
            RawLanguage::Json => "application/json",
            RawLanguage::Xml => "application/xml",
            RawLanguage::Html => "text/html",
            RawLanguage::Text => "text/plain",
            RawLanguage::Javascript => "application/javascript",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormFieldKind {
    Text,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormField {
    pub key: String,
    /// 文本字段的内容。
    pub value: Option<String>,
    /// 文件字段：本地文件的一次性句柄（design D10）。文件路径从不来自前端。
    pub file_handle: Option<String>,
    /// 仅用于展示的文件描述。
    pub description: Option<String>,
    pub kind: FormFieldKind,
    pub enabled: bool,
}

impl FormField {
    pub fn text(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: Some(value.into()),
            file_handle: None,
            description: None,
            kind: FormFieldKind::Text,
            enabled: true,
        }
    }
}

/// 二进制正文：文件由一次性句柄指代（design D10）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BinaryBody {
    /// 本地文件的一次性句柄；路径从不来自前端。
    pub file_handle: Option<String>,
    /// 仅用于展示的文件描述。
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RequestBody {
    pub kind: BodyKind,
    pub raw: Option<String>,
    pub raw_language: Option<RawLanguage>,
    pub form: Vec<FormField>,
    pub urlencoded: Vec<KeyValue>,
    pub binary: Option<BinaryBody>,
}

impl Default for RequestBody {
    fn default() -> Self {
        Self {
            kind: BodyKind::None,
            raw: None,
            raw_language: None,
            form: Vec::new(),
            urlencoded: Vec::new(),
            binary: None,
        }
    }
}

impl RequestBody {
    pub fn raw(text: impl Into<String>, language: RawLanguage) -> Self {
        Self {
            kind: BodyKind::Raw,
            raw: Some(text.into()),
            raw_language: Some(language),
            ..Self::default()
        }
    }

    pub fn none() -> Self {
        Self::default()
    }

    pub fn form(fields: Vec<FormField>) -> Self {
        Self {
            kind: BodyKind::FormData,
            form: fields,
            ..Self::default()
        }
    }

    pub fn urlencoded(pairs: Vec<KeyValue>) -> Self {
        Self {
            kind: BodyKind::UrlEncoded,
            urlencoded: pairs,
            ..Self::default()
        }
    }

    pub fn binary(file_handle: impl Into<String>) -> Self {
        Self {
            kind: BodyKind::Binary,
            binary: Some(BinaryBody {
                file_handle: Some(file_handle.into()),
                description: None,
            }),
            ..Self::default()
        }
    }
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    None,
    Inherit,
    Basic,
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyLocation {
    Header,
    Query,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BasicAuth {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BearerAuth {
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiKeyAuth {
    pub key: String,
    pub value: String,
    pub location: ApiKeyLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    pub kind: AuthKind,
    pub basic: Option<BasicAuth>,
    pub bearer: Option<BearerAuth>,
    pub api_key: Option<ApiKeyAuth>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            kind: AuthKind::Inherit,
            basic: None,
            bearer: None,
            api_key: None,
        }
    }
}

impl AuthConfig {
    pub fn none() -> Self {
        Self {
            kind: AuthKind::None,
            ..Self::default()
        }
    }

    pub fn basic(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            kind: AuthKind::Basic,
            basic: Some(BasicAuth {
                username: username.into(),
                password: password.into(),
            }),
            ..Self::default()
        }
    }

    pub fn bearer(token: impl Into<String>) -> Self {
        Self {
            kind: AuthKind::Bearer,
            bearer: Some(BearerAuth {
                token: token.into(),
            }),
            ..Self::default()
        }
    }

    pub fn api_key(
        key: impl Into<String>,
        value: impl Into<String>,
        location: ApiKeyLocation,
    ) -> Self {
        Self {
            kind: AuthKind::ApiKey,
            api_key: Some(ApiKeyAuth {
                key: key.into(),
                value: value.into(),
                location,
            }),
            ..Self::default()
        }
    }
}

// ---------------------------------------------------------------------------
// 代理与请求级网络设置
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    /// 未配置：顺位到更低层级（请求 → 环境 → 全局）。
    Inherit,
    /// 不使用代理：在该层停下，直接发出请求。
    None,
    /// 跟随操作系统代理设置。
    System,
    /// 手工填写。
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProxyConfig {
    pub mode: ProxyMode,
    /// 形如 `http://host:port` 或 `socks5://host:port`。
    pub url: Option<String>,
    pub username: Option<String>,
    /// 提交的明文凭据。只在「写入这一跳」存在：`Some("")` 表示清除，缺字段表示不改写既有凭据。
    /// 它不落库、也不回传界面（见下面的 `Serialize` 实现）。
    #[serde(default)]
    pub password: Option<String>,
    /// 已保存凭据的 AEAD 密文（`base64(nonce || ciphertext)`）。明文只在内存里出现，
    /// 解密只发生在发送路径。
    #[serde(default)]
    pub password_enc: Option<String>,
    /// 该密文当前是否可解密。与变量的可读标记同一取向：让界面能说出「有值但读不出来」，
    /// 而不是把它显示成「没设置」。
    #[serde(default)]
    pub password_readable: bool,
    /// 不走代理的主机白名单。
    pub no_proxy: Vec<String>,
}

/// 对外（界面）的形状里**没有凭据本身**，只有两个事实：是否已设置、是否可读。
///
/// 手写而不是派生：这样新增字段时必须显式决定它要不要出现在界面上，凭据也就没有
/// 「不小心被序列化出去」这条路径（spec: storage-foundation「敏感值不以明文落盘」）。
impl Serialize for ProxyConfig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("ProxyConfig", 6)?;
        state.serialize_field("mode", &self.mode)?;
        state.serialize_field("url", &self.url)?;
        state.serialize_field("username", &self.username)?;
        state.serialize_field("has_password", &self.password_enc.is_some())?;
        state.serialize_field("password_readable", &self.password_readable)?;
        state.serialize_field("no_proxy", &self.no_proxy)?;
        state.end()
    }
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            mode: ProxyMode::Inherit,
            url: None,
            username: None,
            password: None,
            password_enc: None,
            password_readable: false,
            no_proxy: Vec::new(),
        }
    }
}

impl ProxyConfig {
    pub fn manual(url: impl Into<String>) -> Self {
        Self {
            mode: ProxyMode::Manual,
            url: Some(url.into()),
            ..Self::default()
        }
    }

    pub fn system() -> Self {
        Self {
            mode: ProxyMode::System,
            ..Self::default()
        }
    }

    /// 显式的「不使用代理」。
    pub fn direct() -> Self {
        Self {
            mode: ProxyMode::None,
            ..Self::default()
        }
    }

    /// 该配置是否在本层「生效」——生效即意味着停止向更低层级顺位。
    ///
    /// `Inherit` 不生效，`None`（不使用代理）生效：后者要求的是**直连**这个结果，
    /// 不是一个等待继承的空位。把这两者混为一谈，用户就无法让某个请求绕过全局代理。
    /// 手工填写但地址为空视为未配置——半填的状态没有可执行的意图。
    pub fn is_effective(&self) -> bool {
        match self.mode {
            ProxyMode::Inherit => false,
            ProxyMode::None => true,
            ProxyMode::System => true,
            ProxyMode::Manual => self
                .url
                .as_deref()
                .map(|url| !url.trim().is_empty())
                .unwrap_or(false),
        }
    }

    /// 判断某主机是否命中 `no_proxy` 白名单。
    pub fn bypasses(&self, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        let bare = host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or(host.clone());
        self.no_proxy.iter().any(|entry| {
            let entry = entry.trim().to_ascii_lowercase();
            if entry.is_empty() {
                return false;
            }
            if entry == "*" {
                return true;
            }
            let entry = entry.trim_start_matches('.');
            bare == entry || bare.ends_with(&format!(".{}", entry))
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HttpVersion {
    Auto,
    Http1,
    Http2,
}

/// 响应呈现格式的请求级覆盖（spec: ui-layout「请求级响应格式覆盖」）。
///
/// 只是「选中了哪一档」这一个选择，解释与回退都在前端做（见 `src/lib/sandbox.ts`），
/// 后端不理解也不使用它——它随请求往返，仅此而已。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormatOverride {
    /// 跟随应用级「响应格式检测」设置（缺省）。
    Inherit,
    /// 本次强制按检测结果解释。
    Auto,
    /// 本次强制按 JSON 解释，解释失败静默回退。
    Json,
}

impl Default for ResponseFormatOverride {
    fn default() -> Self {
        Self::Inherit
    }
}

/// 超时取值（spec: http-engine「请求级网络设置」）。
///
/// 三态取代了原先的 `Option<u64>`：一个 `None` 同时承担着「跟随全局」与「没填」，
/// 而「不限制」落在它之外——数字 0 不能用来表示它（本仓库既有约定把非正数当作
/// 无效值并回落缺省），所以「不限制」必须是一个显式取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum TimeoutSetting {
    /// 跟随应用级超时（缺省）。
    Inherit,
    /// 不设超时。
    Unlimited,
    /// 本次使用该毫秒数。
    Custom { ms: u64 },
}

impl Default for TimeoutSetting {
    fn default() -> Self {
        Self::Inherit
    }
}

/// 与 [`TimeoutSetting`] 同形的可派生形态，只为反序列化复用，不对外暴露。
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum TaggedTimeout {
    Inherit,
    Unlimited,
    Custom { ms: u64 },
}

impl From<TaggedTimeout> for TimeoutSetting {
    fn from(value: TaggedTimeout) -> Self {
        match value {
            TaggedTimeout::Inherit => Self::Inherit,
            TaggedTimeout::Unlimited => Self::Unlimited,
            TaggedTimeout::Custom { ms } => Self::Custom { ms },
        }
    }
}

/// 读入时兼容老形态：`timeout_ms` 曾经是裸毫秒数或 `null`（见 `RequestSettings::timeout`
/// 上的别名）。写出一律是新形态，因此老行在第一次保存后即完成升级。
///
/// 手写 `Deserialize` 而不是保留一个只读的老字段：升级发生在反序列化这个边界上，
/// 不需要每个读取点都记得调用一次规范化（漏掉任何一处的代价是用户无感地换了超时值）。
impl<'de> Deserialize<'de> for TimeoutSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct TimeoutVisitor;

        impl<'de> serde::de::Visitor<'de> for TimeoutVisitor {
            type Value = TimeoutSetting;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(
                    "超时取值：{\"mode\":\"inherit\"|\"unlimited\"|\"custom\",\"ms\":毫秒}，或老的裸毫秒数",
                )
            }

            /// 老的 `null`（以及显式空值）等于「跟随全局」。
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(TimeoutSetting::Inherit)
            }

            /// 老的裸毫秒数。
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(TimeoutSetting::Custom { ms: value })
            }

            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                u64::try_from(value)
                    .map(|ms| TimeoutSetting::Custom { ms })
                    .map_err(|_| E::custom("超时的毫秒数不能为负"))
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                TaggedTimeout::deserialize(serde::de::value::MapAccessDeserializer::new(map))
                    .map(TimeoutSetting::from)
            }
        }

        deserializer.deserialize_any(TimeoutVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RequestSettings {
    /// 超时取值（spec: http-engine「请求级网络设置」）。别名让老行里的 `timeout_ms`
    /// 仍被读入，并由 [`TimeoutSetting`] 的反序列化升级为三态。
    #[serde(alias = "timeout_ms")]
    pub timeout: TimeoutSetting,
    pub follow_redirects: bool,
    pub verify_tls: bool,
    pub http_version: HttpVersion,
    pub encoding: Option<String>,
    /// 请求级代理（三级代理中的最高优先层）。
    pub proxy: Option<ProxyConfig>,
    /// 响应呈现格式的请求级覆盖；缺省 = 跟随全局。
    pub response_format: ResponseFormatOverride,
}

impl Default for RequestSettings {
    fn default() -> Self {
        Self {
            timeout: TimeoutSetting::Inherit,
            follow_redirects: true,
            verify_tls: true,
            http_version: HttpVersion::Auto,
            encoding: None,
            proxy: None,
            response_format: ResponseFormatOverride::Inherit,
        }
    }
}

impl RequestSettings {
    /// 证书校验被关闭时需要显著警示（spec: 请求级网络设置）。
    pub fn needs_insecure_warning(&self) -> bool {
        !self.verify_tls
    }
}

// ---------------------------------------------------------------------------
// 环境 / 变量 / 设置
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub id: Id,
    pub workspace_id: Id,
    pub name: String,
    pub is_active: bool,
    /// 环境级代理（三级代理中的中间层）。
    pub proxy: Option<ProxyConfig>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variable {
    pub id: Id,
    pub scope: Scope,
    /// global 作用域下是工作区 id；environment 下是环境 id；collection 下是集合 id。
    pub owner_id: Id,
    pub name: String,
    /// 可选描述，供界面呈现，不参与解析。
    pub description: Option<String>,
    pub is_secret: bool,
    /// 是否参与解析。被禁用的条目仍留在列表里，但不进入作用域。
    pub enabled: bool,
    /// 在所属（作用域 + 归属）内的呈现顺序；同名组里最靠后的**启用**条目生效。
    pub sort_order: i64,
    /// 初始值（往返保真字段，不参与解析）。
    pub initial: StoredValue,
    /// 当前值（参与解析）。
    pub current: StoredValue,
}

impl Variable {
    /// 参与解析的值。不可读或被禁用时视为未定义。
    pub fn resolvable_value(&self) -> Option<&str> {
        if !self.enabled {
            return None;
        }
        self.current.plaintext()
    }
}

/// 应用级设置的键。
pub mod setting_keys {
    /// 全局代理配置（`ProxyConfig` 的 JSON）。
    pub const GLOBAL_PROXY: &str = "global_proxy";
    /// 应用级超时（毫秒；`unlimited` 表示不设超时）。
    pub const REQUEST_TIMEOUT: &str = "request_timeout_ms";
    /// 响应体积硬上限（字节）。
    pub const RESPONSE_SIZE_LIMIT: &str = "response_size_limit_bytes";
    /// 超过该体积不再提供结构化解析视图（字节）。
    pub const PRETTY_PRINT_THRESHOLD: &str = "pretty_print_threshold_bytes";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_priority_matches_spec_order() {
        let order = Scope::RESOLUTION_ORDER;
        assert_eq!(order[0], Scope::Local);
        assert_eq!(order[1], Scope::Data);
        assert_eq!(order[2], Scope::Environment);
        assert_eq!(order[3], Scope::Collection);
        assert_eq!(order[4], Scope::Global);
        // rank 越小越优先
        assert!(Scope::Local.rank() < Scope::Environment.rank());
        assert!(Scope::Environment.rank() < Scope::Global.rank());
    }

    #[test]
    fn only_persisted_scopes_survive_restart() {
        assert!(Scope::Global.is_persisted());
        assert!(Scope::Environment.is_persisted());
        assert!(Scope::Collection.is_persisted());
        assert!(!Scope::Local.is_persisted());
        assert!(!Scope::Data.is_persisted());
    }

    #[test]
    fn scope_roundtrips_through_string() {
        for scope in Scope::RESOLUTION_ORDER {
            assert_eq!(Scope::parse(scope.as_str()), Some(scope));
        }
        assert_eq!(Scope::parse("nope"), None);
    }

    /// 老行里的 `timeout_ms`（裸毫秒数或 `null`）在读取时升级为三态；写出一律是新形态，
    /// 因此老行在第一次保存后即完成升级（spec: http-engine「请求级网络设置」）。
    #[test]
    fn legacy_timeout_shapes_upgrade_to_the_three_state_setting() {
        let bare: RequestSettings =
            serde_json::from_str(r#"{"timeout_ms":1500}"#).expect("老的裸毫秒数应被读入");
        assert_eq!(bare.timeout, TimeoutSetting::Custom { ms: 1500 });

        let null: RequestSettings =
            serde_json::from_str(r#"{"timeout_ms":null}"#).expect("老的 null 应被读入");
        assert_eq!(null.timeout, TimeoutSetting::Inherit, "null 即「跟随全局」");

        let missing: RequestSettings = serde_json::from_str("{}").expect("缺字段应取缺省");
        assert_eq!(missing.timeout, TimeoutSetting::Inherit);

        let encoded = serde_json::to_value(&bare).expect("可序列化");
        assert_eq!(encoded["timeout"]["mode"], "custom");
        assert_eq!(encoded["timeout"]["ms"], 1500);
        assert!(
            encoded.get("timeout_ms").is_none(),
            "老字段不再写出：{encoded}"
        );

        let unlimited: RequestSettings =
            serde_json::from_str(r#"{"timeout":{"mode":"unlimited"}}"#).expect("新形态可读入");
        assert_eq!(unlimited.timeout, TimeoutSetting::Unlimited);
    }

    #[test]
    fn tls_verification_is_on_by_default() {
        let settings = RequestSettings::default();
        assert!(settings.verify_tls);
        assert!(!settings.needs_insecure_warning());
        let insecure = RequestSettings {
            verify_tls: false,
            ..RequestSettings::default()
        };
        assert!(insecure.needs_insecure_warning());
    }

    #[test]
    fn no_proxy_matching_covers_suffix_and_wildcard() {
        let proxy = ProxyConfig {
            no_proxy: vec!["internal.test".into(), ".corp.test".into()],
            ..ProxyConfig::default()
        };
        assert!(proxy.bypasses("internal.test"));
        assert!(proxy.bypasses("internal.test:8080"));
        assert!(proxy.bypasses("api.corp.test"));
        assert!(!proxy.bypasses("example.com"));

        let wildcard = ProxyConfig {
            no_proxy: vec!["*".into()],
            ..ProxyConfig::default()
        };
        assert!(wildcard.bypasses("anything.test"));
    }

    /// 「未配置」不生效（顺位到更低层级），「不使用代理」生效（它是直连这一决定本身）。
    #[test]
    fn proxy_effectiveness_follows_mode() {
        assert!(
            !ProxyConfig::default().is_effective(),
            "默认构造的是「未配置」"
        );
        assert!(
            ProxyConfig::direct().is_effective(),
            "「不使用代理」必须生效，否则它会被顺位跳过"
        );
        assert!(ProxyConfig::system().is_effective());
        assert!(ProxyConfig::manual("http://127.0.0.1:8080").is_effective());
        assert!(!ProxyConfig::manual("   ").is_effective());
    }

    #[test]
    fn default_body_is_none_and_carries_no_residue() {
        let body = RequestBody::none();
        assert_eq!(body.kind, BodyKind::None);
        assert!(body.raw.is_none());
        assert!(body.form.is_empty());
        assert!(body.urlencoded.is_empty());
    }

    #[test]
    fn raw_languages_map_to_content_types() {
        assert_eq!(RawLanguage::Json.content_type(), "application/json");
        assert_eq!(RawLanguage::Xml.content_type(), "application/xml");
        assert_eq!(RawLanguage::Html.content_type(), "text/html");
        assert_eq!(RawLanguage::Text.content_type(), "text/plain");
        assert_eq!(
            RawLanguage::Javascript.content_type(),
            "application/javascript"
        );
    }
}
