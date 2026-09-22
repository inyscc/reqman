//! 本地持久化层（design.md D3 / D4）。
//!
//! 前端不直连存储（D1），所有读写经具名命令进入这里。写操作经单写者串行化，
//! 读走独立连接；数据库访问是阻塞的，命令层负责把它放到阻塞线程池里。

pub mod backup;
pub mod cookies;
pub mod db;
pub mod migrations;
pub mod model;
pub mod proxy_credentials;
pub mod requests;
pub mod variables;
pub mod workspace;

pub use db::Db;
pub use model::*;

use crate::error::{AppError, AppResult};

/// 统一的 UTC 时间戳格式（RFC 3339）。
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 新建实体 id。
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_string(value).map_err(|err| AppError::internal(format!("序列化失败：{}", err)))
}

pub(crate) fn from_json<T: serde::de::DeserializeOwned>(raw: &str) -> AppResult<T> {
    serde_json::from_str(raw).map_err(|err| AppError::storage(format!("存储内容无法解析：{}", err)))
}

/// 非空名称校验。
pub(crate) fn require_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_input("名称不能为空"));
    }
    Ok(trimmed.to_string())
}

/// 把 id 列表写回为连续的 sort_order。
pub(crate) fn apply_order(
    conn: &rusqlite::Connection,
    table: &str,
    ids: &[String],
    scope_column: &str,
    scope_value: &str,
) -> AppResult<()> {
    let sql = format!(
        "UPDATE {} SET sort_order = ?1 WHERE id = ?2 AND {} = ?3",
        table, scope_column
    );
    for (index, id) in ids.iter().enumerate() {
        let changed = conn.execute(&sql, rusqlite::params![index as i64, id, scope_value])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("条目不存在或不属于该父级：{}", id)));
        }
    }
    Ok(())
}
