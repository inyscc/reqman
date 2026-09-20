//! 已保存请求的持久化（spec: 请求保存与恢复）。

use super::model::{AuthConfig, Id, RequestBody, RequestSettings, SavedRequest};
use super::{from_json, new_id, now, require_name, to_json, Db};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, Row};

/// 标准方法集（spec: 请求方法）。
pub const STANDARD_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/// 校验并规范化方法名。
///
/// 标准方法统一为大写；自定义方法保留用户写法，但必须是合法的 HTTP token——
/// 这是防止方法名被用来注入请求行的结构性约束。
pub fn normalize_method(method: &str) -> AppResult<String> {
    let trimmed = method.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input("请求方法不能为空"));
    }

    let is_token = trimmed.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
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
    });
    if !is_token {
        return Err(AppError::invalid_input(
            "请求方法只能由 HTTP token 字符组成，且不能包含空白或换行",
        ));
    }

    if let Some(standard) = STANDARD_METHODS
        .iter()
        .find(|m| m.eq_ignore_ascii_case(trimmed))
    {
        return Ok((*standard).to_string());
    }

    Ok(trimmed.to_string())
}

pub(crate) fn request_from_row(row: &Row<'_>) -> rusqlite::Result<SavedRequest> {
    let params_raw: String = row.get("params")?;
    let headers_raw: String = row.get("headers")?;
    let body_raw: String = row.get("body")?;
    let auth_raw: String = row.get("auth")?;
    let settings_raw: String = row.get("settings")?;

    let fallback = |err: AppError| rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(err),
    );

    Ok(SavedRequest {
        id: row.get("id")?,
        collection_id: row.get("collection_id")?,
        folder_id: row.get("folder_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        method: row.get("method")?,
        url: row.get("url")?,
        params: from_json(&params_raw).map_err(fallback)?,
        headers: from_json(&headers_raw).map_err(fallback)?,
        body: from_json(&body_raw).map_err(fallback)?,
        auth: from_json(&auth_raw).map_err(fallback)?,
        settings: from_json(&settings_raw).map_err(fallback)?,
        pre_request_script: row.get("pre_request_script")?,
        test_script: row.get("test_script")?,
        sort_order: row.get("sort_order")?,
    })
}

pub fn list_requests(db: &Db, collection_id: &str) -> AppResult<Vec<SavedRequest>> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM requests WHERE collection_id = ?1 ORDER BY sort_order, name, id",
        )?;
        let rows = stmt.query_map([collection_id], request_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get_request(db: &Db, id: &str) -> AppResult<SavedRequest> {
    db.read(|conn| {
        conn.query_row("SELECT * FROM requests WHERE id = ?1", [id], request_from_row)
            .map_err(AppError::from)
    })
}

pub fn create_request(
    db: &Db,
    collection_id: &str,
    folder_id: Option<&str>,
    name: &str,
    method: &str,
    url: &str,
) -> AppResult<SavedRequest> {
    let name = require_name(name)?;
    let method = normalize_method(method)?;
    super::workspace::get_collection(db, collection_id)?;
    if let Some(folder_id) = folder_id {
        let folder = super::workspace::get_folder(db, folder_id)?;
        if folder.collection_id != collection_id {
            return Err(AppError::invalid_input("文件夹不属于该集合"));
        }
    }

    let mut request = SavedRequest {
        id: new_id(),
        collection_id: collection_id.to_string(),
        folder_id: folder_id.map(|s| s.to_string()),
        name,
        description: None,
        method,
        url: url.to_string(),
        params: Vec::new(),
        headers: Vec::new(),
        body: RequestBody::default(),
        auth: AuthConfig::default(),
        settings: RequestSettings::default(),
        pre_request_script: None,
        test_script: None,
        sort_order: 0,
    };

    request.sort_order = db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM requests
             WHERE collection_id = ?1 AND folder_id IS ?2",
            params![collection_id, folder_id],
            |row| row.get(0),
        )?;
        let mut to_insert = request.clone();
        to_insert.sort_order = next;
        insert_request(&tx, &to_insert)?;
        tx.commit()?;
        Ok(next)
    })?;

    Ok(request)
}

/// 以显式字段插入一条请求。
///
/// 创建、副本与导入共用同一条写入路径；导入需要在**单个**事务内写入整份文档，
/// 因此这里接受任意 `Connection`（spec: 导入的原子性与失败处置）。
pub(crate) fn insert_request(conn: &Connection, request: &SavedRequest) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO requests
            (id, collection_id, folder_id, name, description, method, url, params, headers,
             body, auth, settings, pre_request_script, test_script, sort_order,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)",
        params![
            request.id,
            request.collection_id,
            request.folder_id,
            request.name,
            request.description,
            request.method,
            request.url,
            to_json(&request.params)?,
            to_json(&request.headers)?,
            to_json(&request.body)?,
            to_json(&request.auth)?,
            to_json(&request.settings)?,
            request.pre_request_script,
            request.test_script,
            request.sort_order,
            ts,
        ],
    )?;
    Ok(())
}

/// 全量保存（显式保存与自动保存共用同一入口）。
pub fn save_request(db: &Db, request: &SavedRequest) -> AppResult<SavedRequest> {
    let name = require_name(&request.name)?;
    let method = normalize_method(&request.method)?;

    let mut to_save = request.clone();
    to_save.name = name;
    to_save.method = method;

    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE requests SET
                name = ?2, description = ?3, method = ?4, url = ?5, params = ?6, headers = ?7,
                body = ?8, auth = ?9, settings = ?10, pre_request_script = ?11,
                test_script = ?12, folder_id = ?13, updated_at = ?14
             WHERE id = ?1",
            params![
                to_save.id,
                to_save.name,
                to_save.description,
                to_save.method,
                to_save.url,
                to_json(&to_save.params)?,
                to_json(&to_save.headers)?,
                to_json(&to_save.body)?,
                to_json(&to_save.auth)?,
                to_json(&to_save.settings)?,
                to_save.pre_request_script,
                to_save.test_script,
                to_save.folder_id,
                now(),
            ],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("请求不存在：{}", to_save.id)));
        }
        Ok(())
    })?;

    get_request(db, &to_save.id)
}

/// 另存为副本：生成一条独立的新请求。
pub fn duplicate_request(db: &Db, id: &str, new_name: Option<&str>) -> AppResult<SavedRequest> {
    let source = get_request(db, id)?;
    let name = match new_name {
        Some(name) => require_name(name)?,
        None => format!("{} 副本", source.name),
    };

    let copied = SavedRequest {
        id: new_id(),
        name,
        ..source
    };

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM requests
             WHERE collection_id = ?1 AND folder_id IS ?2",
            params![copied.collection_id, copied.folder_id],
            |row| row.get(0),
        )?;
        let mut to_insert = copied.clone();
        to_insert.sort_order = next;
        insert_request(&tx, &to_insert)?;
        tx.commit()?;
        Ok(())
    })?;

    let mut saved = copied;
    saved.sort_order = db.read(|conn| {
        conn.query_row(
            "SELECT sort_order FROM requests WHERE id = ?1",
            [&saved.id],
            |row| row.get(0),
        )
        .map_err(AppError::from)
    })?;
    Ok(saved)
}

pub fn rename_request(db: &Db, id: &str, name: &str) -> AppResult<SavedRequest> {
    let name = require_name(name)?;
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE requests SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("请求不存在：{}", id)));
        }
        Ok(())
    })?;
    get_request(db, id)
}

pub fn delete_request(db: &Db, id: &str) -> AppResult<()> {
    db.write(|conn| {
        let changed = conn.execute("DELETE FROM requests WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("请求不存在：{}", id)));
        }
        Ok(())
    })
}

pub fn move_request(db: &Db, id: &str, folder_id: Option<&str>) -> AppResult<SavedRequest> {
    let request = get_request(db, id)?;
    if let Some(folder_id) = folder_id {
        let folder = super::workspace::get_folder(db, folder_id)?;
        if folder.collection_id != request.collection_id {
            return Err(AppError::invalid_input("文件夹不属于该请求所在的集合"));
        }
    }

    let next: i64 = db.read(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM requests
             WHERE collection_id = ?1 AND folder_id IS ?2",
            params![request.collection_id, folder_id],
            |row| row.get(0),
        )
        .map_err(AppError::from)
    })?;

    db.write(|conn| {
        conn.execute(
            "UPDATE requests SET folder_id = ?2, sort_order = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, folder_id, next, now()],
        )?;
        Ok(())
    })?;

    get_request(db, id)
}

/// 集合内请求 id 列表（供顺序调整使用）。
pub fn request_ids(db: &Db, collection_id: &str) -> AppResult<Vec<Id>> {
    Ok(list_requests(db, collection_id)?
        .into_iter()
        .map(|r| r.id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::model::{
        ApiKeyLocation, BodyKind, KeyValue, RawLanguage, RequestBody, ResponseFormatOverride,
    };
    use crate::error::ErrorCode;
    use crate::storage::{variables, workspace, Db};
    use crate::testutil::TempDir;

    fn setup(db: &Db) -> String {
        let ws = workspace::list(db).unwrap().remove(0);
        workspace::create_collection(db, &ws.id, "集合").unwrap().id
    }

    #[test]
    fn request_roundtrips_all_fields_through_reopen() {
        let dir = TempDir::new("req-roundtrip");
        let path = dir.join("reqman.db");

        let collection_id = {
            let db = Db::open(&path).expect("打开数据库");
            let collection_id = setup(&db);

            let mut request =
                create_request(&db, &collection_id, None, "全部字段", "post", "https://api.test/v1/users")
                    .expect("创建请求");

            request.params = vec![
                KeyValue::new("page", "1"),
                KeyValue {
                    key: "disabled".into(),
                    value: "x".into(),
                    enabled: false,
                    description: None,
                },
            ];
            request.headers = vec![
                KeyValue::new("Accept", "application/json"),
                KeyValue {
                    key: "X-Off".into(),
                    value: "1".into(),
                    enabled: false,
                    description: None,
                },
            ];
            request.body = RequestBody::raw("{\"hello\":\"world\"}", RawLanguage::Json);
            request.auth = AuthConfig::api_key("X-Api-Key", "{{apiKey}}", ApiKeyLocation::Header);
            request.settings = RequestSettings {
                timeout_ms: Some(1500),
                verify_tls: false,
                // 响应格式的请求级覆盖也随请求往返（spec: ui-layout「请求级响应格式覆盖」）
                response_format: ResponseFormatOverride::Json,
                ..RequestSettings::default()
            };
            request.pre_request_script = Some("console.log('pre')".into());
            request.test_script = Some("pm.test('ok', () => {})".into());
            request.description = Some("请求说明".into());

            let saved = save_request(&db, &request).expect("保存请求");
            assert_eq!(saved.method, "POST", "标准方法应统一为大写");
            collection_id
        };

        let db = Db::open(&path).expect("重开数据库");
        let list = list_requests(&db, &collection_id).expect("列出请求");
        assert_eq!(list.len(), 1);
        let restored = &list[0];

        assert_eq!(restored.name, "全部字段");
        assert_eq!(restored.description.as_deref(), Some("请求说明"));
        assert_eq!(restored.method, "POST");
        assert_eq!(restored.url, "https://api.test/v1/users");
        assert_eq!(restored.params.len(), 2);
        assert_eq!(restored.params[1].key, "disabled");
        assert!(!restored.params[1].enabled, "启用标记应保留");
        assert_eq!(restored.headers[0].key, "Accept");
        assert!(!restored.headers[1].enabled);
        assert_eq!(restored.body.kind, BodyKind::Raw);
        assert_eq!(restored.body.raw.as_deref(), Some("{\"hello\":\"world\"}"));
        assert_eq!(restored.body.raw_language, Some(RawLanguage::Json));
        assert_eq!(
            restored.auth.api_key.as_ref().unwrap().location,
            ApiKeyLocation::Header
        );
        assert_eq!(restored.settings.timeout_ms, Some(1500));
        assert!(!restored.settings.verify_tls);
        assert_eq!(
            restored.settings.response_format,
            ResponseFormatOverride::Json
        );
        assert_eq!(restored.pre_request_script.as_deref(), Some("console.log('pre')"));
        assert_eq!(
            restored.test_script.as_deref(),
            Some("pm.test('ok', () => {})")
        );
    }

    #[test]
    fn duplicate_creates_an_independent_copy() {
        let db = Db::open_in_memory().expect("打开数据库");
        let collection_id = setup(&db);

        let mut original =
            create_request(&db, &collection_id, None, "原始", "GET", "https://a.test").unwrap();
        original.headers = vec![KeyValue::new("X-Trace", "1")];
        save_request(&db, &original).unwrap();

        let copy = duplicate_request(&db, &original.id, None).expect("另存为");
        assert_ne!(copy.id, original.id);
        assert_eq!(copy.name, "原始 副本");

        // 修改副本不应影响原件
        let mut edited = copy.clone();
        edited.name = "改名后的副本".into();
        edited.url = "https://changed.test".into();
        save_request(&db, &edited).unwrap();

        let reloaded_original = get_request(&db, &original.id).unwrap();
        assert_eq!(reloaded_original.name, "原始");
        assert_eq!(reloaded_original.url, "https://a.test");
        assert_eq!(reloaded_original.headers.len(), 1);

        assert_eq!(list_requests(&db, &collection_id).unwrap().len(), 2);
    }

    #[test]
    fn custom_methods_are_accepted_but_injection_is_rejected() {
        assert_eq!(normalize_method("GET").unwrap(), "GET");
        assert_eq!(normalize_method("delete").unwrap(), "DELETE");
        assert_eq!(normalize_method("PROPFIND").unwrap(), "PROPFIND");
        assert_eq!(normalize_method("Purge").unwrap(), "Purge", "自定义方法保留原写法");

        for bad in ["", "   ", "GET POST", "GET\r\nX: 1", "GÉT"] {
            let err = normalize_method(bad).expect_err("应拒绝");
            assert_eq!(err.code, ErrorCode::InvalidInput, "输入 {:?} 应被拒绝", bad);
        }
    }

    #[test]
    fn missing_request_reports_not_found() {
        let db = Db::open_in_memory().expect("打开数据库");
        let err = get_request(&db, "nope").expect_err("应报不存在");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn moving_a_request_moves_it_between_folders() {
        let db = Db::open_in_memory().expect("打开数据库");
        let collection_id = setup(&db);
        let folder = workspace::create_folder(&db, &collection_id, None, "目标文件夹").unwrap();
        let request =
            create_request(&db, &collection_id, None, "请求", "GET", "https://a.test").unwrap();

        let moved = move_request(&db, &request.id, Some(&folder.id)).expect("移动请求");
        assert_eq!(moved.folder_id.as_deref(), Some(folder.id.as_str()));

        let tree = workspace::collection_tree(&db, &collection_id).unwrap();
        let folder_node = tree
            .children
            .iter()
            .find(|n| n.name == "目标文件夹")
            .expect("文件夹存在");
        assert_eq!(folder_node.children.len(), 1);
    }

    #[test]
    fn environment_variables_are_scoped_to_their_workspace() {
        let db = Db::open_in_memory().expect("打开数据库");
        let a = workspace::list(&db).unwrap().remove(0);
        let b = workspace::create(&db, "另一个工作区").unwrap();

        let env = variables::create_environment(&db, &a.id, "开发环境").expect("创建环境");

        let visible_in_a = variables::list_environments(&db, &a.id).unwrap();
        let visible_in_b = variables::list_environments(&db, &b.id).unwrap();

        assert_eq!(visible_in_a.len(), 1);
        assert_eq!(visible_in_a[0].id, env.id);
        assert!(visible_in_b.is_empty(), "环境不应出现在其他工作区");
    }
}
