//! 把内部模型序列化为 Postman 文档。
//!
//! 与 `parse` 对称：`parse` 是「文档 → 中间表示」，这里是「中间表示 → 文档」。
//! 导出以变量的**当前值**写出（design D13）；secret 变量的值写成占位符而不是
//! 明文（spec: 导出时的 secret 占位符）。

use super::parse::{ParsedCollection, ParsedFolder, ParsedItem, ParsedRequest, ParsedVariable};
use super::secret_placeholder;
use crate::error::{AppError, AppResult};
use crate::secrets::KeyProvider;
use crate::storage::model::{
    ApiKeyLocation, AuthConfig, AuthKind, BodyKind, FormFieldKind, KeyValue, RawLanguage,
    RequestBody, Scope,
};
use crate::storage::workspace::NodeKind;
use crate::storage::{variables as variable_store, workspace, Db};
use serde_json::{json, Map, Value};

const COLLECTION_V21_SCHEMA: &str =
    "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 导出集合为 Postman v2.1 文档文本。
pub fn export_collection(
    db: &Db,
    collection_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<String> {
    let collection = load_collection(db, collection_id, key_provider)?;
    to_json(&collection_document(&collection))
}

/// 导出环境为 Postman Environment 文档文本。
pub fn export_environment(
    db: &Db,
    environment_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<String> {
    let environment = variable_store::get_environment(db, environment_id)?;
    let variables =
        load_variables(db, Scope::Environment, environment_id, key_provider)?;
    to_json(&environment_document(&environment.name, &variables))
}

/// 导出工作区级全局变量为 Postman Globals 文档文本。
pub fn export_globals(
    db: &Db,
    workspace_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<String> {
    workspace::get(db, workspace_id)?;
    let variables = load_variables(db, Scope::Global, workspace_id, key_provider)?;
    to_json(&globals_document(&variables))
}

fn to_json(value: &Value) -> AppResult<String> {
    serde_json::to_string_pretty(value)
        .map_err(|err| AppError::internal(format!("导出序列化失败：{}", err)))
}

// ---------------------------------------------------------------------------
// 存储 → 中间表示
// ---------------------------------------------------------------------------

fn load_collection(
    db: &Db,
    collection_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<ParsedCollection> {
    let collection = workspace::get_collection(db, collection_id)?;
    let tree = workspace::collection_tree(db, collection_id)?;
    let variables = load_variables(db, Scope::Collection, collection_id, key_provider)?;

    let mut children = Vec::with_capacity(tree.children.len());
    for node in &tree.children {
        children.push(load_item(db, node)?);
    }

    Ok(ParsedCollection {
        name: collection.name,
        description: collection.description,
        auth: collection.auth,
        pre_request_script: collection.pre_request_script,
        test_script: collection.test_script,
        variables,
        children,
    })
}

fn load_item(db: &Db, node: &crate::storage::workspace::TreeNode) -> AppResult<ParsedItem> {
    match node.kind {
        NodeKind::Folder => {
            let folder = workspace::get_folder(db, &node.id)?;
            let mut children = Vec::with_capacity(node.children.len());
            for child in &node.children {
                children.push(load_item(db, child)?);
            }
            Ok(ParsedItem::Folder(ParsedFolder {
                name: folder.name,
                description: folder.description,
                auth: folder.auth,
                pre_request_script: folder.pre_request_script,
                test_script: folder.test_script,
                children,
            }))
        }
        NodeKind::Request => {
            let request = node.request.clone().ok_or_else(|| {
                AppError::storage(format!("集合树中的请求节点缺少请求内容：{}", node.id))
            })?;
            Ok(ParsedItem::Request(ParsedRequest {
                name: request.name,
                description: request.description,
                method: request.method,
                url: request.url,
                params: request.params,
                headers: request.headers,
                body: request.body,
                auth: request.auth,
                settings: request.settings,
                pre_request_script: request.pre_request_script,
                test_script: request.test_script,
            }))
        }
    }
}

/// 读取变量并转成导出形态：以当前值写出，secret 以占位符写出。
fn load_variables(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<Vec<ParsedVariable>> {
    let stored = variable_store::list_variables(db, scope, owner_id, key_provider)?;
    Ok(stored
        .into_iter()
        .map(|variable| {
            let value = if variable.is_secret {
                // 明文不进导出结果；占位符让重新导入时仍还原为 secret
                secret_placeholder(&variable.name)
            } else {
                variable.current.plaintext().unwrap_or_default().to_string()
            };
            ParsedVariable {
                name: variable.name,
                value,
                is_secret: variable.is_secret,
                enabled: variable.enabled,
                description: variable.description,
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 中间表示 → 文档
// ---------------------------------------------------------------------------

fn collection_document(collection: &ParsedCollection) -> Value {
    let mut root = Map::new();

    let mut info = Map::new();
    info.insert("name".into(), json!(collection.name));
    if let Some(description) = collection.description.as_ref().filter(|d| !d.is_empty()) {
        info.insert("description".into(), json!(description));
    }
    info.insert("schema".into(), json!(COLLECTION_V21_SCHEMA));
    root.insert("info".into(), Value::Object(info));

    if collection.auth.kind != AuthKind::Inherit {
        root.insert("auth".into(), auth_value(&collection.auth));
    }
    let event = events_value(
        collection.pre_request_script.as_deref(),
        collection.test_script.as_deref(),
    );
    if !event.is_empty() {
        root.insert("event".into(), Value::Array(event));
    }
    if !collection.variables.is_empty() {
        root.insert(
            "variable".into(),
            Value::Array(collection.variables.iter().map(variable_value).collect()),
        );
    }
    root.insert(
        "item".into(),
        Value::Array(collection.children.iter().map(item_value).collect()),
    );

    Value::Object(root)
}

fn environment_document(name: &str, variables: &[ParsedVariable]) -> Value {
    json!({
        "name": name,
        "_postman_variable_scope": "environment",
        "values": variables.iter().map(variable_value).collect::<Vec<_>>(),
    })
}

fn globals_document(variables: &[ParsedVariable]) -> Value {
    json!({
        "_postman_variable_scope": "globals",
        "values": variables.iter().map(variable_value).collect::<Vec<_>>(),
    })
}

fn variable_value(variable: &ParsedVariable) -> Value {
    let mut entry = Map::new();
    entry.insert("key".into(), json!(variable.name));
    entry.insert("value".into(), json!(variable.value));
    // 与环境文档的既有写法一致：只写 `enabled`；读取侧本来就同时容忍 `enabled` 与 `disabled`
    entry.insert("enabled".into(), json!(variable.enabled));
    if let Some(description) = variable.description.as_ref().filter(|text| !text.is_empty()) {
        entry.insert("description".into(), json!(description));
    }
    if variable.is_secret {
        entry.insert("type".into(), json!("secret"));
    }
    Value::Object(entry)
}

fn item_value(item: &ParsedItem) -> Value {
    match item {
        ParsedItem::Folder(folder) => {
            let mut entry = Map::new();
            entry.insert("name".into(), json!(folder.name));
            if let Some(description) = folder.description.as_ref().filter(|d| !d.is_empty()) {
                entry.insert("description".into(), json!(description));
            }
            if folder.auth.kind != AuthKind::Inherit {
                entry.insert("auth".into(), auth_value(&folder.auth));
            }
            let event = events_value(
                folder.pre_request_script.as_deref(),
                folder.test_script.as_deref(),
            );
            if !event.is_empty() {
                entry.insert("event".into(), Value::Array(event));
            }
            entry.insert(
                "item".into(),
                Value::Array(folder.children.iter().map(item_value).collect()),
            );
            Value::Object(entry)
        }
        ParsedItem::Request(request) => {
            let mut body = Map::new();
            body.insert("method".into(), json!(request.method));
            if !request.headers.is_empty() {
                body.insert(
                    "header".into(),
                    Value::Array(request.headers.iter().map(key_value_entry).collect()),
                );
            }
            body.insert("url".into(), url_value(&request.url, &request.params));
            if let Some(value) = body_value(&request.body) {
                body.insert("body".into(), value);
            }
            if request.auth.kind != AuthKind::Inherit {
                body.insert("auth".into(), auth_value(&request.auth));
            }
            if let Some(description) = request.description.as_ref().filter(|d| !d.is_empty()) {
                body.insert("description".into(), json!(description));
            }

            let mut entry = Map::new();
            entry.insert("name".into(), json!(request.name));
            entry.insert("request".into(), Value::Object(body));
            let event = events_value(
                request.pre_request_script.as_deref(),
                request.test_script.as_deref(),
            );
            if !event.is_empty() {
                entry.insert("event".into(), Value::Array(event));
            }
            Value::Object(entry)
        }
    }
}

/// URL 以 `raw` + `query` 数组导出：`raw` 保留原始文本，`query` 数组承载启用标记。
fn url_value(url: &str, params: &[KeyValue]) -> Value {
    json!({
        "raw": url,
        "query": params.iter().map(key_value_entry).collect::<Vec<_>>(),
    })
}

/// 可启用/禁用的键值项：禁用时写 `disabled: true`。
fn key_value_entry(pair: &KeyValue) -> Value {
    let mut entry = Map::new();
    entry.insert("key".into(), json!(pair.key));
    entry.insert("value".into(), json!(pair.value));
    if !pair.enabled {
        entry.insert("disabled".into(), json!(true));
    }
    if let Some(description) = pair.description.as_ref().filter(|d| !d.is_empty()) {
        entry.insert("description".into(), json!(description));
    }
    Value::Object(entry)
}

fn body_value(body: &RequestBody) -> Option<Value> {
    match body.kind {
        BodyKind::None => None,
        BodyKind::Raw => Some(json!({
            "mode": "raw",
            "raw": body.raw.clone().unwrap_or_default(),
            "options": {
                "raw": {
                    "language": raw_language_name(body.raw_language.unwrap_or(RawLanguage::Text))
                }
            }
        })),
        BodyKind::UrlEncoded => Some(json!({
            "mode": "urlencoded",
            "urlencoded": body.urlencoded.iter().map(key_value_entry).collect::<Vec<_>>(),
        })),
        BodyKind::FormData => Some(json!({
            "mode": "formdata",
            "formdata": body.form.iter().map(form_field_value).collect::<Vec<_>>(),
        })),
        BodyKind::Binary => Some(json!({
            "mode": "file",
            // 文件从未被读取，也不写路径：只保留「这是一个二进制正文」这一事实
            "file": { "src": Value::Null },
        })),
    }
}

fn form_field_value(field: &crate::storage::model::FormField) -> Value {
    let mut entry = Map::new();
    entry.insert("key".into(), json!(field.key));
    match field.kind {
        FormFieldKind::Text => {
            entry.insert("type".into(), json!("text"));
            entry.insert("value".into(), json!(field.value.clone().unwrap_or_default()));
        }
        FormFieldKind::File => {
            entry.insert("type".into(), json!("file"));
            entry.insert("src".into(), Value::Null);
            if let Some(description) = field.description.as_ref().filter(|d| !d.is_empty()) {
                entry.insert("description".into(), json!(description));
            }
        }
    }
    if !field.enabled {
        entry.insert("disabled".into(), json!(true));
    }
    Value::Object(entry)
}

fn raw_language_name(language: RawLanguage) -> &'static str {
    match language {
        RawLanguage::Json => "json",
        RawLanguage::Xml => "xml",
        RawLanguage::Html => "html",
        RawLanguage::Text => "text",
        RawLanguage::Javascript => "javascript",
    }
}

fn auth_value(auth: &AuthConfig) -> Value {
    match auth.kind {
        // `Inherit` 不写 auth（缺省即继承），调用方已过滤
        AuthKind::Inherit | AuthKind::None => json!({ "type": "noauth" }),
        AuthKind::Basic => {
            let basic = auth.basic.as_ref();
            json!({
                "type": "basic",
                "basic": [
                    { "key": "username", "value": basic.map(|b| b.username.clone()).unwrap_or_default() },
                    { "key": "password", "value": basic.map(|b| b.password.clone()).unwrap_or_default() },
                ],
            })
        }
        AuthKind::Bearer => {
            let bearer = auth.bearer.as_ref();
            json!({
                "type": "bearer",
                "bearer": [
                    { "key": "token", "value": bearer.map(|b| b.token.clone()).unwrap_or_default() },
                ],
            })
        }
        AuthKind::ApiKey => {
            let api_key = auth.api_key.as_ref();
            json!({
                "type": "apikey",
                "apikey": [
                    { "key": "key", "value": api_key.map(|k| k.key.clone()).unwrap_or_default() },
                    { "key": "value", "value": api_key.map(|k| k.value.clone()).unwrap_or_default() },
                    { "key": "in", "value": match api_key.map(|k| k.location) {
                        Some(ApiKeyLocation::Query) => "query",
                        _ => "header",
                    } },
                ],
            })
        }
    }
}

/// 前后置脚本写成 `event`；`exec` 以行数组承载，与解析侧的换行连接互逆。
fn events_value(pre_request: Option<&str>, test: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(text) = pre_request.filter(|text| !text.trim().is_empty()) {
        out.push(json!({
            "listen": "prerequest",
            "script": { "type": "text/javascript", "exec": text.split('\n').collect::<Vec<_>>() },
        }));
    }
    if let Some(text) = test.filter(|text| !text.trim().is_empty()) {
        out.push(json!({
            "listen": "test",
            "script": { "type": "text/javascript", "exec": text.split('\n').collect::<Vec<_>>() },
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::import::{import_document, ImportSource};
    use crate::interchange::parse::parse_document;
    use crate::secrets::MemoryKeyProvider;
    use crate::storage::variables as var_store;
    use crate::storage::Db;
    use serde_json::json;

    fn key() -> MemoryKeyProvider {
        MemoryKeyProvider::from_bytes([31u8; 32])
    }

    fn workspace_id(db: &Db) -> String {
        workspace::list(db).unwrap().remove(0).id
    }

    /// 导入一份文档并返回新建集合的 id。
    fn seed_collection(db: &Db, workspace_id: &str, document: &str) -> String {
        let parsed = parse_document(document).expect("解析");
        import_document(db, workspace_id, &parsed, &key())
            .expect("导入")
            .collection_id
            .expect("应返回集合 id")
    }

    const SAMPLE: &str = r#"{
        "info": { "name": "往返集合", "schema": "collection/v2.1.0/collection.json",
                  "description": "集合说明" },
        "auth": { "type": "basic", "basic": [
            { "key": "username", "value": "u" }, { "key": "password", "value": "p" } ] },
        "event": [{ "listen": "prerequest", "script": { "exec": ["console.log('集合前置')"] } }],
        "variable": [{ "key": "base", "value": "https://api.test" }],
        "item": [
            { "name": "文件夹", "description": "文件夹说明",
              "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "{{tok}}" }] },
              "event": [{ "listen": "test", "script": { "exec": ["pm.test('文件夹')"] } }],
              "item": [
                { "name": "深层请求", "description": "请求说明",
                  "request": { "method": "POST", "url": "https://api.test/users/:id",
                               "header": [{ "key": "Accept", "value": "application/json" },
                                          { "key": "X-Off", "value": "1", "disabled": true }],
                               "body": { "mode": "raw", "raw": "{\"a\":1}",
                                         "options": { "raw": { "language": "json" } } },
                               "auth": { "type": "apikey", "apikey": [
                                   { "key": "key", "value": "X-Api-Key" },
                                   { "key": "value", "value": "{{k}}" },
                                   { "key": "in", "value": "query" } ] } },
                  "event": [{ "listen": "prerequest", "script": { "exec": ["console.log('请求前置')"] } }] }
              ] },
            { "name": "根请求", "request": { "method": "GET", "url": "https://api.test/health",
                                             "body": { "mode": "urlencoded", "urlencoded": [
                                                 { "key": "a", "value": "1" },
                                                 { "key": "off", "value": "2", "disabled": true } ] } } }
        ]
    }"#;

    // ---- 5.1 集合导出与往返 ----

    #[test]
    fn collection_export_round_trips_without_losing_structure() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let first = import_document(&db, &ws, &parse_document(SAMPLE).expect("解析"), &key())
            .expect("首轮导入");
        let collection_id = first.collection_id.clone().expect("应返回集合 id");
        assert!(
            first.report.is_clean(),
            "首轮导入不应有未预期的降级或丢弃：{:?}",
            first.report
        );

        let exported = export_collection(&db, &collection_id, &key()).expect("导出");

        // 重新导入后再次导出，两次导出应逐字一致（结构不丢）
        let db2 = Db::open_in_memory().expect("打开数据库");
        let ws2 = workspace_id(&db2);
        let second = import_document(
            &db2,
            &ws2,
            &parse_document(&exported).expect("解析导出结果"),
            &key(),
        )
        .expect("重新导入");
        assert!(
            second.report.is_clean(),
            "重新导入不应有未预期的降级或丢弃：{:?}",
            second.report
        );

        let reimported = second.collection_id.clone().expect("应返回集合 id");
        let exported_again = export_collection(&db2, &reimported, &key()).expect("再次导出");

        assert_eq!(exported, exported_again, "往返后结构应完全一致");
    }

    #[test]
    fn exported_document_keeps_requests_auth_scripts_variables_and_bodies() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let collection_id = seed_collection(&db, &ws, SAMPLE);

        let exported = export_collection(&db, &collection_id, &key()).expect("导出");
        let document: Value = serde_json::from_str(&exported).expect("导出结果是合法 JSON");

        assert_eq!(document["info"]["name"], "往返集合");
        assert_eq!(document["info"]["description"], "集合说明");
        assert_eq!(document["info"]["schema"], COLLECTION_V21_SCHEMA);
        assert_eq!(document["auth"]["type"], "basic");
        let events = document["event"].as_array().expect("集合事件存在");
        assert_eq!(events[0]["listen"], "prerequest");

        let variables = document["variable"].as_array().expect("集合变量存在");
        assert_eq!(variables[0]["key"], "base");
        assert_eq!(variables[0]["value"], "https://api.test");

        let items = document["item"].as_array().expect("条目存在");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["name"], "文件夹");
        assert_eq!(items[0]["description"], "文件夹说明");
        assert_eq!(items[0]["auth"]["type"], "bearer");
        assert_eq!(items[0]["event"][0]["listen"], "test");

        let deep = &items[0]["item"][0];
        assert_eq!(deep["name"], "深层请求");
        assert_eq!(deep["request"]["method"], "POST");
        assert_eq!(deep["request"]["url"]["raw"], "https://api.test/users/:id");
        assert_eq!(deep["request"]["auth"]["type"], "apikey");
        assert_eq!(deep["request"]["body"]["mode"], "raw");
        assert_eq!(deep["request"]["body"]["options"]["raw"]["language"], "json");
        // 禁用的头以 disabled 保留
        let headers = deep["request"]["header"].as_array().expect("请求头存在");
        assert_eq!(headers[1]["key"], "X-Off");
        assert_eq!(headers[1]["disabled"], true);

        // 未声明认证的根请求不写出 auth（缺省即继承）
        assert_eq!(items[1]["name"], "根请求");
        assert!(items[1]["request"].get("auth").is_none());
        let urlencoded = items[1]["request"]["body"]["urlencoded"]
            .as_array()
            .expect("表单正文存在");
        assert_eq!(urlencoded[1]["key"], "off");
        assert_eq!(urlencoded[1]["disabled"], true);
    }

    /// 参数、请求头与 urlencoded 字段的描述随导入导出往返
    /// （spec: 键值表的列与描述列——界面上的描述列是这次新开的入口，
    /// 但往返能力在互换层早已存在，这条用例把它钉住，避免以后有人顺手删掉）。
    #[test]
    fn key_value_descriptions_round_trip_through_import_and_export() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        const DOCUMENT: &str = r#"{
            "info": { "name": "描述往返", "schema": "collection/v2.1.0/collection.json" },
            "item": [{
                "name": "带描述的请求",
                "request": {
                    "method": "GET",
                    "url": { "raw": "https://api.test/users?a=1",
                             "query": [{ "key": "a", "value": "1", "description": "查询说明" }] },
                    "header": [{ "key": "Accept", "value": "application/json",
                                 "description": "头说明" }],
                    "body": { "mode": "urlencoded",
                              "urlencoded": [{ "key": "f", "value": "1",
                                               "description": "字段说明" }] }
                }
            }]
        }"#;

        let collection_id = seed_collection(&db, &ws, DOCUMENT);
        let exported = export_collection(&db, &collection_id, &key()).expect("导出");
        let document: Value = serde_json::from_str(&exported).expect("导出结果是合法 JSON");

        let request = &document["item"][0]["request"];
        assert_eq!(request["url"]["query"][0]["description"], "查询说明");
        assert_eq!(request["header"][0]["description"], "头说明");
        assert_eq!(request["body"]["urlencoded"][0]["description"], "字段说明");
    }

    // ---- 5.2 环境与全局变量导出 ----

    #[test]
    fn environment_and_globals_export_reimports_into_the_same_shapes() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let parsed = parse_document(
            &json!({
                "name": "开发环境",
                "_postman_variable_scope": "environment",
                "values": [
                    { "key": "host", "value": "dev.test", "enabled": true },
                    { "key": "off", "value": "2", "enabled": false }
                ]
            })
            .to_string(),
        )
        .expect("解析");
        let environment_id = import_document(&db, &ws, &parsed, &key())
            .expect("导入")
            .environment_id
            .expect("应返回环境 id");

        let exported = export_environment(&db, &environment_id, &key()).expect("导出环境");
        let document: Value = serde_json::from_str(&exported).expect("合法 JSON");
        assert_eq!(document["name"], "开发环境");
        assert_eq!(document["_postman_variable_scope"], "environment");
        let values = document["values"].as_array().expect("变量存在");
        assert_eq!(values.len(), 2, "禁用变量也在库中，因此照常导出并带禁用标记");
        assert_eq!(values[0]["key"], "host");
        assert_eq!(values[0]["value"], "dev.test");
        assert_eq!(values[0]["enabled"], true);
        assert_eq!(values[1]["key"], "off");
        assert_eq!(values[1]["enabled"], false, "禁用状态应写出");

        // 重新导入回同一形状
        let db2 = Db::open_in_memory().expect("打开数据库");
        let ws2 = workspace_id(&db2);
        let reimported = import_document(&db2, &ws2, &parse_document(&exported).unwrap(), &key())
            .expect("重新导入");
        let reimported_id = reimported.environment_id.expect("应有环境");
        let variables =
            var_store::list_variables(&db2, Scope::Environment, &reimported_id, &key()).unwrap();
        assert_eq!(variables.len(), 2);
        assert_eq!(variables[0].name, "host");
        assert_eq!(variables[0].current.plaintext(), Some("dev.test"));
        assert!(!variables[1].enabled, "禁用状态经往返保留");

        // 全局变量
        let globals_parsed = parse_document(
            &json!({
                "_postman_variable_scope": "globals",
                "values": [{ "key": "baseUrl", "value": "https://api.test", "enabled": true }]
            })
            .to_string(),
        )
        .unwrap();
        import_document(&db, &ws, &globals_parsed, &key()).expect("导入全局变量");

        let exported_globals = export_globals(&db, &ws, &key()).expect("导出全局变量");
        let globals_document: Value = serde_json::from_str(&exported_globals).unwrap();
        assert_eq!(globals_document["_postman_variable_scope"], "globals");
        assert_eq!(globals_document["values"][0]["key"], "baseUrl");
    }

    #[test]
    fn disabled_and_duplicated_variables_with_descriptions_survive_a_round_trip() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let environment = var_store::create_environment(&db, &ws, "往返环境").expect("建环境");

        // 同名两条 + 一条禁用 + 一条带描述：三种新性状一起走一遍往返
        var_store::create_variable(
            &db,
            Scope::Environment,
            &environment.id,
            "host",
            "first",
            false,
            None,
            &key(),
        )
        .expect("写入变量");
        var_store::create_variable(
            &db,
            Scope::Environment,
            &environment.id,
            "host",
            "second",
            false,
            Some("靠下的一条"),
            &key(),
        )
        .expect("写入变量");
        // 新增一律是启用的，禁用要显式切一次（spec: 启用状态可以就地切换）
        let off = var_store::create_variable(
            &db,
            Scope::Environment,
            &environment.id,
            "off",
            "never",
            false,
            None,
            &key(),
        )
        .expect("写入变量");
        var_store::update_variable(
            &db,
            &off.id,
            var_store::VariablePatch {
                enabled: Some(false),
                ..Default::default()
            },
            &key(),
        )
        .expect("禁用该变量");

        let exported = export_environment(&db, &environment.id, &key()).expect("导出环境");
        let values = serde_json::from_str::<Value>(&exported).expect("合法 JSON")["values"].clone();
        assert_eq!(
            values.as_array().expect("变量数组").len(),
            3,
            "同名条目与禁用条目都要写出"
        );

        let db2 = Db::open_in_memory().expect("打开数据库");
        let ws2 = workspace_id(&db2);
        let reimported = import_document(&db2, &ws2, &parse_document(&exported).unwrap(), &key())
            .expect("重新导入");
        let id = reimported.environment_id.expect("应有环境");
        let rows = var_store::list_variables(&db2, Scope::Environment, &id, &key()).unwrap();

        assert_eq!(rows.len(), 3, "条目数量一致");
        assert_eq!(
            rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
            ["host", "host", "off"],
            "先后顺序一致"
        );
        assert_eq!(rows[0].current.plaintext(), Some("first"));
        assert_eq!(rows[1].current.plaintext(), Some("second"));
        assert_eq!(rows[1].description.as_deref(), Some("靠下的一条"));
        assert!(!rows[2].enabled, "禁用状态经往返保留");
    }

    // ---- 5.3 secret 占位符 ----

    #[test]
    fn secret_values_are_exported_as_placeholders_only() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let plaintext = "EXPORT_MUST_NOT_LEAK_9001";

        let parsed = parse_document(
            &json!({
                "_postman_variable_scope": "globals",
                "values": [{ "key": "apiKey", "value": plaintext, "enabled": true, "type": "secret" }]
            })
            .to_string(),
        )
        .unwrap();
        import_document(&db, &ws, &parsed, &key()).expect("导入");

        let exported = export_globals(&db, &ws, &key()).expect("导出");
        assert!(
            !exported.contains(plaintext),
            "导出结果不应包含 secret 明文"
        );
        let document: Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(document["values"][0]["type"], "secret");
        assert_eq!(
            document["values"][0]["value"],
            super::super::secret_placeholder("apiKey")
        );
    }

    #[test]
    fn a_reimported_placeholder_is_still_a_secret_variable() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        // 直接导入一份含占位符的文档
        let document = json!({
            "_postman_variable_scope": "globals",
            "values": [{
                "key": "apiKey",
                "value": super::super::secret_placeholder("apiKey"),
                "enabled": true
            }]
        })
        .to_string();

        import_document(&db, &ws, &parse_document(&document).unwrap(), &key()).expect("导入");

        let variables = var_store::list_variables(&db, Scope::Global, &ws, &key()).unwrap();
        assert_eq!(variables.len(), 1);
        assert!(variables[0].is_secret, "占位符应被还原为 secret 变量");
        assert_eq!(
            variables[0].current.plaintext(),
            Some(""),
            "占位符不是真实值，应置空而不是当作明文"
        );
    }

    #[test]
    fn collection_export_uses_the_current_value_of_a_variable() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let collection_id = seed_collection(&db, &ws, SAMPLE);

        let variables =
            var_store::list_variables(&db, Scope::Collection, &collection_id, &key()).unwrap();
        var_store::update_variable_value(
            &db,
            &variables[0].id,
            var_store::ValueField::Current,
            "https://changed.test",
            &key(),
        )
        .expect("改当前值");

        let exported = export_collection(&db, &collection_id, &key()).expect("导出");
        let document: Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(
            document["variable"][0]["value"], "https://changed.test",
            "导出应取当前值"
        );
    }

    #[test]
    fn a_path_string_source_never_reads_a_file_during_export_or_import() {
        // 与导入来源边界呼应：导出同样不接受前端路径（由命令层对话框决定去向）
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let collection_id = seed_collection(&db, &ws, SAMPLE);

        let exported = export_collection(&db, &collection_id, &key()).expect("导出");
        assert!(!exported.contains("/etc/passwd"));

        // `ImportSource` 只有文本与句柄两种形态，路径无法作为来源传入
        let source = ImportSource::Text(exported.clone());
        let uploads = crate::net::uploads::UploadRegistry::new();
        let text = crate::interchange::import::read_source(&source, &uploads).expect("读取");
        assert_eq!(text, exported);
    }
}
