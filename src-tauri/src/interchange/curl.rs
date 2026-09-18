//! 把一条已解析的请求序列化为可执行的 curl 命令。
//!
//! 使用**解析后**的实际取值，与 Postman 的 "Copy as cURL" 一致（design D9）。
//! 由于命令会落到剪贴板而不是文件，凭据取真实值；含 secret 或本地文件时，
//! 通过 `warnings` 把「不可直接执行」的原因显式告知界面。

use crate::storage::model::ApiKeyLocation;
use crate::variables::{ResolvedAuth, ResolvedBody, ResolvedFormField, ResolvedRequest};
use serde::{Deserialize, Serialize};

/// curl 导出结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurlCommand {
    pub command: String,
    /// 命令中是否含 secret 变量的真实取值。
    pub contains_secret: bool,
    /// 使命令无法直接执行的原因；界面据此提示用户。
    pub warnings: Vec<String>,
}

impl CurlCommand {
    /// 命令是否可以直接执行。
    pub fn is_directly_executable(&self) -> bool {
        self.warnings.is_empty()
    }
}

/// 由解析后的请求生成 curl 命令。
pub fn curl_command(resolved: &ResolvedRequest) -> CurlCommand {
    let mut parts: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    parts.push(format!("curl -X {}", resolved.method));

    let mut url = resolved.url.clone();
    if let ResolvedAuth::ApiKey {
        key,
        value,
        location: ApiKeyLocation::Query,
    } = &resolved.auth
    {
        url = append_query(&url, key, value);
    }
    parts.push(shell_quote(&url));

    // 认证：以 curl 惯用的形式携带
    match &resolved.auth {
        ResolvedAuth::Basic { username, password } => {
            parts.push(format!(
                "-u {}",
                shell_quote(&format!("{}:{}", username, password))
            ));
        }
        ResolvedAuth::Bearer { token } => {
            parts.push(format!(
                "-H {}",
                shell_quote(&format!("Authorization: Bearer {}", token))
            ));
        }
        ResolvedAuth::ApiKey {
            key,
            value,
            location: ApiKeyLocation::Header,
        } => {
            parts.push(format!("-H {}", shell_quote(&format!("{}: {}", key, value))));
        }
        _ => {}
    }

    for (name, value) in &resolved.headers {
        parts.push(format!("-H {}", shell_quote(&format!("{}: {}", name, value))));
    }

    match &resolved.body {
        ResolvedBody::None => {}
        ResolvedBody::Raw { text, content_type } => {
            if !has_header(&resolved.headers, "content-type") {
                parts.push(format!(
                    "-H {}",
                    shell_quote(&format!("Content-Type: {}", content_type))
                ));
            }
            parts.push(format!("--data-raw {}", shell_quote(text)));
        }
        ResolvedBody::UrlEncoded { pairs } => {
            if !has_header(&resolved.headers, "content-type") {
                parts.push(format!(
                    "-H {}",
                    shell_quote("Content-Type: application/x-www-form-urlencoded")
                ));
            }
            parts.push(format!("--data-raw {}", shell_quote(&encode_pairs(pairs))));
        }
        ResolvedBody::FormData { fields } => {
            for field in fields {
                match field {
                    ResolvedFormField::Text { key, value } => {
                        parts.push(format!("-F {}", shell_quote(&format!("{}={}", key, value))));
                    }
                    ResolvedFormField::File { key, .. } => {
                        // 本地文件的位置从不进入后端；这里只能给占位符
                        parts.push(format!(
                            "-F {}",
                            shell_quote(&format!("{}=@<需自行替换为本地文件路径>", key))
                        ));
                        warnings.push(format!(
                            "字段「{}」引用了本地文件，命令中的文件位置是占位符",
                            key
                        ));
                    }
                }
            }
        }
        ResolvedBody::Binary { .. } => {
            parts.push(format!(
                "--data-binary {}",
                shell_quote("@<需自行替换为本地文件路径>")
            ));
            warnings.push("请求体为二进制文件，命令中的文件位置是占位符".to_string());
        }
    }

    if !resolved.secret_used.is_empty() {
        warnings.push(format!(
            "命令包含 secret 变量的明文取值：{}",
            resolved.secret_used.join("、")
        ));
    }

    CurlCommand {
        command: parts.join(" \\\n  "),
        contains_secret: !resolved.secret_used.is_empty(),
        warnings,
    }
}

/// 单引号包裹，并转义值中已有的单引号——否则凭据里的引号会让命令变形。
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
}

fn append_query(url: &str, key: &str, value: &str) -> String {
    let pair = encode_pairs(&[(key.to_string(), value.to_string())]);
    if url.contains('?') {
        format!("{}&{}", url, pair)
    } else {
        format!("{}?{}", url, pair)
    }
}

fn encode_pairs(pairs: &[(String, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::model::RequestSettings;
    use crate::variables::{ResolvedAuth, ResolvedBody, ResolvedFormField};

    fn resolved(method: &str, url: &str) -> ResolvedRequest {
        ResolvedRequest {
            method: method.to_string(),
            url: url.to_string(),
            params: Vec::new(),
            headers: Vec::new(),
            body: ResolvedBody::None,
            auth: ResolvedAuth::None,
            settings: RequestSettings::default(),
            proxy: None,
            unresolved: Vec::new(),
            used: Vec::new(),
            secret_used: Vec::new(),
        }
    }

    // ---- 6.1 序列化 ----

    #[test]
    fn get_with_query_and_headers() {
        let mut request = resolved("GET", "https://api.test/users?page=1&size=10");
        request.headers = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("X-Trace".to_string(), "abc".to_string()),
        ];

        let curl = curl_command(&request);
        assert!(curl.command.starts_with("curl -X GET"));
        assert!(curl.command.contains("'https://api.test/users?page=1&size=10'"));
        assert!(curl.command.contains("-H 'Accept: application/json'"));
        assert!(curl.command.contains("-H 'X-Trace: abc'"));
        assert!(curl.is_directly_executable(), "{:?}", curl.warnings);
    }

    #[test]
    fn post_with_raw_json_body_sets_content_type() {
        let mut request = resolved("POST", "https://api.test/users");
        request.body = ResolvedBody::Raw {
            text: "{\"name\":\"n\"}".to_string(),
            content_type: "application/json".to_string(),
        };

        let curl = curl_command(&request);
        assert!(curl.command.contains("curl -X POST"));
        assert!(curl
            .command
            .contains("-H 'Content-Type: application/json'"));
        assert!(curl.command.contains("--data-raw '{\"name\":\"n\"}'"));
        assert!(curl.is_directly_executable());
    }

    #[test]
    fn a_user_supplied_content_type_is_not_duplicated() {
        let mut request = resolved("POST", "https://api.test/users");
        request.headers = vec![("Content-Type".to_string(), "application/vnd.custom+json".to_string())];
        request.body = ResolvedBody::Raw {
            text: "{}".to_string(),
            content_type: "application/json".to_string(),
        };

        let curl = curl_command(&request);
        assert_eq!(
            curl.command.matches("Content-Type").count(),
            1,
            "不应重复添加内容类型"
        );
        assert!(curl.command.contains("application/vnd.custom+json"));
    }

    #[test]
    fn auth_appears_in_the_expected_form() {
        let mut basic = resolved("GET", "https://api.test/");
        basic.auth = ResolvedAuth::Basic {
            username: "u".to_string(),
            password: "p".to_string(),
        };
        assert!(curl_command(&basic).command.contains("-u 'u:p'"));

        let mut bearer = resolved("GET", "https://api.test/");
        bearer.auth = ResolvedAuth::Bearer {
            token: "tok".to_string(),
        };
        assert!(curl_command(&bearer)
            .command
            .contains("-H 'Authorization: Bearer tok'"));

        let mut header_key = resolved("GET", "https://api.test/");
        header_key.auth = ResolvedAuth::ApiKey {
            key: "X-Api-Key".to_string(),
            value: "v".to_string(),
            location: ApiKeyLocation::Header,
        };
        assert!(curl_command(&header_key)
            .command
            .contains("-H 'X-Api-Key: v'"));

        let mut query_key = resolved("GET", "https://api.test/users?page=1");
        query_key.auth = ResolvedAuth::ApiKey {
            key: "api_key".to_string(),
            value: "v".to_string(),
            location: ApiKeyLocation::Query,
        };
        let curl = curl_command(&query_key);
        assert!(
            curl.command.contains("'https://api.test/users?page=1&api_key=v'"),
            "查询参数形式的 API Key 应进入查询串：{}",
            curl.command
        );
    }

    #[test]
    fn url_encoded_body_and_shell_quoting() {
        let mut request = resolved("POST", "https://api.test/");
        request.body = ResolvedBody::UrlEncoded {
            pairs: vec![
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "x y".to_string()),
            ],
        };

        let curl = curl_command(&request);
        assert!(curl.command.contains("--data-raw 'a=1&b=x+y'"));

        // 值里的单引号必须被转义，否则命令会变形
        let mut quoted = resolved("POST", "https://api.test/");
        quoted.body = ResolvedBody::Raw {
            text: "it's".to_string(),
            content_type: "text/plain".to_string(),
        };
        assert!(curl_command(&quoted)
            .command
            .contains("--data-raw 'it'\\''s'"));
    }

    #[test]
    fn form_data_fields_are_emitted() {
        let mut request = resolved("POST", "https://api.test/");
        request.body = ResolvedBody::FormData {
            fields: vec![
                ResolvedFormField::Text {
                    key: "note".to_string(),
                    value: "hi".to_string(),
                },
                ResolvedFormField::File {
                    key: "upload".to_string(),
                    handle: "h1".to_string(),
                },
            ],
        };

        let curl = curl_command(&request);
        assert!(curl.command.contains("-F 'note=hi'"));
        assert!(curl.command.contains("-F 'upload=@<需自行替换为本地文件路径>'"));
        assert!(
            !curl.is_directly_executable(),
            "引用了本地文件时不应声称可直接执行"
        );
        assert!(curl.warnings.iter().any(|warning| warning.contains("upload")));
    }

    // ---- 6.2 secret ----

    #[test]
    fn a_secret_bearing_request_is_flagged_and_its_plaintext_is_scrubbed_from_logs() {
        use crate::logging::{MemorySink, Redactor};
        let plaintext = "CURL_SECRET_4242";

        let mut request = resolved("GET", "https://api.test/");
        request.auth = ResolvedAuth::Bearer {
            token: plaintext.to_string(),
        };
        request.secret_used = vec!["token".to_string()];

        let curl = curl_command(&request);
        assert!(curl.contains_secret, "应标记命令含 secret 明文");
        assert!(curl.command.contains(plaintext), "命令本身取真实值（design D9）");
        assert!(!curl.is_directly_executable());

        // 日志是既有的单一脱敏出口：即便命令被写入日志，明文也会被掩码
        let sink = MemorySink::new();
        let log = Redactor::new(sink.clone());
        log.register_secret_value(plaintext);
        log.info(&log.redact_text(&curl.command));

        assert!(
            !sink.joined().contains(plaintext),
            "日志中不应出现凭据明文：{}",
            sink.joined()
        );
    }
}
