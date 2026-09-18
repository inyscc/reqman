//! Cookie 行的持久化（openspec/changes/add-pm-script-runtime，spec: Cookie 的持久化与加密）。
//!
//! 职责只有两件事：**行模型 CRUD** 与 **取值加密**。Cookie 的匹配、过期与域名/路径
//! 语义全部由 `cookie_store` 承担（design D14），这里不做任何匹配逻辑。
//!
//! 明文列（name / domain / path / 属性标记）用于列表分组与唯一键，不属于机密；
//! **取值**经 [`crate::secrets::encrypt_value`] 加密后存放，数据库文件与备份中
//! 检索不到 Cookie 明文。密钥不可用时进入降级态：拒绝落库，绝不写明文——
//! 与 secret 变量同一取向。

use super::{new_id, now, Db};
use crate::error::{AppError, AppResult};
use crate::secrets::{self, KeyProvider};
use rusqlite::{params, Connection, OptionalExtension};

/// 一条 Cookie 行。`value` 是**明文**，只在内存中存在；落库前必须加密。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookieRow {
    pub name: String,
    /// Cookie 的域字符串，不含前导点；`host_only` 为真时表示仅精确匹配该主机。
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix 秒；`None` 表示会话 Cookie（不落库，仅存活于应用运行期）。
    pub expires_at: Option<i64>,
}

/// 界面用的行视图：行 id（删除、编辑定位用）+ 行内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookieEntry {
    pub id: String,
    pub row: CookieRow,
}

/// 列出全部 Cookie 行（带 id，供手动管理界面）。
pub fn list_entries(db: &Db, key_provider: &dyn KeyProvider) -> AppResult<Vec<CookieEntry>> {
    let key = key_provider.data_key()?;
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, domain, path, host_only, value_enc, secure, http_only, expires_at
             FROM cookies ORDER BY domain, path, name",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let encoded: String = row.get("value_enc")?;
            let value = match secrets::decrypt_value(&key, &encoded) {
                Ok(value) => value,
                Err(_) => String::new(),
            };
            out.push(CookieEntry {
                id: row.get("id")?,
                row: CookieRow {
                    name: row.get("name")?,
                    domain: row.get("domain")?,
                    path: row.get("path")?,
                    host_only: row.get::<_, i64>("host_only")? != 0,
                    value,
                    secure: row.get::<_, i64>("secure")? != 0,
                    http_only: row.get::<_, i64>("http_only")? != 0,
                    expires_at: row.get("expires_at")?,
                },
            });
        }
        Ok(out)
    })
}

/// 按 id 取一条 Cookie 行（删除前需要属性以便同步清理 jar）。
pub fn get_row(db: &Db, key_provider: &dyn KeyProvider, id: &str) -> AppResult<Option<CookieRow>> {
    let key = key_provider.data_key()?;
    db.read(move |conn| {
        let row = conn
            .query_row(
                "SELECT name, domain, path, host_only, value_enc, secure, http_only, expires_at
                 FROM cookies WHERE id = ?1",
                [id],
                |row| {
                    let encoded: String = row.get("value_enc")?;
                    Ok(CookieRow {
                        name: row.get("name")?,
                        domain: row.get("domain")?,
                        path: row.get("path")?,
                        host_only: row.get::<_, i64>("host_only")? != 0,
                        value: secrets::decrypt_value(&key, &encoded).unwrap_or_default(),
                        secure: row.get::<_, i64>("secure")? != 0,
                        http_only: row.get::<_, i64>("http_only")? != 0,
                        expires_at: row.get("expires_at")?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    })
}

/// 列出全部 Cookie 行。取值解密失败时以 `None` 值替代而不是让整个 jar 不可用：
/// 一条损坏的密文不应拖垮其余 Cookie 与全部请求。
pub fn list_rows(db: &Db, key_provider: &dyn KeyProvider) -> AppResult<Vec<CookieRow>> {
    let key = key_provider.data_key()?;
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name, domain, path, host_only, value_enc, secure, http_only, expires_at
             FROM cookies ORDER BY domain, path, name",
        )?;
        let mut rows = stmt.query([])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let encoded: String = row.get("value_enc")?;
            let value = match secrets::decrypt_value(&key, &encoded) {
                Ok(value) => value,
                Err(_) => String::new(),
            };
            out.push(CookieRow {
                name: row.get("name")?,
                domain: row.get("domain")?,
                path: row.get("path")?,
                host_only: row.get::<_, i64>("host_only")? != 0,
                value,
                secure: row.get::<_, i64>("secure")? != 0,
                http_only: row.get::<_, i64>("http_only")? != 0,
                expires_at: row.get("expires_at")?,
            });
        }
        Ok(out)
    })
}

/// 新增或覆盖一条 Cookie（按唯一键 name + domain + path + host_only）。
///
/// 手动管理与脚本写入都走这里；写完立即参与后续请求的匹配。
pub fn put_row(db: &Db, key_provider: &dyn KeyProvider, row: &CookieRow) -> AppResult<()> {
    let key = key_provider.data_key()?;
    let encoded = secrets::encrypt_value(&key, &row.value)?;
    let ts = now();
    let row = row.clone();
    db.write(move |conn| upsert_row(conn, &row, &encoded, &ts))
}

pub(crate) fn upsert_row(
    conn: &Connection,
    row: &CookieRow,
    encoded: &str,
    ts: &str,
) -> AppResult<()> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM cookies WHERE name = ?1 AND domain = ?2 AND path = ?3 AND host_only = ?4",
            params![row.name, row.domain, row.path, row.host_only as i64],
            |r| r.get(0),
        )
        .optional()?;

    match existing {
        Some(id) => {
            conn.execute(
                "UPDATE cookies SET value_enc = ?2, secure = ?3, http_only = ?4,
                 expires_at = ?5, updated_at = ?6 WHERE id = ?1",
                params![
                    id,
                    encoded,
                    row.secure as i64,
                    row.http_only as i64,
                    row.expires_at,
                    ts
                ],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO cookies (id, name, domain, path, host_only, value_enc, secure,
                 http_only, expires_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    new_id(),
                    row.name,
                    row.domain,
                    row.path,
                    row.host_only as i64,
                    encoded,
                    row.secure as i64,
                    row.http_only as i64,
                    row.expires_at,
                    ts
                ],
            )?;
        }
    }
    Ok(())
}

/// 清理已过期的行（装载时调用，过期指令生效后的库侧收尾）。
pub fn delete_expired(db: &Db, now_ts: i64) -> AppResult<usize> {
    db.write(move |conn| {
        Ok(conn.execute(
            "DELETE FROM cookies WHERE expires_at IS NOT NULL AND expires_at <= ?1",
            [now_ts],
        )?)
    })
}

/// 删除一条 Cookie；返回是否真的删除了。
pub fn delete_row(db: &Db, id: &str) -> AppResult<bool> {
    let changed = db.write(move |conn| {
        Ok(conn.execute("DELETE FROM cookies WHERE id = ?1", [id])?)
    })?;
    Ok(changed > 0)
}

/// 删除数据库中不在 `kept` 集合里的行（网络层同步时的清理步骤）。
///
/// `kept` 的元素形如 `host_only|domain|path|name`，与 [`row_key`] 一致。
pub(crate) fn delete_rows_not_in(
    conn: &Connection,
    kept: &std::collections::HashSet<String>,
) -> AppResult<usize> {
    let mut to_delete = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, name, domain, path, host_only FROM cookies")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let key = format!(
                "{}|{}|{}|{}",
                row.get::<_, i64>("host_only")?,
                row.get::<_, String>("domain")?,
                row.get::<_, String>("path")?,
                row.get::<_, String>("name")?,
            );
            if !kept.contains(&key) {
                to_delete.push(row.get::<_, String>("id")?);
            }
        }
    }

    let mut changed = 0;
    for id in to_delete {
        changed += conn.execute("DELETE FROM cookies WHERE id = ?1", [&id])?;
    }
    Ok(changed)
}

/// 行的唯一键（host_only 前缀避免两种域解释互相覆盖）。
pub(crate) fn row_key(row: &CookieRow) -> String {
    format!(
        "{}|{}|{}|{}",
        row.host_only as i64,
        row.domain,
        row.path,
        row.name
    )
}

/// 给 Cookie 管理界面用的行视图：不含明文取值（取值单独经揭示命令获取）。
///
/// 目前只有网络层在消费行数据；界面命令落地时（8.5）沿用 [`list_rows`]。
#[allow(dead_code)]
pub fn count_rows(db: &Db) -> AppResult<i64> {
    db.read(|conn| {
        conn.query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get(0))
            .map_err(AppError::from)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryKeyProvider;
    use crate::testutil::TempDir;

    fn setup(name: &str) -> (TempDir, Arc<Db>, MemoryKeyProvider) {
        let dir = TempDir::new(name);
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        (dir, db, MemoryKeyProvider::new())
    }

    use std::sync::Arc;

    fn row(name: &str, value: &str) -> CookieRow {
        CookieRow {
            name: name.into(),
            domain: "api.test".into(),
            path: "/".into(),
            host_only: true,
            value: value.into(),
            secure: false,
            http_only: false,
            expires_at: Some(4_102_444_800), // 2100-01-01
        }
    }

    #[test]
    fn put_then_list_round_trips_attributes() {
        let (_dir, db, keys) = setup("cookie-roundtrip");

        put_row(&db, &keys, &row("sid", "abc123")).expect("写入");

        let rows = list_rows(&db, &keys).expect("读取");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value, "abc123");
        assert_eq!(rows[0].domain, "api.test");
        assert!(rows[0].host_only);
        assert_eq!(rows[0].expires_at, Some(4_102_444_800));
    }

    #[test]
    fn value_is_encrypted_at_rest() {
        let dir = TempDir::new("cookie-encrypted");
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        let keys = MemoryKeyProvider::new();

        put_row(&db, &keys, &row("sid", "PLAINTEXT_SENTINEL_42")).expect("写入");

        // 直接读数据库文件检索不到明文
        let raw = std::fs::read_to_string(dir.join("reqman.db")).expect("读取库文件");
        assert!(!raw.contains("PLAINTEXT_SENTINEL_42"), "取值不得以明文落盘");
    }

    #[test]
    fn upsert_overwrites_same_key_and_keeps_one_row() {
        let (_dir, db, keys) = setup("cookie-upsert");

        put_row(&db, &keys, &row("sid", "v1")).expect("首次写入");
        put_row(&db, &keys, &row("sid", "v2")).expect("覆盖写入");

        let rows = list_rows(&db, &keys).expect("读取");
        assert_eq!(rows.len(), 1, "同键只保留一行");
        assert_eq!(rows[0].value, "v2");
    }

    #[test]
    fn same_key_with_different_host_only_are_distinct() {
        let (_dir, db, keys) = setup("cookie-hostonly");

        let mut domain_cookie = row("sid", "domain");
        domain_cookie.host_only = false;
        put_row(&db, &keys, &row("sid", "host")).expect("写入 host-only");
        put_row(&db, &keys, &domain_cookie).expect("写入 domain");

        let rows = list_rows(&db, &keys).expect("读取");
        assert_eq!(rows.len(), 2, "host_only 参与唯一键");
    }

    #[test]
    fn delete_removes_row() {
        let (_dir, db, keys) = setup("cookie-delete");

        put_row(&db, &keys, &row("sid", "v")).expect("写入");
        let count = count_rows(&db).expect("计数");
        assert_eq!(count, 1);

        // delete_row 按 id 删；先取 id
        let id: String = db
            .read(|conn| {
                conn.query_row("SELECT id FROM cookies LIMIT 1", [], |row| row.get(0))
                    .map_err(AppError::from)
            })
            .expect("取 id");
        assert!(delete_row(&db, &id).expect("删除"));
        assert_eq!(count_rows(&db).expect("计数"), 0);
    }

    #[test]
    fn unavailable_key_provider_refuses_to_persist() {
        let dir = TempDir::new("cookie-degraded");
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");

        let err = put_row(&db, &crate::secrets::UnavailableKeyProvider, &row("sid", "v"))
            .expect_err("应进入降级态");
        assert_eq!(err.code, crate::error::ErrorCode::SecretStoreUnavailable);
        // 降级态下不写明文
        let raw = std::fs::read_to_string(dir.join("reqman.db")).expect("读取库文件");
        assert!(!raw.contains("sid"));
    }
}
