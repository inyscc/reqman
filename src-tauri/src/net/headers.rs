//! 请求头校验。
//!
//! 请求头的名字与值可能来自变量替换，因此必须结构性地挡住「值里带换行」这类
//! 请求头注入。这里给出更直白的错误信息，网络栈自身的校验作为第二道防线。

use crate::error::{AppError, AppResult};

/// HTTP token 字符集（RFC 9110）。
fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

pub fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(is_token_char)
}

/// 校验一个待发送的请求头。
pub fn validate_header(name: &str, value: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::invalid_input("请求头名称不能为空"));
    }
    if !is_valid_header_name(name) {
        return Err(AppError::invalid_input(format!(
            "请求头名称非法（只能由 HTTP token 字符组成）：{}",
            name
        )));
    }
    if value.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
        return Err(AppError::invalid_input(format!(
            "请求头 {} 的值包含换行，可能造成请求头注入",
            name
        )));
    }
    Ok(())
}

/// 批量校验，返回第一个出错的头名。
pub fn validate_headers(headers: &[(String, String)]) -> AppResult<()> {
    for (name, value) in headers {
        validate_header(name, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn ordinary_headers_pass() {
        assert!(validate_header("Content-Type", "application/json").is_ok());
        assert!(validate_header("X-Trace-Id", "abc-123").is_ok());
        assert!(validate_header("Authorization", "Bearer xyz").is_ok());
    }

    #[test]
    fn header_injection_through_a_value_is_blocked() {
        let err = validate_header("X-Trace", "ok\r\nX-Admin: true").expect_err("应拦住注入");
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("换行"));

        let err = validate_header("X-Trace", "ok\nX-Admin: true").expect_err("应拦住注入");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn malformed_names_are_rejected() {
        for name in ["", "   ", "X Trace", "X:Trace", "X\tTrace"] {
            let err = validate_header(name, "v").expect_err("应拒绝");
            assert_eq!(err.code, ErrorCode::InvalidInput, "头名 {:?} 应被拒绝", name);
        }
    }

    #[test]
    fn batch_validation_reports_the_first_problem() {
        let headers = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("X-Bad".to_string(), "a\r\nb".to_string()),
        ];
        assert!(validate_headers(&headers).is_err());
    }
}
