//! 环境、变量（含工作区级全局变量）与应用设置的持久化。
//!
//! 覆盖 spec: 环境与变量持久化 / 工作区级全局变量与应用设置持久化 /
//! 敏感值不以明文落盘。

use super::model::{setting_keys, Environment, Id, ProxyConfig, Scope, Variable};
use super::{apply_order, from_json, new_id, now, proxy_credentials, require_name, Db};
use crate::error::{AppError, AppResult};
use crate::secrets::{self, KeyProvider, StoredValue};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
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

/// 按给定顺序重写某个工作区下全部环境的顺序（下标即 `sort_order`）。
///
/// 排序本身复用工作区级的 `apply_order`（与 `reorder_collections` 同一套约定），但这里
/// **必须裹在事务里**：`Db::write` 只是「经单写者串行化」，不是事务——底层的 `apply_order`
/// 是逐条 `UPDATE`，中途发现某个 id 不属于该工作区时，前面几条已经提交，于是"整批拒绝"
/// 变成"半批写入"（顺序看起来对、重新读取才发现差了一格）。与 `reorder_variables` 的
/// 整批语义对齐，`write_tx` 让失败整批回滚。
pub fn reorder_environments(db: &Db, workspace_id: &str, ordered_ids: &[Id]) -> AppResult<()> {
    // 与 create_environment 同款：先确认工作区存在，否则空顺序也能"成功"，报错就指不到原因
    super::workspace::get(db, workspace_id)?;

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        apply_order(&tx, "environments", ordered_ids, "workspace_id", workspace_id)?;
        tx.commit()?;
        Ok(())
    })
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
        // 落库形态与对外形态不同：凭据必须以密文落库
        Some(proxy) => Some(proxy_credentials::storage_json(&proxy)?),
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
        description: row.get("description")?,
        is_secret,
        enabled: row.get::<_, i64>("enabled")? != 0,
        sort_order: row.get("sort_order")?,
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
        // 列表顺序就是生效顺序：同名组里最靠下的启用条目胜出（spec: 作用域优先级）
        let mut stmt = conn.prepare(
            "SELECT * FROM variables WHERE scope = ?1 AND owner_id = ?2 ORDER BY sort_order, name",
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

fn require_persisted_scope(scope: Scope) -> AppResult<()> {
    if scope.is_persisted() {
        return Ok(());
    }
    Err(AppError::invalid_input(format!(
        "作用域 {} 不落盘，不能持久化",
        scope.as_str()
    )))
}

/// 空白描述等价于「没有描述」。
fn normalize_description(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 同名组里生效的那一条（按 id）：顺序最靠后的**启用**条目；全组被禁用时取最靠后的一条。
///
/// 这份判定同时被解析层（`layer_for` 跳过禁用）、脚本运行时与只读浮层使用，
/// 改动它必须三处一起改（spec: 作用域优先级）。
fn effective_variable_id(
    conn: &Connection,
    scope: Scope,
    owner_id: &str,
    name: &str,
) -> AppResult<Option<Id>> {
    let pick = |only_enabled: bool| -> AppResult<Option<Id>> {
        let sql = if only_enabled {
            "SELECT id FROM variables WHERE scope = ?1 AND owner_id = ?2 AND name = ?3 AND enabled = 1
             ORDER BY sort_order DESC, rowid DESC LIMIT 1"
        } else {
            "SELECT id FROM variables WHERE scope = ?1 AND owner_id = ?2 AND name = ?3
             ORDER BY sort_order DESC, rowid DESC LIMIT 1"
        };
        Ok(conn
            .query_row(sql, params![scope.as_str(), owner_id, name], |row| {
                row.get::<_, String>(0)
            })
            .optional()?)
    };

    match pick(true)? {
        Some(id) => Ok(Some(id)),
        None => pick(false),
    }
}

/// 新增条目一律落在所属（作用域 + 归属）的末尾（spec: 新增追加到末尾）。
fn next_sort_order(conn: &Connection, scope: Scope, owner_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM variables WHERE scope = ?1 AND owner_id = ?2",
        params![scope.as_str(), owner_id],
        |row| row.get::<_, i64>(0),
    )?)
}

/// 按 id 更新一个变量的若干字段；`None` 表示该字段不变。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VariablePatch {
    pub name: Option<String>,
    /// 同时写入初始值与当前值。
    pub value: Option<String>,
    /// 空字符串等价于清空描述。
    pub description: Option<String>,
    pub is_secret: Option<bool>,
    pub enabled: Option<bool>,
}

/// 切换 secret 标记时把已有取值重编码；值不可读时返回可辨识错误（明文不落库）。
fn reencode_on_toggle(
    raw: &RawVariable,
    is_secret: bool,
    key_provider: &dyn KeyProvider,
) -> AppResult<(Option<String>, Option<String>)> {
    let convert = |existing: &Option<String>, readable: bool| -> AppResult<Option<String>> {
        match existing {
            None => Ok(None),
            Some(encoded) => {
                match decode_value(raw.is_secret, Some(encoded.clone()), readable, key_provider)
                    .plaintext()
                {
                    Some(plain) => Ok(Some(encode_value(is_secret, plain, key_provider)?)),
                    None => Err(AppError::invalid_input(
                        "该变量当前不可解密，无法切换 secret 标记",
                    )),
                }
            }
        }
    };

    Ok((
        convert(&raw.initial_value, raw.initial_readable)?,
        convert(&raw.current_value, raw.current_readable)?,
    ))
}

/// 插入一条变量记录（调用方负责校验作用域与归属）；顺序取该归属的末尾。
///
/// 三条写入路径（新增行、按名 upsert 的新键、导入）都汇到这里，
/// 因此「新条目落在末尾」与「三列新字段的写法」只有一处。
#[allow(clippy::too_many_arguments)]
fn insert_variable_row(
    conn: &Connection,
    scope: Scope,
    owner_id: &str,
    name: &str,
    description: Option<String>,
    initial_encoded: Option<String>,
    current_encoded: Option<String>,
    is_secret: bool,
    enabled: bool,
) -> AppResult<Id> {
    let id = new_id();
    let ts = now();
    let sort_order = next_sort_order(conn, scope, owner_id)?;

    conn.execute(
        "INSERT INTO variables (id, scope, owner_id, name, description, initial_value, current_value,
            is_secret, enabled, initial_readable, current_readable, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 1, ?10, ?11, ?11)",
        params![
            id,
            scope.as_str(),
            owner_id,
            name,
            description,
            initial_encoded,
            current_encoded,
            is_secret as i64,
            enabled as i64,
            sort_order,
            ts,
        ],
    )?;

    Ok(id)
}

/// 新建一个持久化变量，落在所属（作用域 + 归属）的末尾。
///
/// 与 `upsert_variable` 的区别是**永远新增**：界面上的「新增一行」用它，
/// 因此填入一个已存在的名称会新增一条同名条目，而不是覆盖既有条目
/// （spec: 变量表格的重复键与拖拽排序）。
#[allow(clippy::too_many_arguments)]
pub fn create_variable(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    name: &str,
    value: &str,
    is_secret: bool,
    description: Option<&str>,
    key_provider: &dyn KeyProvider,
) -> AppResult<Variable> {
    require_persisted_scope(scope)?;
    let name = require_name(name)?;
    validate_owner(db, scope, owner_id)?;
    let encoded = encode_value(is_secret, value, key_provider)?;
    let description = normalize_description(description);

    let id = db.write(|conn| {
        insert_variable_row(
            conn,
            scope,
            owner_id,
            &name,
            description,
            Some(encoded.clone()),
            Some(encoded),
            is_secret,
            true,
        )
    })?;

    get_variable(db, &id, key_provider)
}

/// 按 id 更新一个变量：名称、值与描述可就地改，启用状态与 secret 标记可就地切换。
///
/// 名称允许与既有条目重名（同名共存）但拒绝空名；改名与排序无关，
/// SHALL NOT 改变该行在列表中的位置。
pub fn update_variable(
    db: &Db,
    id: &str,
    patch: VariablePatch,
    key_provider: &dyn KeyProvider,
) -> AppResult<Variable> {
    let raw = db.read(|conn| raw_variable(conn, id))?;
    let is_secret = patch.is_secret.unwrap_or(raw.is_secret);

    let name = match patch.name.as_deref() {
        Some(candidate) => Some(require_name(candidate)?),
        None => None,
    };
    let description = patch
        .description
        .as_deref()
        .map(|value| normalize_description(Some(value)));

    // 新值优先；没给新值时只有 secret 标记变化才需要重编码
    let (initial_encoded, current_encoded) = match patch.value.as_deref() {
        Some(value) => {
            let encoded = encode_value(is_secret, value, key_provider)?;
            (Some(encoded.clone()), Some(encoded))
        }
        None if is_secret == raw.is_secret => {
            (raw.initial_value.clone(), raw.current_value.clone())
        }
        None => reencode_on_toggle(&raw, is_secret, key_provider)?,
    };

    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE variables SET
                name = COALESCE(?2, name),
                description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
                initial_value = ?5,
                current_value = ?6,
                is_secret = ?7,
                enabled = COALESCE(?8, enabled),
                initial_readable = 1,
                current_readable = 1,
                updated_at = ?9
             WHERE id = ?1",
            params![
                id,
                name,
                patch.description.is_some() as i64,
                description,
                initial_encoded,
                current_encoded,
                is_secret as i64,
                patch.enabled.map(|value| value as i64),
                now(),
            ],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("变量不存在：{}", id)));
        }
        Ok(())
    })?;

    get_variable(db, id, key_provider)
}

/// 按给定顺序重写某个（作用域 + 归属）下全部条目的顺序（下标即 `sort_order`）。
pub fn reorder_variables(
    db: &Db,
    scope: Scope,
    owner_id: &str,
    ordered_ids: &[Id],
) -> AppResult<()> {
    require_persisted_scope(scope)?;
    validate_owner(db, scope, owner_id)?;

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            let changed = tx.execute(
                "UPDATE variables SET sort_order = ?1, updated_at = ?5
                 WHERE id = ?2 AND scope = ?3 AND owner_id = ?4",
                params![index as i64, id, scope.as_str(), owner_id, now()],
            )?;
            if changed == 0 {
                return Err(AppError::not_found(format!(
                    "变量不存在或不属于该归属：{}",
                    id
                )));
            }
        }
        tx.commit()?;
        Ok(())
    })
}

/// 新建或更新一个持久化变量。
///
/// `initial` / `current` 为 `None` 表示「保持原值不变」。名称定位的是**生效的那一条**
/// （同名组里顺序最靠后的启用条目；全组被禁用时取最靠后的一条）；名称不存在时追加到末尾。
/// 脚本经 `pm.*` 写入与导入走这条路径，因此 SHALL NOT 凭空造出同名重复条目
/// （spec: 脚本对变量的读写）。
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
    require_persisted_scope(scope)?;
    let name = require_name(name)?;
    validate_owner(db, scope, owner_id)?;

    let existing = db.read(|conn| effective_variable_id(conn, scope, owner_id, &name))?;

    // 密钥不可用时在这里失败，明文不会落库（design D5 降级态）
    let initial_encoded = initial
        .map(|value| encode_value(is_secret, value, key_provider))
        .transpose()?;
    let current_encoded = current
        .map(|value| encode_value(is_secret, value, key_provider))
        .transpose()?;

    match existing {
        None => {
            let id = db.write(|conn| {
                insert_variable_row(
                    conn,
                    scope,
                    owner_id,
                    &name,
                    None,
                    initial_encoded.clone().or_else(|| Some(String::new())),
                    current_encoded.clone().or_else(|| Some(String::new())),
                    is_secret,
                    true,
                )
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
/// 启用状态与描述由源文档给出，并落在该归属的末尾
/// （spec: 导入集合变量的禁用状态与描述）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert_variable(
    conn: &Connection,
    scope: Scope,
    owner_id: &str,
    name: &str,
    is_secret: bool,
    value: &str,
    enabled: bool,
    description: Option<&str>,
    key_provider: &dyn KeyProvider,
) -> AppResult<()> {
    require_persisted_scope(scope)?;
    let name = require_name(name)?;
    let encoded = encode_value(is_secret, value, key_provider)?;

    insert_variable_row(
        conn,
        scope,
        owner_id,
        &name,
        normalize_description(description),
        Some(encoded.clone()),
        Some(encoded),
        is_secret,
        enabled,
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
        // 落库形态与对外形态不同：凭据必须以密文落库
        Some(proxy) => set_setting(
            db,
            "global",
            setting_keys::GLOBAL_PROXY,
            &proxy_credentials::storage_json(&proxy)?,
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
    // 列表顺序即生效顺序（`ORDER BY sort_order, name`），顺序覆写因此恰好得到
    // 「同名组里最靠下的**启用**条目胜出」；被禁用的条目直接跳过，全组禁用时该名字缺席
    // （spec: 作用域优先级）。
    for variable in variables {
        if !variable.enabled {
            continue;
        }
        // 不可读的 secret 无法参与解析，按未定义处理
        let Some(value) = variable.current.plaintext() else {
            continue;
        };
        // 掩码身份跟随**生效**的那一条：靠下的非 secret 条目会摘掉上面那条留下的名字
        if variable.is_secret {
            secret_names.insert(variable.name.clone());
        } else {
            secret_names.remove(&variable.name);
        }
        map.insert(variable.name.clone(), value.to_string());
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
    fn environments_follow_the_reordered_sequence() {
        let db = Db::open_in_memory().expect("打开数据库");
        let (workspace_id, _) = setup(&db);

        let a = create_environment(&db, &workspace_id, "A").unwrap();
        let b = create_environment(&db, &workspace_id, "B").unwrap();
        let c = create_environment(&db, &workspace_id, "C").unwrap();

        // 故意反序重排：顺序必须跟着传入的下标走，而不是回落到名称序
        reorder_environments(&db, &workspace_id, &[c.id.clone(), a.id.clone(), b.id.clone()])
            .unwrap();

        let rows = list_environments(&db, &workspace_id).unwrap();
        assert_eq!(
            rows.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            vec![c.id, a.id, b.id]
        );
        assert_eq!(
            rows.iter().map(|e| e.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2],
            "下标即 sort_order"
        );
    }

    #[test]
    fn a_reorder_with_a_foreign_environment_writes_nothing() {
        let db = Db::open_in_memory().expect("打开数据库");
        let (workspace_id, _) = setup(&db);
        let other = workspace::create(&db, "另一个工作区").unwrap();

        let a = create_environment(&db, &workspace_id, "A").unwrap();
        let b = create_environment(&db, &workspace_id, "B").unwrap();
        let foreign = create_environment(&db, &other.id, "别处的环境").unwrap();

        // 整批拒绝：合法的前两条也不该被写进去（半批写入正是"有时对、有时差一格"的来源）
        let err = reorder_environments(
            &db,
            &workspace_id,
            &[b.id.clone(), a.id.clone(), foreign.id.clone()],
        )
        .expect_err("不属于该工作区的条目应被拒绝");
        assert_eq!(err.code, ErrorCode::NotFound);

        let rows = list_environments(&db, &workspace_id).unwrap();
        assert_eq!(
            rows.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            vec![a.id, b.id]
        );
        assert_eq!(
            rows.iter().map(|e| e.sort_order).collect::<Vec<_>>(),
            vec![0, 1],
            "失败后不应留下半批写入"
        );
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

    // ---- 顺序与同名组 ----

    /// 建一个环境并返回 id：同名组的用例都在环境作用域上做。
    fn environment(db: &Db, workspace_id: &str) -> String {
        create_environment(db, workspace_id, "同名组环境").unwrap().id
    }

    /// 某归属下按列表顺序的名称。
    fn names_in_order(db: &Db, scope: Scope, owner_id: &str, key: &MemoryKeyProvider) -> Vec<String> {
        list_variables(db, scope, owner_id, key)
            .unwrap()
            .into_iter()
            .map(|variable| variable.name)
            .collect()
    }

    #[test]
    fn list_variables_follows_sort_order_not_name_order() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([20u8; 32]);
        let (workspace_id, collection_id) = setup(&db);
        let env = environment(&db, &workspace_id);

        // 故意按非名称序新增：顺序应当跟随新增（末尾追加），而不是回落到名称序
        for (name, value) in [("zeta", "1"), ("alpha", "2"), ("mid", "3")] {
            create_variable(&db, Scope::Environment, &env, name, value, false, None, &key).unwrap();
        }
        assert_eq!(names_in_order(&db, Scope::Environment, &env, &key), vec!["zeta", "alpha", "mid"]);

        // 重排按下标重写，且只动这个归属
        let ids: Vec<Id> = list_variables(&db, Scope::Environment, &env, &key)
            .unwrap()
            .into_iter()
            .map(|variable| variable.id)
            .collect();
        let reordered = vec![ids[2].clone(), ids[1].clone(), ids[0].clone()];
        reorder_variables(&db, Scope::Environment, &env, &reordered).unwrap();

        let ids_after: Vec<Id> = list_variables(&db, Scope::Environment, &env, &key)
            .unwrap()
            .into_iter()
            .map(|variable| variable.id)
            .collect();
        assert_eq!(ids_after, reordered, "列表顺序应等于重排给定的顺序");
        assert!(
            list_variables(&db, Scope::Collection, &collection_id, &key).unwrap().is_empty(),
            "重排不应波及其它归属"
        );
    }

    #[test]
    fn reorder_variables_rejects_ids_outside_the_owner() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([20u8; 32]);
        let (workspace_id, collection_id) = setup(&db);
        let env = environment(&db, &workspace_id);

        let mine = create_variable(&db, Scope::Environment, &env, "mine", "1", false, None, &key).unwrap();
        let other = create_variable(&db, Scope::Collection, &collection_id, "other", "2", false, None, &key).unwrap();

        let err = reorder_variables(
            &db,
            Scope::Environment,
            &env,
            &[mine.id.clone(), other.id.clone()],
        )
        .expect_err("不属于该归属的条目应被拒绝");
        assert_eq!(err.code, ErrorCode::NotFound);

        // 整批拒绝：合法的那一项也不应被写进去
        let rows = list_variables(&db, Scope::Environment, &env, &key).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sort_order, 0, "失败后不应留下半批写入");
    }

    #[test]
    fn the_last_enabled_row_of_a_group_wins() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([21u8; 32]);
        let (workspace_id, collection_id) = setup(&db);

        // 「新增一行」永远新增，因此同名条目可以共存
        create_variable(&db, Scope::Collection, &collection_id, "host", "first", false, None, &key).unwrap();
        create_variable(&db, Scope::Collection, &collection_id, "host", "second", false, None, &key).unwrap();

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), Some("second"), "靠下的启用条目生效");
    }

    #[test]
    fn disabling_the_effective_row_falls_back_to_the_previous_enabled_row() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([22u8; 32]);
        let (workspace_id, collection_id) = setup(&db);

        create_variable(&db, Scope::Collection, &collection_id, "host", "first", false, None, &key).unwrap();
        let second = create_variable(&db, Scope::Collection, &collection_id, "host", "second", false, None, &key).unwrap();

        update_variable(&db, &second.id, VariablePatch { enabled: Some(false), ..Default::default() }, &key).unwrap();

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), Some("first"), "生效条被禁用后退回上一条可用的");
    }

    #[test]
    fn a_fully_disabled_group_is_undefined() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([23u8; 32]);
        let (workspace_id, collection_id) = setup(&db);

        let first = create_variable(&db, Scope::Collection, &collection_id, "host", "first", false, None, &key).unwrap();
        let second = create_variable(&db, Scope::Collection, &collection_id, "host", "second", false, None, &key).unwrap();

        for id in [first.id, second.id] {
            update_variable(&db, &id, VariablePatch { enabled: Some(false), ..Default::default() }, &key).unwrap();
        }

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("host"), None, "全组禁用时该名字按未定义处理");
    }

    #[test]
    fn masking_follows_the_effective_row() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([24u8; 32]);
        let (workspace_id, collection_id) = setup(&db);

        create_variable(&db, Scope::Collection, &collection_id, "token", "plain-above", false, None, &key).unwrap();
        let secret = create_variable(&db, Scope::Collection, &collection_id, "token", "secret-below", true, None, &key).unwrap();

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("token"), Some("secret-below"));
        assert!(layers.is_secret("token"), "生效条是 secret 时该名字按 secret 处理");

        // 把生效条改成非 secret：掩码身份应随之摘掉
        update_variable(&db, &secret.id, VariablePatch { is_secret: Some(false), ..Default::default() }, &key).unwrap();

        let layers = load_scope_layers(&db, &workspace_id, Some(&collection_id), None, BTreeMap::new(), BTreeMap::new(), &key).unwrap();
        assert_eq!(layers.lookup("token"), Some("secret-below"), "切换 secret 不改变取值");
        assert!(!layers.is_secret("token"), "生效条非 secret 时不应再掩码");
    }

    // ---- 按名写入（脚本与导入） ----

    #[test]
    fn upsert_targets_the_effective_row_and_never_adds_duplicates() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([25u8; 32]);
        let (_, collection_id) = setup(&db);

        create_variable(&db, Scope::Collection, &collection_id, "host", "first", false, None, &key).unwrap();
        create_variable(&db, Scope::Collection, &collection_id, "host", "second", false, None, &key).unwrap();

        upsert_variable(&db, Scope::Collection, &collection_id, "host", false, Some("patched"), Some("patched"), &key).unwrap();

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows.len(), 2, "按名写入不应凭空造出同名条目");
        assert_eq!(rows[0].current.plaintext(), Some("first"), "被遮蔽的那条不应被改动");
        assert_eq!(rows[1].current.plaintext(), Some("patched"), "写入落在生效的那一条");

        // 新名称追加到末尾
        let created = upsert_variable(&db, Scope::Collection, &collection_id, "added", false, Some("v"), Some("v"), &key).unwrap();
        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2].id, created.id, "新名称应追加到末尾");
        assert_eq!(rows[2].sort_order, 2);
    }

    #[test]
    fn upsert_writes_the_last_row_when_the_whole_group_is_disabled() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([26u8; 32]);
        let (_, collection_id) = setup(&db);

        let first = create_variable(&db, Scope::Collection, &collection_id, "host", "first", false, None, &key).unwrap();
        let second = create_variable(&db, Scope::Collection, &collection_id, "host", "second", false, None, &key).unwrap();
        for id in [first.id.clone(), second.id.clone()] {
            update_variable(&db, &id, VariablePatch { enabled: Some(false), ..Default::default() }, &key).unwrap();
        }

        upsert_variable(&db, Scope::Collection, &collection_id, "host", false, Some("patched"), Some("patched"), &key).unwrap();

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows.len(), 2, "全组禁用时按名写入也不新增条目");
        assert_eq!(rows[0].current.plaintext(), Some("first"));
        assert_eq!(rows[1].current.plaintext(), Some("patched"), "落在最靠后的一条");
        assert!(!rows[1].enabled, "写入不改变启用状态");
    }

    // ---- 按 id 更新（编辑器） ----

    #[test]
    fn create_variable_appends_and_allows_duplicate_names() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([27u8; 32]);
        let (_, collection_id) = setup(&db);

        let first = create_variable(&db, Scope::Collection, &collection_id, "dup", "a", false, Some("第一条"), &key).unwrap();
        let second = create_variable(&db, Scope::Collection, &collection_id, "dup", "b", false, None, &key).unwrap();

        assert_eq!(first.sort_order, 0);
        assert_eq!(second.sort_order, 1, "新增落在末尾");
        assert_eq!(first.description.as_deref(), Some("第一条"));
        assert_eq!(second.description, None);

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows.len(), 2, "同名条目共存");
    }

    #[test]
    fn update_variable_renames_by_id_and_accepts_an_existing_name() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([28u8; 32]);
        let (_, collection_id) = setup(&db);

        create_variable(&db, Scope::Collection, &collection_id, "taken", "x", false, None, &key).unwrap();
        let target = create_variable(&db, Scope::Collection, &collection_id, "mine", "y", false, None, &key).unwrap();

        let renamed = update_variable(
            &db,
            &target.id,
            VariablePatch { name: Some("taken".to_string()), ..Default::default() },
            &key,
        )
        .expect("改成一个已存在的名称应被接受");

        assert_eq!(renamed.name, "taken");
        assert_eq!(renamed.sort_order, 1, "改名不改变位置");
        assert_eq!(renamed.current.plaintext(), Some("y"), "改名不动取值");

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].id, target.id, "改名的条目仍留在原位置");
    }

    #[test]
    fn update_variable_rejects_an_empty_name() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([29u8; 32]);
        let (_, collection_id) = setup(&db);

        let variable = create_variable(&db, Scope::Collection, &collection_id, "keep", "v", false, None, &key).unwrap();
        let err = update_variable(
            &db,
            &variable.id,
            VariablePatch { name: Some("   ".to_string()), ..Default::default() },
            &key,
        )
        .expect_err("空名称应被拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert_eq!(rows[0].name, "keep", "拒绝后名称保持原值");
    }

    #[test]
    fn update_variable_writes_and_clears_the_description() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([30u8; 32]);
        let (_, collection_id) = setup(&db);

        let variable = create_variable(&db, Scope::Collection, &collection_id, "doc", "v", false, None, &key).unwrap();

        let described = update_variable(
            &db,
            &variable.id,
            VariablePatch { description: Some("这是描述".to_string()), ..Default::default() },
            &key,
        )
        .unwrap();
        assert_eq!(described.description.as_deref(), Some("这是描述"));

        let cleared = update_variable(
            &db,
            &variable.id,
            VariablePatch { description: Some(String::new()), ..Default::default() },
            &key,
        )
        .unwrap();
        assert_eq!(cleared.description, None, "空字符串等价于清空描述");

        // 不传描述时保持原样
        update_variable(
            &db,
            &variable.id,
            VariablePatch { description: Some("保留".to_string()), ..Default::default() },
            &key,
        )
        .unwrap();
        let kept = update_variable(
            &db,
            &variable.id,
            VariablePatch { enabled: Some(true), ..Default::default() },
            &key,
        )
        .unwrap();
        assert_eq!(kept.description.as_deref(), Some("保留"));
    }

    #[test]
    fn update_variable_refuses_a_secret_toggle_when_the_value_is_unreadable() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([31u8; 32]);
        let (_, collection_id) = setup(&db);

        let secret = create_variable(&db, Scope::Collection, &collection_id, "token", "s3cret", true, None, &key).unwrap();
        let locked = UnavailableKeyProvider;

        let err = update_variable(
            &db,
            &secret.id,
            VariablePatch { is_secret: Some(false), ..Default::default() },
            &locked,
        )
        .expect_err("值不可读时不应允许切换 secret 标记");
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(err.message.contains("不可解密"), "错误应说明原因：{}", err.message);

        let rows = list_variables(&db, Scope::Collection, &collection_id, &key).unwrap();
        assert!(rows[0].is_secret, "拒绝后该变量仍是 secret");
        assert_eq!(rows[0].current.plaintext(), Some("s3cret"), "取值未被破坏");
    }

    #[test]
    fn update_variable_toggles_secret_without_changing_the_value() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([32u8; 32]);
        let (_, collection_id) = setup(&db);

        let variable = create_variable(&db, Scope::Collection, &collection_id, "token", "plain-text", false, None, &key).unwrap();

        let toggled = update_variable(
            &db,
            &variable.id,
            VariablePatch { is_secret: Some(true), ..Default::default() },
            &key,
        )
        .unwrap();
        assert!(toggled.is_secret);
        assert_eq!(toggled.current.plaintext(), Some("plain-text"), "切换标记不改变取值");

        // 落库形态已加密：库里读不到明文
        let raw = db
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT current_value FROM variables WHERE id = ?1",
                    [&toggled.id],
                    |row| row.get::<_, Option<String>>(0),
                )?)
            })
            .unwrap()
            .unwrap_or_default();
        assert!(!contains_bytes(raw.as_bytes(), b"plain-text"), "secret 值不应以明文落库");
    }

    #[test]
    fn create_variable_rejects_an_empty_name() {
        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::from_bytes([33u8; 32]);
        let (_, collection_id) = setup(&db);

        let err = create_variable(&db, Scope::Collection, &collection_id, "  ", "v", false, None, &key)
            .expect_err("空名称应被拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
        assert!(list_variables(&db, Scope::Collection, &collection_id, &key).unwrap().is_empty());
    }
}
