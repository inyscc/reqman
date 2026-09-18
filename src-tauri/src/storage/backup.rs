//! 数据备份导出与恢复（spec: 数据备份与恢复）。

use super::Db;
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::time::Duration;

/// 校验一个文件是本应用的数据库。
///
/// 只检查结构性事实（能否打开、是否含 `workspaces` 表），避免把一个无关的
/// SQLite 文件当成备份灌进当前库。
pub fn ensure_app_database(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::invalid_input(format!(
            "文件不存在：{}",
            path.display()
        )));
    }

    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| AppError::invalid_input(format!("无法读取该文件：{}", err)))?;

    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='workspaces'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| AppError::invalid_input(format!("该文件不是本应用的数据库：{}", err)))?;

    if found == 0 {
        return Err(AppError::invalid_input(
            "该文件不是本应用的数据库（缺少 workspaces 表）",
        ));
    }
    Ok(())
}

/// 把当前数据导出为可恢复副本。
pub fn export(db: &Db, destination: &Path) -> AppResult<()> {
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    if destination.exists() {
        std::fs::remove_file(destination)?;
    }

    let mut target = Connection::open(destination)?;
    db.read(|source| {
        let backup = rusqlite::backup::Backup::new(source, &mut target)?;
        backup.run_to_completion(64, Duration::from_millis(0), None)?;
        Ok(())
    })?;

    // 导出物必须自身可用
    ensure_app_database(destination)?;
    crate::logging::global().info("backup exported");
    Ok(())
}

/// 从备份恢复。
pub fn restore(db: &Db, source: &Path) -> AppResult<()> {
    ensure_app_database(source)?;
    db.replace_contents_with(source)?;
    // 恢复后重新保证不变量（至少一个工作区、存在活动工作区）
    super::workspace::ensure_default_workspace(db)?;
    crate::logging::global().info("backup restored");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::secrets::MemoryKeyProvider;
    use crate::storage::model::{ProxyConfig, Scope};
    use crate::storage::{requests, variables, workspace, Db};
    use crate::testutil::TempDir;

    struct Snapshot {
        workspaces: usize,
        collections: Vec<String>,
        requests: Vec<(String, String)>,
        environments: Vec<String>,
        variables: Vec<(String, String)>,
    }

    fn snapshot(db: &Db, workspace_id: &str, key: &MemoryKeyProvider) -> Snapshot {
        let collections = workspace::list_collections(db, workspace_id).expect("列出集合");
        let mut all_requests = Vec::new();
        for collection in &collections {
            for request in requests::list_requests(db, &collection.id).expect("列出请求") {
                all_requests.push((request.name.clone(), request.url.clone()));
            }
        }
        all_requests.sort();

        let environments = variables::list_environments(db, workspace_id)
            .expect("列出环境")
            .into_iter()
            .map(|e| e.name)
            .collect();

        let mut all_variables: Vec<(String, String)> =
            variables::list_globals(db, workspace_id, key)
                .expect("列出全局变量")
                .into_iter()
                .map(|v| (v.name, v.current.plaintext().unwrap_or_default().to_string()))
                .collect();
        for environment in variables::list_environments(db, workspace_id).unwrap() {
            for variable in
                variables::list_variables(db, Scope::Environment, &environment.id, key).unwrap()
            {
                all_variables.push((
                    format!("env:{}", variable.name),
                    variable.current.plaintext().unwrap_or_default().to_string(),
                ));
            }
        }
        all_variables.sort();

        Snapshot {
            workspaces: workspace::list(db).expect("列出工作区").len(),
            collections: collections.into_iter().map(|c| c.name).collect(),
            requests: all_requests,
            environments,
            variables: all_variables,
        }
    }

    fn populate(db: &Db, key: &MemoryKeyProvider) -> String {
        let workspace_id = workspace::list(db).unwrap().remove(0).id;
        let collection = workspace::create_collection(db, &workspace_id, "集合").unwrap();
        let folder = workspace::create_folder(db, &collection.id, None, "文件夹").unwrap();
        requests::create_request(
            db,
            &collection.id,
            Some(&folder.id),
            "请求一",
            "GET",
            "https://a.test/1",
        )
        .unwrap();
        requests::create_request(db, &collection.id, None, "请求二", "POST", "https://a.test/2")
            .unwrap();

        let env = variables::create_environment(db, &workspace_id, "开发环境").unwrap();
        variables::upsert_variable(
            db,
            Scope::Environment,
            &env.id,
            "host",
            false,
            Some("dev.test"),
            Some("dev.test"),
            key,
        )
        .unwrap();
        variables::set_global(db, &workspace_id, "baseUrl", "https://base.test", false, key).unwrap();
        variables::set_global_proxy(db, Some(ProxyConfig::manual("http://127.0.0.1:8080"))).unwrap();

        workspace_id
    }

    #[test]
    fn export_then_restore_roundtrips_everything() {
        let dir = TempDir::new("backup-roundtrip");
        let db_path = dir.join("reqman.db");
        let backup_path = dir.join("backup.db");
        let key = MemoryKeyProvider::from_bytes([21u8; 32]);

        let db = Db::open(&db_path).expect("打开数据库");
        let workspace_id = populate(&db, &key);
        let before = snapshot(&db, &workspace_id, &key);

        export(&db, &backup_path).expect("导出备份");
        assert!(backup_path.exists());
        assert_eq!(before.workspaces, 1);

        // 清空本地数据
        for collection in workspace::list_collections(&db, &workspace_id).unwrap() {
            workspace::delete_collection(&db, &collection.id).unwrap();
        }
        for environment in variables::list_environments(&db, &workspace_id).unwrap() {
            variables::delete_environment(&db, &environment.id).unwrap();
        }
        variables::set_global_proxy(&db, None).unwrap();

        let cleared = snapshot(&db, &workspace_id, &key);
        assert!(cleared.collections.is_empty(), "本地数据应已清空");
        assert!(cleared.requests.is_empty());
        assert!(cleared.environments.is_empty());

        // 恢复
        restore(&db, &backup_path).expect("恢复备份");
        let after = snapshot(&db, &workspace_id, &key);

        assert_eq!(after.workspaces, before.workspaces);
        assert_eq!(after.collections, before.collections);
        assert_eq!(after.requests, before.requests);
        assert_eq!(after.environments, before.environments);
        assert_eq!(after.variables, before.variables);
        assert!(
            variables::global_proxy(&db).unwrap().is_some(),
            "全局代理配置应随备份恢复"
        );
    }

    #[test]
    fn restoring_a_foreign_file_is_rejected() {
        let dir = TempDir::new("backup-foreign");
        let db_path = dir.join("reqman.db");
        let foreign = dir.join("foreign.db");
        let key = MemoryKeyProvider::new();

        let db = Db::open(&db_path).expect("打开数据库");
        populate(&db, &key);

        // 造一个无关的 SQLite 文件
        let other = Connection::open(&foreign).unwrap();
        other
            .execute("CREATE TABLE unrelated (x INTEGER)", [])
            .unwrap();
        drop(other);

        let err = restore(&db, &foreign).expect_err("应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);

        // 原数据未被破坏
        let workspace_id = workspace::list(&db).unwrap().remove(0).id;
        assert_eq!(
            workspace::list_collections(&db, &workspace_id).unwrap().len(),
            1
        );
    }

    #[test]
    fn cookies_roundtrip_through_backup_and_still_match() {
        use crate::net::cookies::CookieJar;
        use crate::storage::cookies::{self, CookieRow};

        let dir = TempDir::new("backup-cookies");
        let source_path = dir.join("reqman.db");
        let backup_path = dir.join("backup.db");
        let key = MemoryKeyProvider::from_bytes([41u8; 32]);

        let source = Db::open(&source_path).expect("打开数据库");
        let row = CookieRow {
            name: "sid".into(),
            domain: "api.test".into(),
            path: "/".into(),
            host_only: true,
            value: "BACKUP_COOKIE_42".into(),
            secure: false,
            http_only: false,
            expires_at: Some(4_102_444_800),
        };
        cookies::put_row(&source, &key, &row).expect("写入 Cookie");
        export(&source, &backup_path).expect("导出备份");

        // 备份文件里检索不到 Cookie 明文
        let raw = std::fs::read(&backup_path).expect("读取备份文件");
        assert!(
            !raw.windows(row.value.len()).any(|w| w == row.value.as_bytes()),
            "备份文件不应含 Cookie 明文"
        );

        // 恢复到全新数据库
        let target = Db::open(dir.join("restored.db")).expect("打开恢复目标");
        restore(&target, &backup_path).expect("恢复备份");

        let rows = cookies::list_rows(&target, &key).expect("列出");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value, "BACKUP_COOKIE_42");
        assert_eq!(rows[0].domain, "api.test");
        assert_eq!(rows[0].expires_at, row.expires_at);

        // 恢复后的 Cookie 仍可用于匹配请求
        let jar = CookieJar::new();
        jar.load_from_db(&target, &key).expect("装载");
        assert_eq!(
            jar.matches_for_url("http://api.test/x"),
            vec![("sid".to_string(), "BACKUP_COOKIE_42".to_string())]
        );
    }

    #[test]
    fn restored_secrets_are_readable_with_the_same_key_and_flagged_otherwise() {
        let dir = TempDir::new("backup-secret");
        let db_path = dir.join("reqman.db");
        let backup_path = dir.join("backup.db");
        let key = MemoryKeyProvider::from_bytes([31u8; 32]);
        let plaintext = "RESTORED_SECRET_5150";

        let workspace_id = {
            let source = Db::open(&db_path).expect("打开数据库");
            let workspace_id = workspace::list(&source).unwrap().remove(0).id;
            variables::set_global(&source, &workspace_id, "apiKey", plaintext, true, &key)
                .expect("写入 secret 变量");
            export(&source, &backup_path).expect("导出备份");
            workspace_id
        };

        // 备份文件本身不含明文
        let raw = std::fs::read(&backup_path).expect("读取备份文件");
        assert!(
            !raw.windows(plaintext.len()).any(|window| window == plaintext.as_bytes()),
            "备份文件里不应出现 secret 明文"
        );

        // 同一把设备密钥：恢复后可读
        let target_path = dir.join("restored.db");
        let target = Db::open(&target_path).expect("打开数据库");
        restore(&target, &backup_path).expect("恢复备份");

        let globals = variables::list_globals(&target, &workspace_id, &key).expect("列出变量");
        assert_eq!(globals.len(), 1);
        assert_eq!(globals[0].current.plaintext(), Some(plaintext));

        // 另一把设备密钥：明确标记为不可读，而不是给出空值
        let other_key = MemoryKeyProvider::from_bytes([32u8; 32]);
        let globals =
            variables::list_globals(&target, &workspace_id, &other_key).expect("列出变量");
        assert!(
            globals[0].current.is_unreadable(),
            "换设备密钥后应显示不可读"
        );
        assert!(globals[0].current.plaintext().is_none());
    }

    #[test]
    fn export_to_missing_directory_is_created() {
        let dir = TempDir::new("backup-mkdir");
        let db_path = dir.join("reqman.db");
        let backup_path = dir.join("nested").join("deep").join("backup.db");

        let db = Db::open(&db_path).expect("打开数据库");
        export(&db, &backup_path).expect("导出备份");
        assert!(backup_path.exists());
    }
}
