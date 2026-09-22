//! 变量解析引擎（design.md D7 / D8）。
//!
//! 解析是一个纯函数：输入有序作用域快照与待替换文本，输出替换结果与未解析
//! 占位符清单。真实发送与界面预览调用**同一实现**，预览只是在结果之上加一层
//! secret 掩码，因此界面显示与实际请求不会出现分歧。

use crate::logging::MASK;
use crate::storage::model::{
    ApiKeyLocation, AuthConfig, AuthKind, BodyKind, FormFieldKind, HttpVersion, KeyValue,
    ProxyConfig, RawLanguage, RequestBody, RequestSettings, SavedRequest,
};
use crate::storage::variables::ScopeLayers;
use crate::url_util;
use rand::Rng;
use serde::Serialize;
use std::collections::BTreeSet;

/// 变量值里还可能引用其它变量，做有限次数的展开，避免无界递归。
pub const MAX_PASSES: usize = 8;

const FIRST_NAMES: [&str; 8] = [
    "Alice", "Bob", "Carol", "David", "Erin", "Frank", "Grace", "Heidi",
];
const LAST_NAMES: [&str; 8] = [
    "Anderson", "Brown", "Clark", "Davis", "Evans", "Foster", "Garcia", "Hughes",
];
const COLORS: [&str; 6] = ["red", "green", "blue", "cyan", "magenta", "yellow"];

// ---------------------------------------------------------------------------
// 动态变量
// ---------------------------------------------------------------------------

/// 求一个动态变量的值。每次调用独立求值（D8）。
pub fn dynamic_value(name: &str) -> Option<String> {
    let mut rng = rand::thread_rng();
    let first = FIRST_NAMES[rng.gen_range(0..FIRST_NAMES.len())];
    let last = LAST_NAMES[rng.gen_range(0..LAST_NAMES.len())];

    Some(match name {
        "guid" | "randomUUID" => uuid::Uuid::new_v4().to_string(),
        "timestamp" => chrono::Utc::now().timestamp().to_string(),
        "isoTimestamp" => chrono::Utc::now().to_rfc3339(),
        "randomInt" => rng.gen_range(0..1000).to_string(),
        "randomBoolean" => if rng.gen_bool(0.5) { "true" } else { "false" }.to_string(),
        "randomFullName" | "randomName" => format!("{} {}", first, last),
        "randomFirstName" => first.to_string(),
        "randomLastName" => last.to_string(),
        "randomEmail" | "randomEmailAddress" => {
            format!("{}.{}@example.test", first.to_lowercase(), last.to_lowercase())
        }
        "randomColor" => COLORS[rng.gen_range(0..COLORS.len())].to_string(),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resolution {
    pub text: String,
    pub used: Vec<String>,
    pub secret_used: Vec<String>,
    pub unresolved: Vec<String>,
}

/// 解析文本中的 `{{name}}` 与 `{{$dynamic}}` 占位符。
///
/// 未解析的占位符**保留原文**，不会被替换成空串（spec: 未解析变量提示）。
pub fn resolve(text: &str, layers: &ScopeLayers) -> Resolution {
    let mut current = text.to_string();
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut secret_used: BTreeSet<String> = BTreeSet::new();

    for _ in 0..MAX_PASSES {
        let (next, changed) = substitute_once(&current, layers, &mut used, &mut secret_used);
        current = next;
        if !changed {
            break;
        }
    }

    Resolution {
        unresolved: find_placeholders(&current),
        text: current,
        used: used.into_iter().collect(),
        secret_used: secret_used.into_iter().collect(),
    }
}

fn substitute_once(
    text: &str,
    layers: &ScopeLayers,
    used: &mut BTreeSet<String>,
    secret_used: &mut BTreeSet<String>,
) -> (String, bool) {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    let mut changed = false;

    while index < text.len() {
        if bytes[index] == b'{' && index + 1 < text.len() && bytes[index + 1] == b'{' {
            if let Some(offset) = text[index + 2..].find("}}") {
                let token = &text[index + 2..index + 2 + offset];
                let name = token.trim();
                let token_end = index + 2 + offset + 2;

                if !name.is_empty() {
                    if let Some(value) = lookup_token(name, layers, used, secret_used) {
                        out.push_str(&value);
                        changed = true;
                        index = token_end;
                        continue;
                    }
                }

                out.push_str(&text[index..token_end]);
                index = token_end;
                continue;
            }
        }

        let ch = text[index..].chars().next().expect("索引落在字符边界上");
        out.push(ch);
        index += ch.len_utf8();
    }

    (out, changed)
}

fn lookup_token(
    name: &str,
    layers: &ScopeLayers,
    used: &mut BTreeSet<String>,
    secret_used: &mut BTreeSet<String>,
) -> Option<String> {
    if let Some(dynamic) = name.strip_prefix('$') {
        return dynamic_value(dynamic.trim());
    }

    let value = layers.lookup(name)?;
    used.insert(name.to_string());
    if layers.is_secret(name) {
        secret_used.insert(name.to_string());
    }
    Some(value.to_string())
}

/// 扫描文本中残留的占位符名字。
pub fn find_placeholders(text: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = after[..end].trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
                rest = &after[end + 2..];
            }
            None => break,
        }
    }
    names.into_iter().collect()
}

/// 把文本中出现的 secret 变量取值替换为掩码。
pub fn mask_secret_values(text: &str, layers: &ScopeLayers) -> String {
    let mut out = text.to_string();
    for name in layers.secret_names.iter() {
        if let Some(value) = layers.lookup(name) {
            if value.chars().count() >= 4 && out.contains(value) {
                out = out.replace(value, MASK);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 认证继承链
// ---------------------------------------------------------------------------

/// 把一层认证配置叠加到已继承的配置上。
pub fn apply_auth_layer(auth: &AuthConfig, inherited: &AuthConfig) -> AuthConfig {
    if auth.kind == AuthKind::Inherit {
        inherited.clone()
    } else {
        auth.clone()
    }
}

/// 从根到叶叠加认证链（集合 → 文件夹 → 请求），得到生效配置。
pub fn resolve_auth_chain(chain: &[AuthConfig]) -> AuthConfig {
    let mut effective = AuthConfig::none();
    for auth in chain {
        effective = apply_auth_layer(auth, &effective);
    }
    effective
}

// ---------------------------------------------------------------------------
// 请求解析结果
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedBody {
    None,
    Raw {
        text: String,
        content_type: String,
    },
    FormData {
        fields: Vec<ResolvedFormField>,
    },
    UrlEncoded {
        pairs: Vec<(String, String)>,
    },
    Binary {
        /// 本地文件的一次性句柄（不是路径）。
        handle: Option<String>,
        description: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedFormField {
    Text { key: String, value: String },
    File { key: String, handle: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedAuth {
    None,
    Basic { username: String, password: String },
    Bearer { token: String },
    ApiKey {
        key: String,
        value: String,
        location: ApiKeyLocation,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRequest {
    pub method: String,
    pub url: String,
    pub params: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body: ResolvedBody,
    pub auth: ResolvedAuth,
    pub settings: RequestSettings,
    pub proxy: Option<ProxyConfig>,
    pub unresolved: Vec<String>,
    pub used: Vec<String>,
    pub secret_used: Vec<String>,
}

impl ResolvedRequest {
    /// 实际会作为请求头发送的名字列表（不含值），供日志使用。
    pub fn header_names(&self) -> Vec<String> {
        self.headers.iter().map(|(name, _)| name.clone()).collect()
    }
}

/// 把一条已保存请求解析为可直接发送的形态。
///
/// `inherited_auth` 是集合/文件夹链上继承下来的生效认证配置。
pub fn resolve_request(
    request: &SavedRequest,
    inherited_auth: &AuthConfig,
    layers: &ScopeLayers,
) -> ResolvedRequest {
    let mut unresolved: BTreeSet<String> = BTreeSet::new();
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut secret_used: BTreeSet<String> = BTreeSet::new();

    let mut resolve_into = |text: &str| -> String {
        let resolution = resolve(text, layers);
        unresolved.extend(resolution.unresolved);
        used.extend(resolution.used);
        secret_used.extend(resolution.secret_used);
        resolution.text
    };

    let url_with_placeholders = resolve_into(&request.url);

    // 路径变量在占位符替换后再填充（端口不会被误判）。
    // 传给 fill_path_variables 的闭包只读 layers，避免与 resolve_into 的可变借用冲突；
    // 用到的名字在闭包外收集，最后统一并入统计。
    let mut path_unresolved: BTreeSet<String> = BTreeSet::new();
    let url_with_path = url_util::fill_path_variables(
        &url_with_placeholders,
        |name| layers.lookup(name).map(|value| value.to_string()),
        &mut path_unresolved,
    );
    let mut path_used: BTreeSet<String> = BTreeSet::new();
    for name in url_util::path_variable_names(&url_with_placeholders) {
        if layers.lookup(&name).is_some() {
            path_used.insert(name);
        }
    }

    // 查询串只解析一次：动态变量不应因为「算两遍」而在参数列表与 URL 之间产生分歧
    let resolved_params: Vec<KeyValue> = url_params(&request.params, |text| resolve_into(text));
    let params: Vec<(String, String)> = resolved_params
        .iter()
        .filter(|param| param.enabled)
        .map(|param| (param.key.clone(), param.value.clone()))
        .collect();

    let composed_url =
        url_util::compose_url(&url_with_path, &resolved_params).unwrap_or(url_with_path);

    let headers: Vec<(String, String)> = request
        .headers
        .iter()
        .filter(|header| header.enabled)
        .map(|header| (resolve_into(&header.key), resolve_into(&header.value)))
        .collect();

    let body = resolve_body(&request.body, &mut resolve_into);

    let effective_auth = apply_auth_layer(&request.auth, inherited_auth);
    let auth = resolve_auth(&effective_auth, &mut resolve_into);

    // 凭据不参与变量解析：提交时它是明文、落库后是密文，两者都不是可解析的引用。
    // 解析只覆盖代理地址与用户名，密文原样带过（spec: 三级代理）。
    let proxy = request.settings.proxy.as_ref().map(|proxy| ProxyConfig {
        mode: proxy.mode,
        url: proxy.url.as_deref().map(&mut resolve_into),
        username: proxy.username.as_deref().map(&mut resolve_into),
        password: None,
        password_enc: proxy.password_enc.clone(),
        password_readable: proxy.password_readable,
        no_proxy: proxy.no_proxy.clone(),
    });

    // resolve_into 的最后一次使用已经结束，这里再并入路径变量的统计
    unresolved.extend(path_unresolved);
    for name in path_used {
        if layers.is_secret(&name) {
            secret_used.insert(name.clone());
        }
        used.insert(name);
    }

    ResolvedRequest {
        method: request.method.clone(),
        url: composed_url,
        params,
        headers,
        body,
        auth,
        settings: request.settings.clone(),
        proxy,
        unresolved: unresolved.into_iter().collect(),
        used: used.into_iter().collect(),
        secret_used: secret_used.into_iter().collect(),
    }
}

/// 合成查询串时复用同一份解析结果，避免二次求值把动态变量算成两个值。
fn url_params<F>(params: &[KeyValue], mut resolve_text: F) -> Vec<KeyValue>
where
    F: FnMut(&str) -> String,
{
    params
        .iter()
        .map(|param| KeyValue {
            key: resolve_text(&param.key),
            value: resolve_text(&param.value),
            enabled: param.enabled,
            description: param.description.clone(),
        })
        .collect()
}

fn resolve_body<F>(body: &RequestBody, resolve_text: &mut F) -> ResolvedBody
where
    F: FnMut(&str) -> String,
{
    match body.kind {
        BodyKind::None => ResolvedBody::None,
        BodyKind::Raw => {
            let language = body.raw_language.unwrap_or(RawLanguage::Text);
            ResolvedBody::Raw {
                text: resolve_text(body.raw.as_deref().unwrap_or("")),
                content_type: language.content_type().to_string(),
            }
        }
        BodyKind::FormData => ResolvedBody::FormData {
            fields: body
                .form
                .iter()
                .filter(|field| field.enabled)
                .map(|field| match field.kind {
                    FormFieldKind::Text => ResolvedFormField::Text {
                        key: resolve_text(&field.key),
                        value: resolve_text(field.value.as_deref().unwrap_or("")),
                    },
                    FormFieldKind::File => ResolvedFormField::File {
                        key: resolve_text(&field.key),
                        // 句柄不是路径，原样透传
                        handle: field.file_handle.clone().unwrap_or_default(),
                    },
                })
                .collect(),
        },
        BodyKind::UrlEncoded => ResolvedBody::UrlEncoded {
            pairs: body
                .urlencoded
                .iter()
                .filter(|pair| pair.enabled)
                .map(|pair| (resolve_text(&pair.key), resolve_text(&pair.value)))
                .collect(),
        },
        BodyKind::Binary => ResolvedBody::Binary {
            handle: body
                .binary
                .as_ref()
                .and_then(|binary| binary.file_handle.clone()),
            description: body
                .binary
                .as_ref()
                .and_then(|binary| binary.description.clone()),
        },
    }
}

fn resolve_auth<F>(auth: &AuthConfig, resolve_text: &mut F) -> ResolvedAuth
where
    F: FnMut(&str) -> String,
{
    match auth.kind {
        AuthKind::None | AuthKind::Inherit => ResolvedAuth::None,
        AuthKind::Basic => match &auth.basic {
            Some(basic) => ResolvedAuth::Basic {
                username: resolve_text(&basic.username),
                password: resolve_text(&basic.password),
            },
            None => ResolvedAuth::None,
        },
        AuthKind::Bearer => match &auth.bearer {
            Some(bearer) => ResolvedAuth::Bearer {
                token: resolve_text(&bearer.token),
            },
            None => ResolvedAuth::None,
        },
        AuthKind::ApiKey => match &auth.api_key {
            Some(api_key) => ResolvedAuth::ApiKey {
                key: resolve_text(&api_key.key),
                value: resolve_text(&api_key.value),
                location: api_key.location,
            },
            None => ResolvedAuth::None,
        },
    }
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

/// 供界面展示的预览结果：由 [`resolve_request`] 的结果加掩码得到，
/// 因此与实际发送的请求同源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequestPreview {
    pub method: String,
    pub url: String,
    pub params: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub body_text: Option<String>,
    pub auth_kind: AuthKind,
    pub auth_key: Option<String>,
    pub proxy_url: Option<String>,
    pub unresolved: Vec<String>,
    /// 本请求实际用到的变量名（含路径变量与动态变量）。
    ///
    /// 与发送使用同一份解析结果（[`ResolvedRequest::used`]），因此界面上列出的就是
    /// 真正生效的那些名字——只读浮层靠它回答「这个请求用了哪些变量」。
    #[serde(default)]
    pub used: Vec<String>,
    /// 是否有取值因 secret 被掩码。
    pub masked: bool,
    /// 证书校验被关闭时的显著警示（spec: 请求级网络设置）。
    pub insecure_warning: bool,
    /// 该目标当前会自动携带的 Cookie（spec: Cookie 在请求中的自动附带——
    /// 「该事实可在请求调试信息中看到」）。由网络层填入，引擎层无从知晓。
    #[serde(default)]
    pub cookies: Vec<(String, String)>,
}

pub fn preview_request(
    request: &SavedRequest,
    inherited_auth: &AuthConfig,
    layers: &ScopeLayers,
) -> RequestPreview {
    let resolved = resolve_request(request, inherited_auth, layers);
    let mask = |text: &str| mask_secret_values(text, layers);

    let body_text = match &resolved.body {
        ResolvedBody::None => None,
        ResolvedBody::Raw { text, .. } => Some(mask(text)),
        ResolvedBody::FormData { fields } => Some(
            fields
                .iter()
                .map(|field| match field {
                    ResolvedFormField::Text { key, value } => {
                        format!("{}\t{}", mask(key), mask(value))
                    }
                    ResolvedFormField::File { key, .. } => {
                        format!("{}\t(文件)", mask(key))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        ResolvedBody::UrlEncoded { pairs } => Some(
            pairs
                .iter()
                .map(|(key, value)| format!("{}\t{}", mask(key), mask(value)))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        ResolvedBody::Binary { description, .. } => Some(match description {
            Some(name) => format!("(二进制内容：{})", name),
            None => "(二进制内容)".to_string(),
        }),
    };

    let auth_key = match &resolved.auth {
        ResolvedAuth::ApiKey { key, .. } => Some(mask(key)),
        _ => None,
    };

    // 认证字段一律掩码：预览不需要暴露可用凭据
    let (_, auth_masked) = match &resolved.auth {
        ResolvedAuth::Basic { .. } => (AuthKind::Basic, true),
        ResolvedAuth::Bearer { .. } => (AuthKind::Bearer, true),
        ResolvedAuth::ApiKey { .. } => (AuthKind::ApiKey, true),
        ResolvedAuth::None => (AuthKind::None, false),
    };

    let mut masked_any = auth_masked;
    let headers: Vec<(String, String)> = resolved
        .headers
        .iter()
        .map(|(name, value)| {
            let masked_value = mask(value);
            if masked_value != *value {
                masked_any = true;
            }
            (name.clone(), masked_value)
        })
        .collect();

    let url = {
        let masked_url = mask(&resolved.url);
        if masked_url != resolved.url {
            masked_any = true;
        }
        masked_url
    };

    let params: Vec<(String, String)> = resolved
        .params
        .iter()
        .map(|(key, value)| (mask(key), mask(value)))
        .collect();

    RequestPreview {
        method: resolved.method.clone(),
        url,
        params,
        headers,
        body_text,
        auth_kind: resolved.auth_kind(),
        auth_key,
        proxy_url: resolved
            .proxy
            .as_ref()
            .and_then(|proxy| proxy.url.clone())
            .map(|url| mask(&url)),
        unresolved: resolved.unresolved.clone(),
        used: resolved.used.clone(),
        masked: masked_any,
        insecure_warning: request.settings.needs_insecure_warning(),
        cookies: Vec::new(),
    }
}

impl ResolvedRequest {
    fn auth_kind(&self) -> AuthKind {
        match self.auth {
            ResolvedAuth::None => AuthKind::None,
            ResolvedAuth::Basic { .. } => AuthKind::Basic,
            ResolvedAuth::Bearer { .. } => AuthKind::Bearer,
            ResolvedAuth::ApiKey { .. } => AuthKind::ApiKey,
        }
    }
}

// ---------------------------------------------------------------------------
// 未使用参数占位（保持 HttpVersion 引用，供后续层使用）
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn _http_version_of(settings: &RequestSettings) -> HttpVersion {
    settings.http_version
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::model::{ApiKeyLocation, KeyValue, RawLanguage};
    use crate::storage::model::Scope;
    use std::collections::BTreeMap;

    fn layers_with(pairs: &[(&str, &str)], secrets: &[&str]) -> ScopeLayers {
        let mut map = BTreeMap::new();
        for (name, value) in pairs {
            map.insert((*name).to_string(), (*value).to_string());
        }
        ScopeLayers {
            layers: vec![(Scope::Environment, map)],
            secret_names: secrets.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn sample_request() -> SavedRequest {
        SavedRequest {
            id: "r1".into(),
            collection_id: "c1".into(),
            folder_id: None,
            name: "示例".into(),
            description: None,
            method: "GET".into(),
            url: "https://{{host}}/users/:id".into(),
            params: vec![KeyValue::new("page", "{{page}}")],
            headers: vec![KeyValue::new("X-Token", "{{token}}")],
            body: RequestBody::none(),
            auth: AuthConfig::default(),
            settings: RequestSettings::default(),
            pre_request_script: None,
            test_script: None,
            sort_order: 0,
        }
    }

    #[test]
    fn same_name_resolves_by_scope_priority() {
        let mut global = BTreeMap::new();
        global.insert("host".to_string(), "global.test".to_string());
        let mut environment = BTreeMap::new();
        environment.insert("host".to_string(), "env.test".to_string());
        let layers = ScopeLayers {
            layers: vec![
                (Scope::Local, BTreeMap::new()),
                (Scope::Data, BTreeMap::new()),
                (Scope::Environment, environment),
                (Scope::Collection, BTreeMap::new()),
                (Scope::Global, global),
            ],
            secret_names: Default::default(),
        };

        assert_eq!(resolve("{{host}}", &layers).text, "env.test");

        // 高优先级作用域存在但未定义该名称时，取次优先级
        let mut collection = BTreeMap::new();
        collection.insert("only".to_string(), "collection.test".to_string());
        let mut global_only = BTreeMap::new();
        global_only.insert("only".to_string(), "global.test".to_string());
        let layers = ScopeLayers {
            layers: vec![
                (Scope::Environment, BTreeMap::new()),
                (Scope::Collection, collection),
                (Scope::Global, global_only),
            ],
            secret_names: Default::default(),
        };
        assert_eq!(resolve("{{only}}", &layers).text, "collection.test");
    }

    #[test]
    fn unresolved_placeholders_keep_their_original_text() {
        let layers = layers_with(&[("known", "1")], &[]);
        let resolution = resolve("a={{known}}&b={{unknown}}", &layers);
        assert_eq!(resolution.text, "a=1&b={{unknown}}");
        assert_eq!(resolution.unresolved, vec!["unknown"]);
        assert!(
            resolution.text.contains("b={{unknown}}"),
            "未知变量应保留占位符原文，而不是被替换成空串：{}",
            resolution.text
        );
    }

    #[test]
    fn dynamic_variables_are_evaluated_independently_per_occurrence() {
        let layers = ScopeLayers::default();
        let resolution = resolve("{{$guid}}|{{$guid}}", &layers);
        let parts: Vec<&str> = resolution.text.split('|').collect();
        assert_eq!(parts.len(), 2);
        assert_ne!(parts[0], parts[1], "同一动态变量两次出现应得到不同值");
        assert!(resolution.unresolved.is_empty());
    }

    #[test]
    fn random_int_falls_in_the_documented_range() {
        for _ in 0..50 {
            let value = dynamic_value("randomInt").expect("已定义");
            let parsed: i64 = value.parse().expect("是整数");
            assert!((0..1000).contains(&parsed), "随机整数应在 0..1000");
        }
    }

    #[test]
    fn random_email_and_names_look_valid() {
        let email = dynamic_value("randomEmail").expect("已定义");
        assert!(email.contains('@'), "邮箱应含 @：{}", email);

        let full = dynamic_value("randomFullName").expect("已定义");
        assert!(full.contains(' '), "全名应含空格：{}", full);
    }

    #[test]
    fn unknown_dynamic_variable_is_reported_as_unresolved() {
        let layers = ScopeLayers::default();
        let resolution = resolve("{{$notAThing}}", &layers);
        assert_eq!(resolution.text, "{{$notAThing}}");
        assert_eq!(resolution.unresolved, vec!["$notAThing"]);
    }

    #[test]
    fn user_variable_does_not_shadow_dynamic_namespace() {
        let layers = layers_with(&[("$guid", "user-value")], &[]);
        let resolution = resolve("{{$guid}}", &layers);
        assert_ne!(resolution.text, "user-value");
        assert_eq!(resolution.text.len(), 36, "应得到 UUID 形态");
    }

    #[test]
    fn nested_variable_values_are_expanded() {
        let layers = layers_with(&[("base", "https://{{host}}"), ("host", "api.test")], &[]);
        assert_eq!(resolve("{{base}}/x", &layers).text, "https://api.test/x");
    }

    #[test]
    fn self_referencing_variable_does_not_loop_forever() {
        let layers = layers_with(&[("loop", "{{loop}}")], &[]);
        let resolution = resolve("{{loop}}", &layers);
        assert_eq!(resolution.text, "{{loop}}");
        assert_eq!(resolution.unresolved, vec!["loop"]);
    }

    #[test]
    fn secret_values_are_masked_in_previews_only() {
        let layers = layers_with(&[("token", "s3cr3t-value")], &["token"]);
        let resolution = resolve("Bearer {{token}}", &layers);
        assert_eq!(resolution.text, "Bearer s3cr3t-value");
        assert_eq!(resolution.secret_used, vec!["token"]);

        let masked = mask_secret_values(&resolution.text, &layers);
        assert_eq!(masked, format!("Bearer {}", MASK));
    }

    #[test]
    fn colon_and_brace_path_variables_agree() {
        let layers = layers_with(&[("id", "42")], &[]);

        let mut with_colon = sample_request();
        with_colon.url = "https://api.test/users/:id".into();
        with_colon.params.clear();
        let resolved_colon = resolve_request(&with_colon, &AuthConfig::none(), &layers);

        let mut with_brace = sample_request();
        with_brace.url = "https://api.test/users/{{id}}".into();
        with_brace.params.clear();
        let resolved_brace = resolve_request(&with_brace, &AuthConfig::none(), &layers);

        assert_eq!(resolved_colon.url, resolved_brace.url);
        assert_eq!(resolved_colon.url, "https://api.test/users/42");
    }

    #[test]
    fn preview_matches_the_send_path_except_for_masking() {
        let layers = layers_with(
            &[("host", "api.test"), ("id", "7"), ("page", "2"), ("token", "s3cr3t-value")],
            &["token"],
        );
        let request = sample_request();

        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        let preview = preview_request(&request, &AuthConfig::none(), &layers);

        // 非 secret 字段逐字一致
        assert_eq!(preview.method, resolved.method);
        assert_eq!(preview.url, resolved.url);
        assert_eq!(preview.params, resolved.params);
        assert_eq!(preview.unresolved, resolved.unresolved);
        // 「用到哪些变量」与发送同源：只读浮层列出的就是实际生效的那些名字
        assert_eq!(preview.used, resolved.used);
        assert!(!preview.used.is_empty(), "sample_request 应当用到变量");
        // secret 字段：预览被掩码，实际发送用明文
        assert_eq!(resolved.headers[0].1, "s3cr3t-value");
        assert_eq!(preview.headers[0].1, MASK);
        assert!(preview.masked);
    }

    #[test]
    fn unresolved_variables_are_reported_for_the_whole_request() {
        let layers = layers_with(&[("host", "api.test")], &[]);
        let mut request = sample_request();
        request.params = vec![KeyValue::new("page", "{{missing}}")];

        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        assert!(resolved.unresolved.contains(&"missing".to_string()));
        assert!(resolved.unresolved.contains(&"id".to_string()), "路径变量也应被报告");
        assert!(resolved.url.contains(":id"), "未解析的路径变量保留原样");
    }

    #[test]
    fn auth_chain_inherits_from_parent() {
        let collection = AuthConfig::basic("user", "pass");
        let folder = AuthConfig::default(); // inherit
        let request = AuthConfig::default(); // inherit

        let effective = resolve_auth_chain(&[collection.clone(), folder, request]);
        assert_eq!(effective.kind, AuthKind::Basic);
        assert_eq!(effective.basic.as_ref().unwrap().username, "user");

        // 子级显式覆盖父级
        let bearer = AuthConfig::bearer("tok");
        let effective = resolve_auth_chain(&[collection, bearer]);
        assert_eq!(effective.kind, AuthKind::Bearer);
    }

    #[test]
    fn effective_auth_is_resolved_into_the_request() {
        let layers = layers_with(&[("user", "u1"), ("pass", "p1")], &[]);
        let mut request = sample_request();
        request.url = "https://api.test/".into();
        request.params.clear();
        request.headers.clear();
        request.auth = AuthConfig::default(); // inherit

        let inherited = AuthConfig::basic("{{user}}", "{{pass}}");
        let resolved = resolve_request(&request, &inherited, &layers);
        assert_eq!(
            resolved.auth,
            ResolvedAuth::Basic {
                username: "u1".into(),
                password: "p1".into()
            }
        );
    }

    #[test]
    fn api_key_can_target_query_or_header() {
        let layers = layers_with(&[("key", "abc")], &[]);
        let mut request = sample_request();
        request.url = "https://api.test/".into();
        request.params.clear();

        request.auth = AuthConfig::api_key("apiKey", "{{key}}", ApiKeyLocation::Query);
        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        assert_eq!(
            resolved.auth,
            ResolvedAuth::ApiKey {
                key: "apiKey".into(),
                value: "abc".into(),
                location: ApiKeyLocation::Query
            }
        );

        request.auth = AuthConfig::api_key("X-Key", "{{key}}", ApiKeyLocation::Header);
        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        match resolved.auth {
            ResolvedAuth::ApiKey { location, .. } => assert_eq!(location, ApiKeyLocation::Header),
            other => panic!("期望 ApiKey，得到 {:?}", other),
        }
    }

    #[test]
    fn body_kinds_are_resolved_with_expected_content_types() {
        let layers = layers_with(&[("name", "reqman")], &[]);

        let mut request = sample_request();
        request.body = RequestBody::raw("{\"n\":\"{{name}}\"}", RawLanguage::Json);
        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        match resolved.body {
            ResolvedBody::Raw { text, content_type } => {
                assert_eq!(text, "{\"n\":\"reqman\"}");
                assert_eq!(content_type, "application/json");
            }
            other => panic!("期望 Raw，得到 {:?}", other),
        }

        request.body = RequestBody::none();
        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        assert_eq!(resolved.body, ResolvedBody::None, "切换到无正文后不应残留旧正文");
    }

    #[test]
    fn disabled_headers_and_params_are_not_sent() {
        let layers = layers_with(&[("host", "api.test")], &[]);
        let mut request = sample_request();
        request.params = vec![
            KeyValue::new("keep", "1"),
            KeyValue {
                key: "drop".into(),
                value: "2".into(),
                enabled: false,
                description: None,
            },
        ];
        request.headers = vec![KeyValue {
            key: "X-Off".into(),
            value: "1".into(),
            enabled: false,
            description: None,
        }];

        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        assert!(resolved.url.contains("keep=1"));
        assert!(!resolved.url.contains("drop=2"));
        assert!(resolved.headers.is_empty());
    }

    #[test]
    fn insecure_tls_setting_raises_the_warning_flag() {
        let layers = ScopeLayers::default();
        let mut request = sample_request();
        request.settings.verify_tls = false;

        let preview = preview_request(&request, &AuthConfig::none(), &layers);
        assert!(preview.insecure_warning);
    }

    #[test]
    fn form_data_file_fields_pass_handles_through_untouched() {
        use crate::storage::model::FormField;
        let layers = ScopeLayers::default();
        let mut request = sample_request();
        request.body = RequestBody::form(vec![
            FormField::text("note", "hi"),
            FormField {
                key: "file".into(),
                value: None,
                file_handle: Some("handle-1".into()),
                description: Some("a.txt".into()),
                kind: FormFieldKind::File,
                enabled: true,
            },
        ]);

        let resolved = resolve_request(&request, &AuthConfig::none(), &layers);
        match resolved.body {
            ResolvedBody::FormData { fields } => {
                assert_eq!(
                    fields[0],
                    ResolvedFormField::Text {
                        key: "note".into(),
                        value: "hi".into()
                    }
                );
                assert_eq!(
                    fields[1],
                    ResolvedFormField::File {
                        key: "file".into(),
                        handle: "handle-1".into()
                    }
                );
            }
            other => panic!("期望 FormData，得到 {:?}", other),
        }
    }
}
