//! Postman 文档的宽松 serde 模型。
//!
//! 只声明映射真正需要读取的字段：未知字段一律忽略（Postman 文档字段多且随版本
//! 增删），缺失字段给默认值，使解析对文档形状差异有韧性。

use serde::Deserialize;
use serde_json::Value;

/// `description` 既可能是字符串，也可能是 `{ "content": "...", "type": ... }`。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum DescriptionField {
    Plain(String),
    Structured(StructuredDescription),
}

#[derive(Debug, Clone, Deserialize)]
pub struct StructuredDescription {
    #[serde(default)]
    pub content: Option<String>,
}

impl DescriptionField {
    /// 取出描述文本；空白视为没有描述。
    pub fn text(&self) -> Option<String> {
        let raw = match self {
            DescriptionField::Plain(text) => Some(text.as_str()),
            DescriptionField::Structured(structured) => structured.content.as_deref(),
        };
        raw.map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    }
}

/// 字符串或字符串数组。`host` / `path` 在不同文档里出现两种形状。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum StringOrList {
    One(String),
    Many(Vec<String>),
}

impl StringOrList {
    pub fn parts(&self) -> Vec<String> {
        match self {
            StringOrList::One(text) => vec![text.clone()],
            StringOrList::Many(list) => list.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CollectionDoc {
    #[serde(default)]
    pub info: Option<InfoDoc>,
    #[serde(default)]
    pub item: Vec<ItemDoc>,
    #[serde(default)]
    pub auth: Option<AuthField>,
    #[serde(default)]
    pub event: Vec<EventDoc>,
    #[serde(default)]
    pub variable: Vec<VariableDoc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InfoDoc {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<DescriptionField>,
    #[serde(default)]
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ItemDoc {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<DescriptionField>,
    /// 非空即为文件夹。
    #[serde(default)]
    pub item: Vec<ItemDoc>,
    #[serde(default)]
    pub request: Option<RequestField>,
    #[serde(default)]
    pub auth: Option<AuthField>,
    #[serde(default)]
    pub event: Vec<EventDoc>,
    /// 内嵌示例。本轮不持久化，只在报告中递归计数。
    #[serde(default)]
    pub response: Vec<Value>,
}

/// 条目里的 `request`：v2.1 是对象，个别旧文档是纯 URL 字符串。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum RequestField {
    Object(Box<RequestDoc>),
    Url(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct RequestDoc {
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub header: Vec<HeaderDoc>,
    #[serde(default)]
    pub url: Option<UrlField>,
    #[serde(default)]
    pub body: Option<BodyDoc>,
    #[serde(default)]
    pub auth: Option<AuthField>,
    #[serde(default)]
    pub description: Option<DescriptionField>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum UrlField {
    Structured(UrlDoc),
    Raw(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UrlDoc {
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub host: Option<StringOrList>,
    #[serde(default)]
    pub path: Option<StringOrList>,
    #[serde(default)]
    pub port: Option<String>,
    #[serde(default)]
    pub query: Vec<QueryDoc>,
    #[serde(default)]
    pub variable: Vec<VariableDoc>,
    #[serde(default)]
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct QueryDoc {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub description: Option<DescriptionField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HeaderDoc {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub description: Option<DescriptionField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VariableDoc {
    #[serde(default)]
    pub key: Option<String>,
    /// 值可能是字符串、数字或布尔，统一按文本处理。
    #[serde(default)]
    pub value: Option<Value>,
    /// 集合变量用 `disabled`，环境/全局变量用 `enabled`。
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub enabled: Option<bool>,
    /// `"secret"` 表示敏感变量。
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BodyDoc {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub raw: Option<String>,
    #[serde(default)]
    pub options: Option<BodyOptions>,
    #[serde(default)]
    pub urlencoded: Vec<FormParamDoc>,
    #[serde(default)]
    pub formdata: Vec<FormParamDoc>,
    #[serde(default)]
    pub file: Option<FileDoc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BodyOptions {
    #[serde(default)]
    pub raw: Option<RawOptions>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawOptions {
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FormParamDoc {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    /// 文件字段的本地路径。**本系统不读取它**，只取文件名用于展示。
    #[serde(default)]
    pub src: Option<Value>,
    /// `"text"` 或 `"file"`。
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub description: Option<DescriptionField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileDoc {
    /// 二进制正文的本地路径。同样不被读取。
    #[serde(default)]
    pub src: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthField {
    /// `noauth` / `basic` / `bearer` / `apikey` / `digest` / `oauth2` …
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub basic: Vec<AuthParamDoc>,
    #[serde(default)]
    pub bearer: Vec<AuthParamDoc>,
    #[serde(default)]
    pub apikey: Vec<AuthParamDoc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthParamDoc {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventDoc {
    /// `prerequest` 或 `test`。
    #[serde(default)]
    pub listen: Option<String>,
    #[serde(default)]
    pub script: Option<ScriptDoc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptDoc {
    #[serde(default)]
    pub exec: Option<ExecField>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ExecField {
    One(String),
    Many(Vec<String>),
}

impl ExecField {
    pub fn text(&self) -> String {
        match self {
            ExecField::One(text) => text.clone(),
            ExecField::Many(lines) => lines.join("\n"),
        }
    }
}

/// Environment 与 Globals 文档。
#[derive(Debug, Clone, Deserialize)]
pub struct VariablesDoc {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub values: Vec<VariableDoc>,
    #[serde(default, rename = "_postman_variable_scope")]
    pub variable_scope: Option<String>,
}
