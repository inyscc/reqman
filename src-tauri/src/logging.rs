//! 日志脱敏的单一出口（design.md D6）。
//!
//! 所有日志都经过 [`Redactor`]：先按头名黑名单做字段级脱敏，再对已知 secret
//! 明文值做一次值级清洗作为兜底。请求与响应正文默认不写入日志——本模块**不提供**
//! 任何记录正文的入口，这是把「正文不落日志」变成结构性事实而不是纪律要求。

use std::collections::HashSet;
use std::sync::{Arc, OnceLock, RwLock};

/// 掩码字面量。
pub const MASK: &str = "******";

/// 头名黑名单。按小写比较。
const SENSITIVE_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
    "x-amz-security-token",
    "x-csrf-token",
];

/// 短于该长度的 secret 值不做值级清洗，避免把常见短串整片掩掉。
const MIN_SCRUB_LEN: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

/// 日志下游。测试用它捕获输出以做断言。
pub trait Sink: Send + Sync {
    fn emit(&self, level: Level, line: &str);
}

/// 默认下游：转发给 `tracing`。
pub struct TracingSink;

impl Sink for TracingSink {
    fn emit(&self, level: Level, line: &str) {
        match level {
            Level::Debug => tracing::debug!("{}", line),
            Level::Info => tracing::info!("{}", line),
            Level::Warn => tracing::warn!("{}", line),
            Level::Error => tracing::error!("{}", line),
        }
    }
}

/// 捕获式下游，供测试与诊断面板使用。
#[derive(Default)]
pub struct MemorySink {
    lines: RwLock<Vec<String>>,
}

impl MemorySink {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines.read().expect("日志锁未中毒").clone()
    }

    pub fn joined(&self) -> String {
        self.lines().join("\n")
    }
}

impl Sink for MemorySink {
    fn emit(&self, level: Level, line: &str) {
        self.lines
            .write()
            .expect("日志锁未中毒")
            .push(format!("{} {}", level.as_str(), line));
    }
}

/// 脱敏出口。可独立实例化，便于测试不受进程级全局状态干扰。
pub struct Redactor {
    sink: RwLock<Arc<dyn Sink>>,
    secret_values: RwLock<HashSet<String>>,
}

impl Redactor {
    pub fn new(sink: Arc<dyn Sink>) -> Self {
        Self {
            sink: RwLock::new(sink),
            secret_values: RwLock::new(HashSet::new()),
        }
    }

    pub fn set_sink(&self, sink: Arc<dyn Sink>) {
        *self.sink.write().expect("日志锁未中毒") = sink;
    }

    /// 登记一个 secret 明文值，之后任何日志里出现它都会被清洗。
    pub fn register_secret_value(&self, value: &str) {
        let trimmed = value.trim();
        if trimmed.chars().count() < MIN_SCRUB_LEN {
            return;
        }
        self.secret_values
            .write()
            .expect("日志锁未中毒")
            .insert(trimmed.to_string());
    }

    /// 批量登记当前工作区的 secret 值。
    pub fn register_secret_values<'a, I: IntoIterator<Item = &'a str>>(&self, values: I) {
        for value in values {
            self.register_secret_value(value);
        }
    }

    pub fn forget_secret_values(&self) {
        self.secret_values.write().expect("日志锁未中毒").clear();
    }

    /// 值级清洗兜底：把已知 secret 明文替换为掩码。
    pub fn redact_text(&self, text: &str) -> String {
        let secrets = self.secret_values.read().expect("日志锁未中毒");
        let mut out = text.to_string();
        for secret in secrets.iter() {
            if out.contains(secret.as_str()) {
                out = out.replace(secret.as_str(), MASK);
            }
        }
        out
    }

    /// 唯一的写日志入口：先脱敏，再交给下游。
    pub fn log(&self, level: Level, message: &str) {
        let redacted = self.redact_text(message);
        let sink = self.sink.read().expect("日志锁未中毒").clone();
        sink.emit(level, &redacted);
    }

    pub fn info(&self, message: &str) {
        self.log(Level::Info, message);
    }

    pub fn warn(&self, message: &str) {
        self.log(Level::Warn, message);
    }

    pub fn error(&self, message: &str) {
        self.log(Level::Error, message);
    }

    pub fn debug(&self, message: &str) {
        self.log(Level::Debug, message);
    }

    /// 请求开始。只记录方法、脱敏后的 URL，以及请求头的**名字**——
    /// 不记头值，不记正文。
    pub fn log_request_start(&self, method: &str, url: &str, header_names: &[String]) {
        let names = if header_names.is_empty() {
            "-".to_string()
        } else {
            header_names.join(",")
        };
        self.log(
            Level::Info,
            &format!("request start method={} url={} headers=[{}]", method, url, names),
        );
    }

    /// 响应摘要。只记录状态码、耗时与体积——不记正文。
    pub fn log_response_summary(&self, status: u16, elapsed_ms: u128, size: u64) {
        self.log(
            Level::Info,
            &format!(
                "response summary status={} elapsed_ms={} size={}",
                status, elapsed_ms, size
            ),
        );
    }
}

/// 头名是否属于敏感头。
pub fn is_sensitive_header(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    SENSITIVE_HEADERS.iter().any(|h| *h == lower)
}

/// 字段级脱敏：敏感头的值替换为掩码，其余原样返回。
pub fn redact_header_value(name: &str, value: &str) -> String {
    if is_sensitive_header(name) {
        MASK.to_string()
    } else {
        value.to_string()
    }
}

static GLOBAL: OnceLock<Redactor> = OnceLock::new();

/// 进程级出口。命令层与网络层统一从这里记录。
pub fn global() -> &'static Redactor {
    GLOBAL.get_or_init(|| Redactor::new(Arc::new(TracingSink)))
}

/// 初始化日志下游。日志内容仍全部经过 [`global`] 的脱敏出口。
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> (Redactor, Arc<MemorySink>) {
        let sink = MemorySink::new();
        (Redactor::new(sink.clone()), sink)
    }

    #[test]
    fn sensitive_headers_are_masked_by_name() {
        for name in [
            "Authorization",
            "authorization",
            "Cookie",
            "Set-Cookie",
            "X-Api-Key",
            "proxy-authorization",
        ] {
            assert_eq!(
                redact_header_value(name, "Bearer very-secret"),
                MASK,
                "头 {} 应被掩码",
                name
            );
        }
    }

    #[test]
    fn benign_header_value_is_untouched() {
        assert_eq!(
            redact_header_value("Content-Type", "application/json"),
            "application/json"
        );
    }

    #[test]
    fn known_secret_value_is_scrubbed_anywhere() {
        let (log, _sink) = redactor();
        log.register_secret_value("super-secret-token");
        let redacted = log.redact_text("普通字段=x super-secret-token y");
        assert_eq!(redacted, format!("普通字段=x {} y", MASK));
        assert!(!redacted.contains("super-secret-token"));
    }

    #[test]
    fn short_secret_values_are_not_scrubbed() {
        let (log, _sink) = redactor();
        log.register_secret_value("abc");
        assert_eq!(log.redact_text("abc"), "abc");
    }

    #[test]
    fn request_log_carries_no_header_values_and_no_body() {
        let (log, sink) = redactor();
        let header_names = vec!["Authorization".to_string(), "Content-Type".to_string()];
        log.log_request_start("POST", "https://example.test/api", &header_names);
        let text = sink.joined();
        assert!(text.contains("method=POST"));
        assert!(text.contains("Authorization,Content-Type"));
        assert!(!text.contains("Bearer"));
    }

    #[test]
    fn full_request_response_flow_logs_no_body_content() {
        let (log, sink) = redactor();
        let request_body = "BODY_SENTINEL_12345";
        let response_body = "RESPONSE_SENTINEL_67890";

        log.log_request_start(
            "POST",
            "https://example.test/api",
            &["Content-Type".to_string()],
        );
        log.log_response_summary(200, 42, 512);

        let text = sink.joined();
        assert!(!text.contains(request_body));
        assert!(!text.contains(response_body));
        assert!(text.contains("response summary"));
    }

    #[test]
    fn secret_smuggled_through_a_benign_header_field_is_still_scrubbed() {
        // 值级清洗作为兜底：secret 值以普通字段出现时同样被清洗
        let (log, sink) = redactor();
        log.register_secret_value("leaked-value-42");
        log.info("debug dump field=leaked-value-42");
        let text = sink.joined();
        assert!(!text.contains("leaked-value-42"));
        assert!(text.contains(MASK));
    }
}
