//! 认证的应用（spec: 基础认证方式）。
//!
//! 认证配置先经过变量解析，再由这里落成实际的请求头或查询参数。

use super::headers;
use crate::error::{AppError, AppResult};
use crate::logging;
use crate::storage::model::ApiKeyLocation;
use crate::variables::ResolvedAuth;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// 认证落到请求上的结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthApplication {
    pub headers: Vec<(String, String)>,
    pub query: Vec<(String, String)>,
}

/// 把已解析的认证配置转成请求头或查询参数。
pub fn apply(auth: &ResolvedAuth) -> AppResult<AuthApplication> {
    let mut application = AuthApplication::default();

    match auth {
        ResolvedAuth::None => {}

        ResolvedAuth::Basic { username, password } => {
            if username.is_empty() && password.is_empty() {
                return Err(AppError::invalid_input("Basic 认证缺少用户名与密码"));
            }
            // 凭据明文登记给日志出口，之后任何日志里出现它都会被清洗
            logging::global().register_secret_value(password);
            let raw = format!("{}:{}", username, password);
            let encoded = B64.encode(raw.as_bytes());
            application
                .headers
                .push(("Authorization".to_string(), format!("Basic {}", encoded)));
        }

        ResolvedAuth::Bearer { token } => {
            if token.trim().is_empty() {
                return Err(AppError::invalid_input("Bearer 认证缺少令牌"));
            }
            logging::global().register_secret_value(token);
            application
                .headers
                .push(("Authorization".to_string(), format!("Bearer {}", token)));
        }

        ResolvedAuth::ApiKey {
            key,
            value,
            location,
        } => {
            if key.trim().is_empty() {
                return Err(AppError::invalid_input("API Key 名称不能为空"));
            }
            logging::global().register_secret_value(value);

            match location {
                ApiKeyLocation::Header => {
                    if !headers::is_valid_header_name(key) {
                        return Err(AppError::invalid_input(format!(
                            "API Key 的头名称非法：{}",
                            key
                        )));
                    }
                    application
                        .headers
                        .push((key.clone(), value.clone()));
                }
                ApiKeyLocation::Query => {
                    application.query.push((key.clone(), value.clone()));
                }
            }
        }
    }

    headers::validate_headers(&application.headers)?;
    Ok(application)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn basic_auth_encodes_credentials() {
        let application = apply(&ResolvedAuth::Basic {
            username: "user".into(),
            password: "pass".into(),
        })
        .expect("应用认证");

        assert_eq!(application.headers.len(), 1);
        assert_eq!(application.headers[0].0, "Authorization");
        assert_eq!(application.headers[0].1, "Basic dXNlcjpwYXNz");
        assert!(application.query.is_empty());
    }

    #[test]
    fn bearer_auth_sets_the_authorization_header() {
        let application = apply(&ResolvedAuth::Bearer {
            token: "abc123".into(),
        })
        .expect("应用认证");
        assert_eq!(application.headers[0].1, "Bearer abc123");
    }

    #[test]
    fn api_key_goes_to_the_header_when_configured() {
        let application = apply(&ResolvedAuth::ApiKey {
            key: "X-Api-Key".into(),
            value: "secret".into(),
            location: ApiKeyLocation::Header,
        })
        .expect("应用认证");
        assert_eq!(application.headers, vec![("X-Api-Key".to_string(), "secret".to_string())]);
        assert!(application.query.is_empty());
    }

    #[test]
    fn api_key_goes_to_the_query_when_configured() {
        let application = apply(&ResolvedAuth::ApiKey {
            key: "apiKey".into(),
            value: "secret".into(),
            location: ApiKeyLocation::Query,
        })
        .expect("应用认证");
        assert!(application.headers.is_empty());
        assert_eq!(application.query, vec![("apiKey".to_string(), "secret".to_string())]);
    }

    #[test]
    fn no_auth_produces_nothing() {
        let application = apply(&ResolvedAuth::None).expect("应用认证");
        assert_eq!(application, AuthApplication::default());
    }

    #[test]
    fn empty_credentials_are_rejected() {
        let err = apply(&ResolvedAuth::Bearer { token: "  ".into() }).expect_err("应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);

        let err = apply(&ResolvedAuth::ApiKey {
            key: "".into(),
            value: "v".into(),
            location: ApiKeyLocation::Header,
        })
        .expect_err("应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn api_key_with_an_illegal_header_name_is_rejected() {
        let err = apply(&ResolvedAuth::ApiKey {
            key: "X Bad".into(),
            value: "v".into(),
            location: ApiKeyLocation::Header,
        })
        .expect_err("应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn credentials_are_registered_for_log_scrubbing() {
        let secret = "TOKEN_FOR_SCRUBBING_8899";
        apply(&ResolvedAuth::Bearer {
            token: secret.into(),
        })
        .unwrap();
        let redacted = logging::global().redact_text(&format!("dump={}", secret));
        assert!(!redacted.contains(secret), "凭据应被日志出口清洗");
    }
}
