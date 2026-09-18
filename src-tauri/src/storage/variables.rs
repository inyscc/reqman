//! 环境、变量（含工作区级全局变量）与应用设置的持久化。
//!
//! 覆盖 spec: 环境与变量持久化 / 工作区级全局变量与应用设置持久化 /
//! 敏感值不以明文落盘。

use super::model::{setting_keys, Environment, ProxyConfig, Scope, Variable};
use super::{from_json, new_id, now, require_name, to_json, Db};
use crate::error::{AppError, AppResult};
use crate::secrets::{self, KeyProvider, StoredValue};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::{BTreeMap, BTreeSet};

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

fn environment_from_row(row: &Row<'_>) -> rusqlite::Result<Environment> {
    let proxy_raw: Option<String> = row.get("proxy")?;
    Ok(Environment {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        name: row.get("name")?,
        is_active: row.get::<_, i64>("is_active")? != 0,
        proxy: proxy_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
        sort_order: row.get("sort_order")?,
    })
}

pub fn list_environments(db: &Db, workspace_id: &str) -> AppResult<Vec<Environment>> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM environments WHERE workspace_id = ?1 ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([workspace_id], environment_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get_environment(db: &Db, id: &str) -> AppResult<Environment> {
    db.read(|conn| {
        conn.query_row(
            "SELECT * FROM environments WHERE id = ?1",
            [id],
            environment_from_row,
        )
        .map_err(AppError::from)
    })
}

pub fn create_environment(db: &Db, workspace_id: &str, name: &str) -> AppResult<Environment> {
    let name = require_name(name)?;
    super::workspace::get(db, workspace_id)?;

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM environments WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        let id = new_id();
        let ts = now();
        tx.execute(
            "INSERT INTO environments (id, workspace_id, name, is_active, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)",
            params![id, workspace_id, name, next, ts],
        )?;
        tx.commit()?;
        Ok(Environment {
            id,
            workspace_id: workspace_id.to_string(),
            name,
            is_active: false,
            proxy: None,
            sort_order: next,
        })
    })
}

/// 以给定连接插入一个环境，返回新环境 id。
///
/// 导入需要在**单个**事务里写入整份文档（spec: 导入的原子性与失败处置），
/// 因此这里接受任意 `Connection`。
pub(crate) fn insert_environment(
    conn: &Connection,
    workspace_id: &str,
    name: &str,
) -> AppResult<String> {
    let name = require_name(name)?;
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM environments WHERE workspace_id = ?1",
        [workspace_id],
        |row| row.get(0),
    )?;
    let id = new_id();
    let ts = now();
    conn.execute(
        "INSERT INTO environments (id, workspace_id, name, is_active, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)",
        params![id, workspace_id, name, next, ts],
    )?;
    Ok(id)
}

pub fn rename_environment(db: &Db, id: &str, name: &str) -> AppResult<Environment> {
    let name = require_name(name)?;
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE environments SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("环境不存在：{}", id)));
        }
        Ok(())
    })?;
    get_environment(db, id)
}

pub fn delete_environment(db: &Db, id: &str) -> AppResult<()> {
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let changed = tx.execute("DELETE FROM environments WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("环境不存在：{}", id)));
        }
        tx.execute(
            "DELETE FROM variables WHERE scope = 'environment' AND owner_id = ?1",
            [id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// 设置活动环境。传 `None` 表示取消活动环境。
///
/// 同一工作区至多一个活动环境（spec: 环境变量与活动环境）。
pub fn set_active_environment(db: &Db, workspace_id: &str, env_id: Option<&str>) -> AppResult<()> {
    if let Some(env_id) = env_id {
        let env = get_environment(db, env_id)?;
        if env.workspace_id != workspace_id {
            return Err(AppError::invalid_input("环境不属于该工作区"));
        }
    }

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE environments SET is_active = 0 WHERE workspace_id = ?1",
            [workspace_id],
        )?;
        if let Some(env_id) = env_id {
            tx.execute(
                "UPDATE environments SET is_active = 1, updated_at = ?2 WHERE id = ?1",
                params![env_id, now()],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn active_environment(db: &Db, workspace_id: &str) -> AppResult<Option<Environment>> {
    db.read(|conn| {
        let row = conn
            .query_row(
                "SELECT * FROM environments WHERE workspace_id = ?1 AND is_active = 1 LIMIT 1",
                [workspace_id],
                environment_from_row,
            )
            .optional()?;
        Ok(row)
    })
}

pub fn set_environment_proxy(
    db: &Db,
    id: &str,
    proxy: Option<ProxyConfig>,
) -> AppResult<Environment> {
    let encoded = match proxy {
        Some(proxy) => Some(to_json(&proxy)?),
        None => None,
    };
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE environments SET proxy = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, encoded, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("环境不存在：{}", id)));
        }
        Ok(())
    })?;
    get_environment(db, id)
}

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueField {
    Initial,
    Current,
}

struct RawVariable {
    is_secret: bool,
    initial_value: Option<String>,
    initial_readable: bool,
    current_value: Option<String>,
    current_readable: bool,
}

fn raw_variable(conn: &Connection, id: &str) -> AppResult<RawVariable> {
    conn.query_row(
        "SELECT is_secret, initial_value, initial_readable, current_value, current_readable
         FROM variables WHERE id = ?1",
        [id],
        |row| {
            Ok(RawVariable {
                is_secret: row.get::<_, i64>(0)? != 0,
                initial_value: row.get(1)?,
                initial_readable: row.get::<_, i64>(2)? != 0,
                current_value: row.get(3)?,
                current_readable: row.get::<_, i64>(4)? != 0,
            })
        },
    )
    .map_err(AppError::from)
}

/// 把明文编码为落库形态。secret 值在密钥不可用时直接失败——明文不会落库。
fn encode_value(is_secret: bool, value: &str, key_provider: &dyn KeyProvider) -> AppResult<String> {
    if !is_secret {
        return Ok(value.to_string());
    }
    let key = key_provider.data_key()?;
    let encoded = secrets::encrypt_value(&key, value)?;
    crate::logging::global().register_secret_value(value);
    Ok(encoded)
}

/// 把落库形态解码为可观察的取值状态。
pub fn decode_value(
    is_secret: bool,
    raw: Option<String>,
    readable: bool,
    key_provider: &dyn KeyProvider,
) -> StoredValue {
    let raw = match raw {
        Some(raw) => raw,
        None => return StoredValue::NotPersisted,
    };

    if !is_secret {
        return StoredValue::Value { value: raw };
    }

    if !readable {
        return StoredValue::Unreadable;
    }

    match key_provider.data_key() {
        Err(_) => StoredValue::Unreadable,
        Ok(key) => match secrets::decrypt_value(&key, &raw) {
            Ok(plaintext) => {
                crate::logging::global().register_secret_value(&plaintext);
                StoredValue::Value { value: plaintext }
            }
            Err(_) => StoredValue::Unreadable,
        },
    }
}

fn variable_from_row(row: &Row<'_>, key_provider: &dyn KeyProvider) -> rusqlite::Result<Variable> {
    let scope_raw: String = row.get("scope")?;
    let scope = Scope::parse(&scope_raw).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(AppError::storage(format!("未知变量作用域：{}", scope_raw))),
        )
    })?;

    let is_secret = row.get::<_, i64>("is_secret")? != 0;
    let initial_value: Option<String> = row.get("initial_value")?;
    let initial_readable = row.get::<_, i64>("initial_readable")? != 0;
    let current_value: Option<String> = row.get("current_value")?;
    let current_readable = row.get::<_, i64>("current_readable")? != 0;

    Ok(Variable {
        id: row.get("id")?,
        scope,
        owner_id: row.get("owner_id")?,
        name: row.get("name")?,
        is_secret,
        initial: decode_value(is_secret, initial_value, initial_readable, key_provider),
        current: decode_value(is_secret, current_value, current_readable, key_provider),
    })
}

pub fn list_variables(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<Vec<Variable>> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM variables WHERE scope = ?1 AND owner_id = ?2 ORDER BY name",
        )?;
        let rows = stmt.query_map(params![scope.as_str(), owner_id], |row| {
            variable_from_row(row, key_provider)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get_variable(db: &Db, id: &str, key_provider: &dyn KeyProvider) -> AppResult<Variable> {
    db.read(|conn| {
        conn.query_row("SELECT * FROM variables WHERE id = ?1", [id], |row| {
            variable_from_row(row, key_provider)
        })
        .map_err(AppError::from)
    })
}

fn validate_owner(db: &Db, scope: Scope, owner_id: &str) -> AppResult<()> {
    match scope {
        Scope::Global => super::workspace::get(db, owner_id).map(|_| ()),
        Scope::Environment => get_environment(db, owner_id).map(|_| ()),
        Scope::Collection => super::workspace::get_collection(db, owner_id).map(|_| ()),
        Scope::Local | Scope::Data => Err(AppError::invalid_input(
            "本地变量与迭代数据不落盘，不能持久化",
        )),
    }
}

/// 新建或更新一个持久化变量。
///
/// `initial` / `current` 为 `None` 表示「保持原值不变」。
#[allow(clippy::too_many_arguments)]
pub fn upsert_variable(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    name: &str,
    is_secret: bool,
    initial: Option<&str>,
    current: Option<&str>,
    key_provider: &dyn KeyProvider,
) -> AppResult<Variable> {
    if !scope.is_persisted() {
        return Err(AppError::invalid_input(format!(
            "作用域 {} 不落盘，不能持久化",
            scope.as_str()
        )));
    }
    let name = require_name(name)?;
    validate_owner(db, scope, owner_id)?;

    let existing_id: Option<String> = db.read(|conn| {
        Ok(conn
            .query_row(
                "SELECT id FROM variables WHERE scope = ?1 AND owner_id = ?2 AND name = ?3",
                params![scope.as_str(), owner_id, name],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })?;

    // 密钥不可用时在这里失败，明文不会落库（design D5 降级态）
    let initial_encoded = initial
        .map(|value| encode_value(is_secret, value, key_provider))
        .transpose()?;
    let current_encoded = current
        .map(|value| encode_value(is_secret, value, key_provider))
        .transpose()?;

    match existing_id {
        None => {
            let id = new_id();
            let ts = now();
            db.write(|conn| {
                conn.execute(
                    "INSERT INTO variables (id, scope, owner_id, name, initial_value, current_value,
                        is_secret, initial_readable, current_readable, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?8)",
                    params![
                        id,
                        scope.as_str(),
                        owner_id,
                        name,
                        initial_encoded
                            .clone()
                            .or_else(|| Some(String::new())),
                        current_encoded.clone().or_else(|| Some(String::new())),
                        is_secret as i64,
                        ts,
                    ],
                )?;
                Ok(())
            })?;
            get_variable(db, &id, key_provider)
        }
        Some(id) => {
            let raw = db.read(|conn| raw_variable(conn, &id))?;

            // secret 标记发生变化时，需要把已有值重新编码；不可读的值无法转换
            if raw.is_secret != is_secret {
                let initial_plain = if initial_encoded.is_some() {
                    None
                } else {
                    decode_value(raw.is_secret, raw.initial_value.clone(), raw.initial_readable, key_provider)
                        .plaintext()
                        .map(|s| s.to_string())
                };
                let current_plain = if current_encoded.is_some() {
                    None
                } else {
                    decode_value(raw.is_secret, raw.current_value.clone(), raw.current_readable, key_provider)
                        .plaintext()
                        .map(|s| s.to_string())
                };

                let needs_conversion = (initial_encoded.is_none() && raw.initial_value.is_some())
                    || (current_encoded.is_none() && raw.current_value.is_some());
                if needs_conversion
                    && (initial_plain.is_none() && raw.initial_value.is_some()
                        || current_plain.is_none() && raw.current_value.is_some())
                {
                    return Err(AppError::invalid_input(
                        "该变量当前不可解密，无法切换 secret 标记",
                    ));
                }

                let initial_encoded = match initial_encoded {
                    Some(encoded) => Some(encoded),
                    None => initial_plain
                        .as_deref()
                        .map(|value| encode_value(is_secret, value, key_provider))
                        .transpose()?,
                };
                let current_encoded = match current_encoded {
                    Some(encoded) => Some(encoded),
                    None => current_plain
                        .as_deref()
                        .map(|value| encode_value(is_secret, value, key_provider))
                        .transpose()?,
                };

                db.write(|conn| {
                    conn.execute(
                        "UPDATE variables SET is_secret = ?2, initial_value = COALESCE(?3, initial_value),
                            current_value = COALESCE(?4, current_value), initial_readable = 1,
                            current_readable = 1, updated_at = ?5 WHERE id = ?1",
                        params![id, is_secret as i64, initial_encoded, current_encoded, now()],
                    )?;
                    Ok(())
                })?;
                return get_variable(db, &id, key_provider);
            }

            db.write(|conn| {
                conn.execute(
                    "UPDATE variables SET initial_value = COALESCE(?2, initial_value),
                        current_value = COALESCE(?3, current_value), updated_at = ?4 WHERE id = ?1",
                    params![id, initial_encoded, current_encoded, now()],
                )?;
                Ok(())
            })?;
            get_variable(db, &id, key_provider)
        }
    }
}

/// 以给定连接插入一个变量（导入在单个事务内使用）。
///
/// 源文档只有单一值，因此把同一个值同时写入初始值与当前值（design D13）；
/// secret 值先经 AEAD 加密才落库，密钥不可用时直接失败、明文不落库。
pub(crate) fn insert_variable(
    conn: &Connection,
    scope: Scope,
    owner_id: &str,
    name: &str,
    is_secret: bool,
    value: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<()> {
    if !scope.is_persisted() {
        return Err(AppError::invalid_input(format!(
            "作用域 {} 不落盘，不能持久化",
            scope.as_str()
        )));
    }
    let name = require_name(name)?;
    let encoded = encode_value(is_secret, value, key_provider)?;
    let ts = now();

    conn.execute(
        "INSERT INTO variables (id, scope, owner_id, name, initial_value, current_value,
            is_secret, initial_readable, current_readable, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1, 1, ?7, ?7)",
        params![
            new_id(),
            scope.as_str(),
            owner_id,
            name,
            encoded,
            is_secret as i64,
            ts,
        ],
    )?;
    Ok(())
}

/// 只更新初始值或只更新当前值——两者的修改互相独立。
pub fn update_variable_value(
    db: &Db,
    id: &str,
    field: ValueField,
    value: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<Variable> {
    let raw = db.read(|conn| raw_variable(conn, id))?;
    let encoded = encode_value(raw.is_secret, value, key_provider)?;

    let (column, readable_column) = match field {
        ValueField::Initial => ("initial_value", "initial_readable"),
        ValueField::Current => ("current_value", "current_readable"),
    };

    let sql = format!(
        "UPDATE variables SET {} = ?2, {} = 1, updated_at = ?3 WHERE id = ?1",
        column, readable_column
    );
    db.write(|conn| {
        conn.execute(&sql, params![id, encoded, now()])?;
        Ok(())
    })?;

    get_variable(db, id, key_provider)
}

pub fn delete_variable(db: &Db, id: &str) -> AppResult<()> {
    db.write(|conn| {
        let changed = conn.execute("DELETE FROM variables WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("变量不存在：{}", id)));
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// 全局变量
// ---------------------------------------------------------------------------

pub fn list_globals(
    db: &Db,
    workspace_id: &str,
    key_provider: &dyn KeyProvider,
) -> AppResult<Vec<Variable>> {
    list_variables(db, Scope::Global, workspace_id, key_provider)
}

pub fn set_global(
    db: &Db,
    workspace_id: &str,
    name: &str,
    value: &str,
    is_secret: bool,
    key_provider: &dyn KeyProvider,
) -> AppResult<Variable> {
    upsert_variable(
        db,
        Scope::Global,
        workspace_id,
        name,
        is_secret,
        Some(value),
        Some(value),
        key_provider,
    )
}

// ---------------------------------------------------------------------------
// 应用设置
// ---------------------------------------------------------------------------

pub fn get_setting(db: &Db, scope: &str, key: &str) -> AppResult<Option<String>> {
    db.read(|conn| {
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE scope = ?1 AND key = ?2",
                params![scope, key],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })
}

pub fn set_setting(db: &Db, scope: &str, key: &str, value: &str) -> AppResult<()> {
    db.write(|conn| {
        conn.execute(
            "INSERT INTO settings (scope, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![scope, key, value, now()],
        )?;
        Ok(())
    })
}

/// 全局代理配置（三级代理中的最底层）。
pub fn global_proxy(db: &Db) -> AppResult<Option<ProxyConfig>> {
    match get_setting(db, "global", setting_keys::GLOBAL_PROXY)? {
        Some(raw) => Ok(Some(from_json(&raw)?)),
        None => Ok(None),
    }
}

pub fn set_global_proxy(db: &Db, proxy: Option<ProxyConfig>) -> AppResult<()> {
    match proxy {
        Some(proxy) => set_setting(
            db,
            "global",
            setting_keys::GLOBAL_PROXY,
            &to_json(&proxy)?,
        ),
        None => {
            db.write(|conn| {
                conn.execute(
                    "DELETE FROM settings WHERE scope = 'global' AND key = ?1",
                    [setting_keys::GLOBAL_PROXY],
                )?;
                Ok(())
            })?;
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// 解析用作用域快照
// ---------------------------------------------------------------------------

/// 按解析优先级排列的作用域取值，供变量引擎消费。
///
/// `local` 与 `data` 由调用方在运行时提供，不落盘。
#[derive(Debug, Clone, Default)]
pub struct ScopeLayers {
    /// 高优先级在前：(作用域, 变量名 -> 值)。
    pub layers: Vec<(Scope, BTreeMap<String, String>)>,
    /// 来自 secret 的变量名，供界面掩码与日志脱敏。
    pub secret_names: BTreeSet<String>,
}

impl ScopeLayers {
    /// 按优先级查找变量值。
    pub fn lookup(&self, name: &str) -> Option<&str> {
        self.layers
            .iter()
            .find_map(|(_, map)| map.get(name).map(|v| v.as_str()))
    }

    /// 该名字是否来自 secret 变量。
    pub fn is_secret(&self, name: &str) -> bool {
        self.secret_names.contains(name)
    }
}

fn layer_for(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    key_provider: &dyn KeyProvider,
    secret_names: &mut BTreeSet<String>,
) -> AppResult<BTreeMap<String, String>> {
    let variables = list_variables(db, scope, owner_id, key_provider)?;
    let mut map = BTreeMap::new();
    for variable in variables {
        // 不可读的 secret 无法参与解析，按未定义处理
        if let Some(value) = variable.current.plaintext() {
            if variable.is_secret {
                secret_names.insert(variable.name.clone());
            }
            map.insert(variable.name.clone(), value.to_string());
        }
    }
    Ok(map)
}

#[allow(clippy::too_many_arguments)]
pub fn load_scope_layers(
    db: &Db,
    workspace_id: &str,
    collection_id: Option<&str>,
    environment_id: Option<&str>,
    local: BTreeMap<String, String>,
    data: BTreeMap<String, String>,
    key_provider: &dyn KeyProvider,
) -> AppResult<ScopeLayers> {
    let mut secret_names = BTreeSet::new();

    let global = layer_for(db, Scope::Global, workspace_id, key_provider, &mut secret_names)?;
    let collection = match collection_id {
        Some(id) => layer_for(db, Scope::Collection, id, key_provider, &mut secret_names)?,
        None => BTreeMap::new(),
    };
    let environment = match environment_id {
        Some(id) => layer_for(db, Scope::Environment, id, key_provider, &mut secret_names)?,
        None => BTreeMap::new(),
    };

    Ok(ScopeLayers {
        layers: vec![
            (Scope::Local, local),
            (Scope::Data, data),
            (Scope::Environment, environment),
            (Scope::Collection, collection),
            (Scope::Global, global),
        ],
        secret_names,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::secrets::{MemoryKeyProvider, UnavailableKeyProvider};
    use crate::storage::workspace;
    use crate::testutil::TempDir;

    fn setup(db: &Db) -> (String, String) {
        let workspace_id = workspace::list(db).unwrap().remove(0).id;
        let collection_id = workspace::create_collection(db, &workspace_id, "集合").unwrap().id;
        (workspace_id, collection_id)
    }

    #[test]
    fn initial_and_current_values_change_independently() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([3u8; 32]);
        let (workspace_id, _) = setup(&db);

        let variable = set_global(&db, &workspace_id, "host", "A", false, &key).expect("写入变量");
        assert_eq!(variable.initial.plaintext(), Some("A"));
        assert_eq!(variable.current.plaintext(), Some("A"));

        let updated =
            update_variable_value(&db, &variable.id, ValueField::Current, "B", &key).expect("改当前值");
        assert_eq!(updated.initial.plaintext(), Some("A"), "初始值不应被改动");
        assert_eq!(updated.current.plaintext(), Some("B"));

        let updated =
            update_variable_value(&db, &variable.id, ValueField::Initial, "C", &key).expect("改初始值");
        assert_eq!(updated.initial.plaintext(), Some("C"));
        assert_eq!(updated.current.plaintext(), Some("B"), "当前值不应被改动");
    }

    #[test]
    fn initial_and_current_survive_reopen_independently() {
        let dir = TempDir::new("vars-reopen");
        let path = dir.join("reqman.db");
        let key = MemoryKeyProvider::from_bytes([4u8; 32]);

        let (variable_id, workspace_id) = {
            let db = Db::open(&path).expect("打开数据库");
            let (workspace_id, _) = setup(&db);
            let variable =
                set_global(&db, &workspace_id, "token", "A", false, &key).expect("写入变量");
            update_variable_value(&db, &variable.id, ValueField::Current, "B", &key).unwrap();
            (variable.id, workspace_id)
        };

        let db = Db::open(&path).expect("重开数据库");
        let variable = get_variable(&db, &variable_id, &key).expect("读取变量");
        assert_eq!(variable.initial.plaintext(), Some("A"));
        assert_eq!(variable.current.plaintext(), Some("B"));

        // 作用域快照里只有当前值参与解析
        let layers = load_scope_layers(&db, &workspace_id, None, None, BTreeMap::new(), BTreeMap::new(), &key)
            .expect("组装作用域");
        assert_eq!(layers.lookup("token"), Some("B"));
    }

    #[test]
    fn secret_values_are_not_stored_as_plaintext_on_disk() {
        let dir = TempDir::new("vars-secret");
        let path = dir.join("reqman.db");
        let key = MemoryKeyProvider::from_bytes([5u8; 32]);
        let plaintext = "SUPER_SECRET_TOKEN_9911";

        {
            let db = Db::open(&path).expect("打开数据库");
            let (workspace_id, _) = setup(&db);
            set_global(&db, &workspace_id, "apiKey", plaintext, true, &key).expect("写入 secret 变量");
        }

        // 直接读取数据库文件字节：不应出现明文
        let bytes = std::fs::read(&path).expect("读取数据库文件");
        assert!(
            !contains_bytes(&bytes, plaintext.as_bytes()),
            "secret 明文不应出现在数据库文件中"
        );

        // 但解密后可用
        let db = Db::open(&path).expect("重开数据库");
        let globals = list_globals(&db, &workspace::list(&db).unwrap().remove(0).id, &key).unwrap();
        assert_eq!(globals.len(), 1);
        assert_eq!(globals[0].current.plaintext(), Some(plaintext));
        assert!(globals[0].is_secret);
    }

    #[test]
    fn degraded_key_provider_refuses_to_persist_and_writes_no_plaintext() {
        let dir = TempDir::new("vars-degraded");
        let path = dir.join("reqman.db");
        let plaintext = "SHOULD_NEVER_LAND_4242";

        {
            let db = Db::open(&path).expect("打开数据库");
            let (workspace_id, _) = setup(&db);
            let unavailable = UnavailableKeyProvider;
            let err = set_global(&db, &workspace_id, "apiKey", plaintext, true, &unavailable)
                .expect_err("应进入降级态");
            assert_eq!(err.code, ErrorCode::SecretStoreUnavailable);
            // 变量没有被写入
            assert!(list_globals(&db, &workspace_id, &unavailable).unwrap().is_empty());
        }

        let db = Db::open(&path).expect("重开数据库");
        let (workspace_id, _) = setup(&db);
        assert!(list_globals(&db, &workspace_id, &UnavailableKeyProvider)
            .unwrap()
            .is_empty());

        let bytes = std::fs::read(&path).expect("读取数据库文件");
        assert!(
            !contains_bytes(&bytes, plaintext.as_bytes()),
            "降级态下明文也不能落库"
        );
    }

    #[test]
    fn unreadable_ciphertext_reports_unreadable_not_empty() {
        let db = Db::open_in_memory().expect("打开数据库");
        let writer_key = MemoryKeyProvider::from_bytes([6u8; 32]);
        let (workspace_id, _) = setup(&db);

        let variable = set_global(&db, &workspace_id, "apiKey", "value", true, &writer_key).unwrap();

        // 换一把密钥（模拟设备密钥丢失）
        let other_key = MemoryKeyProvider::from_bytes([7u8; 32]);
        let reloaded = get_variable(&db, &variable.id, &other_key).expect("读取变量");
        assert_eq!(reloaded.current, StoredValue::Unreadable);
        assert!(reloaded.current.plaintext().is_none());
        assert!(reloaded.current.is_unreadable());
    }

    #[test]
    fn globals_are_visible_across_collections_and_survive_reopen() {
        let dir = TempDir::new("vars-globals");
        let path = dir.join("reqman.db");
        let key = MemoryKeyProvider::from_bytes([8u8; 32]);

        let (workspace_id, first, second) = {
            let db = Db::open(&path).expect("打开数据库");
            let (workspace_id, first) = setup(&db);
            let second = workspace::create_collection(&db, &workspace_id, "第二个集合")
                .unwrap()
                .id;
            set_global(&db, &workspace_id, "baseUrl", "https://api.test", false, &key)
                .expect("写入全局变量");
            (workspace_id, first, second)
        };

        let db = Db::open(&path).expect("重开数据库");
        for collection_id in [&first, &second] {
            let layers = load_scope_layers(
                &db,
                &workspace_id,
                Some(collection_id),
                None,
                BTreeMap::new(),
                BTreeMap::new(),
                &key,
            )
            .expect("组装作用域");
            assert_eq!(
                layers.lookup("baseUrl"),
                Some("https://api.test"),
                "全局变量应在该工作区的任一集合中可解析"
            );
        }
    }

    #[test]
    fn only_one_environment_is_active_and_switching_takes_effect_immediately() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([9u8; 32]);
        let (workspace_id, collection_id) = setup(&db);

        let dev = create_environment(&db, &workspace_id, "开发").unwrap();
        let prod = create_environment(&db, &workspace_id, "生产").unwrap();

        upsert_variable(&db, Scope::Environment, &dev.id, "host", false, Some("dev.test"), Some("dev.test"), &key).unwrap();
        upsert_variable(&db, Scope::Environment, &prod.id, "host", false, Some("prod.test"), Some("prod.test"), &key).unwrap();

        set_active_environment(&db, &workspace_id, Some(&dev.id)).unwrap();
        let active = active_environment(&db, &workspace_id).unwrap().unwrap();
        assert_eq!(active.id, dev.id);

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), Some(&active.id), BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), Some("dev.test"));

        // 切换后立即生效
        set_active_environment(&db, &workspace_id, Some(&prod.id)).unwrap();
        let active = active_environment(&db, &workspace_id).unwrap().unwrap();
        assert_eq!(active.id, prod.id);
        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), Some(&active.id), BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), Some("prod.test"));

        // 至多一个活动环境
        let active_count = list_environments(&db, &workspace_id)
            .unwrap()
            .into_iter()
            .filter(|e| e.is_active)
            .count();
        assert_eq!(active_count, 1);
    }

    #[test]
    fn environment_proxy_travels_with_its_environment() {
        let db = Db::open_in_memory().expect("打开数据库");
        let (workspace_id, _) = setup(&db);

        let dev = create_environment(&db, &workspace_id, "开发").unwrap();
        let prod = create_environment(&db, &workspace_id, "生产").unwrap();

        set_environment_proxy(&db, &dev.id, Some(ProxyConfig::manual("http://127.0.0.1:8080")))
            .expect("设置环境代理");

        assert_eq!(
            get_environment(&db, &dev.id).unwrap().proxy.map(|p| p.url),
            Some(Some("http://127.0.0.1:8080".to_string()))
        );
        assert!(
            get_environment(&db, &prod.id).unwrap().proxy.is_none(),
            "另一个环境的代理不应被影响"
        );

        // 切走再切回仍在
        set_active_environment(&db, &workspace_id, Some(&prod.id)).unwrap();
        set_active_environment(&db, &workspace_id, Some(&dev.id)).unwrap();
        assert!(get_environment(&db, &dev.id).unwrap().proxy.is_some());
    }

    #[test]
    fn global_proxy_survives_reopen() {
        let dir = TempDir::new("vars-proxy");
        let path = dir.join("reqman.db");

        {
            let db = Db::open(&path).expect("打开数据库");
            set_global_proxy(&db, Some(ProxyConfig::manual("socks5://127.0.0.1:1080")))
                .expect("设置全局代理");
        }

        let db = Db::open(&path).expect("重开数据库");
        let proxy = global_proxy(&db).expect("读取全局代理").expect("应存在");
        assert_eq!(proxy.url.as_deref(), Some("socks5://127.0.0.1:1080"));
        assert!(proxy.is_effective());

        set_global_proxy(&db, None).expect("清除全局代理");
        assert!(global_proxy(&db).unwrap().is_none());
    }

    #[test]
    fn local_and_data_scopes_are_rejected_by_persistence() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::new();
        let (workspace_id, _) = setup(&db);

        for scope in [Scope::Local, Scope::Data] {
            let err = upsert_variable(&db, scope, &workspace_id, "x", false, Some("1"), Some("1"), &key)
                .expect_err("不应允许落盘");
            assert_eq!(err.code, ErrorCode::InvalidInput);
        }
    }

    #[test]
    fn collection_variables_do_not_leak_to_other_collections() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([11u8; 32]);
        let (workspace_id, first) = setup(&db);
        let second = workspace::create_collection(&db, &workspace_id, "集合 B").unwrap().id;

        upsert_variable(&db, Scope::Collection, &first, "only", false, Some("1"), Some("1"), &key).unwrap();

        let layers = load_scope_layers(&db, &workspace_id, Some(&second), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("only"), None, "集合变量不应外泄到其他集合");
    }

    #[test]
    fn local_scope_shadows_environment_and_global() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([12u8; 32]);
        let (workspace_id, collection_id) = setup(&db);
        let env = create_environment(&db, &workspace_id, "开发").unwrap();

        set_global(&db, &workspace_id, "host", "global.test", false, &key).unwrap();
        upsert_variable(&db, Scope::Environment, &env.id, "host", false, Some("env.test"), Some("env.test"), &key).unwrap();

        let mut local = BTreeMap::new();
        local.insert("host".to_string(), "local.test".to_string());

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), Some(&env.id), local, BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), Some("local.test"));
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }
}
