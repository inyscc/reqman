//! 把解析后的文档写入本地存储，以及导入来源的读取。
//!
//! 单份文档一个事务：要么完整生成其全部条目，要么不产生任何条目
//! （spec: 导入的原子性与失败处置）。导入总是新建集合，不按 `_postman_id`
//! 做合并或覆盖（design D10）。

use super::parse::{
    DocumentKind, ParsedCollection, ParsedDocument, ParsedEnvironment, ParsedItem, ParsedPayload,
};
use super::ImportReport;
use crate::error::{AppError, AppResult};
use crate::net::uploads::UploadRegistry;
use crate::secrets::KeyProvider;
use crate::storage::model::{Collection, Folder, SavedRequest, Scope};
use crate::storage::{new_id, requests, variables, workspace, Db};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// 导入来源（design D2）。
///
/// 只有两种来源，且都不允许前端传入任意路径去读取：一段文档文本，或由系统
/// 文件对话框登记的一次性句柄（spec: 导入来源与访问边界）。
#[derive(Debug, Clone)]
pub enum ImportSource {
    Text(String),
    Handle(String),
}

/// 把导入来源解析为文档文本。
pub fn read_source(source: &ImportSource, uploads: &UploadRegistry) -> AppResult<String> {
    match source {
        ImportSource::Text(text) => Ok(text.clone()),
        ImportSource::Handle(handle) => {
            // 句柄一次性消费；路径从不来自前端
            let path = uploads.take(handle)?;
            std::fs::read_to_string(&path)
                .map_err(|err| AppError::invalid_input(format!("所选文件无法作为文本读取：{}", err)))
        }
    }
}

/// 导入结果。`report` 让用户看到本次导入的全部差异（spec: 导入报告）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportOutcome {
    pub kind: DocumentKind,
    pub workspace_id: String,
    /// 导入集合时给出新建集合的 id。
    pub collection_id: Option<String>,
    /// 导入环境时给出新建环境的 id。
    pub environment_id: Option<String>,
    pub report: ImportReport,
}

/// 把一份已解析的文档导入到目标工作区。
pub fn import_document(
    db: &Db,
    workspace_id: &str,
    document: &ParsedDocument,
    key_provider: &dyn KeyProvider,
) -> AppResult<ImportOutcome> {
    // 目标工作区必须存在；不存在时在开事务之前就失败
    workspace::get(db, workspace_id)?;

    let mut outcome = ImportOutcome {
        kind: document.kind,
        workspace_id: workspace_id.to_string(),
        collection_id: None,
        environment_id: None,
        report: document.report.clone(),
    };

    match &document.payload {
        ParsedPayload::Collection(collection) => {
            outcome.collection_id =
                Some(import_collection(db, workspace_id, collection, key_provider)?);
        }
        ParsedPayload::Environment(environment) => {
            outcome.environment_id =
                Some(import_environment(db, workspace_id, environment, key_provider)?);
        }
        ParsedPayload::Globals(globals) => {
            import_globals(db, workspace_id, globals, key_provider)?;
        }
    }

    Ok(outcome)
}

/// 导入集合：集合、递归文件夹、请求与集合变量在同一个事务里落盘。
///
/// 写顺序刻意是「集合 → 条目 → 变量」：最后一步失败时，前面已写入的集合、
/// 文件夹与请求都必须被回滚，不存在半份集合。
fn import_collection(
    db: &Db,
    workspace_id: &str,
    collection: &ParsedCollection,
    key_provider: &dyn KeyProvider,
) -> AppResult<String> {
    let collection_id = new_id();

    db.write_tx(|conn| {
        let tx = conn.transaction()?;

        let sort_order: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM collections WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;

        workspace::insert_collection(
            &tx,
            &Collection {
                id: collection_id.clone(),
                workspace_id: workspace_id.to_string(),
                name: collection.name.clone(),
                description: collection.description.clone(),
                auth: collection.auth.clone(),
                pre_request_script: collection.pre_request_script.clone(),
                test_script: collection.test_script.clone(),
                sort_order,
            },
        )?;

        for (index, item) in collection.children.iter().enumerate() {
            insert_item(&tx, &collection_id, None, index as i64, item)?;
        }

        for variable in &collection.variables {
            variables::insert_variable(
                &tx,
                Scope::Collection,
                &collection_id,
                &variable.name,
                variable.is_secret,
                &variable.value,
                key_provider,
            )?;
        }

        tx.commit()?;
        Ok(())
    })?;

    Ok(collection_id)
}

/// 导入环境：环境与其变量在同一事务里落盘。
fn import_environment(
    db: &Db,
    workspace_id: &str,
    environment: &ParsedEnvironment,
    key_provider: &dyn KeyProvider,
) -> AppResult<String> {
    let environment_id = db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let environment_id = variables::insert_environment(&tx, workspace_id, &environment.name)?;
        for variable in &environment.variables {
            variables::insert_variable(
                &tx,
                Scope::Environment,
                &environment_id,
                &variable.name,
                variable.is_secret,
                &variable.value,
                key_provider,
            )?;
        }
        tx.commit()?;
        Ok(environment_id)
    })?;

    Ok(environment_id)
}

/// 导入全局变量：归属目标工作区，任意集合下均可解析。
fn import_globals(
    db: &Db,
    workspace_id: &str,
    globals: &[super::parse::ParsedVariable],
    key_provider: &dyn KeyProvider,
) -> AppResult<()> {
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        for variable in globals {
            variables::insert_variable(
                &tx,
                Scope::Global,
                workspace_id,
                &variable.name,
                variable.is_secret,
                &variable.value,
                key_provider,
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

fn insert_item(
    conn: &Connection,
    collection_id: &str,
    parent_folder_id: Option<&str>,
    sort_order: i64,
    item: &ParsedItem,
) -> AppResult<()> {
    match item {
        ParsedItem::Folder(folder) => {
            let folder_id = new_id();
            workspace::insert_folder(
                conn,
                &Folder {
                    id: folder_id.clone(),
                    collection_id: collection_id.to_string(),
                    parent_folder_id: parent_folder_id.map(str::to_string),
                    name: folder.name.clone(),
                    description: folder.description.clone(),
                    auth: folder.auth.clone(),
                    pre_request_script: folder.pre_request_script.clone(),
                    test_script: folder.test_script.clone(),
                    sort_order,
                },
            )?;

            for (index, child) in folder.children.iter().enumerate() {
                insert_item(conn, collection_id, Some(&folder_id), index as i64, child)?;
            }
            Ok(())
        }
        ParsedItem::Request(request) => requests::insert_request(
            conn,
            &SavedRequest {
                id: new_id(),
                collection_id: collection_id.to_string(),
                folder_id: parent_folder_id.map(str::to_string),
                name: request.name.clone(),
                description: request.description.clone(),
                method: request.method.clone(),
                url: request.url.clone(),
                params: request.params.clone(),
                headers: request.headers.clone(),
                body: request.body.clone(),
                auth: request.auth.clone(),
                settings: request.settings.clone(),
                pre_request_script: request.pre_request_script.clone(),
                test_script: request.test_script.clone(),
                sort_order,
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interchange::parse::{parse_document, ParsedVariable};
    use crate::secrets::{MemoryKeyProvider, UnavailableKeyProvider};
    use crate::storage::model::{AuthKind, BodyKind};
    use crate::storage::variables as var_store;
    use crate::testutil::TempDir;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn key() -> MemoryKeyProvider {
        MemoryKeyProvider::from_bytes([21u8; 32])
    }

    fn workspace_id(db: &Db) -> String {
        workspace::list(db).unwrap().remove(0).id
    }

    fn import(db: &Db, workspace_id: &str, document: &str) -> ImportOutcome {
        let parsed = parse_document(document).expect("解析");
        import_document(db, workspace_id, &parsed, &key()).expect("导入")
    }

    fn count(db: &Db, table: &str) -> i64 {
        db.read(|conn| {
            Ok(conn.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| row.get(0))?)
        })
        .unwrap()
    }

    const NESTED: &str = r#"{
        "info": { "name": "导入的集合", "schema": "collection/v2.1.0/collection.json",
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
                               "header": [{ "key": "Accept", "value": "application/json" }],
                               "body": { "mode": "raw", "raw": "{\"a\":1}",
                                         "options": { "raw": { "language": "json" } } } },
                  "event": [{ "listen": "prerequest", "script": { "exec": ["console.log('请求前置')"] } }] }
              ] },
            { "name": "根请求", "request": { "method": "GET", "url": "https://api.test/health" } }
        ]
    }"#;

    // ---- 3.1 集合导入 ----

    #[test]
    fn collection_import_reproduces_structure_descriptions_auth_and_scripts() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let outcome = import(&db, &ws, NESTED);

        let collection_id = outcome.collection_id.clone().expect("应返回集合 id");
        assert_eq!(outcome.kind, DocumentKind::CollectionV21);

        let collection = workspace::get_collection(&db, &collection_id).expect("读集合");
        assert_eq!(collection.name, "导入的集合");
        assert_eq!(collection.description.as_deref(), Some("集合说明"));
        assert_eq!(collection.auth.kind, AuthKind::Basic, "集合级认证应落在集合上");
        assert_eq!(
            collection.pre_request_script.as_deref(),
            Some("console.log('集合前置')"),
            "集合级事件应落在集合上"
        );

        let tree = workspace::collection_tree(&db, &collection_id).expect("读树");
        let names: Vec<&str> = tree.children.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["文件夹", "根请求"], "同级顺序应保持");

        let folder_node = &tree.children[0];
        assert_eq!(folder_node.children.len(), 1);

        let folder = workspace::get_folder(&db, &folder_node.id).expect("读文件夹");
        assert_eq!(folder.description.as_deref(), Some("文件夹说明"));
        assert_eq!(folder.auth.kind, AuthKind::Bearer, "文件夹级认证应落在文件夹上");
        assert_eq!(
            folder.test_script.as_deref(),
            Some("pm.test('文件夹')"),
            "文件夹级事件应落在文件夹上"
        );

        let request_node = &folder_node.children[0];
        let request = requests::get_request(&db, &request_node.id).expect("读请求");
        assert_eq!(request.name, "深层请求");
        assert_eq!(request.description.as_deref(), Some("请求说明"));
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.test/users/:id");
        assert_eq!(request.body.kind, BodyKind::Raw);
        assert_eq!(request.headers[0].key, "Accept");
        assert_eq!(
            request.pre_request_script.as_deref(),
            Some("console.log('请求前置')")
        );
        assert_eq!(
            request.auth.kind,
            AuthKind::Inherit,
            "请求未声明认证时应继承上层"
        );

        let collection_variables =
            var_store::list_variables(&db, Scope::Collection, &collection_id, &key())
                .expect("读变量");
        assert_eq!(collection_variables.len(), 1);
        assert_eq!(collection_variables[0].name, "base");

        assert!(
            outcome.report.is_clean(),
            "这份文档应无损映射：{:?}",
            outcome.report
        );
    }

    #[test]
    fn upper_level_auth_applies_to_requests_that_do_not_override_it() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let collection_id = import(&db, &ws, NESTED).collection_id.unwrap();

        let tree = workspace::collection_tree(&db, &collection_id).unwrap();
        let root_request = tree
            .children
            .iter()
            .find(|node| node.name == "根请求")
            .and_then(|node| node.request.as_ref())
            .expect("根请求存在");
        assert_eq!(root_request.auth.kind, AuthKind::Inherit);

        // 继承语义：集合级 basic 在其下未覆盖的请求上生效
        let collection = workspace::get_collection(&db, &collection_id).unwrap();
        let resolved = crate::variables::resolve_request(root_request, &collection.auth, &{
            var_store::load_scope_layers(
                &db,
                &ws,
                Some(&collection_id),
                None,
                BTreeMap::new(),
                BTreeMap::new(),
                &key(),
            )
            .unwrap()
        });
        assert!(
            matches!(resolved.auth, crate::variables::ResolvedAuth::Basic { .. }),
            "继承语义应让根请求取到集合级认证，实际为 {:?}",
            resolved.auth
        );
    }

    // ---- 3.2 环境与全局变量 ----

    #[test]
    fn environment_variables_are_scoped_and_globals_are_workspace_wide() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let environment = import(
            &db,
            &ws,
            &json!({
                "name": "开发环境",
                "_postman_variable_scope": "environment",
                "values": [
                    { "key": "host", "value": "dev.test", "enabled": true },
                    { "key": "token", "value": "SECRET_VALUE_7788", "enabled": true, "type": "secret" }
                ]
            })
            .to_string(),
        );
        let environment_id = environment.environment_id.clone().expect("应返回环境 id");

        import(
            &db,
            &ws,
            &json!({
                "_postman_variable_scope": "globals",
                "values": [{ "key": "baseUrl", "value": "https://api.test", "enabled": true }]
            })
            .to_string(),
        );

        let collection_id = workspace::create_collection(&db, &ws, "集合").unwrap().id;

        let layers = var_store::load_scope_layers(
            &db,
            &ws,
            Some(&collection_id),
            Some(&environment_id),
            BTreeMap::new(),
            BTreeMap::new(),
            &key(),
        )
        .unwrap();
        assert_eq!(layers.lookup("host"), Some("dev.test"));
        assert_eq!(
            layers.lookup("baseUrl"),
            Some("https://api.test"),
            "全局变量应可解析"
        );
        assert_eq!(layers.lookup("token"), Some("SECRET_VALUE_7788"));

        // 其他环境下不可见
        let other = var_store::create_environment(&db, &ws, "其他环境").unwrap();
        let layers = var_store::load_scope_layers(
            &db,
            &ws,
            Some(&collection_id),
            Some(&other.id),
            BTreeMap::new(),
            BTreeMap::new(),
            &key(),
        )
        .unwrap();
        assert_eq!(layers.lookup("host"), None, "环境变量不应外泄到其他环境");

        let variables =
            var_store::list_variables(&db, Scope::Environment, &environment_id, &key())
                .expect("读环境变量");
        let secret = variables
            .iter()
            .find(|variable| variable.name == "token")
            .expect("secret 变量存在");
        assert!(secret.is_secret);
        assert_eq!(secret.current.plaintext(), Some("SECRET_VALUE_7788"));
        assert_eq!(
            secret.initial.plaintext(),
            Some("SECRET_VALUE_7788"),
            "单一值应同时写入初始值与当前值"
        );
    }

    #[test]
    fn secret_variables_are_encrypted_on_disk_after_import() {
        let dir = TempDir::new("import-secret");
        let path = dir.join("reqman.db");
        let plaintext = "IMPORTED_SECRET_5150";

        {
            let db = Db::open(&path).expect("打开数据库");
            let ws = workspace_id(&db);
            import(
                &db,
                &ws,
                &json!({
                    "_postman_variable_scope": "globals",
                    "values": [{ "key": "apiKey", "value": plaintext, "enabled": true, "type": "secret" }]
                })
                .to_string(),
            );
        }

        let bytes = std::fs::read(&path).expect("读取数据库文件");
        assert!(
            !bytes
                .windows(plaintext.len())
                .any(|window| window == plaintext.as_bytes()),
            "导入的 secret 明文不应出现在数据库文件中"
        );
    }

    #[test]
    fn a_single_source_value_fills_both_initial_and_current() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let collection_id = import(&db, &ws, NESTED).collection_id.unwrap();

        let variables =
            var_store::list_variables(&db, Scope::Collection, &collection_id, &key()).unwrap();
        assert_eq!(variables.len(), 1);
        assert_eq!(variables[0].initial.plaintext(), Some("https://api.test"));
        assert_eq!(
            variables[0].current.plaintext(),
            Some("https://api.test"),
            "源文档的单一值应同时写入初始值与当前值"
        );
        assert!(!variables[0].is_secret);
    }

    // ---- 3.3 原子性与失败处置 ----

    #[test]
    fn a_failure_midway_leaves_no_partial_collection() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let parsed = parse_document(NESTED).expect("解析");
        let ParsedPayload::Collection(mut collection) = parsed.payload.clone() else {
            panic!("应为集合");
        };
        // 注入一次写入失败：空白变量名会在写入阶段被拒绝，
        // 此时集合、文件夹与请求都已经写过，必须一并回滚。
        collection.variables.push(ParsedVariable {
            name: "   ".to_string(),
            value: "x".to_string(),
            is_secret: false,
        });
        let broken = ParsedDocument {
            kind: parsed.kind,
            payload: ParsedPayload::Collection(collection),
            report: parsed.report.clone(),
        };

        let err = import_document(&db, &ws, &broken, &key()).expect_err("应失败");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);

        assert!(
            workspace::list_collections(&db, &ws).unwrap().is_empty(),
            "失败的导入不应留下集合"
        );
        assert_eq!(count(&db, "folders"), 0, "失败的导入不应留下文件夹");
        assert_eq!(count(&db, "requests"), 0, "失败的导入不应留下请求");
        assert_eq!(count(&db, "variables"), 0, "失败的导入不应留下变量");
    }

    #[test]
    fn an_invalid_document_is_rejected_without_touching_existing_data() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let existing = workspace::create_collection(&db, &ws, "既有集合").unwrap();

        let err = parse_document("{ 不是 JSON").expect_err("应拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);

        let collections = workspace::list_collections(&db, &ws).unwrap();
        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].id, existing.id);
    }

    #[test]
    fn importing_a_collection_does_not_merge_with_an_existing_one() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let first = import(&db, &ws, NESTED).collection_id.unwrap();
        let second = import(&db, &ws, NESTED).collection_id.unwrap();

        assert_ne!(first, second, "重复导入应新建集合，而不是合并");
        assert_eq!(workspace::list_collections(&db, &ws).unwrap().len(), 2);
    }

    #[test]
    fn importing_into_a_missing_workspace_is_rejected() {
        let db = Db::open_in_memory().expect("打开数据库");
        let parsed = parse_document(NESTED).expect("解析");
        let err = import_document(&db, "nope", &parsed, &key()).expect_err("应拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    // ---- 3.4 禁用变量 ----

    #[test]
    fn disabled_source_variables_are_skipped_and_reported() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);

        let outcome = import(
            &db,
            &ws,
            &json!({
                "name": "环境",
                "_postman_variable_scope": "environment",
                "values": [
                    { "key": "keep", "value": "1", "enabled": true },
                    { "key": "off", "value": "2", "enabled": false }
                ]
            })
            .to_string(),
        );

        let environment_id = outcome.environment_id.unwrap();
        let variables =
            var_store::list_variables(&db, Scope::Environment, &environment_id, &key()).unwrap();
        assert_eq!(variables.len(), 1, "禁用变量不应被导入为启用状态");
        assert_eq!(variables[0].name, "keep");

        assert_eq!(outcome.report.skipped_items.len(), 1);
        assert_eq!(outcome.report.skipped_items[0].name, "off");
    }

    // ---- 3.5 导入来源 ----

    #[test]
    fn both_sources_yield_the_same_import_result() {
        let dir = TempDir::new("import-source");
        let path = dir.join("collection.json");
        std::fs::write(&path, NESTED).expect("写入文档文件");

        // 来源一：粘贴文本
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let uploads = UploadRegistry::new();
        let by_text = read_source(&ImportSource::Text(NESTED.to_string()), &uploads).expect("读取");
        let outcome_text = import(&db, &ws, &by_text);

        // 来源二：文件句柄
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let uploads = UploadRegistry::new();
        let handle = uploads.register(&path).expect("登记文件");
        let by_handle =
            read_source(&ImportSource::Handle(handle), &uploads).expect("从句柄读取");
        assert_eq!(by_text, by_handle, "两种来源应产出同一文档文本");
        let outcome_handle = import(&db, &ws, &by_handle);

        assert_eq!(outcome_text.kind, outcome_handle.kind);
        assert_eq!(outcome_text.report, outcome_handle.report);
    }

    #[test]
    fn an_upload_handle_is_single_use_and_unknown_handles_are_rejected() {
        let dir = TempDir::new("import-handle");
        let path = dir.join("collection.json");
        std::fs::write(&path, NESTED).expect("写入文档文件");

        let uploads = UploadRegistry::new();
        let handle = uploads.register(&path).expect("登记文件");
        read_source(&ImportSource::Handle(handle.clone()), &uploads).expect("首次读取成功");

        let err = read_source(&ImportSource::Handle(handle), &uploads).expect_err("不可重复使用");
        assert_eq!(err.code, crate::error::ErrorCode::UploadHandleConsumed);

        let err = read_source(&ImportSource::Handle("nope".into()), &uploads)
            .expect_err("未知句柄应被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::UploadHandleInvalid);
    }

    #[test]
    fn a_path_string_is_never_treated_as_a_file_to_read() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = workspace_id(&db);
        let uploads = UploadRegistry::new();

        // 把路径当作文档文本传入：只会因「不是合法 JSON」被拒绝，不会被当作路径读取
        let text = read_source(&ImportSource::Text("/etc/passwd".to_string()), &uploads)
            .expect("文本来源原样返回");
        let err = parse_document(&text).expect_err("应因不是 JSON 而被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
        assert!(workspace::list_collections(&db, &ws).unwrap().is_empty());
    }

    // ---- 密钥降级 ----

    #[test]
    fn degraded_key_provider_refuses_secret_import_without_plaintext() {
        let dir = TempDir::new("import-degraded");
        let path = dir.join("reqman.db");
        let plaintext = "NEVER_LAND_3131";

        {
            let db = Db::open(&path).expect("打开数据库");
            let ws = workspace_id(&db);
            let parsed = parse_document(
                &json!({
                    "_postman_variable_scope": "globals",
                    "values": [{ "key": "apiKey", "value": plaintext, "enabled": true, "type": "secret" }]
                })
                .to_string(),
            )
            .expect("解析");

            let err = import_document(&db, &ws, &parsed, &UnavailableKeyProvider)
                .expect_err("应进入降级态");
            assert_eq!(err.code, crate::error::ErrorCode::SecretStoreUnavailable);
            assert_eq!(count(&db, "variables"), 0, "降级态不应写入任何变量");
        }

        let bytes = std::fs::read(&path).expect("读取数据库文件");
        assert!(
            !bytes
                .windows(plaintext.len())
                .any(|window| window == plaintext.as_bytes()),
            "降级态下明文不能落库"
        );
    }
}
