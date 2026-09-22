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
    RequestBuild,
    Io,

    // 请求取消
    /// 用户主动中止了这次发送。**不是失败**：界面不该把它呈现为错误，
    /// 但它必须与超时等失败可区分（spec: http-engine「请求取消」）。
    Cancelled,
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
            ErrorCode::RequestBuild => "request_build",
            ErrorCode::Io => "io",
            ErrorCode::Cancelled => "cancelled",
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
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
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

/// 序列化为 `{ "code": "...", "message": "..." }`，供前端读取分类码。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code.as_str())?;
        s.serialize_field("message", &self.message)?;
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

    let looks_tls = s.contains("invalid peer certificate")
        || s.contains("certificate")
        || s.contains("unknownissuer")
        || s.contains("unknown issuer")
        || s.contains("handshake failure");
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

/// 取最贴近根因的错误文本，用于呈现给用户。
pub fn describe_net_error(err: &reqwest::Error) -> String {
    let deepest = deepest_source(err);
    if deepest.trim().is_empty() {
        err.to_string()
    } else {
        deepest
    }
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
            ErrorCode::RequestBuild,
            ErrorCode::Io,
            ErrorCode::Cancelled,
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

    #[test]
    fn no_rows_maps_to_not_found() {
        let err: AppError = rusqlite::Error::QueryReturnedNoRows.into();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
