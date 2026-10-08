//! 把一条已解析的请求序列化为可执行的 curl 命令。
//!
//! 使用**解析后**的实际取值，与 Postman 的 "Copy as cURL" 一致（design D9）。
//! 由于命令会落到剪贴板而不是文件，凭据取真实值；含 secret 或本地文件时，
//! 通过 `warnings` 把「不可直接执行」的原因显式告知界面。

use crate::storage::model::{ApiKeyLocation, CurlBodyCompress};
use crate::variables::{ResolvedAuth, ResolvedBody, ResolvedFormField, ResolvedRequest};
use serde::{Deserialize, Serialize};

/// curl 导出结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurlCommand {
    /// 多行布局的完整命令（参数之间以续行符连接）。缺省形态，导入 / 导出模态用它。
    pub command: String,
    /// 命令的**分段**（逐段已 shell-quote）。段与段之间的分隔由布局决定：多行为
    /// `" \\\n  "`、单行为 `" "`。请求编辑器的单行 / 多行开关据此重排，因此两种
    /// 布局共享同一份参数，取值不会漂移（design D3）。
    pub parts: Vec<String>,
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
///
/// `compress_body` 是压缩的**生效值**（应用级缺省 + 请求级覆盖，见 [`resolve_compress`]）：
/// 为真时尝试把命令里内嵌的正文作为 JSON 紧凑化，**成功即采用、失败即原样**。判定按正文
/// 内容做，SHALL NOT 依据正文语言的选择（spec: postman-interchange「导出 curl」）。
pub fn curl_command(resolved: &ResolvedRequest, compress_body: bool) -> CurlCommand {
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
            // 压缩只改命令里的这一份正文；请求本身与编辑器里的正文都不动
            let body = maybe_compact_json(text, compress_body).unwrap_or_else(|| text.clone());
            parts.push(data_arg(&body));
        }
        ResolvedBody::UrlEncoded { pairs } => {
            if !has_header(&resolved.headers, "content-type") {
                parts.push(format!(
                    "-H {}",
                    shell_quote("Content-Type: application/x-www-form-urlencoded")
                ));
            }
            parts.push(data_arg(&encode_pairs(pairs)));
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
        command: parts.join(MULTILINE_SEPARATOR),
        parts,
        contains_secret: !resolved.secret_used.is_empty(),
        warnings,
    }
}

/// 多行布局的段间分隔符：续行符 + 换行 + 两个空格缩进。
///
/// 单一来源：`command` 的缺省拼接与前端单行 / 多行开关都引这一个常量
/// （前端有同名的镜像常量，改动必须同时落两处）。
pub const MULTILINE_SEPARATOR: &str = " \\\n  ";

/// 数据体参数：取值以 `@` 开头时用 `--data-raw`，否则用 `-d`。
///
/// `-d`（`--data`）会把以 `@` 开头的取值当作文件名去读，那会破坏「命令可直接执行」
/// （spec: 导出 curl）。`--data-raw` 与 `-d` 的唯一差别正是这个 `@` 解释，因此只在
/// 需要时退回它——参数该有的形态更贴近通用写法。
fn data_arg(value: &str) -> String {
    if value.starts_with('@') {
        format!("--data-raw {}", shell_quote(value))
    } else {
        format!("-d {}", shell_quote(value))
    }
}

/// 应用级「cURL 正文压缩」缺省的解析（spec: ui-layout「cURL 正文压缩」）。
///
/// 只有明确的 `false` 才关；缺失、空串与读不懂的值一律回落缺省（开）——一条显示偏好
/// 的坏值不该让本该压缩的命令变成多行。
pub fn parse_compress_default(raw: Option<&str>) -> bool {
    raw.map(str::trim) != Some("false")
}

/// 压缩的**生效值**：请求级三态覆盖应用级缺省（spec: ui-layout「cURL 正文压缩」）。
pub fn resolve_compress(global_default: bool, request: CurlBodyCompress) -> bool {
    match request {
        CurlBodyCompress::Compress => true,
        CurlBodyCompress::Raw => false,
        CurlBodyCompress::Inherit => global_default,
    }
}

/// 压缩内嵌的 raw 正文；不该压时返回 `None`（调用方据此原样引用）。
///
/// 判定**只看正文内容**，不看正文语言的选择：开关生效、正文非空、且能被解析成 JSON 时才压。
/// 「语言选 text 而正文其实是 JSON」这类请求体因此同样被压成一行；非法 JSON 与空正文一律
/// 原样，且不报错、不追加警告（spec: postman-interchange「导出 curl」）。
fn maybe_compact_json(text: &str, compress: bool) -> Option<String> {
    if !compress || text.trim().is_empty() {
        return None;
    }
    // 合法性先过 serde_json；输出不用它序列化（见 compact_json 的说明）
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        return None;
    }
    Some(compact_json(text))
}

/// 把 JSON 文本压成紧凑形式——**在字符串之外**剥掉结构性空白。
///
/// 为什么不用 `serde_json` 的 `parse + to_string`：它默认的对象是**排序映射**，会把
/// `{"b":1,"a":2}` 变成 `{"a":2,"b":1}`。键序被重排是用户可见的破坏，也让命令里的正文
/// 与 Body 的 `Minify`（JS `JSON.stringify`，保留键序）对不上。所以这里自己走一遍字符：
/// 结构层丢空白，字符串内部（含转义）一字不改，键序因此天然保住。
///
/// 与 `JSON.stringify(JSON.parse(x))` 的已知差异只剩两类**语义等价**的边角输入：
/// 重复键不被合并（原样留着），显式转义（`\uXXXX`、`\/`）不被归一。
fn compact_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;

    for ch in text.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            // JSON 只允许这四种结构性空白；它们不出现在字符串里才可丢
            ' ' | '\t' | '\n' | '\r' => {}
            _ => out.push(ch),
        }
    }

    out
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

        let curl = curl_command(&request, false);
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

        let curl = curl_command(&request, false);
        assert!(curl.command.contains("curl -X POST"));
        assert!(curl
            .command
            .contains("-H 'Content-Type: application/json'"));
        assert!(curl.command.contains("-d '{\"name\":\"n\"}'"));
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

        let curl = curl_command(&request, false);
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
        assert!(curl_command(&basic, false).command.contains("-u 'u:p'"));

        let mut bearer = resolved("GET", "https://api.test/");
        bearer.auth = ResolvedAuth::Bearer {
            token: "tok".to_string(),
        };
        assert!(curl_command(&bearer, false)
            .command
            .contains("-H 'Authorization: Bearer tok'"));

        let mut header_key = resolved("GET", "https://api.test/");
        header_key.auth = ResolvedAuth::ApiKey {
            key: "X-Api-Key".to_string(),
            value: "v".to_string(),
            location: ApiKeyLocation::Header,
        };
        assert!(curl_command(&header_key, false)
            .command
            .contains("-H 'X-Api-Key: v'"));

        let mut query_key = resolved("GET", "https://api.test/users?page=1");
        query_key.auth = ResolvedAuth::ApiKey {
            key: "api_key".to_string(),
            value: "v".to_string(),
            location: ApiKeyLocation::Query,
        };
        let curl = curl_command(&query_key, false);
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

        let curl = curl_command(&request, false);
        assert!(curl.command.contains("-d 'a=1&b=x+y'"));

        // 值里的单引号必须被转义，否则命令会变形
        let mut quoted = resolved("POST", "https://api.test/");
        quoted.body = ResolvedBody::Raw {
            text: "it's".to_string(),
            content_type: "text/plain".to_string(),
        };
        assert!(curl_command(&quoted, false)
            .command
            .contains("-d 'it'\\''s'"));
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

        let curl = curl_command(&request, false);
        assert!(curl.command.contains("-F 'note=hi'"));
        assert!(curl.command.contains("-F 'upload=@<需自行替换为本地文件路径>'"));
        assert!(
            !curl.is_directly_executable(),
            "引用了本地文件时不应声称可直接执行"
        );
        assert!(curl.warnings.iter().any(|warning| warning.contains("upload")));
    }

    #[test]
    fn a_data_arg_uses_d_unless_the_value_starts_with_at() {
        let mut request = resolved("POST", "https://api.test/");
        request.body = ResolvedBody::Raw {
            text: "{\"a\":1}".to_string(),
            content_type: "application/json".to_string(),
        };
        assert!(curl_command(&request, false).command.contains("-d '{\"a\":1}'"));

        // 取值以 @ 开头：`-d` 会把它当文件名去读，必须退回 --data-raw
        let mut at_body = resolved("POST", "https://api.test/");
        at_body.body = ResolvedBody::Raw {
            text: "@handle=1".to_string(),
            content_type: "text/plain".to_string(),
        };
        let curl = curl_command(&at_body, false);
        assert!(
            curl.command.contains("--data-raw '@handle=1'"),
            "以 @ 开头的取值应退回 --data-raw：{}",
            curl.command
        );
        assert!(!curl.command.contains("-d '@handle=1'"));
        assert!(curl.is_directly_executable());

        // urlencoded 走同一个 helper，但它的取值是百分号编码的：`@` 会变成 `%40`，
        // 因此这里实际永远是 `-d`（判定照样逐个做，只是触发不了回退）
        let mut encoded = resolved("POST", "https://api.test/");
        encoded.body = ResolvedBody::UrlEncoded {
            pairs: vec![("@a".to_string(), "1".to_string())],
        };
        let curl = curl_command(&encoded, false);
        assert!(curl.command.contains("-d '%40a=1'"), "{}", curl.command);
        assert!(!curl.command.contains("--data-raw"));
    }

    #[test]
    fn parts_and_command_carry_the_same_sequence() {
        let mut request = resolved("POST", "https://api.test/users?page=1");
        request.headers = vec![("Accept".to_string(), "application/json".to_string())];
        request.body = ResolvedBody::Raw {
            text: "{\"a\":1}".to_string(),
            content_type: "application/json".to_string(),
        };

        let curl = curl_command(&request, false);
        assert_eq!(
            curl.command,
            curl.parts.join(MULTILINE_SEPARATOR),
            "command 应是 parts 的多行拼接"
        );
        assert!(curl.parts.len() > 3, "参数应有多个分段：{:?}", curl.parts);

        // 单行布局 = 段之间以单个空格连接；片段自身的取值不受影响
        let single = curl.parts.join(" ");
        assert!(!single.contains('\\'), "单行不应出现续行符：{}", single);
        assert!(single.starts_with("curl -X POST"));
    }

    // ---- 压缩的生效值 ----

    #[test]
    fn compress_default_only_off_on_explicit_false() {
        assert!(parse_compress_default(None));
        assert!(parse_compress_default(Some("")));
        assert!(parse_compress_default(Some("true")));
        assert!(parse_compress_default(Some("  true ")));
        assert!(!parse_compress_default(Some("false")));
        assert!(!parse_compress_default(Some(" false ")));
        assert!(
            parse_compress_default(Some("坏值")),
            "读不懂的值回落缺省（开）"
        );
    }

    #[test]
    fn request_override_beats_global_default() {
        assert!(resolve_compress(false, CurlBodyCompress::Compress));
        assert!(!resolve_compress(true, CurlBodyCompress::Raw));
        assert!(resolve_compress(true, CurlBodyCompress::Inherit));
        assert!(!resolve_compress(false, CurlBodyCompress::Inherit));
    }

    // ---- 压缩内嵌正文 ----

    #[test]
    fn compact_body_keeps_key_order_and_drops_structural_whitespace() {
        let mut request = resolved("POST", "https://api.test/users");
        request.body = ResolvedBody::Raw {
            // 键序刻意不是字典序：任何重排都会被这条抓住
            text: "{\n  \"b\": 1,\n  \"a\": [1, 2],\n  \"c\": \"x y\\tz\"\n}".to_string(),
            content_type: "application/json".to_string(),
        };

        let curl = curl_command(&request, true);
        assert!(
            curl.command
                .contains("-d '{\"b\":1,\"a\":[1,2],\"c\":\"x y\\tz\"}'"),
            "压缩应保键序、丢结构空白、留字符串内空白：{}",
            curl.command
        );
        assert!(curl.is_directly_executable());
    }

    #[test]
    fn compact_body_matches_the_frontend_minify_semantics_on_typical_json() {
        // 与 JS `JSON.stringify(JSON.parse(x))` 在常规输入上应逐字节一致
        assert_eq!(
            compact_json("{\n\t\"z\": 1,\n\t\"m\": {\"k\": \"v\"}\n}"),
            "{\"z\":1,\"m\":{\"k\":\"v\"}}"
        );
    }

    #[test]
    fn compression_off_keeps_the_body_verbatim() {
        let text = "{\n  \"a\": 1\n}";
        let mut request = resolved("POST", "https://api.test/users");
        request.body = ResolvedBody::Raw {
            text: text.to_string(),
            content_type: "application/json".to_string(),
        };

        let curl = curl_command(&request, false);
        assert!(
            curl.command.contains(&format!("-d '{}'", text)),
            "不压缩时正文应逐字节一致：{}",
            curl.command
        );
    }

    #[test]
    fn invalid_json_and_empty_bodies_are_left_alone_without_warnings() {
        // 非法 JSON：原样，且不因压缩失败产生 warning
        let mut broken = resolved("POST", "https://api.test/");
        broken.body = ResolvedBody::Raw {
            text: "{\n  \"a\": ,\n}".to_string(),
            content_type: "application/json".to_string(),
        };
        let curl = curl_command(&broken, true);
        assert!(curl.command.contains("{\n  \"a\": ,\n}"), "{}", curl.command);
        assert!(curl.is_directly_executable(), "不因压缩失败产生 warning");

        // 空正文（含仅空白）
        let mut empty = resolved("POST", "https://api.test/");
        empty.body = ResolvedBody::Raw {
            text: "   \n".to_string(),
            content_type: "application/json".to_string(),
        };
        assert!(curl_command(&empty, true).command.contains("-d '   \n'"));
    }

    #[test]
    fn compression_judges_by_content_not_by_the_declared_language() {
        // 语言选 text（命令里是 Content-Type: text/plain）而正文其实是合法 JSON：
        // 照样压成一行——判据是内容，不是语言（spec: postman-interchange「导出 curl」）
        let mut text_language = resolved("POST", "https://api.test/");
        text_language.body = ResolvedBody::Raw {
            text: "{ \"a\": 1 }".to_string(),
            content_type: "text/plain".to_string(),
        };

        let compressed = curl_command(&text_language, true);
        assert!(
            compressed.command.contains("-d '{\"a\":1}'"),
            "{}",
            compressed.command
        );

        // 不压缩时仍逐字节一致
        let verbatim = curl_command(&text_language, false);
        assert!(
            verbatim.command.contains("-d '{ \"a\": 1 }'"),
            "{}",
            verbatim.command
        );
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

        let curl = curl_command(&request, false);
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
