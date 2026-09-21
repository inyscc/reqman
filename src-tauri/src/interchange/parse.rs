//! 把 Postman 文档归一化为内部模型的中间表示。
//!
//! 纯函数：不碰数据库、网络与系统对话框，因此可以只靠内存数据做断言。
//! 落盘（含 secret 加密）由 `crate::interchange::import` 在单个事务里完成。

use super::document::{
    AuthField, AuthParamDoc, BodyDoc, CollectionDoc, DescriptionField, EventDoc, FileDoc,
    FormParamDoc, HeaderDoc, ItemDoc, QueryDoc, RequestField, StringOrList, UrlDoc, UrlField,
    VariableDoc, VariablesDoc,
};
use super::{AuthDowngrade, EntryLevel, FileFieldDowngrade, ImportReport, SkippedItem};
use crate::error::{AppError, AppResult};
use crate::storage::model::{
    ApiKeyLocation, AuthConfig, BinaryBody, BodyKind, FormField, FormFieldKind, KeyValue,
    RawLanguage, RequestBody, RequestSettings,
};
use crate::url_util;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// 探测到的文档类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    CollectionV21,
    CollectionV20,
    Environment,
    Globals,
}

// ---------------------------------------------------------------------------
// 中间表示
// ---------------------------------------------------------------------------

/// 源文档中的变量。源格式只有一个值，落盘时同时写入初始值与当前值（design D13）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVariable {
    pub name: String,
    pub value: String,
    pub is_secret: bool,
    /// 源文档中的启用状态；禁用的变量照常导入，只是不参与解析。
    pub enabled: bool,
    /// 源文档中的描述（可选）。
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRequest {
    pub name: String,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFolder {
    pub name: String,
    pub description: Option<String>,
    pub auth: AuthConfig,
    pub pre_request_script: Option<String>,
    pub test_script: Option<String>,
    pub children: Vec<ParsedItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedItem {
    Folder(ParsedFolder),
    Request(ParsedRequest),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCollection {
    pub name: String,
    pub description: Option<String>,
    pub auth: AuthConfig,
    pub pre_request_script: Option<String>,
    pub test_script: Option<String>,
    pub variables: Vec<ParsedVariable>,
    pub children: Vec<ParsedItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEnvironment {
    pub name: String,
    pub variables: Vec<ParsedVariable>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedPayload {
    Collection(ParsedCollection),
    Environment(ParsedEnvironment),
    Globals(Vec<ParsedVariable>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedDocument {
    pub kind: DocumentKind,
    pub payload: ParsedPayload,
    pub report: ImportReport,
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 解析一份 Postman 文档文本。
///
/// 非法 JSON 与无法识别的文档形状都返回可辨识的错误（`invalid_input`），
/// 而不是给出一个空结果。
pub fn parse_document(raw: &str) -> AppResult<ParsedDocument> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| AppError::invalid_input(format!("文档不是合法 JSON：{}", err)))?;

    let kind = detect(&value)?;
    let mut report = ImportReport::default();

    let payload = match kind {
        DocumentKind::CollectionV21 | DocumentKind::CollectionV20 => {
            let doc: CollectionDoc = serde_json::from_value(value).map_err(shape_error)?;
            ParsedPayload::Collection(parse_collection(&doc, &mut report))
        }
        DocumentKind::Environment | DocumentKind::Globals => {
            let doc: VariablesDoc = serde_json::from_value(value).map_err(shape_error)?;
            let variables = parse_variables(&doc.values, &mut report);
            if kind == DocumentKind::Environment {
                ParsedPayload::Environment(ParsedEnvironment {
                    name: doc
                        .name
                        .map(|name| name.trim().to_string())
                        .filter(|name| !name.is_empty())
                        .unwrap_or_else(|| "导入的环境".to_string()),
                    variables,
                })
            } else {
                ParsedPayload::Globals(variables)
            }
        }
    };

    Ok(ParsedDocument {
        kind,
        payload,
        report,
    })
}

/// 探测文档类型。
pub fn detect(value: &Value) -> AppResult<DocumentKind> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::invalid_input("文档顶层应为 JSON 对象"))?;

    match object
        .get("_postman_variable_scope")
        .and_then(Value::as_str)
    {
        Some("globals") => return Ok(DocumentKind::Globals),
        Some("environment") => return Ok(DocumentKind::Environment),
        _ => {}
    }

    if let Some(info) = object.get("info").and_then(Value::as_object) {
        let schema = info.get("schema").and_then(Value::as_str).unwrap_or("");
        return Ok(if schema.contains("v2.0") {
            DocumentKind::CollectionV20
        } else {
            DocumentKind::CollectionV21
        });
    }

    if object.contains_key("item") {
        return Ok(DocumentKind::CollectionV21);
    }

    if object.get("values").map(Value::is_array).unwrap_or(false) {
        return Ok(DocumentKind::Environment);
    }

    Err(AppError::invalid_input(
        "无法识别的文档：既不是 Postman Collection，也不是 Environment 或 Globals",
    ))
}

fn shape_error(err: serde_json::Error) -> AppError {
    AppError::invalid_input(format!("文档结构与 Postman 格式不符：{}", err))
}

// ---------------------------------------------------------------------------
// 集合
// ---------------------------------------------------------------------------

fn parse_collection(doc: &CollectionDoc, report: &mut ImportReport) -> ParsedCollection {
    let name = doc
        .info
        .as_ref()
        .and_then(|info| info.name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("导入的集合")
        .to_string();

    let description = doc
        .info
        .as_ref()
        .and_then(|info| info.description.as_ref())
        .and_then(DescriptionField::text);

    let auth = map_auth(
        doc.auth.as_ref(),
        EntryLevel::Collection,
        &name,
        report,
    );
    let (pre_request_script, test_script) = map_scripts(&doc.event);

    let variables = parse_variables(&doc.variable, report);
    let children = parse_items(&doc.item, report);

    ParsedCollection {
        name,
        description,
        auth,
        pre_request_script,
        test_script,
        variables,
        children,
    }
}

/// 递归映射条目，保持层级归属与同级顺序（spec: 导入 Postman 集合）。
fn parse_items(items: &[ItemDoc], report: &mut ImportReport) -> Vec<ParsedItem> {
    let mut out = Vec::with_capacity(items.len());

    for item in items {
        let name = item
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("(未命名条目)")
            .to_string();

        // 内嵌示例本轮不持久化，但在嵌套条目上递归计数（spec: 导入报告）
        report.dropped_examples += item.response.len();

        if !item.item.is_empty() {
            let auth = map_auth(item.auth.as_ref(), EntryLevel::Folder, &name, report);
            let (pre_request_script, test_script) = map_scripts(&item.event);
            out.push(ParsedItem::Folder(ParsedFolder {
                name,
                description: item.description.as_ref().and_then(DescriptionField::text),
                auth,
                pre_request_script,
                test_script,
                children: parse_items(&item.item, report),
            }));
        } else {
            out.push(ParsedItem::Request(parse_request(item, &name, report)));
        }
    }

    out
}

fn parse_request(item: &ItemDoc, name: &str, report: &mut ImportReport) -> ParsedRequest {
    let (method, url, params, headers, body, auth, item_description) = match item.request.as_ref() {
        Some(RequestField::Object(doc)) => {
            let (url, params) = doc
                .url
                .as_ref()
                .map(map_url)
                .unwrap_or_else(|| (String::new(), Vec::new()));
            (
                map_method(doc.method.as_deref()),
                url,
                params,
                map_headers(&doc.header),
                map_body(doc.body.as_ref(), name, report),
                map_auth(doc.auth.as_ref(), EntryLevel::Request, name, report),
                doc.description.as_ref().and_then(DescriptionField::text),
            )
        }
        Some(RequestField::Url(raw)) => {
            let (url, params) = map_url(&UrlField::Raw(raw.clone()));
            (
                "GET".to_string(),
                url,
                params,
                Vec::new(),
                RequestBody::none(),
                AuthConfig::default(),
                None,
            )
        }
        None => (
            "GET".to_string(),
            String::new(),
            Vec::new(),
            Vec::new(),
            RequestBody::none(),
            AuthConfig::default(),
            None,
        ),
    };

    ParsedRequest {
        name: name.to_string(),
        description: item_description.or_else(|| {
            item.description
                .as_ref()
                .and_then(DescriptionField::text)
        }),
        method,
        url,
        params,
        headers,
        body,
        auth,
        settings: RequestSettings::default(),
        pre_request_script: None,
        test_script: None,
    }
    .with_scripts(&item.event)
}

impl ParsedRequest {
    fn with_scripts(mut self, events: &[EventDoc]) -> Self {
        let (pre_request_script, test_script) = map_scripts(events);
        self.pre_request_script = pre_request_script;
        self.test_script = test_script;
        self
    }
}

/// 标准方法统一为大写；其余保留源文档写法。
fn map_method(raw: Option<&str>) -> String {
    let text = raw.unwrap_or("GET").trim();
    if text.is_empty() {
        return "GET".to_string();
    }
    let upper = text.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        upper
    } else {
        text.to_string()
    }
}

// ---------------------------------------------------------------------------
// URL 与查询参数
// ---------------------------------------------------------------------------

/// 把源文档的 URL 映射为「扁平 URL + 参数表」。
///
/// 路径变量 `:name` 在 `url.variable` 里给出取值时直接落到路径上，使「发送时
/// 得到该取值」成立；未给出取值时保留 `:name` 原文，交由变量解析判定为未解析。
fn map_url(url: &UrlField) -> (String, Vec<KeyValue>) {
    match url {
        UrlField::Raw(text) => url_util::split_url_query(text),
        UrlField::Structured(doc) => structured_url(doc),
    }
}

fn structured_url(doc: &UrlDoc) -> (String, Vec<KeyValue>) {
    let host = doc.host.as_ref().map(StringOrList::parts).unwrap_or_default();
    let path = doc.path.as_ref().map(StringOrList::parts).unwrap_or_default();
    let query_params: Vec<KeyValue> = doc.query.iter().map(map_query).collect();

    // 结构化字段整体缺失时：以 `raw` 为 URL 文本，用带启用标记的 `query` 数组补全。
    // 本系统导出的文档正是这个形状，因此这条分支决定往返保真。
    if host.is_empty() && path.is_empty() {
        return match doc.raw.as_deref().filter(|raw| !raw.trim().is_empty()) {
            Some(raw) => {
                let (base, from_raw) = url_util::split_url_query(raw);
                (base, merge_params(from_raw, query_params))
            }
            None => (String::new(), query_params),
        };
    }

    let values: BTreeMap<String, String> = doc
        .variable
        .iter()
        .filter_map(|variable| {
            let key = variable.key.as_deref()?;
            Some((key.to_string(), value_to_string(variable.value.as_ref())))
        })
        .collect();

    let mut base = String::new();
    if let Some(protocol) = doc.protocol.as_deref().filter(|p| !p.trim().is_empty()) {
        base.push_str(protocol);
        base.push_str("://");
    }
    base.push_str(&host.join("."));
    if let Some(port) = doc.port.as_deref().filter(|port| !port.trim().is_empty()) {
        base.push(':');
        base.push_str(port);
    }
    base.push('/');
    let segments: Vec<String> = path
        .iter()
        .map(|segment| match segment.strip_prefix(':') {
            Some(name) => values.get(name).cloned().unwrap_or_else(|| segment.clone()),
            None => segment.clone(),
        })
        .collect();
    base.push_str(&segments.join("/"));
    if let Some(hash) = doc.hash.as_deref().filter(|hash| !hash.trim().is_empty()) {
        base.push('#');
        base.push_str(hash);
    }

    let mut params = query_params;

    // `raw` 的查询串作为底，带启用标记的 `query` 数组覆盖同键项
    if let Some(raw) = doc.raw.as_deref().filter(|raw| !raw.trim().is_empty()) {
        let (_, from_raw) = url_util::split_url_query(raw);
        params = merge_params(from_raw, params);
    }

    (base, params)
}

/// `preferred` 覆盖 `base` 中同键的项，并保留 `base` 中独有的键。
///
/// 只有结构化 `query` 数组带启用标记，因此它优先；`raw` 里的查询串只用于补齐。
fn merge_params(base: Vec<KeyValue>, preferred: Vec<KeyValue>) -> Vec<KeyValue> {
    let mut out = base;
    for candidate in preferred {
        match out.iter_mut().find(|existing| existing.key == candidate.key) {
            Some(existing) => *existing = candidate,
            None => out.push(candidate),
        }
    }
    out
}

fn map_query(query: &QueryDoc) -> KeyValue {
    KeyValue {
        key: query.key.clone().unwrap_or_default(),
        value: query.value.clone().unwrap_or_default(),
        enabled: !query.disabled,
        description: query.description.as_ref().and_then(DescriptionField::text),
    }
}

fn map_headers(headers: &[HeaderDoc]) -> Vec<KeyValue> {
    headers
        .iter()
        .map(|header| KeyValue {
            key: header.key.clone().unwrap_or_default(),
            value: header.value.clone().unwrap_or_default(),
            enabled: !header.disabled,
            description: header
                .description
                .as_ref()
                .and_then(DescriptionField::text),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

fn map_body(body: Option<&BodyDoc>, entry_name: &str, report: &mut ImportReport) -> RequestBody {
    let Some(body) = body else {
        return RequestBody::none();
    };

    match body.mode.as_deref().map(str::trim) {
        Some("raw") => RequestBody::raw(
            body.raw.clone().unwrap_or_default(),
            body.options
                .as_ref()
                .and_then(|options| options.raw.as_ref())
                .and_then(|raw| raw.language.as_deref())
                .map(map_raw_language)
                .unwrap_or(RawLanguage::Text),
        ),
        Some("urlencoded") => RequestBody::urlencoded(
            body.urlencoded
                .iter()
                .map(|param| KeyValue {
                    key: param.key.clone().unwrap_or_default(),
                    value: value_to_string(param.value.as_ref()),
                    enabled: !param.disabled,
                    description: param.description.as_ref().and_then(DescriptionField::text),
                })
                .collect(),
        ),
        Some("formdata") => RequestBody {
            kind: BodyKind::FormData,
            form: body
                .formdata
                .iter()
                .map(|param| map_form_field(param, entry_name, report))
                .collect(),
            ..RequestBody::default()
        },
        Some("file") => {
            let src = body.file.as_ref().and_then(|file: &FileDoc| file.src.as_ref());
            let description = src.and_then(src_description);
            report.file_field_downgrades.push(FileFieldDowngrade {
                entry_name: entry_name.to_string(),
                field_name: description
                    .clone()
                    .unwrap_or_else(|| "(未命名文件)".to_string()),
            });
            RequestBody {
                kind: BodyKind::Binary,
                binary: Some(BinaryBody {
                    file_handle: None,
                    description,
                }),
                ..RequestBody::default()
            }
        }
        Some(other) if !other.is_empty() && other != "none" => {
            // 例如 graphql：本变更不映射，但差异必须可见
            report.skipped_items.push(SkippedItem {
                name: entry_name.to_string(),
                reason: format!("不支持的请求体类型：{}", other),
            });
            RequestBody::none()
        }
        _ => RequestBody::none(),
    }
}

/// 表单字段：文件字段降级为「未选择文件」，且**不读取**源文档所指路径（design D12）。
fn map_form_field(
    param: &FormParamDoc,
    entry_name: &str,
    report: &mut ImportReport,
) -> FormField {
    let is_file = param.kind.as_deref() == Some("file") || param.src.is_some();

    if is_file {
        let description = param
            .description
            .as_ref()
            .and_then(DescriptionField::text)
            .or_else(|| param.src.as_ref().and_then(src_description));
        report.file_field_downgrades.push(FileFieldDowngrade {
            entry_name: entry_name.to_string(),
            field_name: param
                .key
                .clone()
                .filter(|key| !key.trim().is_empty())
                .unwrap_or_else(|| "(未命名字段)".to_string()),
        });
        FormField {
            key: param.key.clone().unwrap_or_default(),
            value: None,
            file_handle: None,
            description,
            kind: FormFieldKind::File,
            enabled: !param.disabled,
        }
    } else {
        FormField {
            key: param.key.clone().unwrap_or_default(),
            value: Some(value_to_string(param.value.as_ref())),
            file_handle: None,
            description: param.description.as_ref().and_then(DescriptionField::text),
            kind: FormFieldKind::Text,
            enabled: !param.disabled,
        }
    }
}

fn map_raw_language(language: &str) -> RawLanguage {
    match language.trim().to_ascii_lowercase().as_str() {
        "json" => RawLanguage::Json,
        "xml" => RawLanguage::Xml,
        "html" => RawLanguage::Html,
        "javascript" => RawLanguage::Javascript,
        _ => RawLanguage::Text,
    }
}

/// 从 `src` 取出仅用于展示的文件名。**不打开、不读取该路径**。
fn src_description(src: &Value) -> Option<String> {
    let text = match src {
        Value::String(text) => text.as_str(),
        Value::Array(items) => items.first().and_then(Value::as_str)?,
        _ => return None,
    };
    let basename = text
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or(text);
    let trimmed = basename.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ---------------------------------------------------------------------------
// 认证与事件
// ---------------------------------------------------------------------------

/// 映射认证。集合、文件夹、请求三层各映射到对应实体（design D11）；
/// 内部不支持的类型降级为「无认证」并记录（design D4）。
fn map_auth(
    auth: Option<&AuthField>,
    level: EntryLevel,
    entry_name: &str,
    report: &mut ImportReport,
) -> AuthConfig {
    let Some(auth) = auth else {
        // 源文档未给出认证 => 继承上层
        return AuthConfig::default();
    };

    match auth.kind.as_deref().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        // 未声明类型，按继承处理
        "" => AuthConfig::default(),
        "noauth" => AuthConfig::none(),
        "basic" => AuthConfig::basic(
            auth_param(&auth.basic, "username"),
            auth_param(&auth.basic, "password"),
        ),
        "bearer" => AuthConfig::bearer(auth_param(&auth.bearer, "token")),
        "apikey" => {
            let location = if auth_param(&auth.apikey, "in").eq_ignore_ascii_case("query") {
                ApiKeyLocation::Query
            } else {
                ApiKeyLocation::Header
            };
            AuthConfig::api_key(
                auth_param(&auth.apikey, "key"),
                auth_param(&auth.apikey, "value"),
                location,
            )
        }
        other => {
            report.auth_downgrades.push(AuthDowngrade {
                level,
                entry_name: entry_name.to_string(),
                auth_type: other.to_string(),
            });
            AuthConfig::none()
        }
    }
}

fn auth_param(params: &[AuthParamDoc], key: &str) -> String {
    params
        .iter()
        .find(|param| param.key.as_deref() == Some(key))
        .map(|param| value_to_string(param.value.as_ref()))
        .unwrap_or_default()
}

/// 映射 `prerequest` / `test` 事件为前后置脚本文本。
fn map_scripts(events: &[EventDoc]) -> (Option<String>, Option<String>) {
    let mut pre_request_script = None;
    let mut test_script = None;

    for event in events {
        let Some(listen) = event.listen.as_deref().map(str::trim) else {
            continue;
        };
        let Some(exec) = event
            .script
            .as_ref()
            .and_then(|script| script.exec.as_ref())
        else {
            continue;
        };
        let text = exec.text();
        if text.trim().is_empty() {
            continue;
        }
        match listen {
            "prerequest" => pre_request_script = Some(text),
            "test" => test_script = Some(text),
            _ => {}
        }
    }

    (pre_request_script, test_script)
}

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------

/// 映射变量列表。
///
/// 禁用的变量**不再被跳过**：它随变量一起导入，只是带有禁用状态，因此不参与解析
/// （spec: 导入集合变量的禁用状态与描述）。只有缺少名称这种真正无法映射的条目才被丢弃并记录。
fn parse_variables(docs: &[VariableDoc], report: &mut ImportReport) -> Vec<ParsedVariable> {
    let mut out = Vec::with_capacity(docs.len());

    for doc in docs {
        let Some(name) = doc
            .key
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            report.skipped_items.push(SkippedItem {
                name: "(未命名变量)".to_string(),
                reason: "变量缺少名称".to_string(),
            });
            continue;
        };

        let raw_value = value_to_string(doc.value.as_ref());
        // 识别本系统导出的 secret 占位符：还原为 secret 变量且值置空（design D8）
        let placeholder = super::secret_placeholder_name(&raw_value);
        let is_secret = doc.kind.as_deref() == Some("secret") || placeholder.is_some();

        out.push(ParsedVariable {
            name: name.to_string(),
            value: if placeholder.is_some() {
                String::new()
            } else {
                raw_value
            },
            is_secret,
            // 集合变量用 `disabled`，环境 / 全局变量用 `enabled`，两者都识别
            enabled: doc.enabled.unwrap_or(!doc.disabled),
            description: doc.description.as_ref().and_then(DescriptionField::text),
        });
    }

    out
}

/// 把可能非字符串的 JSON 值转为文本。缺失与 `null` 都视为空串。
fn value_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> ParsedDocument {
        parse_document(&value.to_string()).expect("解析成功")
    }

    fn collection_of(document: &ParsedDocument) -> &ParsedCollection {
        match &document.payload {
            ParsedPayload::Collection(collection) => collection,
            other => panic!("应为集合，实际为 {:?}", other),
        }
    }

    // ---- 2.1 版本探测与归一化 ----

    #[test]
    fn detects_the_four_document_kinds() {
        let v21 = json!({
            "info": { "name": "C", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
            "item": []
        });
        let v20 = json!({
            "info": { "name": "C", "schema": "https://schema.getpostman.com/json/collection/v2.0.0/collection.json" },
            "item": []
        });
        let environment = json!({
            "name": "E", "values": [], "_postman_variable_scope": "environment"
        });
        let globals = json!({
            "values": [], "_postman_variable_scope": "globals"
        });

        assert_eq!(detect(&v21).unwrap(), DocumentKind::CollectionV21);
        assert_eq!(detect(&v20).unwrap(), DocumentKind::CollectionV20);
        assert_eq!(detect(&environment).unwrap(), DocumentKind::Environment);
        assert_eq!(detect(&globals).unwrap(), DocumentKind::Globals);
    }

    #[test]
    fn invalid_json_and_unknown_shapes_are_rejected_recognizably() {
        let err = parse_document("{ not json").expect_err("非法 JSON 应被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);

        let err = parse_document(&json!({ "hello": "world" }).to_string())
            .expect_err("无法识别的形状应被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);

        let err = parse_document("[1,2,3]").expect_err("顶层非对象应被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
    }

    // ---- 2.2 层级与顺序 ----

    #[test]
    fn nested_items_keep_hierarchy_and_sibling_order() {
        let document = parse(json!({
            "info": { "name": "嵌套", "schema": "collection/v2.1.0/collection.json" },
            "item": [
                { "name": "文件夹甲", "item": [
                    { "name": "甲内请求", "request": { "method": "GET", "url": "https://a.test/1" } }
                ]},
                { "name": "请求乙", "request": { "method": "POST", "url": "https://a.test/2" } },
                { "name": "请求丙", "request": { "method": "PUT", "url": "https://a.test/3" } }
            ]
        }));

        let children = &collection_of(&document).children;
        let names: Vec<String> = children
            .iter()
            .map(|item| match item {
                ParsedItem::Folder(folder) => folder.name.clone(),
                ParsedItem::Request(request) => request.name.clone(),
            })
            .collect();
        assert_eq!(names, vec!["文件夹甲", "请求乙", "请求丙"], "同级顺序应保持");

        match &children[0] {
            ParsedItem::Folder(folder) => {
                assert_eq!(folder.children.len(), 1);
                match &folder.children[0] {
                    ParsedItem::Request(request) => assert_eq!(request.name, "甲内请求"),
                    other => panic!("应为请求，实际为 {:?}", other),
                }
            }
            other => panic!("应为文件夹，实际为 {:?}", other),
        }
    }

    // ---- 2.3 URL ----

    #[test]
    fn path_variable_value_is_applied_and_disabled_query_is_preserved() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [{
                "name": "带路径变量",
                "request": {
                    "method": "GET",
                    "url": {
                        "raw": "https://api.test/users/:id?keep=1&off=2",
                        "protocol": "https",
                        "host": ["api", "test"],
                        "path": ["users", ":id"],
                        "query": [
                            { "key": "keep", "value": "1" },
                            { "key": "off", "value": "2", "disabled": true }
                        ],
                        "variable": [{ "key": "id", "value": "42" }]
                    }
                }
            }]
        }));

        let ParsedItem::Request(request) = &collection_of(&document).children[0] else {
            panic!("应为请求");
        };

        assert_eq!(request.url, "https://api.test/users/42", "路径变量取值应落到路径上");
        assert_eq!(request.params.len(), 2, "raw 的查询串不应重复补齐");
        assert_eq!(request.params[0].key, "keep");
        assert!(request.params[0].enabled);
        assert_eq!(request.params[1].key, "off");
        assert!(!request.params[1].enabled, "禁用参数应保持禁用");
    }

    #[test]
    fn unresolved_path_variable_is_left_in_place() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [{
                "name": "无取值路径变量",
                "request": {
                    "method": "GET",
                    "url": {
                        "protocol": "https",
                        "host": ["api", "test"],
                        "path": ["users", ":id"]
                    }
                }
            }]
        }));

        let ParsedItem::Request(request) = &collection_of(&document).children[0] else {
            panic!("应为请求");
        };
        assert_eq!(request.url, "https://api.test/users/:id");
    }

    #[test]
    fn v20_string_url_and_v21_object_url_agree() {
        let object_form = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [{
                "name": "请求",
                "request": {
                    "method": "GET",
                    "url": {
                        "protocol": "https",
                        "host": ["api", "test"],
                        "path": ["users"],
                        "query": [{ "key": "page", "value": "1" }]
                    }
                }
            }]
        }));

        let string_form = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.0.0/collection.json" },
            "item": [{
                "name": "请求",
                "request": {
                    "method": "GET",
                    "url": "https://api.test/users?page=1"
                }
            }]
        }));

        let ParsedItem::Request(a) = &collection_of(&object_form).children[0] else {
            panic!("应为请求");
        };
        let ParsedItem::Request(b) = &collection_of(&string_form).children[0] else {
            panic!("应为请求");
        };

        assert_eq!(a.url, b.url, "两种 URL 形状在等价输入下应产出同一 URL");
        assert_eq!(a.params.len(), b.params.len());
        assert_eq!(a.params[0].key, b.params[0].key);
        assert_eq!(a.params[0].value, b.params[0].value);
    }

    // ---- 2.4 请求体 ----

    #[test]
    fn body_kinds_map_to_expected_types_and_languages() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [
                { "name": "无正文", "request": { "method": "GET", "url": "https://a.test" } },
                { "name": "JSON", "request": { "method": "POST", "url": "https://a.test",
                    "body": { "mode": "raw", "raw": "{\"a\":1}", "options": { "raw": { "language": "json" } } } } },
                { "name": "URL 编码", "request": { "method": "POST", "url": "https://a.test",
                    "body": { "mode": "urlencoded", "urlencoded": [
                        { "key": "a", "value": "1" },
                        { "key": "off", "value": "2", "disabled": true }
                    ] } } }
            ]
        }));

        let children = &collection_of(&document).children;

        let ParsedItem::Request(none) = &children[0] else { panic!("应为请求") };
        assert_eq!(none.body.kind, BodyKind::None);

        let ParsedItem::Request(json_body) = &children[1] else { panic!("应为请求") };
        assert_eq!(json_body.body.kind, BodyKind::Raw);
        assert_eq!(json_body.body.raw.as_deref(), Some("{\"a\":1}"));
        assert_eq!(json_body.body.raw_language, Some(RawLanguage::Json));
        assert!(json_body.body.form.is_empty(), "不应携带其他类型的残留内容");

        let ParsedItem::Request(urlencoded) = &children[2] else { panic!("应为请求") };
        assert_eq!(urlencoded.body.kind, BodyKind::UrlEncoded);
        assert_eq!(urlencoded.body.urlencoded.len(), 2);
        assert!(!urlencoded.body.urlencoded[1].enabled);
        assert!(urlencoded.body.raw.is_none(), "不应携带其他类型的残留内容");
    }

    #[test]
    fn file_fields_are_downgraded_without_touching_the_filesystem() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [
                { "name": "多段表单", "request": { "method": "POST", "url": "https://a.test",
                    "body": { "mode": "formdata", "formdata": [
                        { "key": "note", "value": "hi", "type": "text" },
                        { "key": "upload", "type": "file", "src": "/nonexistent/dir/secret.pdf" }
                    ] } } },
                { "name": "二进制", "request": { "method": "POST", "url": "https://a.test",
                    "body": { "mode": "file", "file": { "src": "/nonexistent/dir/blob.bin" } } } }
            ]
        }));

        let children = &collection_of(&document).children;

        let ParsedItem::Request(form) = &children[0] else { panic!("应为请求") };
        assert_eq!(form.body.kind, BodyKind::FormData);
        assert_eq!(form.body.form[0].kind, FormFieldKind::Text);
        assert_eq!(form.body.form[1].kind, FormFieldKind::File);
        assert!(
            form.body.form[1].file_handle.is_none(),
            "文件字段应处于「未选择文件」状态"
        );
        assert_eq!(form.body.form[1].description.as_deref(), Some("secret.pdf"));

        let ParsedItem::Request(binary) = &children[1] else { panic!("应为请求") };
        assert_eq!(binary.body.kind, BodyKind::Binary);
        assert!(binary.body.binary.as_ref().unwrap().file_handle.is_none());

        let names: Vec<&str> = document
            .report
            .file_field_downgrades
            .iter()
            .map(|entry| entry.field_name.as_str())
            .collect();
        assert_eq!(names, vec!["upload", "blob.bin"]);
        assert_eq!(document.report.file_field_downgrades[0].entry_name, "多段表单");
    }

    #[test]
    fn unsupported_body_mode_is_reported_rather_than_silently_dropped() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [{ "name": "GraphQL", "request": { "method": "POST", "url": "https://a.test",
                "body": { "mode": "graphql", "graphql": { "query": "{ a }" } } } }]
        }));

        assert_eq!(document.report.skipped_items.len(), 1);
        assert_eq!(document.report.skipped_items[0].name, "GraphQL");
        assert!(document.report.skipped_items[0].reason.contains("graphql"));
    }

    // ---- 2.5 认证与事件（三层） ----

    #[test]
    fn auth_maps_at_all_three_levels_and_events_land_on_their_level() {
        let document = parse(json!({
            "info": { "name": "三层", "schema": "collection/v2.1.0/collection.json" },
            "auth": { "type": "basic", "basic": [
                { "key": "username", "value": "u" }, { "key": "password", "value": "p" } ] },
            "event": [{ "listen": "prerequest", "script": { "exec": ["console.log('集合前置')"] } }],
            "item": [{
                "name": "文件夹",
                "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "{{tok}}" }] },
                "event": [{ "listen": "test", "script": { "exec": ["pm.test('文件夹')"] } }],
                "item": [{
                    "name": "请求",
                    "request": {
                        "method": "GET", "url": "https://a.test",
                        "auth": { "type": "apikey", "apikey": [
                            { "key": "key", "value": "X-Api-Key" },
                            { "key": "value", "value": "{{k}}" },
                            { "key": "in", "value": "query" } ] }
                    },
                    "event": [{ "listen": "prerequest", "script": { "exec": ["console.log('请求前置')", "console.log('第二行')"] } }]
                }]
            }]
        }));

        let collection = collection_of(&document);
        assert_eq!(collection.auth.kind, crate::storage::model::AuthKind::Basic);
        assert_eq!(
            collection.auth.basic.as_ref().unwrap().username,
            "u"
        );
        assert_eq!(
            collection.pre_request_script.as_deref(),
            Some("console.log('集合前置')"),
            "集合级事件应落在集合上"
        );

        let ParsedItem::Folder(folder) = &collection.children[0] else { panic!("应为文件夹") };
        assert_eq!(folder.auth.kind, crate::storage::model::AuthKind::Bearer);
        assert_eq!(folder.test_script.as_deref(), Some("pm.test('文件夹')"), "文件夹级事件应落在文件夹上");

        let ParsedItem::Request(request) = &folder.children[0] else { panic!("应为请求") };
        assert_eq!(request.auth.kind, crate::storage::model::AuthKind::ApiKey);
        assert_eq!(
            request.auth.api_key.as_ref().unwrap().location,
            ApiKeyLocation::Query
        );
        assert_eq!(
            request.pre_request_script.as_deref(),
            Some("console.log('请求前置')\nconsole.log('第二行')"),
            "exec 数组应以换行连接"
        );
        assert!(document.report.auth_downgrades.is_empty());
    }

    #[test]
    fn unsupported_auth_is_downgraded_to_none_and_recorded_with_level() {
        let document = parse(json!({
            "info": { "name": "降级", "schema": "collection/v2.1.0/collection.json" },
            "auth": { "type": "digest", "digest": [] },
            "item": [{
                "name": "请求",
                "request": {
                    "method": "GET", "url": "https://a.test",
                    "auth": { "type": "oauth2", "oauth2": [] }
                }
            }]
        }));

        let collection = collection_of(&document);
        assert_eq!(
            collection.auth.kind,
            crate::storage::model::AuthKind::None,
            "不支持的认证应降级为「无认证」，而不是继承"
        );
        let ParsedItem::Request(request) = &collection.children[0] else { panic!("应为请求") };
        assert_eq!(request.auth.kind, crate::storage::model::AuthKind::None);

        assert_eq!(document.report.auth_downgrades.len(), 2);
        assert_eq!(document.report.auth_downgrades[0].level, EntryLevel::Collection);
        assert_eq!(document.report.auth_downgrades[0].entry_name, "降级");
        assert_eq!(document.report.auth_downgrades[0].auth_type, "digest");
        assert_eq!(document.report.auth_downgrades[1].level, EntryLevel::Request);
        assert_eq!(document.report.auth_downgrades[1].entry_name, "请求");
        assert_eq!(document.report.auth_downgrades[1].auth_type, "oauth2");
    }

    #[test]
    fn noauth_is_none_and_missing_auth_inherits() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "item": [
                { "name": "显式无认证", "request": { "method": "GET", "url": "https://a.test",
                    "auth": { "type": "noauth" } } },
                { "name": "未声明", "request": { "method": "GET", "url": "https://a.test" } }
            ]
        }));

        let children = &collection_of(&document).children;
        let ParsedItem::Request(explicit) = &children[0] else { panic!("应为请求") };
        let ParsedItem::Request(inherited) = &children[1] else { panic!("应为请求") };
        assert_eq!(explicit.auth.kind, crate::storage::model::AuthKind::None);
        assert_eq!(inherited.auth.kind, crate::storage::model::AuthKind::Inherit);
    }

    // ---- 变量与环境 ----

    #[test]
    fn disabled_variables_are_imported_as_disabled() {
        let document = parse(json!({
            "values": [
                { "key": "keep", "value": "1", "enabled": true },
                { "key": "off", "value": "2", "enabled": false },
                { "key": "secret", "value": "s", "enabled": true, "type": "secret" },
                { "key": "described", "value": "3", "description": "一段描述" }
            ],
            "_postman_variable_scope": "environment",
            "name": "开发环境"
        }));

        let ParsedPayload::Environment(environment) = &document.payload else {
            panic!("应为环境");
        };
        assert_eq!(environment.name, "开发环境");
        assert_eq!(environment.variables.len(), 4, "禁用变量照常进入中间表示");
        assert!(environment.variables[0].enabled);
        assert!(!environment.variables[1].enabled, "禁用状态应被保留");
        assert!(!environment.variables[1].is_secret);
        assert!(environment.variables[2].is_secret, "secret 标记应保持");
        assert_eq!(
            environment.variables[3].description.as_deref(),
            Some("一段描述"),
            "描述应被保留"
        );
        assert!(
            document.report.skipped_items.is_empty(),
            "禁用不再计入被跳过的条目：{:?}",
            document.report.skipped_items
        );
    }

    #[test]
    fn unnamed_variables_are_still_skipped_and_reported() {
        let document = parse(json!({
            "values": [
                { "key": "keep", "value": "1" },
                { "key": "   ", "value": "2" }
            ],
            "_postman_variable_scope": "globals"
        }));

        let ParsedPayload::Globals(variables) = &document.payload else {
            panic!("应为全局变量");
        };
        assert_eq!(variables.len(), 1, "缺名称的条目无法映射，仍被丢弃");
        assert_eq!(document.report.skipped_items.len(), 1);
        assert_eq!(document.report.skipped_items[0].reason, "变量缺少名称");
    }

    #[test]
    fn globals_map_to_variables_without_an_environment_name() {
        let document = parse(json!({
            "values": [
                { "key": "host", "value": "api.test", "enabled": true },
                { "key": "off", "value": "x", "enabled": false }
            ],
            "_postman_variable_scope": "globals"
        }));

        let ParsedPayload::Globals(variables) = &document.payload else {
            panic!("应为全局变量");
        };
        assert_eq!(variables.len(), 2, "禁用变量同样进入中间表示");
        assert_eq!(variables[0].name, "host");
        assert_eq!(variables[0].value, "api.test");
        assert!(variables[0].enabled);
        assert_eq!(variables[1].name, "off");
        assert!(!variables[1].enabled);
        assert_eq!(variables[1].description, None);
    }

    #[test]
    fn collection_variables_and_examples_are_counted_recursively() {
        let document = parse(json!({
            "info": { "name": "C", "schema": "collection/v2.1.0/collection.json" },
            "variable": [{ "key": "base", "value": "https://api.test" }],
            "item": [
                { "name": "带示例的请求", "request": { "method": "GET", "url": "https://a.test" },
                  "response": [{ "name": "示例一" }, { "name": "示例二" }] },
                { "name": "文件夹", "item": [
                    { "name": "深层请求", "request": { "method": "GET", "url": "https://a.test" },
                      "response": [{ "name": "示例三" }] }
                ]}
            ]
        }));

        let collection = collection_of(&document);
        assert_eq!(collection.variables.len(), 1);
        assert_eq!(collection.variables[0].name, "base");
        assert_eq!(document.report.dropped_examples, 3, "示例应在嵌套条目上递归计数");
    }

    #[test]
    fn a_document_with_downgrades_yields_a_complete_report() {
        let document = parse(json!({
            "info": { "name": "有差异", "schema": "collection/v2.1.0/collection.json" },
            "item": [{
                "name": "请求",
                "request": {
                    "method": "POST", "url": "https://a.test",
                    "auth": { "type": "ntlm" },
                    "body": { "mode": "formdata", "formdata": [
                        { "key": "file", "type": "file", "src": "/tmp/x.bin" }
                    ] }
                },
                "response": [{ "name": "示例一" }]
            }]
        }));

        let report = &document.report;
        assert_eq!(report.auth_downgrades.len(), 1);
        assert_eq!(report.auth_downgrades[0].level, EntryLevel::Request);
        assert_eq!(report.auth_downgrades[0].entry_name, "请求");
        assert_eq!(report.auth_downgrades[0].auth_type, "ntlm");
        assert_eq!(report.file_field_downgrades.len(), 1);
        assert_eq!(report.file_field_downgrades[0].entry_name, "请求");
        assert_eq!(report.file_field_downgrades[0].field_name, "file");
        assert_eq!(report.dropped_examples, 1);
        assert!(!report.is_clean(), "存在差异时报告不应为空");
    }

    #[test]
    fn a_lossless_document_produces_a_clean_report() {
        let document = parse(json!({
            "info": { "name": "干净", "schema": "collection/v2.1.0/collection.json",
                      "description": "集合说明" },
            "variable": [{ "key": "base", "value": "https://api.test" }],
            "item": [{ "name": "请求", "description": "请求说明",
                "request": { "method": "GET", "url": "https://a.test",
                             "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "t" }] } } }]
        }));

        assert!(document.report.is_clean(), "完全可无损映射时报告应为空");
        assert_eq!(collection_of(&document).description.as_deref(), Some("集合说明"));
        let ParsedItem::Request(request) = &collection_of(&document).children[0] else {
            panic!("应为请求");
        };
        assert_eq!(request.description.as_deref(), Some("请求说明"));
    }
}
