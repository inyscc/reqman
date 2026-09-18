//! schema 版本迁移（design.md D4）。
//!
//! `PRAGMA user_version` 记录版本；迁移步骤按序、每步一个事务；开始迁移前把
//! 数据库文件复制一份留在同目录，成功后才清理。任一步失败则事务回滚、保留
//! 备份、报出原因，绝不留下半迁移状态。

use crate::error::{AppError, AppResult, ErrorCode};
use rusqlite::Connection;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// 初始 schema（版本 1）。
pub const INITIAL_SCHEMA: &str = r#"
CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE collections (
    id                  TEXT PRIMARY KEY,
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    auth                TEXT NOT NULL DEFAULT '{"kind":"inherit"}',
    pre_request_script  TEXT,
    test_script         TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX idx_collections_workspace ON collections(workspace_id, sort_order);

CREATE TABLE folders (
    id                  TEXT PRIMARY KEY,
    collection_id       TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    parent_folder_id    TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    auth                TEXT NOT NULL DEFAULT '{"kind":"inherit"}',
    pre_request_script  TEXT,
    test_script         TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX idx_folders_parent ON folders(collection_id, parent_folder_id, sort_order);

CREATE TABLE requests (
    id                  TEXT PRIMARY KEY,
    collection_id       TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    folder_id           TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    method              TEXT NOT NULL DEFAULT 'GET',
    url                 TEXT NOT NULL DEFAULT '',
    params              TEXT NOT NULL DEFAULT '[]',
    headers             TEXT NOT NULL DEFAULT '[]',
    body                TEXT NOT NULL DEFAULT '{"kind":"none"}',
    auth                TEXT NOT NULL DEFAULT '{"kind":"inherit"}',
    settings            TEXT NOT NULL DEFAULT '{}',
    pre_request_script  TEXT,
    test_script         TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX idx_requests_place ON requests(collection_id, folder_id, sort_order);

CREATE TABLE environments (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 0,
    proxy        TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX idx_environments_workspace ON environments(workspace_id, sort_order);

CREATE TABLE variables (
    id                TEXT PRIMARY KEY,
    scope             TEXT NOT NULL,
    owner_id          TEXT NOT NULL,
    name              TEXT NOT NULL,
    initial_value     TEXT,
    current_value     TEXT,
    is_secret         INTEGER NOT NULL DEFAULT 0,
    initial_readable  INTEGER NOT NULL DEFAULT 1,
    current_readable  INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE(scope, owner_id, name)
);
CREATE INDEX idx_variables_owner ON variables(scope, owner_id);

CREATE TABLE settings (
    scope       TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
"#;

/// 版本 2：为集合、文件夹与请求补上可选描述。
///
/// Postman 的条目普遍携带描述，模型不补这一列会导致往返丢结构
/// （openspec/changes/add-postman-io，spec: 条目描述持久化）。
pub const ADD_DESCRIPTIONS: &str = r#"
ALTER TABLE collections ADD COLUMN description TEXT;
ALTER TABLE folders ADD COLUMN description TEXT;
ALTER TABLE requests ADD COLUMN description TEXT;
"#;

/// 版本 3：Cookie 存储（openspec/changes/add-pm-script-runtime，spec: Cookie 的持久化与加密）。
///
/// 明文列只有 `name` / `domain` / `path` / 属性标记——这些是路由信息，不属于机密，
/// 手动管理界面靠它们分组呈现。**取值**连同属性行以 AEAD 加密存放在 `payload_enc`
/// （加密由调用方完成，本表只存密文），数据库文件与备份中检索不到 Cookie 明文。
///
/// `host_only` 参与唯一键：同一 host 字符串在「仅该主机」与「含子域」两种解释下
/// 是两个不同的 Cookie，不能互相覆盖。`expires_at` 为 Unix 秒；NULL 表示会话
/// Cookie，仅存活于应用运行期，不参与落库同步。
pub const ADD_COOKIES: &str = r#"
CREATE TABLE cookies (
    id          TEXT PRIMARY KEY,
    name        TEXT    NOT NULL,
    domain      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    host_only   INTEGER NOT NULL DEFAULT 1,
    value_enc   TEXT    NOT NULL,
    secure      INTEGER NOT NULL DEFAULT 0,
    http_only   INTEGER NOT NULL DEFAULT 0,
    expires_at  INTEGER,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE(name, domain, path, host_only)
);
CREATE INDEX idx_cookies_domain ON cookies(domain);
"#;

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        sql: INITIAL_SCHEMA,
    },
    Migration {
        version: 2,
        name: "add_descriptions",
        sql: ADD_DESCRIPTIONS,
    },
    Migration {
        version: 3,
        name: "add_cookies",
        sql: ADD_COOKIES,
    },
];

/// 当前代码期望的 schema 版本。
pub const LATEST_VERSION: i64 = 3;

/// 迁移前备份文件的位置。
pub fn backup_path_for(db_path: &Path) -> PathBuf {
    let mut name: OsString = db_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| OsString::from("reqman.db"));
    name.push(".premigration.bak");
    db_path.with_file_name(name)
}

pub fn current_version(conn: &Connection) -> AppResult<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(AppError::from)
}

/// 按序应用待执行的迁移步骤，返回迁移后的版本号。
///
/// `db_path` 为 `None` 时不落备份（内存库没有文件可备份）。
pub fn migrate(
    conn: &mut Connection,
    db_path: Option<&Path>,
    steps: &[Migration],
) -> AppResult<i64> {
    let from = current_version(conn)?;

    let mut pending: Vec<&Migration> = steps.iter().filter(|m| m.version > from).collect();
    pending.sort_by_key(|m| m.version);

    if pending.is_empty() {
        return Ok(from);
    }

    // 迁移前留副本：没有副本就不迁移。
    let backup = match db_path {
        Some(path) if path.exists() => {
            let target = backup_path_for(path);
            std::fs::copy(path, &target).map_err(|err| {
                AppError::new(
                    ErrorCode::MigrationFailed,
                    format!("迁移前备份失败，已中止迁移：{}", err),
                )
            })?;
            Some(target)
        }
        _ => None,
    };

    for step in &pending {
        let result = apply_step(conn, step);
        if let Err(err) = result {
            // 事务已回滚；保留备份以便人工排查。
            return Err(AppError::new(
                ErrorCode::MigrationFailed,
                format!("迁移步骤 {}（{}）失败：{}", step.version, step.name, err),
            ));
        }
    }

    if let Some(path) = backup {
        let _ = std::fs::remove_file(path);
    }

    current_version(conn)
}

fn apply_step(conn: &mut Connection, step: &Migration) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(step.sql)?;
    tx.pragma_update(None, "user_version", step.version)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn open_file_db(dir: &TempDir) -> (PathBuf, Connection) {
        let path = dir.join("reqman.db");
        let conn = Connection::open(&path).expect("打开数据库");
        (path, conn)
    }

    #[test]
    fn applies_pending_steps_in_order() {
        let dir = TempDir::new("migrate-order");
        let (path, mut conn) = open_file_db(&dir);

        let steps = [
            Migration {
                version: 1,
                name: "one",
                sql: "CREATE TABLE t (a INTEGER);",
            },
            Migration {
                version: 2,
                name: "two",
                sql: "ALTER TABLE t ADD COLUMN b INTEGER;",
            },
        ];

        let version = migrate(&mut conn, Some(&path), &steps).expect("迁移成功");
        assert_eq!(version, 2);

        // 第二列确实存在
        conn.execute("INSERT INTO t (a, b) VALUES (1, 2)", [])
            .expect("两列都存在");
    }

    #[test]
    fn is_idempotent_on_rerun() {
        let dir = TempDir::new("migrate-idempotent");
        let (path, mut conn) = open_file_db(&dir);

        let steps = [Migration {
            version: 1,
            name: "one",
            sql: "CREATE TABLE t (a INTEGER);",
        }];

        assert_eq!(migrate(&mut conn, Some(&path), &steps).unwrap(), 1);
        // 再跑一次不应重复执行建表语句
        assert_eq!(migrate(&mut conn, Some(&path), &steps).unwrap(), 1);
    }

    #[test]
    fn failing_step_keeps_original_data_and_leaves_backup() {
        let dir = TempDir::new("migrate-fail");
        let (path, mut conn) = open_file_db(&dir);

        let initial = [Migration {
            version: 1,
            name: "one",
            sql: "CREATE TABLE t (a INTEGER); INSERT INTO t (a) VALUES (42);",
        }];
        assert_eq!(migrate(&mut conn, Some(&path), &initial).unwrap(), 1);

        let broken = [
            Migration {
                version: 1,
                name: "one",
                sql: "CREATE TABLE t (a INTEGER); INSERT INTO t (a) VALUES (42);",
            },
            Migration {
                version: 2,
                name: "two",
                sql: "THIS IS NOT SQL;",
            },
        ];

        let err = migrate(&mut conn, Some(&path), &broken).expect_err("应失败");
        assert_eq!(err.code, ErrorCode::MigrationFailed);

        // 原数据仍可读，版本未推进，且没有半迁移状态
        let value: i64 = conn
            .query_row("SELECT a FROM t", [], |row| row.get(0))
            .expect("原数据可读");
        assert_eq!(value, 42);
        assert_eq!(current_version(&conn).unwrap(), 1);

        // 备份文件保留
        assert!(
            backup_path_for(&path).exists(),
            "迁移失败后应保留备份副本"
        );
    }

    #[test]
    fn successful_migration_cleans_up_backup() {
        let dir = TempDir::new("migrate-cleanup");
        let (path, mut conn) = open_file_db(&dir);

        let steps = [Migration {
            version: 1,
            name: "one",
            sql: "CREATE TABLE t (a INTEGER);",
        }];
        migrate(&mut conn, Some(&path), &steps).unwrap();
        assert!(
            !backup_path_for(&path).exists(),
            "迁移成功后备份应被清理"
        );
    }

    #[test]
    fn upgrading_from_v1_keeps_existing_rows_and_leaves_descriptions_empty() {
        let dir = TempDir::new("migrate-v2-upgrade");
        let (path, mut conn) = open_file_db(&dir);

        // 先落 v1，再写入既有数据
        assert_eq!(migrate(&mut conn, Some(&path), &MIGRATIONS[..1]).unwrap(), 1);

        let ts = "2026-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w1','工作区',?1,?1)",
            [ts],
        )
        .expect("写入工作区");
        conn.execute(
            "INSERT INTO collections (id, workspace_id, name, created_at, updated_at) VALUES ('c1','w1','集合',?1,?1)",
            [ts],
        )
        .expect("写入集合");
        conn.execute(
            "INSERT INTO folders (id, collection_id, name, created_at, updated_at) VALUES ('f1','c1','文件夹',?1,?1)",
            [ts],
        )
        .expect("写入文件夹");
        conn.execute(
            "INSERT INTO requests (id, collection_id, name, created_at, updated_at) VALUES ('r1','c1','请求',?1,?1)",
            [ts],
        )
        .expect("写入请求");

        // 升级到 v2
        assert_eq!(
            migrate(&mut conn, Some(&path), MIGRATIONS).unwrap(),
            LATEST_VERSION
        );

        // 既有行仍可读，且描述读出为空
        for (table, id) in [("collections", "c1"), ("folders", "f1"), ("requests", "r1")] {
            let (name, description): (String, Option<String>) = conn
                .query_row(
                    &format!("SELECT name, description FROM {} WHERE id = ?1", table),
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("既有行可读");
            assert!(!name.is_empty(), "{} 的名称应保留", table);
            assert_eq!(description, None, "{} 的描述应为空", table);
        }
    }

    #[test]
    fn upgrading_from_v2_keeps_existing_rows_and_creates_cookies_table() {
        let dir = TempDir::new("migrate-v3-upgrade");
        let (path, mut conn) = open_file_db(&dir);

        // 先落 v2，并写入既有数据
        assert_eq!(migrate(&mut conn, Some(&path), &MIGRATIONS[..2]).unwrap(), 2);

        let ts = "2026-01-01T00:00:00Z";
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w1','工作区',?1,?1)",
            [ts],
        )
        .expect("写入工作区");
        conn.execute(
            "INSERT INTO collections (id, workspace_id, name, created_at, updated_at) VALUES ('c1','w1','集合',?1,?1)",
            [ts],
        )
        .expect("写入集合");
        conn.execute(
            "INSERT INTO requests (id, collection_id, name, created_at, updated_at) VALUES ('r1','c1','请求',?1,?1)",
            [ts],
        )
        .expect("写入请求");

        // 升级到 v3
        assert_eq!(
            migrate(&mut conn, Some(&path), MIGRATIONS).unwrap(),
            LATEST_VERSION
        );

        // 既有数据仍可读
        let name: String = conn
            .query_row("SELECT name FROM workspaces WHERE id = 'w1'", [], |row| row.get(0))
            .expect("既有工作区可读");
        assert_eq!(name, "工作区");

        // cookies 表存在，且唯一键容纳 host_only
        conn.execute(
            "INSERT INTO cookies (id, name, domain, path, host_only, value_enc, created_at, updated_at)
             VALUES ('k1','sid','api.test','/',1,'enc',?1,?1)",
            [ts],
        )
        .expect("写入 Cookie");
        let err = conn.execute(
            "INSERT INTO cookies (id, name, domain, path, host_only, value_enc, created_at, updated_at)
             VALUES ('k2','sid','api.test','/',1,'enc',?1,?1)",
            [ts],
        );
        assert!(err.is_err(), "同键 Cookie 不应重复插入");
        // host_only 不同的同名 Cookie 是两个条目
        conn.execute(
            "INSERT INTO cookies (id, name, domain, path, host_only, value_enc, created_at, updated_at)
             VALUES ('k3','sid','api.test','/',0,'enc',?1,?1)",
            [ts],
        )
        .expect("host_only 不同应视为不同 Cookie");
    }

    #[test]
    fn initial_schema_lands_at_latest_version() {
        let dir = TempDir::new("migrate-schema");
        let (path, mut conn) = open_file_db(&dir);
        let version = migrate(&mut conn, Some(&path), MIGRATIONS).expect("迁移成功");
        assert_eq!(version, LATEST_VERSION);

        for table in [
            "workspaces",
            "collections",
            "folders",
            "requests",
            "environments",
            "variables",
            "settings",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("查询表");
            assert_eq!(found, 1, "表 {} 应存在", table);
        }
    }

    #[test]
    fn a_partially_failing_v2_step_rolls_back_and_keeps_v1() {
        let dir = TempDir::new("migrate-v2-fail");
        let (path, mut conn) = open_file_db(&dir);
        assert_eq!(migrate(&mut conn, Some(&path), &MIGRATIONS[..1]).unwrap(), 1);

        // 第一步 ALTER 会成功，第二步指向不存在的表而失败：
        // 事务回滚后第一步加的列也不应留下（无半迁移状态）。
        let steps = [
            Migration {
                version: 1,
                name: "initial_schema",
                sql: INITIAL_SCHEMA,
            },
            Migration {
                version: 2,
                name: "add_descriptions",
                sql: "ALTER TABLE collections ADD COLUMN description TEXT;
                      ALTER TABLE does_not_exist ADD COLUMN description TEXT;",
            },
        ];

        let err = migrate(&mut conn, Some(&path), &steps).expect_err("v2 应失败");
        assert_eq!(err.code, ErrorCode::MigrationFailed);
        assert_eq!(current_version(&conn).unwrap(), 1, "版本不应推进到 2");

        let description_columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('collections') WHERE name = 'description'",
                [],
                |row| row.get(0),
            )
            .expect("查询列");
        assert_eq!(description_columns, 0, "半迁移不应留下已加的列");

        assert!(
            backup_path_for(&path).exists(),
            "迁移失败后应保留备份副本"
        );
    }
}
