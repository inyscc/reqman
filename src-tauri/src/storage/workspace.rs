//! 工作区、集合、文件夹的组织与顺序（spec: 本地多工作区 / 集合层级组织）。

use super::model::{AuthConfig, Collection, Folder, Id, SavedRequest, Workspace};
use super::{apply_order, from_json, new_id, now, require_name, to_json, Db};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

const DEFAULT_WORKSPACE_NAME: &str = "默认工作区";
const ACTIVE_WORKSPACE_KEY: &str = "active_workspace_id";

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

fn workspace_from_row(row: &Row<'_>) -> rusqlite::Result<Workspace> {
    Ok(Workspace {
        id: row.get("id")?,
        name: row.get("name")?,
    })
}

pub fn list(db: &Db) -> AppResult<Vec<Workspace>> {
    db.read(|conn| {
        let mut stmt = conn.prepare("SELECT id, name FROM workspaces ORDER BY created_at, id")?;
        let rows = stmt.query_map([], workspace_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get(db: &Db, id: &str) -> AppResult<Workspace> {
    db.read(|conn| {
        conn.query_row(
            "SELECT id, name FROM workspaces WHERE id = ?1",
            [id],
            workspace_from_row,
        )
        .map_err(AppError::from)
    })
}

fn insert_workspace(conn: &Connection, id: &str, name: &str) -> AppResult<Workspace> {
    let ts = now();
    conn.execute(
        "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, name, ts],
    )?;
    Ok(Workspace {
        id: id.to_string(),
        name: name.to_string(),
    })
}

pub fn create(db: &Db, name: &str) -> AppResult<Workspace> {
    let name = require_name(name)?;
    let id = new_id();
    db.write(|conn| insert_workspace(conn, &id, &name))
}

pub fn rename(db: &Db, id: &str, name: &str) -> AppResult<Workspace> {
    let name = require_name(name)?;
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("工作区不存在：{}", id)));
        }
        Ok(Workspace {
            id: id.to_string(),
            name,
        })
    })
}

/// 删除工作区。若删除后不再有任何工作区，自动补一个默认工作区，
/// 以维持「至少存在一个可用工作区」这一不变量。
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let changed = tx.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("工作区不存在：{}", id)));
        }

        let remaining: i64 = tx.query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))?;
        if remaining == 0 {
            insert_workspace(&tx, &new_id(), DEFAULT_WORKSPACE_NAME)?;
        }

        // 活动工作区被删掉时改指向现存的第一项
        let active: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE scope = 'global' AND key = ?1",
                [ACTIVE_WORKSPACE_KEY],
                |row| row.get(0),
            )
            .ok();
        let still_valid = match active {
            Some(ref active_id) => tx
                .query_row(
                    "SELECT COUNT(*) FROM workspaces WHERE id = ?1",
                    [active_id],
                    |row| row.get::<_, i64>(0),
                )?
                > 0,
            None => false,
        };
        if !still_valid {
            let first: String =
                tx.query_row("SELECT id FROM workspaces ORDER BY created_at, id", [], |row| {
                    row.get(0)
                })?;
            upsert_active(&tx, &first)?;
        }

        tx.commit()?;
        Ok(())
    })
}

/// 切换活动工作区。
pub fn set_active(db: &Db, id: &str) -> AppResult<()> {
    get(db, id)?;
    db.write(|conn| upsert_active(conn, id))
}

fn upsert_active(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (scope, key, value, updated_at) VALUES ('global', ?1, ?2, ?3)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![ACTIVE_WORKSPACE_KEY, id, now()],
    )?;
    Ok(())
}

pub fn active(db: &Db) -> AppResult<Option<Workspace>> {
    db.read(|conn| {
        let id: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE scope = 'global' AND key = ?1",
                [ACTIVE_WORKSPACE_KEY],
                |row| row.get(0),
            )
            .ok();
        match id {
            Some(id) => match conn.query_row(
                "SELECT id, name FROM workspaces WHERE id = ?1",
                [id.as_str()],
                workspace_from_row,
            ) {
                Ok(ws) => Ok(Some(ws)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(err) => Err(err.into()),
            },
            None => Ok(None),
        }
    })
}

/// 保证至少存在一个工作区，并保证存在活动工作区。
pub fn ensure_default_workspace(db: &Db) -> AppResult<Workspace> {
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM workspaces ORDER BY created_at, id",
                [],
                |row| row.get(0),
            )
            .ok();

        let workspace = match existing {
            Some(id) => Workspace {
                id: id.clone(),
                name: tx.query_row("SELECT name FROM workspaces WHERE id = ?1", [&id], |row| {
                    row.get(0)
                })?,
            },
            None => insert_workspace(&tx, &new_id(), DEFAULT_WORKSPACE_NAME)?,
        };

        let has_active: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE scope = 'global' AND key = ?1",
                [ACTIVE_WORKSPACE_KEY],
                |row| row.get::<_, i64>(0),
            )?
            > 0;
        if !has_active {
            upsert_active(&tx, &workspace.id)?;
        }

        tx.commit()?;
        Ok(workspace)
    })
}

// ---------------------------------------------------------------------------
// 集合
// ---------------------------------------------------------------------------

pub(crate) fn collection_from_row(row: &Row<'_>) -> rusqlite::Result<Collection> {
    let auth_raw: String = row.get("auth")?;
    Ok(Collection {
        id: row.get("id")?,
        workspace_id: row.get("workspace_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        auth: from_json(&auth_raw).unwrap_or_else(|_| AuthConfig::default()),
        pre_request_script: row.get("pre_request_script")?,
        test_script: row.get("test_script")?,
        sort_order: row.get("sort_order")?,
    })
}

pub fn list_collections(db: &Db, workspace_id: &str) -> AppResult<Vec<Collection>> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM collections WHERE workspace_id = ?1 ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([workspace_id], collection_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get_collection(db: &Db, id: &str) -> AppResult<Collection> {
    db.read(|conn| {
        conn.query_row("SELECT * FROM collections WHERE id = ?1", [id], collection_from_row)
            .map_err(AppError::from)
    })
}

pub fn create_collection(db: &Db, workspace_id: &str, name: &str) -> AppResult<Collection> {
    let name = require_name(name)?;
    get(db, workspace_id)?;
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM collections WHERE workspace_id = ?1",
            [workspace_id],
            |row| row.get(0),
        )?;
        let collection = Collection {
            id: new_id(),
            workspace_id: workspace_id.to_string(),
            name,
            description: None,
            auth: AuthConfig::default(),
            pre_request_script: None,
            test_script: None,
            sort_order: next,
        };
        insert_collection(&tx, &collection)?;
        tx.commit()?;
        Ok(collection)
    })
}

/// 以显式字段插入一条集合。
///
/// 接受任意 `Connection`，因为导入需要在**单个**事务里写入整份文档
/// （spec: 导入的原子性与失败处置）。
pub(crate) fn insert_collection(conn: &Connection, collection: &Collection) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO collections
            (id, workspace_id, name, description, auth, pre_request_script, test_script,
             sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            collection.id,
            collection.workspace_id,
            collection.name,
            collection.description,
            to_json(&collection.auth)?,
            collection.pre_request_script,
            collection.test_script,
            collection.sort_order,
            ts,
        ],
    )?;
    Ok(())
}

pub fn rename_collection(db: &Db, id: &str, name: &str) -> AppResult<Collection> {
    let name = require_name(name)?;
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE collections SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("集合不存在：{}", id)));
        }
        Ok(())
    })?;
    get_collection(db, id)
}

/// 更新集合级前后置脚本（spec: 脚本编辑与保存）。`None` 表示清空。
pub fn set_collection_script(
    db: &Db,
    id: &str,
    pre_request_script: Option<&str>,
    test_script: Option<&str>,
) -> AppResult<Collection> {
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE collections SET pre_request_script = ?2, test_script = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, pre_request_script, test_script, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("集合不存在：{}", id)));
        }
        Ok(())
    })?;
    get_collection(db, id)
}

pub fn delete_collection(db: &Db, id: &str) -> AppResult<()> {
    db.write(|conn| {
        let changed = conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("集合不存在：{}", id)));
        }
        Ok(())
    })
}

pub fn reorder_collections(db: &Db, workspace_id: &str, ordered_ids: &[Id]) -> AppResult<()> {
    db.write(|conn| apply_order(conn, "collections", ordered_ids, "workspace_id", workspace_id))
}

// ---------------------------------------------------------------------------
// 文件夹
// ---------------------------------------------------------------------------

pub(crate) fn folder_from_row(row: &Row<'_>) -> rusqlite::Result<Folder> {
    let auth_raw: String = row.get("auth")?;
    Ok(Folder {
        id: row.get("id")?,
        collection_id: row.get("collection_id")?,
        parent_folder_id: row.get("parent_folder_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        auth: from_json(&auth_raw).unwrap_or_else(|_| AuthConfig::default()),
        pre_request_script: row.get("pre_request_script")?,
        test_script: row.get("test_script")?,
        sort_order: row.get("sort_order")?,
    })
}

pub fn list_folders(db: &Db, collection_id: &str) -> AppResult<Vec<Folder>> {
    db.read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM folders WHERE collection_id = ?1 ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([collection_id], folder_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn get_folder(db: &Db, id: &str) -> AppResult<Folder> {
    db.read(|conn| {
        conn.query_row("SELECT * FROM folders WHERE id = ?1", [id], folder_from_row)
            .map_err(AppError::from)
    })
}

pub fn create_folder(
    db: &Db,
    collection_id: &str,
    parent_folder_id: Option<&str>,
    name: &str,
) -> AppResult<Folder> {
    let name = require_name(name)?;
    get_collection(db, collection_id)?;
    if let Some(parent) = parent_folder_id {
        let parent_folder = get_folder(db, parent)?;
        if parent_folder.collection_id != collection_id {
            return Err(AppError::invalid_input("父文件夹不属于该集合"));
        }
    }

    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        let next: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders
             WHERE collection_id = ?1 AND parent_folder_id IS ?2",
            params![collection_id, parent_folder_id],
            |row| row.get(0),
        )?;
        let folder = Folder {
            id: new_id(),
            collection_id: collection_id.to_string(),
            parent_folder_id: parent_folder_id.map(|s| s.to_string()),
            name,
            description: None,
            auth: AuthConfig::default(),
            pre_request_script: None,
            test_script: None,
            sort_order: next,
        };
        insert_folder(&tx, &folder)?;
        tx.commit()?;
        Ok(folder)
    })
}

/// 以显式字段插入一条文件夹（导入在单个事务内使用）。
pub(crate) fn insert_folder(conn: &Connection, folder: &Folder) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO folders
            (id, collection_id, parent_folder_id, name, description, auth,
             pre_request_script, test_script, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            folder.id,
            folder.collection_id,
            folder.parent_folder_id,
            folder.name,
            folder.description,
            to_json(&folder.auth)?,
            folder.pre_request_script,
            folder.test_script,
            folder.sort_order,
            ts,
        ],
    )?;
    Ok(())
}

pub fn rename_folder(db: &Db, id: &str, name: &str) -> AppResult<Folder> {
    let name = require_name(name)?;
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE folders SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("文件夹不存在：{}", id)));
        }
        Ok(())
    })?;
    get_folder(db, id)
}

/// 更新文件夹级前后置脚本（spec: 脚本编辑与保存）。`None` 表示清空。
pub fn set_folder_script(
    db: &Db,
    id: &str,
    pre_request_script: Option<&str>,
    test_script: Option<&str>,
) -> AppResult<Folder> {
    db.write(|conn| {
        let changed = conn.execute(
            "UPDATE folders SET pre_request_script = ?2, test_script = ?3, updated_at = ?4
             WHERE id = ?1",
            params![id, pre_request_script, test_script, now()],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!("文件夹不存在：{}", id)));
        }
        Ok(())
    })?;
    get_folder(db, id)
}

pub fn delete_folder(db: &Db, id: &str) -> AppResult<()> {
    db.write(|conn| {
        let changed = conn.execute("DELETE FROM folders WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!("文件夹不存在：{}", id)));
        }
        Ok(())
    })
}

/// 移动文件夹到新的父级（`None` 表示移到集合根）。拒绝移入自身的后代，避免成环。
pub fn move_folder(db: &Db, id: &str, new_parent: Option<&str>) -> AppResult<Folder> {
    let folder = get_folder(db, id)?;

    if let Some(parent_id) = new_parent {
        if parent_id == id {
            return Err(AppError::new(
                crate::error::ErrorCode::Conflict,
                "不能把文件夹移动到自身",
            ));
        }
        let parent = get_folder(db, parent_id)?;
        if parent.collection_id != folder.collection_id {
            return Err(AppError::invalid_input("父文件夹不属于该集合"));
        }
        if is_descendant(db, &folder.id, &parent.id)? {
            return Err(AppError::new(
                crate::error::ErrorCode::Conflict,
                "不能把文件夹移动到它自己的子文件夹中",
            ));
        }
    }

    db.write(|conn| {
        conn.execute(
            "UPDATE folders SET parent_folder_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, new_parent, now()],
        )?;
        Ok(())
    })?;
    get_folder(db, id)
}

fn is_descendant(db: &Db, ancestor_id: &str, candidate_id: &str) -> AppResult<bool> {
    db.read(|conn| {
        let mut current = Some(candidate_id.to_string());
        let mut hops = 0usize;
        while let Some(id) = current {
            if id == ancestor_id {
                return Ok(true);
            }
            hops += 1;
            if hops > 512 {
                return Err(AppError::new(
                    crate::error::ErrorCode::Conflict,
                    "文件夹层级过深或存在环",
                ));
            }
            let parent: Option<String> = conn
                .query_row(
                    "SELECT parent_folder_id FROM folders WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(AppError::from)?;
            current = parent;
        }
        Ok(false)
    })
}

/// 重写某个父级下全部子条目的顺序：下标即 `sort_order`。
///
/// 入参是**一个有序列表**（每项带种类），而不是「文件夹列表 + 请求列表」两个独立序列——
/// 后者给两类各自从 0 编号，表达不出「目录与请求交错」的顺序，而 `collection_tree`
/// 恰恰是按共享的 `sort_order` 混排的。
///
/// 逐项校验「该 id 以该种类挂在这个父级下」，任一不满足则整批回滚。
pub fn reorder_children(
    db: &Db,
    collection_id: &str,
    parent_folder_id: Option<&str>,
    items: &[(Id, NodeKind)],
) -> AppResult<()> {
    db.write_tx(|conn| {
        let tx = conn.transaction()?;
        for (index, (id, kind)) in items.iter().enumerate() {
            let changed = match kind {
                NodeKind::Folder => tx.execute(
                    "UPDATE folders SET sort_order = ?1 WHERE id = ?2 AND collection_id = ?3 AND parent_folder_id IS ?4",
                    params![index as i64, id, collection_id, parent_folder_id],
                )?,
                NodeKind::Request => tx.execute(
                    "UPDATE requests SET sort_order = ?1 WHERE id = ?2 AND collection_id = ?3 AND folder_id IS ?4",
                    params![index as i64, id, collection_id, parent_folder_id],
                )?,
            };
            if changed == 0 {
                return Err(AppError::not_found(format!(
                    "条目不存在或不属于该父级：{}",
                    id
                )));
            }
        }
        tx.commit()?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// 树
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Folder,
    Request,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    pub kind: NodeKind,
    pub id: Id,
    pub name: String,
    pub sort_order: i64,
    pub children: Vec<TreeNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<SavedRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionTree {
    pub collection: Collection,
    pub children: Vec<TreeNode>,
}

/// 组装集合的完整层级，顺序与持久化的 `sort_order` 一致。
pub fn collection_tree(db: &Db, collection_id: &str) -> AppResult<CollectionTree> {
    let collection = get_collection(db, collection_id)?;
    let folders = list_folders(db, collection_id)?;
    let requests = super::requests::list_requests(db, collection_id)?;

    fn build_nodes(
        parent: Option<&str>,
        folders: &[Folder],
        requests: &[SavedRequest],
    ) -> Vec<TreeNode> {
        let mut nodes: Vec<TreeNode> = Vec::new();

        for folder in folders
            .iter()
            .filter(|f| f.parent_folder_id.as_deref() == parent)
        {
            nodes.push(TreeNode {
                kind: NodeKind::Folder,
                id: folder.id.clone(),
                name: folder.name.clone(),
                sort_order: folder.sort_order,
                children: build_nodes(Some(&folder.id), folders, requests),
                request: None,
            });
        }

        for request in requests
            .iter()
            .filter(|r| r.folder_id.as_deref() == parent)
        {
            nodes.push(TreeNode {
                kind: NodeKind::Request,
                id: request.id.clone(),
                name: request.name.clone(),
                sort_order: request.sort_order,
                children: Vec::new(),
                request: Some(request.clone()),
            });
        }

        // 文件夹与请求混排：按 sort_order 稳定排序，同序号时文件夹在前
        nodes.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| match (a.kind, b.kind) {
                    (NodeKind::Folder, NodeKind::Request) => std::cmp::Ordering::Less,
                    (NodeKind::Request, NodeKind::Folder) => std::cmp::Ordering::Greater,
                    _ => a.name.cmp(&b.name),
                })
        });
        nodes
    }

    Ok(CollectionTree {
        children: build_nodes(None, &folders, &requests),
        collection,
    })
}

/// 工作区下所有集合的树。
pub fn workspace_tree(db: &Db, workspace_id: &str) -> AppResult<Vec<CollectionTree>> {
    let collections = list_collections(db, workspace_id)?;
    let mut out = Vec::with_capacity(collections.len());
    for collection in collections {
        out.push(collection_tree(db, &collection.id)?);
    }
    Ok(out)
}

/// 供集合树渲染的既有 JSON 字段兼容：把 folder 的 auth 写回（内部使用）。
#[allow(dead_code)]
fn _touch(_: &AuthConfig) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::requests;

    #[test]
    fn first_start_creates_a_default_workspace() {
        let db = Db::open_in_memory().expect("打开数据库");
        let list = self::list(&db).expect("列出工作区");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, DEFAULT_WORKSPACE_NAME);

        let active = active(&db).expect("取活动工作区");
        assert_eq!(active.map(|w| w.id), Some(list[0].id.clone()));
    }

    #[test]
    fn reopening_keeps_a_single_default_workspace() {
        let dir = crate::testutil::TempDir::new("ws-reopen");
        let path = dir.join("reqman.db");

        let first = {
            let db = Db::open(&path).expect("打开数据库");
            self::list(&db).unwrap()
        };
        let second = {
            let db = Db::open(&path).expect("重开数据库");
            self::list(&db).unwrap()
        };
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].id, second[0].id, "重复启动不应新建工作区");
    }

    #[test]
    fn two_workspaces_do_not_leak_into_each_other() {
        let db = Db::open_in_memory().expect("打开数据库");
        let a = self::list(&db).unwrap().remove(0);
        let b = create(&db, "工作区 B").expect("创建工作区");

        let collection_a = create_collection(&db, &a.id, "集合 A").expect("创建集合");
        let collection_b = create_collection(&db, &b.id, "集合 B").expect("创建集合");
        requests::create_request(&db, &collection_a.id, None, "请求 A", "GET", "https://a.test")
            .expect("创建请求");

        let list_a = list_collections(&db, &a.id).unwrap();
        let list_b = list_collections(&db, &b.id).unwrap();

        assert_eq!(list_a.len(), 1);
        assert_eq!(list_a[0].name, "集合 A");
        assert_eq!(list_b.len(), 1);
        assert_eq!(list_b[0].name, "集合 B");
        assert_ne!(collection_a.id, collection_b.id);

        assert_eq!(requests::list_requests(&db, &collection_a.id).unwrap().len(), 1);
        assert_eq!(requests::list_requests(&db, &collection_b.id).unwrap().len(), 0);
    }

    #[test]
    fn deleting_the_last_workspace_keeps_the_invariant() {
        let db = Db::open_in_memory().expect("打开数据库");
        let only = self::list(&db).unwrap().remove(0);

        delete(&db, &only.id).expect("删除工作区");

        let remaining = self::list(&db).unwrap();
        assert_eq!(remaining.len(), 1, "应自动补一个默认工作区");
        assert_ne!(remaining[0].id, only.id);
        assert!(active(&db).unwrap().is_some(), "活动工作区应指向现存工作区");
    }

    #[test]
    fn renaming_workspace_persists() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        rename(&db, &ws.id, "改名后").expect("重命名");
        assert_eq!(get(&db, &ws.id).unwrap().name, "改名后");
    }

    #[test]
    fn nested_folders_survive_reopen_with_same_structure_and_order() {
        let dir = crate::testutil::TempDir::new("ws-nesting");
        let path = dir.join("reqman.db");
        let db = Db::open(&path).expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let outer = create_folder(&db, &collection.id, None, "外层").unwrap();
        let inner = create_folder(&db, &collection.id, Some(&outer.id), "内层").unwrap();
        requests::create_request(&db, &collection.id, Some(&inner.id), "深层请求", "GET", "https://x.test")
            .unwrap();
        // 同级重名条目
        requests::create_request(&db, &collection.id, Some(&inner.id), "深层请求", "POST", "https://y.test")
            .unwrap();

        let before = collection_tree(&db, &collection.id).unwrap();
        drop(db);

        let reopened = Db::open(&path).expect("重开数据库");
        let after = collection_tree(&reopened, &collection.id).unwrap();

        assert_eq!(before, after, "层级、归属与顺序应完全一致");
        assert_eq!(after.children.len(), 1);
        assert_eq!(after.children[0].name, "外层");
        assert_eq!(after.children[0].children.len(), 1);
        assert_eq!(after.children[0].children[0].name, "内层");
        assert_eq!(after.children[0].children[0].children.len(), 2);
    }

    #[test]
    fn collection_and_folder_descriptions_survive_reopen() {
        use crate::storage::model::{Collection, Folder};

        let dir = crate::testutil::TempDir::new("descriptions");
        let path = dir.join("reqman.db");

        {
            let db = Db::open(&path).expect("打开数据库");
            let ws = self::list(&db).unwrap().remove(0);

            let collection = Collection {
                id: "c-desc".into(),
                workspace_id: ws.id.clone(),
                name: "带描述的集合".into(),
                description: Some("集合说明".into()),
                auth: AuthConfig::default(),
                pre_request_script: None,
                test_script: None,
                sort_order: 0,
            };
            let folder = Folder {
                id: "f-desc".into(),
                collection_id: collection.id.clone(),
                parent_folder_id: None,
                name: "带描述的文件夹".into(),
                description: Some("文件夹说明".into()),
                auth: AuthConfig::default(),
                pre_request_script: None,
                test_script: None,
                sort_order: 0,
            };

            db.write_tx(|conn| {
                let tx = conn.transaction()?;
                insert_collection(&tx, &collection)?;
                insert_folder(&tx, &folder)?;
                tx.commit()?;
                Ok(())
            })
            .expect("写入集合与文件夹");
        }

        let db = Db::open(&path).expect("重开数据库");
        assert_eq!(
            get_collection(&db, "c-desc").unwrap().description.as_deref(),
            Some("集合说明")
        );
        assert_eq!(
            get_folder(&db, "f-desc").unwrap().description.as_deref(),
            Some("文件夹说明")
        );
    }

    #[test]
    fn same_name_siblings_are_stored_independently() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let first = requests::create_request(&db, &collection.id, None, "同名", "GET", "https://a.test")
            .unwrap();
        let second = requests::create_request(&db, &collection.id, None, "同名", "POST", "https://b.test")
            .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(requests::get_request(&db, &first.id).unwrap().method, "GET");
        assert_eq!(requests::get_request(&db, &second.id).unwrap().method, "POST");
    }

    #[test]
    fn reorder_changes_persisted_order() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let a = requests::create_request(&db, &collection.id, None, "A", "GET", "https://a.test").unwrap();
        let b = requests::create_request(&db, &collection.id, None, "B", "GET", "https://b.test").unwrap();

        reorder_children(
            &db,
            &collection.id,
            None,
            &[
                (b.id.clone(), NodeKind::Request),
                (a.id.clone(), NodeKind::Request),
            ],
        )
        .unwrap();

        let tree = collection_tree(&db, &collection.id).unwrap();
        let names: Vec<_> = tree.children.iter().map(|n| n.name.clone()).collect();
        assert_eq!(names, vec!["B", "A"]);
    }

    #[test]
    fn reorder_children_keeps_folders_and_requests_interleaved() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let folder = create_folder(&db, &collection.id, None, "目录").unwrap();
        let first = requests::create_request(&db, &collection.id, None, "P", "GET", "https://p.test").unwrap();
        let second = requests::create_request(&db, &collection.id, None, "Q", "GET", "https://q.test").unwrap();

        // 请求、目录、请求——顺序本身没法用「两个独立序列」表达
        reorder_children(
            &db,
            &collection.id,
            None,
            &[
                (first.id.clone(), NodeKind::Request),
                (folder.id.clone(), NodeKind::Folder),
                (second.id.clone(), NodeKind::Request),
            ],
        )
        .unwrap();

        let tree = collection_tree(&db, &collection.id).unwrap();
        let shape: Vec<_> = tree
            .children
            .iter()
            .map(|node| match node.kind {
                NodeKind::Folder => "folder",
                NodeKind::Request => "request",
            })
            .collect();
        assert_eq!(shape, vec!["request", "folder", "request"]);
    }

    #[test]
    fn reorder_children_rejects_entries_outside_the_parent() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();
        let folder = create_folder(&db, &collection.id, None, "目录").unwrap();
        let inside = requests::create_request(&db, &collection.id, Some(&folder.id), "内部", "GET", "https://i.test").unwrap();

        // 这个请求挂在目录下，不属于集合根：整批要拒绝，且不能留下半批写入
        let err = reorder_children(
            &db,
            &collection.id,
            None,
            &[(inside.id.clone(), NodeKind::Request)],
        )
        .expect_err("不属于该父级的条目应被拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);

        let tree = collection_tree(&db, &collection.id).unwrap();
        assert_eq!(tree.children.len(), 1, "集合根下只有那个目录");
        assert_eq!(tree.children[0].kind, NodeKind::Folder);
        assert_eq!(tree.children[0].children.len(), 1, "请求仍在目录里");
    }

    #[test]
    fn moving_a_folder_into_its_own_descendant_is_rejected() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let outer = create_folder(&db, &collection.id, None, "外层").unwrap();
        let inner = create_folder(&db, &collection.id, Some(&outer.id), "内层").unwrap();

        let err = move_folder(&db, &outer.id, Some(&inner.id)).expect_err("应拒绝成环");
        assert_eq!(err.code, crate::error::ErrorCode::Conflict);

        let err = move_folder(&db, &outer.id, Some(&outer.id)).expect_err("应拒绝自环");
        assert_eq!(err.code, crate::error::ErrorCode::Conflict);
    }

    #[test]
    fn moving_a_folder_to_root_works() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();

        let outer = create_folder(&db, &collection.id, None, "外层").unwrap();
        let inner = create_folder(&db, &collection.id, Some(&outer.id), "内层").unwrap();

        let moved = move_folder(&db, &inner.id, None).expect("移到根");
        assert_eq!(moved.parent_folder_id, None);

        let tree = collection_tree(&db, &collection.id).unwrap();
        assert_eq!(tree.children.len(), 2);
    }

    #[test]
    fn deleting_a_collection_removes_its_descendants() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();
        let folder = create_folder(&db, &collection.id, None, "文件夹").unwrap();
        requests::create_request(&db, &collection.id, Some(&folder.id), "请求", "GET", "https://a.test")
            .unwrap();

        delete_collection(&db, &collection.id).expect("删除集合");

        assert_eq!(list_collections(&db, &ws.id).unwrap().len(), 0);
        assert_eq!(list_folders(&db, &collection.id).unwrap().len(), 0);
        assert_eq!(requests::list_requests(&db, &collection.id).unwrap().len(), 0);
    }

    #[test]
    fn deleting_a_folder_cascades_to_its_descendants() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();
        let outer = create_folder(&db, &collection.id, None, "外层").unwrap();
        let inner = create_folder(&db, &collection.id, Some(&outer.id), "内层").unwrap();
        requests::create_request(&db, &collection.id, Some(&inner.id), "请求", "GET", "https://a.test")
            .unwrap();
        // 不在子树里的另一个文件夹与请求，删除后应当原样保留
        let sibling = create_folder(&db, &collection.id, None, "平级").unwrap();

        delete_folder(&db, &outer.id).expect("删除文件夹");

        assert_eq!(list_folders(&db, &collection.id).unwrap().len(), 1);
        assert_eq!(
            list_folders(&db, &collection.id).unwrap()[0].id,
            sibling.id,
            "级联删除不该越过被删子树"
        );
        assert_eq!(requests::list_requests(&db, &collection.id).unwrap().len(), 0);
    }

    #[test]
    fn deleting_a_missing_folder_reports_not_found() {
        let db = Db::open_in_memory().expect("打开数据库");
        let err = delete_folder(&db, "nope").expect_err("应报不存在");
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn renaming_a_folder_persists_and_keeps_its_descendants() {
        let db = Db::open_in_memory().expect("打开数据库");
        let ws = self::list(&db).unwrap().remove(0);
        let collection = create_collection(&db, &ws.id, "集合").unwrap();
        let folder = create_folder(&db, &collection.id, None, "文件夹").unwrap();
        let inner = create_folder(&db, &collection.id, Some(&folder.id), "内层").unwrap();
        requests::create_request(&db, &collection.id, Some(&inner.id), "请求", "GET", "https://a.test")
            .unwrap();

        let renamed = rename_folder(&db, &folder.id, "改名后").expect("重命名文件夹");
        assert_eq!(renamed.name, "改名后");

        let tree = collection_tree(&db, &collection.id).unwrap();
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].name, "改名后");
        assert_eq!(tree.children[0].children.len(), 1);
        assert_eq!(tree.children[0].children[0].children.len(), 1);
    }

    #[test]
    fn empty_name_is_rejected() {
        let db = Db::open_in_memory().expect("打开数据库");
        let err = create(&db, "   ").expect_err("应拒绝空名称");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
    }

    #[test]
    fn missing_workspace_reports_not_found() {
        let db = Db::open_in_memory().expect("打开数据库");
        let err = get(&db, "nope").expect_err("应报不存在");
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }
}
