//! 统一错误类型与稳定分类码。
//!
//! design.md D14：超时、域名解析失败、连接被拒、证书错误、代理错误，以及
//! 「收到响应但状态码非成功」必须是可区分的稳定分类，使 spec 中
//! 「失败类别可区分」可被测试断言。错误文本中不含凭据明文。

use serde::{Serialize, Serializer};
use std::fmt;

/// 稳定的错误分类码。前端按此码做差异化引导，测试按此码断言。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    // 输入与通用状态
    InvalidInput,
    NotFound,
    Conflict,
    Internal,

    // 存储
    StorageError,
    /// 凭据库不可用等导致的降级态。
    StorageUnavailable,
    MigrationFailed,

    // 密钥
    /// 操作系统凭据库不可用，拒绝持久化 secret 值（design D5 降级态）。
    SecretStoreUnavailable,
    /// 密文存在但无法解密（例如设备密钥已丢失）。
    SecretUnreadable,

    // 上传句柄
    UploadHandleInvalid,
    UploadHandleConsumed,

    // 网络失败分类
    Timeout,
    DnsFailure,
    TlsError,
    ProxyError,
    ConnectionRefused,
    ConnectionFailed,
    /// 连接建立阶段超时：目标未应答（SYN 被静默丢弃），而不是主动拒绝。
    ///
    /// 与应用级 [`ErrorCode::Timeout`] 不是一回事：后者是我们在客户端上设的时限到了。
    /// 两者混为一谈的话，"卡了很久然后失败"就看不出该往哪儿查——静默丢包恰恰是
    /// "这里出网需要代理"最常见的签名。
    ConnectionTimedOut,
    RequestBuild,
    Io,

    // 请求取消
    /// 用户主动中止了这次发送。**不是失败**：界面不该把它呈现为错误，
    /// 但它必须与超时等失败可区分（spec: http-engine「请求取消」）。
    Cancelled,

    // 变量解析
    /// 请求中存在未能解析的变量，请求因此没有发出（spec: variable-engine「未解析变量提示」）。
    ///
    /// 它不是网络失败：判定发生在解析完成之后、连接建立之前，因此这类请求不产生任何
    /// 网络往返。界面据它把响应区留着（请求没出去），同时把变量名报出来。
    UnresolvedVariables,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidInput => "invalid_input",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Internal => "internal",
            ErrorCode::StorageError => "storage_error",
            ErrorCode::StorageUnavailable => "storage_unavailable",
            ErrorCode::MigrationFailed => "migration_failed",
            ErrorCode::SecretStoreUnavailable => "secret_store_unavailable",
            ErrorCode::SecretUnreadable => "secret_unreadable",
            ErrorCode::UploadHandleInvalid => "upload_handle_invalid",
            ErrorCode::UploadHandleConsumed => "upload_handle_consumed",
            ErrorCode::Timeout => "timeout",
            ErrorCode::DnsFailure => "dns_failure",
            ErrorCode::TlsError => "tls_error",
            ErrorCode::ProxyError => "proxy_error",
            ErrorCode::ConnectionRefused => "connection_refused",
            ErrorCode::ConnectionFailed => "connection_failed",
            ErrorCode::ConnectionTimedOut => "connection_timed_out",
            ErrorCode::RequestBuild => "request_build",
            ErrorCode::Io => "io",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::UnresolvedVariables => "unresolved_variables",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 贯穿存储层与网络层的单一错误类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    /// 出错的这一次发送的**代理决定**（不含凭据）。
    ///
    /// 只在网络层的发送路径上被填上：请求失败时，前端同样要能看到"这次走的是哪个代理"
    /// （spec: http-engine「代理决定的可见性」）。其余错误保持 `None`。
    ///
    /// 代价是这个通用错误类型上挂着一个网络概念。换来的是不必改动既有的错误形状——
    /// 前端 `describeError` 与各处错误处理都按 `{code, message}` 解析，把发送路径的错误
    /// 换成结构体会在多处引出特判（design D6）。
    pub proxy_decision: Option<crate::storage::model::ProxyDecisionView>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            proxy_decision: None,
        }
    }

    /// 挂上这一次发送的代理决定。
    pub fn with_proxy_decision(
        mut self,
        view: crate::storage::model::ProxyDecisionView,
    ) -> Self {
        self.proxy_decision = Some(view);
        self
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::StorageError, message)
    }

    pub fn secret_store_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SecretStoreUnavailable, message)
    }

    pub fn secret_unreadable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::SecretUnreadable, message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

/// 序列化为 `{ "code": "...", "message": "...", "proxy_decision": ... }`，供前端读取分类码。
///
/// `code` 与 `message` 的位置与含义不变——既有的错误处理一律照旧；`proxy_decision`
/// 是附加项，只有发送路径会把它填上。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code.as_str())?;
        s.serialize_field("message", &self.message)?;
        s.serialize_field("proxy_decision", &self.proxy_decision)?;
        s.end()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        match value {
            rusqlite::Error::QueryReturnedNoRows => AppError::not_found("记录不存在"),
            rusqlite::Error::SqliteFailure(err, _) if err.code == rusqlite::ErrorCode::CannotOpen => {
                AppError::new(ErrorCode::StorageUnavailable, "本地数据库无法打开")
            }
            other => AppError::storage(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::new(ErrorCode::Io, value.to_string())
    }
}

/// 网络失败的纯判定函数，便于用合成输入做断言。
///
/// 参数是从 `reqwest::Error` 上抽取的事实：是否为超时、是否为连接阶段失败、
/// 最深层错误来源的文本，以及错误链上最内层 `io::Error` 的原始错误码。
/// 因此本函数不依赖真实网络即可被测试覆盖。
///
/// **为什么除了文本还要错误码**：这里的文本来自操作系统，会随界面语言翻译。
/// 简体中文 Windows 把 getaddrinfo 失败渲染成「不知道这样的主机。 (os error 11001)」，
/// 下面那串英文子串一条都匹配不上，于是一个域名解析失败会被降级成笼统的连接失败，
/// 违反 spec: http-engine 的「失败类别可区分」。错误码不随语言变化，因此优先用它。
pub fn classify_net_failure(
    is_timeout: bool,
    is_connect: bool,
    is_request: bool,
    source: &str,
    os_error: Option<i32>,
) -> ErrorCode {
    let s = source.to_ascii_lowercase();

    if is_timeout {
        return ErrorCode::Timeout;
    }

    if is_dns_failure(&s, os_error) {
        return ErrorCode::DnsFailure;
    }

    // 连接建立阶段超时排在 TLS / 代理的**文案**判定之前：它靠错误码判定，而文案会随
    // 系统界面语言变（见本模块顶部那段说明）。
    if is_connect_timeout(os_error) {
        return ErrorCode::ConnectionTimedOut;
    }

    // TLS 失败的判定：证书问题、握手失败，以及**握手位置读到的不是 TLS 记录**
    // （rustls 的 InvalidMessage 一族）。最后这一类在现实中几乎只来自一个原因——
    // 用 https:// 访问了一个只提供 http 的服务——把它降级成笼统的连接失败，用户
    // 就彻底摸不着头脑了。
    let looks_tls = s.contains("invalid peer certificate")
        || s.contains("certificate")
        || s.contains("unknownissuer")
        || s.contains("unknown issuer")
        || s.contains("handshake failure")
        || looks_like_plaintext_at_tls(&s)
        || s.contains("received fatal alert")
        || s.contains("unsupported protocol")
        || s.contains("peer sent no certificates")
        || s.contains("invalid protocol version");
    if looks_tls {
        return ErrorCode::TlsError;
    }

    let looks_proxy = s.contains("proxy") || s.contains("socks");
    if looks_proxy {
        return ErrorCode::ProxyError;
    }

    if s.contains("connection refused") || is_connection_refused(os_error) {
        return ErrorCode::ConnectionRefused;
    }

    if is_connect {
        return ErrorCode::ConnectionFailed;
    }

    if is_request {
        return ErrorCode::RequestBuild;
    }

    ErrorCode::Io
}

/// 域名解析失败：错误码优先，英文文案兜底。
///
/// 兜底只为了覆盖错误码拿不到的情形（reqwest 自带的 `dns error` 包装层、
/// 以及英文环境下的 getaddrinfo 文案）——**判定本身不能依赖它**。
fn is_dns_failure(lowercase_source: &str, os_error: Option<i32>) -> bool {
    if let Some(code) = os_error {
        let dns_code = matches!(
            code,
            // Windows（Winsock）：主机不存在 / 临时解析失败 / 无恢复 / 无数据记录
            11001..=11004
            // glibc：EAI_* 以负值出现（-2 NONAME / -3 AGAIN / -4 FAIL / -5 NODATA）
            | -5..=-2
        );
        if dns_code {
            return true;
        }
    }

    lowercase_source.contains("dns error")
        || lowercase_source.contains("failed to lookup address")
        || lowercase_source.contains("name or service not known")
        || lowercase_source.contains("nodename nor servname")
        || lowercase_source.contains("no such host")
        || lowercase_source.contains("temporary failure in name resolution")
}

/// 连接被拒：Linux 的 ECONNREFUSED(111) 与 Windows 的 WSAECONNREFUSED(10061)。
///
/// 与 DNS 同理，这条也不能只看英文文案：Rust 把 OS 错误渲染成
/// 「本地化文案 (os error N)」，文案会翻译，N 不会。
fn is_connection_refused(os_error: Option<i32>) -> bool {
    matches!(os_error, Some(111) | Some(10061))
}

/// 连接建立阶段超时：Windows 的 WSAETIMEDOUT(10060) 与 Linux 的 ETIMEDOUT(110)。
///
/// 与「连接被拒」的区别是**对端有没有回应**：被拒是对方回了 RST（说明路径通、只是
/// 那里没服务），超时是连 SYN 都没人理——静默丢包。这条差异对排查很关键，所以判据
/// 同样只看错误码，不看会翻译的文案。
fn is_connect_timeout(os_error: Option<i32>) -> bool {
    matches!(os_error, Some(10060) | Some(110))
}

/// 沿 `source()` 链找出最内层 `io::Error` 的原始错误码（最贴近根因的那一个）。
///
/// 这是分类里唯一不随系统界面语言变化的信号。
fn deepest_os_error(err: &(dyn std::error::Error + 'static)) -> Option<i32> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut found = None;

    while let Some(inner) = current {
        if let Some(code) = inner
            .downcast_ref::<std::io::Error>()
            .and_then(|io| io.raw_os_error())
        {
            found = Some(code);
        }
        current = inner.source();
    }

    found
}

/// 从 `reqwest::Error` 抽取事实后交判定函数分类。
pub fn classify_reqwest_error(err: &reqwest::Error) -> ErrorCode {
    classify_net_failure(
        err.is_timeout(),
        err.is_connect(),
        err.is_request(),
        &deepest_source(err),
        deepest_os_error(err),
    )
}

/// 对端在 TLS 握手位置返回了非 TLS 数据（rustls 把它报成 `corrupt message of type …`）。
///
/// 现实中它几乎只有一个来源：**用 `https://` 访问了一个只提供 HTTP 的服务**（其次是
/// 链路中间设备截断了连接）。所以这句话既该被归为 TLS 失败，也该换成用户能照着做的提示。
fn looks_like_plaintext_at_tls(source: &str) -> bool {
    let s = source.to_ascii_lowercase();

    s.contains("corrupt message") || s.contains("invalidcontenttype")
}

/// 把最深层错误文本转成**给用户看**的文案。
///
/// 默认原样返回：系统与本机产生的文案（域名解析失败、连接被拒等）本来就能看懂。只有那些
/// 对用户毫无指引的底层库措辞才被换掉——目前是「TLS 握手位置读到非 TLS 数据」这一类。
/// 原始措辞仍保留在末尾，排查时不丢信息。
pub fn describe_net_failure(source: &str) -> String {
    let trimmed = source.trim();

    if trimmed.is_empty() {
        return String::new();
    }

    if looks_like_plaintext_at_tls(trimmed) {
        return format!(
            "TLS 握手失败：对端返回的不是加密数据。这通常是因为用 https:// 访问了一个只提供 \
             http 的服务——请核对 URL 的协议与端口是否与目标一致。原始错误：{trimmed}"
        );
    }

    trimmed.to_string()
}

/// 取最贴近根因的错误文本，用于呈现给用户。
pub fn describe_net_error(err: &reqwest::Error) -> String {
    let deepest = deepest_source(err);
    if deepest.trim().is_empty() {
        err.to_string()
    } else {
        describe_net_failure(&deepest)
    }
}

/// 在已描述好的失败文本之上，补上「本次未经代理」这一**事实**。
///
/// 纯函数，因此不必真的制造一次连接建立超时（那要等目标把 SYN 丢到系统放弃，二十秒
/// 起步）就能断言这条行为。
///
/// 补充的条件是「分类为连接建立超时」且「本次决定为直连」：经代理时连的是代理而不是
/// 目标，那时说"未经代理"就是错的。只说**事实**，SHALL NOT 断言代理是唯一成因——
/// 我们只知道这次没走代理，不知道对端是不是本来就不通。
pub fn describe_failure(code: ErrorCode, via_proxy: bool, described: &str) -> String {
    if code == ErrorCode::ConnectionTimedOut && !via_proxy {
        return format!("连接建立超时：目标一直没有应答。本次未经代理。原始错误：{described}");
    }

    described.to_string()
}

/// 沿 `source()` 链取最深层文本——最贴近根因的那一层。
fn deepest_source(err: &dyn std::error::Error) -> String {
    let mut current: Option<&(dyn std::error::Error + 'static)> = err.source();
    let mut text = err.to_string();
    while let Some(inner) = current {
        text = inner.to_string();
        current = inner.source();
    }
    text
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_with_stable_code() {
        let err = AppError::new(ErrorCode::Timeout, "请求超过设定的超时时间");
        let value = serde_json::to_value(&err).expect("可序列化");
        assert_eq!(value["code"], "timeout");
        assert_eq!(value["message"], "请求超过设定的超时时间");
    }

    #[test]
    fn every_code_has_distinct_string() {
        let codes = [
            ErrorCode::InvalidInput,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Internal,
            ErrorCode::StorageError,
            ErrorCode::StorageUnavailable,
            ErrorCode::MigrationFailed,
            ErrorCode::SecretStoreUnavailable,
            ErrorCode::SecretUnreadable,
            ErrorCode::UploadHandleInvalid,
            ErrorCode::UploadHandleConsumed,
            ErrorCode::Timeout,
            ErrorCode::DnsFailure,
            ErrorCode::TlsError,
            ErrorCode::ProxyError,
            ErrorCode::ConnectionRefused,
            ErrorCode::ConnectionFailed,
            ErrorCode::ConnectionTimedOut,
            ErrorCode::RequestBuild,
            ErrorCode::Io,
            ErrorCode::Cancelled,
            ErrorCode::UnresolvedVariables,
        ];
        let mut seen = std::collections::HashSet::new();
        for code in codes {
            assert!(seen.insert(code.as_str()), "重复的分类码: {}", code);
        }
    }

    #[test]
    fn network_failure_classes_are_distinguishable() {
        // 超时优先于其它线索
        assert_eq!(
            classify_net_failure(true, true, false, "connection refused", None),
            ErrorCode::Timeout
        );
        assert_eq!(
            classify_net_failure(false, true, false, "dns error: failed to lookup address", None),
            ErrorCode::DnsFailure
        );
        assert_eq!(
            classify_net_failure(
                false,
                true,
                false,
                "invalid peer certificate: UnknownIssuer",
                None
            ),
            ErrorCode::TlsError
        );
        assert_eq!(
            classify_net_failure(false, true, false, "proxy CONNECT failed", None),
            ErrorCode::ProxyError
        );
        assert_eq!(
            classify_net_failure(false, true, false, "Connection refused (os error 111)", None),
            ErrorCode::ConnectionRefused
        );
        assert_eq!(
            classify_net_failure(false, true, false, "connection reset", None),
            ErrorCode::ConnectionFailed
        );
        assert_eq!(
            classify_net_failure(false, false, true, "builder error", None),
            ErrorCode::RequestBuild
        );
    }

    #[test]
    fn a_plaintext_service_behind_https_is_a_tls_failure_not_a_vague_connect_error() {
        // rustls 在握手位置读到非 TLS 记录时报这句。它几乎只来自「用 https 访问了一个
        // 只提供 http 的服务」，因此必须落在 TLS 类别里，而不是被当成笼统的连接失败。
        assert_eq!(
            classify_net_failure(
                false,
                true,
                false,
                "received corrupt message of type InvalidContentType",
                None
            ),
            ErrorCode::TlsError
        );
    }

    #[test]
    fn that_failure_tells_the_user_to_check_the_scheme() {
        let text = describe_net_failure("received corrupt message of type InvalidContentType");

        // 用户看到的是可操作的原因（协议与目标不匹配），而不是 rustls 的枚举名
        assert!(text.contains("https://"), "消息应点名 https：{text}");
        assert!(text.contains("http 的服务"), "消息应点名目标其实是 http：{text}");
        // 原始措辞留在末尾，排查时不丢信息
        assert!(
            text.contains("received corrupt message"),
            "消息应保留原始错误：{text}"
        );
    }

    #[test]
    fn other_failures_keep_their_original_text() {
        // 只有那一类被改写：其余失败保持原样，避免给出与成因不符的引导
        assert_eq!(
            describe_net_failure("Connection refused (os error 111)"),
            "Connection refused (os error 111)"
        );
    }

    #[test]
    fn dns_is_not_masked_by_connect_flag() {
        // DNS 解析失败在 reqwest 中同时是 connect 类错误，必须仍被识别为 DnsFailure
        let code = classify_net_failure(false, true, false, "error trying to connect: dns error", None);
        assert_eq!(code, ErrorCode::DnsFailure);
    }

    #[test]
    fn dns_failure_is_recognized_from_the_os_code_not_the_text() {
        // 简体中文 Windows 的 getaddrinfo 失败文案：上面那串英文子串一条都匹配不上，
        // 只有 Rust 自己加的错误码是不随语言变化的（回归用例：这就是线上把解析
        // 失败报成「连接失败」的原因）。
        assert_eq!(
            classify_net_failure(
                false,
                true,
                false,
                "不知道这样的主机。 (os error 11001)",
                Some(11001)
            ),
            ErrorCode::DnsFailure
        );
        // glibc 的 EAI_* 以负值出现，文案同样可能是本地化的
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的解析失败文案", Some(-2)),
            ErrorCode::DnsFailure
        );
    }

    #[test]
    fn connection_refused_is_recognized_from_the_os_code() {
        // Linux ECONNREFUSED 与 Windows WSAECONNREFUSED，文案都可能被翻译
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的拒绝文案", Some(111)),
            ErrorCode::ConnectionRefused
        );
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的拒绝文案", Some(10061)),
            ErrorCode::ConnectionRefused
        );
    }

    #[test]
    fn a_non_dns_os_code_is_not_mistaken_for_dns() {
        // WSAECONNRESET：不能因为带了错误码就当解析失败
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的连接重置文案", Some(10054)),
            ErrorCode::ConnectionFailed
        );
    }

    /// 连接建立超时是**自己一类**：它是静默丢包的签名，被压进笼统的连接失败就看不出
    /// 该往哪儿查了（"这里出网要不要走代理"）。
    #[test]
    fn a_connect_phase_timeout_is_its_own_class() {
        // Windows 的 WSAETIMEDOUT 与 Linux 的 ETIMEDOUT；两者的文案都可能被翻译
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的超时文案", Some(10060)),
            ErrorCode::ConnectionTimedOut
        );
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的超时文案", Some(110)),
            ErrorCode::ConnectionTimedOut
        );

        // 与相邻的两类互不吞并
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的拒绝文案", Some(10061)),
            ErrorCode::ConnectionRefused,
            "被拒是对方回了 RST，不是超时"
        );
        assert_eq!(
            classify_net_failure(false, true, false, "不知道这样的主机。 (os error 11001)", Some(11001)),
            ErrorCode::DnsFailure
        );
        assert_eq!(
            classify_net_failure(false, true, false, "本地化的连接重置文案", Some(10054)),
            ErrorCode::ConnectionFailed,
            "重置既不是超时也不是被拒"
        );
    }

    /// 直连时的连接建立超时要**陈述这一事实**，经代理时不陈述——并始终保留原始文本。
    #[test]
    fn a_direct_connect_timeout_says_it_went_direct() {
        let raw = "由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。 (os error 10060)";

        let direct = describe_failure(ErrorCode::ConnectionTimedOut, false, raw);
        assert!(direct.contains("本次未经代理"), "{direct}");
        assert!(direct.contains("os error 10060"), "原始文本要保留：{direct}");

        // 经代理时连的是代理而不是目标，说"未经代理"就是错的
        let proxied = describe_failure(ErrorCode::ConnectionTimedOut, true, raw);
        assert!(!proxied.contains("本次未经代理"), "经代理时不该这么说：{proxied}");
        assert!(proxied.contains("os error 10060"), "原始文本照旧保留：{proxied}");

        // 其它分类不受这条影响
        let other = describe_failure(ErrorCode::ConnectionRefused, false, raw);
        assert!(!other.contains("本次未经代理"), "{other}");
        assert_eq!(other, raw, "其余失败保持原有呈现");
    }

    #[test]
    fn no_rows_maps_to_not_found() {
        let err: AppError = rusqlite::Error::QueryReturnedNoRows.into();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
