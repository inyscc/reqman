//! URL 与查询串处理。
//!
//! spec 要求「URL 与参数表保持同步」以及「路径变量 `:name` 与 `{{name}}` 等价」，
//! 两件事都落在这里：`split_url_query` 供界面把 URL 里的查询串拆进参数表，
//! `compose_url` 供发送时把参数表合回 URL。

use crate::error::{AppError, AppResult};
use crate::storage::model::KeyValue;
use std::collections::BTreeSet;
use url::Url;

/// 把 URL 拆成「不含查询串的基础部分」与「查询参数表」。
pub fn split_url_query(url: &str) -> (String, Vec<KeyValue>) {
    let Ok(parsed) = Url::parse(url) else {
        return (url.to_string(), Vec::new());
    };

    let params: Vec<KeyValue> = parsed
        .query_pairs()
        .map(|(key, value)| KeyValue::new(key.to_string(), value.to_string()))
        .collect();

    if params.is_empty() {
        return (url.to_string(), params);
    }

    let mut base = parsed.clone();
    base.set_query(None);
    let mut text = base.to_string();
    // 仅查询串被移除时，去掉可能多出的尾部 '?'
    if let Some(stripped) = text.strip_suffix('?') {
        text = stripped.to_string();
    }
    (text, params)
}

/// 把 URL 自身的查询串与参数表合并为一个查询串。
///
/// 参数表优先：同键时参数表的值覆盖 URL 中的值。这样即使界面尚未把 URL 里的
/// 查询串同步进参数表，也不会丢参数；同步之后也不会出现重复。
///
/// 非查询部分**原样保留**用户输入，不做 URL 规范化——否则路径里的 `{{var}}`
/// 会被转义成 `%7B%7Bvar%7D%7D`，既看不到原文，也违背「未解析变量保留原文」。
pub fn compose_url(base: &str, params: &[KeyValue]) -> AppResult<String> {
    let parsed = Url::parse(base)
        .map_err(|err| AppError::invalid_input(format!("URL 无法解析：{}", err)))?;

    let (head, fragment) = match base.split_once('#') {
        Some((head, fragment)) => (head, format!("#{}", fragment)),
        None => (base, String::new()),
    };
    let head_without_query = match head.split_once('?') {
        Some((head, _)) => head,
        None => head,
    };

    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();

    for param in params.iter().filter(|param| param.enabled) {
        match pairs.iter_mut().find(|(key, _)| *key == param.key) {
            Some(existing) => existing.1 = param.value.clone(),
            None => pairs.push((param.key.clone(), param.value.clone())),
        }
    }

    let mut out = head_without_query.to_string();
    if !pairs.is_empty() {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in &pairs {
            serializer.append_pair(key, value);
        }
        out.push('?');
        out.push_str(&serializer.finish());
    }
    out.push_str(&fragment);

    Ok(out)
}

/// 变量名是否可作为路径变量（`:name`）使用。
pub fn is_valid_path_variable(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 填充 `:name` 形式的路径变量。
///
/// 只替换路径中真正以 `:` 开头的段，其余部分——包括端口、查询串与路径里的
/// `{{var}}`——按原文字节保留，避免 URL 规范化改变用户输入。
/// 解析失败的 URL（例如仍是相对路径）原样返回；未能解析的名字收集到
/// `unresolved` 中，由调用方汇总为诊断信息。
pub fn fill_path_variables(
    url: &str,
    mut lookup: impl FnMut(&str) -> Option<String>,
    unresolved: &mut BTreeSet<String>,
) -> String {
    if Url::parse(url).is_err() {
        return url.to_string();
    }

    let after_scheme = match url.find("://") {
        Some(index) => index + 3,
        None => return url.to_string(),
    };

    // authority 到第一个 '/' 结束；没有路径则无需处理
    let path_start = match url[after_scheme..].find('/') {
        Some(offset) => after_scheme + offset,
        None => return url.to_string(),
    };
    // 路径到查询串或片段标识结束
    let path_end = url[path_start..]
        .find(|c| c == '?' || c == '#')
        .map(|offset| path_start + offset)
        .unwrap_or(url.len());

    let path = &url[path_start..path_end];
    let mut rebuilt = String::with_capacity(path.len());
    let mut changed = false;

    for (index, segment) in path.split('/').enumerate() {
        if index > 0 {
            rebuilt.push('/');
        }
        if let Some(name) = segment.strip_prefix(':') {
            if is_valid_path_variable(name) {
                match lookup(name) {
                    Some(value) => {
                        rebuilt.push_str(&value);
                        changed = true;
                        continue;
                    }
                    None => {
                        unresolved.insert(name.to_string());
                    }
                }
            }
        }
        rebuilt.push_str(segment);
    }

    if !changed {
        return url.to_string();
    }

    let mut out = String::with_capacity(url.len() + rebuilt.len());
    out.push_str(&url[..path_start]);
    out.push_str(&rebuilt);
    out.push_str(&url[path_end..]);
    out
}

/// 取出 URL 中的主机名（不含端口），供 `no_proxy` 匹配使用。
pub fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok()?.host_str().map(|h| h.to_string())
}

/// 列出 URL 路径中出现的 `:name` 形式的路径变量名。
pub fn path_variable_names(url: &str) -> Vec<String> {
    let Ok(parsed) = Url::parse(url) else {
        return Vec::new();
    };
    let Some(segments) = parsed.path_segments() else {
        return Vec::new();
    };
    segments
        .filter_map(|segment| segment.strip_prefix(':'))
        .filter(|name| is_valid_path_variable(name))
        .map(|name| name.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_url_query_into_table() {
        let (base, params) = split_url_query("https://api.test/users?page=1&size=10");
        assert_eq!(base, "https://api.test/users");
        assert_eq!(params.len(), 2);
        assert_eq!(params[0].key, "page");
        assert_eq!(params[0].value, "1");
        assert!(params[0].enabled);
        assert_eq!(params[1].key, "size");
    }

    #[test]
    fn split_leaves_url_without_query_untouched() {
        let (base, params) = split_url_query("https://api.test/users");
        assert_eq!(base, "https://api.test/users");
        assert!(params.is_empty());
    }

    #[test]
    fn compose_keeps_url_own_query_when_table_is_empty() {
        let url = compose_url("https://api.test/users?page=1", &[]).expect("合成 URL");
        assert_eq!(url, "https://api.test/users?page=1");
    }

    #[test]
    fn compose_lets_table_override_url_query_without_duplicating() {
        let params = vec![KeyValue::new("page", "2")];
        let url = compose_url("https://api.test/users?page=1&size=10", &params).expect("合成 URL");
        assert_eq!(url, "https://api.test/users?page=2&size=10");
        assert_eq!(url.matches("page=").count(), 1, "同键不应重复");
    }

    #[test]
    fn disabled_params_are_excluded() {
        let params = vec![
            KeyValue::new("keep", "1"),
            KeyValue {
                key: "drop".into(),
                value: "2".into(),
                enabled: false,
                description: None,
            },
        ];
        let url = compose_url("https://api.test/", &params).expect("合成 URL");
        assert_eq!(url, "https://api.test/?keep=1");
    }

    #[test]
    fn path_variables_are_filled_from_lookup() {
        let mut unresolved = BTreeSet::new();
        let out = fill_path_variables(
            "https://api.test/users/:id/posts/:postId",
            |name| match name {
                "id" => Some("42".to_string()),
                "postId" => Some("7".to_string()),
                _ => None,
            },
            &mut unresolved,
        );
        assert_eq!(out, "https://api.test/users/42/posts/7");
        assert!(unresolved.is_empty());
    }

    #[test]
    fn unresolved_path_variable_is_reported_and_left_in_place() {
        let mut unresolved = BTreeSet::new();
        let out = fill_path_variables("https://api.test/users/:id", |_| None, &mut unresolved);
        assert_eq!(out, "https://api.test/users/:id");
        assert_eq!(unresolved.iter().cloned().collect::<Vec<_>>(), vec!["id"]);
    }

    #[test]
    fn port_notation_is_not_mistaken_for_a_path_variable() {
        let mut unresolved = BTreeSet::new();
        let out = fill_path_variables("https://api.test:8443/users", |_| None, &mut unresolved);
        assert_eq!(out, "https://api.test:8443/users");
        assert!(unresolved.is_empty(), "端口不应被当成路径变量");
    }

    #[test]
    fn equivalent_brace_and_colon_forms_produce_the_same_url() {
        let mut unresolved = BTreeSet::new();
        let colon = fill_path_variables("https://api.test/users/:id", |_| Some("42".to_string()), &mut unresolved);

        let braced = "https://api.test/users/{{id}}".replace("{{id}}", "42");
        assert_eq!(colon, braced, "两种写法在相同取值下应产出同一 URL");
    }

    #[test]
    fn invalid_base_url_is_reported() {
        let err = compose_url("not a url", &[]).expect_err("应报错");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
    }

    #[test]
    fn host_of_ignores_port() {
        assert_eq!(host_of("https://api.test:8443/x").as_deref(), Some("api.test"));
        assert_eq!(host_of("https://api.test/x").as_deref(), Some("api.test"));
    }
}
