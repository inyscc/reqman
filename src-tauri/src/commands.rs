//! Tauri 命令面（design.md D1 / D18）。
//!
//! 这里只做两件事：把参数交给自己可测试的逻辑函数，以及把系统对话框拿到
//! 的路径**留在后端**——前端从不提供路径，只提供句柄。

use crate::error::{AppError, AppResult};
use crate::interchange::{self, ImportOutcome, ImportSource};
use crate::logging::MASK;
use crate::net::response::ResponseSpan;
use crate::net::{self, ResponsePayload, SendRequestInput};
use crate::secrets::StoredValue;
use crate::state::AppState;
use crate::storage::model::{
    AuthConfig, Collection, Environment, Folder, ProxyConfig, SavedRequest, Scope, Variable,
    Workspace,
};
use crate::storage::workspace::{CollectionTree, NodeKind};
use crate::storage::{backup, cookies as storage_cookies, requests, variables, workspace};
use crate::variables::RequestPreview;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// 参数与返回类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRequestArgs {
    pub collection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetVariableArgs {
    pub scope: Scope,
    pub owner_id: String,
    pub name: String,
    #[serde(default)]
    pub is_secret: bool,
    /// `None` 表示保持初始值不变。
    pub initial: Option<String>,
    /// `None` 表示保持当前值不变。
    pub current: Option<String>,
}

/// 新增一个变量（界面的「新增一行」）。
///
/// 与 [`SetVariableArgs`] 的区别是**永远新增**：填入已存在的名称会新增一条同名条目，
/// 而不是覆盖既有条目（spec: 变量表格的重复键与拖拽排序）。
#[derive(Debug, Clone, Deserialize)]
pub struct CreateVariableArgs {
    pub scope: Scope,
    pub owner_id: String,
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub is_secret: bool,
    #[serde(default)]
    pub description: Option<String>,
}

/// `children_reorder` 的一项：一个子条目的 id 与其种类。
///
/// 顺序即入参顺序（下标就是 `sort_order`），因此目录与请求可以任意交错。
#[derive(Debug, Clone, Deserialize)]
pub struct ReorderItem {
    pub id: String,
    pub kind: NodeKind,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickedFile {
    /// 一次性句柄。发送请求时只接受句柄，不接受路径。
    pub handle: String,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SaveOutcome {
    pub path: String,
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// 逻辑函数（可单测，不依赖 Tauri 运行时）
// ---------------------------------------------------------------------------

pub fn list_workspaces(state: &AppState) -> AppResult<Vec<Workspace>> {
    workspace::list(&state.db)
}

pub fn active_workspace(state: &AppState) -> AppResult<Option<Workspace>> {
    workspace::active(&state.db)
}

pub fn create_workspace(state: &AppState, name: &str) -> AppResult<Workspace> {
    workspace::create(&state.db, name)
}

pub fn rename_workspace(state: &AppState, id: &str, name: &str) -> AppResult<Workspace> {
    workspace::rename(&state.db, id, name)
}

pub fn delete_workspace(state: &AppState, id: &str) -> AppResult<()> {
    workspace::delete(&state.db, id)
}

pub fn set_active_workspace(state: &AppState, id: &str) -> AppResult<()> {
    workspace::set_active(&state.db, id)
}

pub fn load_workspace_tree(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<Vec<CollectionTree>> {
    workspace::workspace_tree(&state.db, workspace_id)
}

pub fn load_collection_tree(state: &AppState, collection_id: &str) -> AppResult<CollectionTree> {
    workspace::collection_tree(&state.db, collection_id)
}

pub fn create_collection(state: &AppState, workspace_id: &str, name: &str) -> AppResult<Collection> {
    workspace::create_collection(&state.db, workspace_id, name)
}

pub fn rename_collection(state: &AppState, id: &str, name: &str) -> AppResult<Collection> {
    workspace::rename_collection(&state.db, id, name)
}

/// 更新集合级前后置脚本（spec: 脚本编辑与保存）。
pub fn set_collection_script(
    state: &AppState,
    id: &str,
    pre_request_script: Option<&str>,
    test_script: Option<&str>,
) -> AppResult<Collection> {
    workspace::set_collection_script(&state.db, id, pre_request_script, test_script)
}

pub fn delete_collection(state: &AppState, id: &str) -> AppResult<()> {
    workspace::delete_collection(&state.db, id)
}

pub fn reorder_collections(
    state: &AppState,
    workspace_id: &str,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    workspace::reorder_collections(&state.db, workspace_id, &ordered_ids)
}

pub fn create_folder(
    state: &AppState,
    collection_id: &str,
    parent_folder_id: Option<String>,
    name: &str,
) -> AppResult<Folder> {
    workspace::create_folder(
        &state.db,
        collection_id,
        parent_folder_id.as_deref(),
        name,
    )
}

pub fn rename_folder(state: &AppState, id: &str, name: &str) -> AppResult<Folder> {
    workspace::rename_folder(&state.db, id, name)
}

/// 更新文件夹级前后置脚本（spec: 脚本编辑与保存）。
pub fn set_folder_script(
    state: &AppState,
    id: &str,
    pre_request_script: Option<&str>,
    test_script: Option<&str>,
) -> AppResult<Folder> {
    workspace::set_folder_script(&state.db, id, pre_request_script, test_script)
}

pub fn delete_folder(state: &AppState, id: &str) -> AppResult<()> {
    workspace::delete_folder(&state.db, id)
}

pub fn move_folder(
    state: &AppState,
    id: &str,
    new_parent_id: Option<String>,
    index: Option<i64>,
) -> AppResult<Folder> {
    workspace::move_folder(&state.db, id, new_parent_id.as_deref(), index)
}

pub fn reorder_children(
    state: &AppState,
    collection_id: &str,
    parent_folder_id: Option<String>,
    items: Vec<ReorderItem>,
) -> AppResult<()> {
    let items: Vec<(String, NodeKind)> = items
        .into_iter()
        .map(|item| (item.id, item.kind))
        .collect();
    workspace::reorder_children(
        &state.db,
        collection_id,
        parent_folder_id.as_deref(),
        &items,
    )
}

pub fn get_request(state: &AppState, id: &str) -> AppResult<SavedRequest> {
    requests::get_request(&state.db, id)
}

pub fn create_request(state: &AppState, args: CreateRequestArgs) -> AppResult<SavedRequest> {
    requests::create_request(
        &state.db,
        &args.collection_id,
        args.folder_id.as_deref(),
        &args.name,
        &args.method,
        &args.url,
    )
}

pub fn save_request(state: &AppState, request: SavedRequest) -> AppResult<SavedRequest> {
    requests::save_request(&state.db, &request)
}

pub fn duplicate_request(
    state: &AppState,
    id: &str,
    new_name: Option<String>,
) -> AppResult<SavedRequest> {
    requests::duplicate_request(&state.db, id, new_name.as_deref())
}

pub fn delete_request(state: &AppState, id: &str) -> AppResult<()> {
    requests::delete_request(&state.db, id)
}

pub fn move_request(
    state: &AppState,
    id: &str,
    folder_id: Option<String>,
    index: Option<i64>,
) -> AppResult<SavedRequest> {
    requests::move_request(&state.db, id, folder_id.as_deref(), index)
}

pub fn list_environments(state: &AppState, workspace_id: &str) -> AppResult<Vec<Environment>> {
    variables::list_environments(&state.db, workspace_id)
}

pub fn active_environment(
    state: &AppState,
    workspace_id: &str,
) -> AppResult<Option<Environment>> {
    variables::active_environment(&state.db, workspace_id)
}

pub fn create_environment(
    state: &AppState,
    workspace_id: &str,
    name: &str,
) -> AppResult<Environment> {
    variables::create_environment(&state.db, workspace_id, name)
}

pub fn rename_environment(state: &AppState, id: &str, name: &str) -> AppResult<Environment> {
    variables::rename_environment(&state.db, id, name)
}

pub fn delete_environment(state: &AppState, id: &str) -> AppResult<()> {
    variables::delete_environment(&state.db, id)
}

pub fn set_active_environment(
    state: &AppState,
    workspace_id: &str,
    environment_id: Option<String>,
) -> AppResult<()> {
    variables::set_active_environment(&state.db, workspace_id, environment_id.as_deref())
}

pub fn set_environment_proxy(
    state: &AppState,
    environment_id: &str,
    proxy: Option<ProxyConfig>,
) -> AppResult<Environment> {
    variables::set_environment_proxy(&state.db, environment_id, proxy)
}

/// 把 secret 变量的取值换成掩码后再交给前端。
fn masked(variable: Variable) -> Variable {
    if !variable.is_secret {
        return variable;
    }
    let mask = |value: StoredValue| match value {
        StoredValue::Value { .. } => StoredValue::Value {
            value: MASK.to_string(),
        },
        other => other,
    };
    Variable {
        initial: mask(variable.initial),
        current: mask(variable.current),
        ..variable
    }
}

/// 列出变量。secret 值以掩码返回，明文只能经 [`reveal_secret`] 取得。
pub fn list_variables(
    state: &AppState,
    scope: Scope,
    owner_id: &str,
) -> AppResult<Vec<Variable>> {
    let list = variables::list_variables(&state.db, scope, owner_id, state.key_provider.as_ref())?;
    Ok(list.into_iter().map(masked).collect())
}

pub fn list_globals(state: &AppState, workspace_id: &str) -> AppResult<Vec<Variable>> {
    let list = variables::list_globals(&state.db, workspace_id, state.key_provider.as_ref())?;
    Ok(list.into_iter().map(masked).collect())
}

pub fn set_variable(state: &AppState, args: SetVariableArgs) -> AppResult<Variable> {
    let variable = variables::upsert_variable(
        &state.db,
        args.scope,
        &args.owner_id,
        &args.name,
        args.is_secret,
        args.initial.as_deref(),
        args.current.as_deref(),
        state.key_provider.as_ref(),
    )?;
    Ok(masked(variable))
}

pub fn delete_variable(state: &AppState, id: &str) -> AppResult<()> {
    variables::delete_variable(&state.db, id)
}

/// 新增一条变量，落在所属归属的末尾。
pub fn create_variable(state: &AppState, args: CreateVariableArgs) -> AppResult<Variable> {
    let variable = variables::create_variable(
        &state.db,
        args.scope,
        &args.owner_id,
        &args.name,
        &args.value,
        args.is_secret,
        args.description.as_deref(),
        state.key_provider.as_ref(),
    )?;
    Ok(masked(variable))
}

/// 按 id 就地更新：名称、值与描述可就地改，启用状态与 secret 标记可就地切换。
pub fn update_variable(
    state: &AppState,
    id: &str,
    patch: variables::VariablePatch,
) -> AppResult<Variable> {
    let variable =
        variables::update_variable(&state.db, id, patch, state.key_provider.as_ref())?;
    Ok(masked(variable))
}

/// 按给定顺序重写某个（作用域 + 归属）下全部条目的顺序。
pub fn reorder_variables(
    state: &AppState,
    scope: Scope,
    owner_id: &str,
    ordered_ids: &[String],
) -> AppResult<()> {
    variables::reorder_variables(&state.db, scope, owner_id, ordered_ids)
}

/// 显式揭示一个 secret 变量的明文。
///
/// 这是拿到明文的唯一入口，与列表命令刻意分开，便于审计「谁在什么时候看了明文」。
pub fn reveal_secret(state: &AppState, id: &str) -> AppResult<Variable> {
    variables::get_variable(&state.db, id, state.key_provider.as_ref())
}

pub fn set_global(
    state: &AppState,
    workspace_id: &str,
    name: &str,
    value: &str,
    is_secret: bool,
) -> AppResult<Variable> {
    let variable = variables::set_global(
        &state.db,
        workspace_id,
        name,
        value,
        is_secret,
        state.key_provider.as_ref(),
    )?;
    Ok(masked(variable))
}

pub fn get_setting(state: &AppState, scope: &str, key: &str) -> AppResult<Option<String>> {
    variables::get_setting(&state.db, scope, key)
}

pub fn set_setting(state: &AppState, scope: &str, key: &str, value: &str) -> AppResult<()> {
    variables::set_setting(&state.db, scope, key, value)
}

pub fn get_global_proxy(state: &AppState) -> AppResult<Option<ProxyConfig>> {
    variables::global_proxy(&state.db)
}

pub fn set_global_proxy(state: &AppState, proxy: Option<ProxyConfig>) -> AppResult<()> {
    variables::set_global_proxy(&state.db, proxy)
}

pub fn preview_request(
    state: &AppState,
    input: SendRequestInput,
) -> AppResult<RequestPreview> {
    net::preview(
        &state.db,
        state.key_provider.as_ref(),
        Some(&state.cookies),
        &input,
    )
}

pub async fn perform_send_request(
    state: &AppState,
    input: SendRequestInput,
) -> AppResult<ResponsePayload> {
    net::send_request(
        &state.db,
        state.key_provider.as_ref(),
        &state.uploads,
        &state.responses,
        &state.cookies,
        &input,
    )
    .await
}

pub fn read_response_span(
    state: &AppState,
    response_id: &str,
    offset: u64,
    length: usize,
) -> AppResult<ResponseSpan> {
    state.responses.span(response_id, offset, length)
}

pub fn register_upload(state: &AppState, path: &std::path::Path) -> AppResult<PickedFile> {
    let handle = state.uploads.register(path)?;
    let metadata = std::fs::metadata(path)?;
    Ok(PickedFile {
        handle,
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string()),
        size_bytes: metadata.len(),
    })
}

pub fn export_backup(state: &AppState, destination: &std::path::Path) -> AppResult<SaveOutcome> {
    backup::export(&state.db, destination)?;
    let bytes = std::fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
    Ok(SaveOutcome {
        path: destination.display().to_string(),
        bytes,
    })
}

pub fn restore_backup(state: &AppState, source: &std::path::Path) -> AppResult<()> {
    backup::restore(&state.db, source)
}

pub fn save_response_body(
    state: &AppState,
    response_id: &str,
    destination: &std::path::Path,
) -> AppResult<SaveOutcome> {
    let bytes = state.responses.save_full(response_id, destination)?;
    Ok(SaveOutcome {
        path: destination.display().to_string(),
        bytes,
    })
}

// ---------------------------------------------------------------------------
// 导入与导出（Postman 文档）
// ---------------------------------------------------------------------------

/// 把集合导出为 Postman v2.1 文档并写到指定位置。
///
/// 位置由命令层经系统对话框取得；本函数只接受已经定好的目的地，
/// 因此可以被单测直接调用（design D2 / spec: 导入来源与访问边界）。
pub fn export_collection_to(
    state: &AppState,
    collection_id: &str,
    destination: &std::path::Path,
) -> AppResult<SaveOutcome> {
    let text = interchange::export::export_collection(&state.db, collection_id, state.key_provider.as_ref())?;
    write_export(&text, destination)
}

/// 把环境导出为 Postman Environment 文档。
pub fn export_environment_to(
    state: &AppState,
    environment_id: &str,
    destination: &std::path::Path,
) -> AppResult<SaveOutcome> {
    let text =
        interchange::export::export_environment(&state.db, environment_id, state.key_provider.as_ref())?;
    write_export(&text, destination)
}

/// 把工作区级全局变量导出为 Postman Globals 文档。
pub fn export_globals_to(
    state: &AppState,
    workspace_id: &str,
    destination: &std::path::Path,
) -> AppResult<SaveOutcome> {
    let text =
        interchange::export::export_globals(&state.db, workspace_id, state.key_provider.as_ref())?;
    write_export(&text, destination)
}

fn write_export(text: &str, destination: &std::path::Path) -> AppResult<SaveOutcome> {
    std::fs::write(destination, text)?;
    let bytes = std::fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
    Ok(SaveOutcome {
        path: destination.display().to_string(),
        bytes,
    })
}

/// 生成请求对应的 curl 命令。
///
/// 走与发送完全一致的解析路径（同一作用域快照与继承认证），因此命令里的取值
/// 就是实际会发出去的取值（spec: 导出 curl）。
pub fn curl_for(
    state: &AppState,
    input: &SendRequestInput,
) -> AppResult<interchange::curl::CurlCommand> {
    let (_request, resolved) =
        net::resolve_for_export(&state.db, state.key_provider.as_ref(), input)?;
    Ok(interchange::curl::curl_command(&resolved))
}

/// 从给定来源导入一份 Postman 文档到目标工作区。
pub fn import_into(
    state: &AppState,
    workspace_id: &str,
    source: ImportSource,
) -> AppResult<ImportOutcome> {
    let text = interchange::read_source(&source, &state.uploads)?;
    let document = interchange::parse::parse_document(&text)?;
    interchange::import_document(&state.db, workspace_id, &document, state.key_provider.as_ref())
}

// ---------------------------------------------------------------------------
// 与认证相关的辅助（供后续 UI 使用）
// ---------------------------------------------------------------------------

/// 供界面展示集合当前生效的认证方式。
pub fn collection_auth(state: &AppState, collection_id: &str) -> AppResult<AuthConfig> {
    Ok(workspace::get_collection(&state.db, collection_id)?.auth)
}

// ---------------------------------------------------------------------------
// Tauri 命令包装：唯一职责是把参数接进来、把系统对话框的路径留在后端
// ---------------------------------------------------------------------------

fn pick_path(app: &AppHandle, save: bool) -> Option<std::path::PathBuf> {
    let dialog = app.dialog().file();
    let picked = if save {
        dialog.blocking_save_file()
    } else {
        dialog.blocking_pick_file()
    };
    picked.and_then(|file| file.into_path().ok())
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> AppResult<Vec<Workspace>> {
    list_workspaces(&state)
}

#[tauri::command]
pub fn workspace_active(state: State<'_, AppState>) -> AppResult<Option<Workspace>> {
    active_workspace(&state)
}

#[tauri::command]
pub fn workspace_create(state: State<'_, AppState>, name: String) -> AppResult<Workspace> {
    create_workspace(&state, &name)
}

#[tauri::command]
pub fn workspace_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Workspace> {
    rename_workspace(&state, &id, &name)
}

#[tauri::command]
pub fn workspace_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_workspace(&state, &id)
}

#[tauri::command]
pub fn workspace_set_active(state: State<'_, AppState>, id: String) -> AppResult<()> {
    set_active_workspace(&state, &id)
}

#[tauri::command]
pub fn workspace_tree(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<CollectionTree>> {
    load_workspace_tree(&state, &workspace_id)
}

#[tauri::command]
pub fn collection_tree(
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<CollectionTree> {
    load_collection_tree(&state, &collection_id)
}

/// 取回集合实体本身。
///
/// `collection_tree` 只给出树形结构，而集合级的前后置脚本挂在实体上；脚本运行时
/// 需要「集合 → 文件夹 → 请求」三级编排，因此上层脚本必须有独立的取回入口。
#[tauri::command]
pub fn collection_get(state: State<'_, AppState>, id: String) -> AppResult<Collection> {
    workspace::get_collection(&state.db, &id)
}

#[tauri::command]
pub fn collection_create(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> AppResult<Collection> {
    create_collection(&state, &workspace_id, &name)
}

#[tauri::command]
pub fn collection_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Collection> {
    rename_collection(&state, &id, &name)
}

#[tauri::command]
pub fn collection_set_script(
    state: State<'_, AppState>,
    id: String,
    pre_request_script: Option<String>,
    test_script: Option<String>,
) -> AppResult<Collection> {
    set_collection_script(&state, &id, pre_request_script.as_deref(), test_script.as_deref())
}

#[tauri::command]
pub fn folder_set_script(
    state: State<'_, AppState>,
    id: String,
    pre_request_script: Option<String>,
    test_script: Option<String>,
) -> AppResult<Folder> {
    set_folder_script(&state, &id, pre_request_script.as_deref(), test_script.as_deref())
}

#[tauri::command]
pub fn collection_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_collection(&state, &id)
}

#[tauri::command]
pub fn collection_reorder(
    state: State<'_, AppState>,
    workspace_id: String,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    reorder_collections(&state, &workspace_id, ordered_ids)
}

#[tauri::command]
pub fn folder_create(
    state: State<'_, AppState>,
    collection_id: String,
    parent_folder_id: Option<String>,
    name: String,
) -> AppResult<Folder> {
    create_folder(&state, &collection_id, parent_folder_id, &name)
}

#[tauri::command]
pub fn folder_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Folder> {
    rename_folder(&state, &id, &name)
}

/// 取回文件夹实体本身，理由同 `collection_get`——文件夹级脚本也挂在实体上。
#[tauri::command]
pub fn folder_get(state: State<'_, AppState>, id: String) -> AppResult<Folder> {
    workspace::get_folder(&state.db, &id)
}

#[tauri::command]
pub fn folder_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_folder(&state, &id)
}

#[tauri::command]
pub fn folder_move(
    state: State<'_, AppState>,
    id: String,
    new_parent_id: Option<String>,
    index: Option<i64>,
) -> AppResult<Folder> {
    move_folder(&state, &id, new_parent_id, index)
}

#[tauri::command]
pub fn children_reorder(
    state: State<'_, AppState>,
    collection_id: String,
    parent_folder_id: Option<String>,
    items: Vec<ReorderItem>,
) -> AppResult<()> {
    reorder_children(&state, &collection_id, parent_folder_id, items)
}

#[tauri::command]
pub fn request_get(state: State<'_, AppState>, id: String) -> AppResult<SavedRequest> {
    get_request(&state, &id)
}

#[tauri::command]
pub fn request_create(
    state: State<'_, AppState>,
    args: CreateRequestArgs,
) -> AppResult<SavedRequest> {
    create_request(&state, args)
}

#[tauri::command]
pub fn request_save(
    state: State<'_, AppState>,
    request: SavedRequest,
) -> AppResult<SavedRequest> {
    save_request(&state, request)
}

#[tauri::command]
pub fn request_duplicate(
    state: State<'_, AppState>,
    id: String,
    new_name: Option<String>,
) -> AppResult<SavedRequest> {
    duplicate_request(&state, &id, new_name)
}

#[tauri::command]
pub fn request_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_request(&state, &id)
}

#[tauri::command]
pub fn request_move(
    state: State<'_, AppState>,
    id: String,
    folder_id: Option<String>,
    index: Option<i64>,
) -> AppResult<SavedRequest> {
    move_request(&state, &id, folder_id, index)
}

#[tauri::command]
pub fn environment_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<Environment>> {
    list_environments(&state, &workspace_id)
}

#[tauri::command]
pub fn environment_active(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Option<Environment>> {
    active_environment(&state, &workspace_id)
}

#[tauri::command]
pub fn environment_create(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> AppResult<Environment> {
    create_environment(&state, &workspace_id, &name)
}

#[tauri::command]
pub fn environment_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Environment> {
    rename_environment(&state, &id, &name)
}

#[tauri::command]
pub fn environment_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_environment(&state, &id)
}

#[tauri::command]
pub fn environment_set_active(
    state: State<'_, AppState>,
    workspace_id: String,
    environment_id: Option<String>,
) -> AppResult<()> {
    set_active_environment(&state, &workspace_id, environment_id)
}

#[tauri::command]
pub fn environment_set_proxy(
    state: State<'_, AppState>,
    environment_id: String,
    proxy: Option<ProxyConfig>,
) -> AppResult<Environment> {
    set_environment_proxy(&state, &environment_id, proxy)
}

#[tauri::command]
pub fn variable_list(
    state: State<'_, AppState>,
    scope: Scope,
    owner_id: String,
) -> AppResult<Vec<Variable>> {
    list_variables(&state, scope, &owner_id)
}

#[tauri::command]
pub fn variable_set(state: State<'_, AppState>, args: SetVariableArgs) -> AppResult<Variable> {
    set_variable(&state, args)
}

#[tauri::command]
pub fn variable_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    delete_variable(&state, &id)
}

#[tauri::command]
pub fn variable_create(state: State<'_, AppState>, args: CreateVariableArgs) -> AppResult<Variable> {
    create_variable(&state, args)
}

#[tauri::command]
pub fn variable_update(
    state: State<'_, AppState>,
    id: String,
    patch: variables::VariablePatch,
) -> AppResult<Variable> {
    update_variable(&state, &id, patch)
}

#[tauri::command]
pub fn variable_reorder(
    state: State<'_, AppState>,
    scope: Scope,
    owner_id: String,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    reorder_variables(&state, scope, &owner_id, &ordered_ids)
}

#[tauri::command]
pub fn secret_reveal(state: State<'_, AppState>, id: String) -> AppResult<Variable> {
    reveal_secret(&state, &id)
}

#[tauri::command]
pub fn globals_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<Variable>> {
    list_globals(&state, &workspace_id)
}

#[tauri::command]
pub fn globals_set(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
    value: String,
    is_secret: bool,
) -> AppResult<Variable> {
    set_global(&state, &workspace_id, &name, &value, is_secret)
}

#[tauri::command]
pub fn settings_get(
    state: State<'_, AppState>,
    scope: String,
    key: String,
) -> AppResult<Option<String>> {
    get_setting(&state, &scope, &key)
}

#[tauri::command]
pub fn settings_set(
    state: State<'_, AppState>,
    scope: String,
    key: String,
    value: String,
) -> AppResult<()> {
    set_setting(&state, &scope, &key, &value)
}

#[tauri::command]
pub fn global_proxy_get(state: State<'_, AppState>) -> AppResult<Option<ProxyConfig>> {
    get_global_proxy(&state)
}

#[tauri::command]
pub fn global_proxy_set(
    state: State<'_, AppState>,
    proxy: Option<ProxyConfig>,
) -> AppResult<()> {
    set_global_proxy(&state, proxy)
}

// ---------------------------------------------------------------------------
// Cookie 手动管理（spec: Cookie 的手动管理）
// ---------------------------------------------------------------------------

/// 界面上的 Cookie 条目。取值明文呈现——Cookie 会随每个请求发送，
/// 不属于 secret；但落库仍是密文（spec: Cookie 的持久化与加密）。
#[derive(Debug, Serialize)]
pub struct CookieView {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub path: String,
    pub host_only: bool,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CookieArgs {
    pub domain: String,
    pub name: String,
    pub value: String,
    #[serde(default = "default_cookie_path")]
    pub path: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    /// Unix 秒；`None` 表示会话 Cookie（仅本次应用运行内有效）。
    #[serde(default)]
    pub expires_at: Option<i64>,
}

fn default_cookie_path() -> String {
    "/".to_string()
}

fn cookie_view(entry: crate::storage::cookies::CookieEntry) -> CookieView {
    CookieView {
        id: entry.id,
        name: entry.row.name,
        domain: entry.row.domain,
        path: entry.row.path,
        host_only: entry.row.host_only,
        value: entry.row.value,
        secure: entry.row.secure,
        http_only: entry.row.http_only,
        expires_at: entry.row.expires_at,
    }
}

pub fn list_cookies(state: &AppState) -> AppResult<Vec<CookieView>> {
    Ok(storage_cookies::list_entries(&state.db, state.key_provider.as_ref())?
        .into_iter()
        .map(cookie_view)
        .collect())
}

/// 新增或覆盖一条 Cookie。写完立即参与后续请求（spec: 手动新增后生效）。
pub fn save_cookie(state: &AppState, args: CookieArgs) -> AppResult<()> {
    let domain = args.domain.trim().to_lowercase();
    if domain.is_empty() || args.name.trim().is_empty() {
        return Err(AppError::invalid_input("Cookie 的域与名称不能为空"));
    }

    state
        .cookies
        .put(
            &state.db,
            state.key_provider.as_ref(),
            crate::storage::cookies::CookieRow {
                name: args.name.trim().to_string(),
                domain,
                path: if args.path.is_empty() { "/".into() } else { args.path },
                host_only: args.host_only,
                value: args.value,
                secure: args.secure,
                http_only: args.http_only,
                expires_at: args.expires_at,
            },
        )
}

/// 删除一条 Cookie；jar 与数据库同时清理（spec: 删除后不再携带）。
pub fn remove_cookie(state: &AppState, id: &str) -> AppResult<()> {
    let Some(row) = storage_cookies::get_row(&state.db, state.key_provider.as_ref(), id)? else {
        return Ok(()); // 已不存在视为删除成功
    };
    state.cookies.expire(&row);
    storage_cookies::delete_row(&state.db, id)?;
    Ok(())
}

#[tauri::command]
pub fn cookie_list(state: State<'_, AppState>) -> AppResult<Vec<CookieView>> {
    list_cookies(&state)
}

#[tauri::command]
pub fn cookie_put(state: State<'_, AppState>, args: CookieArgs) -> AppResult<()> {
    save_cookie(&state, args)
}

#[tauri::command]
pub fn cookie_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    remove_cookie(&state, &id)
}

/// `pm.cookies` 的读取出口：给定目标 URL，返回将自动携带的 Cookie 及其完整属性。
/// 与请求自动附带共用同一套匹配（spec: 脚本读到的集合与自动附带规则一致）。
pub fn query_cookies(state: &AppState, url: &str) -> AppResult<Vec<CookieView>> {
    Ok(state
        .cookies
        .matching_cookies(url)
        .into_iter()
        .map(|row| {
            cookie_view(crate::storage::cookies::CookieEntry {
                id: String::new(),
                row,
            })
        })
        .collect())
}

#[tauri::command]
pub fn cookie_query(state: State<'_, AppState>, url: String) -> AppResult<Vec<CookieView>> {
    query_cookies(&state, &url)
}

#[tauri::command]
pub fn variables_preview(
    state: State<'_, AppState>,
    input: SendRequestInput,
) -> AppResult<RequestPreview> {
    preview_request(&state, input)
}

#[tauri::command]
pub async fn send_request(
    state: State<'_, AppState>,
    input: SendRequestInput,
) -> AppResult<ResponsePayload> {
    perform_send_request(&state, input).await
}

#[tauri::command]
pub fn response_body_span(
    state: State<'_, AppState>,
    response_id: String,
    offset: u64,
    length: usize,
) -> AppResult<ResponseSpan> {
    read_response_span(&state, &response_id, offset, length)
}

/// 选择要上传的文件。路径留在后端，前端只拿到一次性句柄。
#[tauri::command]
pub fn pick_upload_file(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<PickedFile>> {
    match pick_path(&app, false) {
        Some(path) => register_upload(&state, &path).map(Some),
        None => Ok(None),
    }
}

/// 导出备份到用户选择的位置。
#[tauri::command]
pub fn backup_export(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<SaveOutcome>> {
    match pick_path(&app, true) {
        Some(path) => export_backup(&state, &path).map(Some),
        None => Ok(None),
    }
}

/// 从用户选择的备份文件恢复。
#[tauri::command]
pub fn backup_restore(app: AppHandle, state: State<'_, AppState>) -> AppResult<bool> {
    match pick_path(&app, false) {
        Some(path) => {
            restore_backup(&state, &path)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 把某个响应的完整正文保存到用户选择的位置。
#[tauri::command]
pub fn response_save_full(
    app: AppHandle,
    state: State<'_, AppState>,
    response_id: String,
) -> AppResult<Option<SaveOutcome>> {
    match pick_path(&app, true) {
        Some(path) => save_response_body(&state, &response_id, &path).map(Some),
        None => Ok(None),
    }
}

/// 导出集合。前端只说「导出哪个集合」，去向由后端拉起系统对话框决定。
#[tauri::command]
pub fn collection_export(
    app: AppHandle,
    state: State<'_, AppState>,
    collection_id: String,
) -> AppResult<Option<SaveOutcome>> {
    match pick_path(&app, true) {
        Some(path) => export_collection_to(&state, &collection_id, &path).map(Some),
        None => Ok(None),
    }
}

/// 导出环境。
#[tauri::command]
pub fn environment_export(
    app: AppHandle,
    state: State<'_, AppState>,
    environment_id: String,
) -> AppResult<Option<SaveOutcome>> {
    match pick_path(&app, true) {
        Some(path) => export_environment_to(&state, &environment_id, &path).map(Some),
        None => Ok(None),
    }
}

/// 导出工作区级全局变量。
#[tauri::command]
pub fn globals_export(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Option<SaveOutcome>> {
    match pick_path(&app, true) {
        Some(path) => export_globals_to(&state, &workspace_id, &path).map(Some),
        None => Ok(None),
    }
}

/// 导出 curl 命令。命令随返回值交给界面，不写入日志。
#[tauri::command]
pub fn curl_export(
    state: State<'_, AppState>,
    input: SendRequestInput,
) -> AppResult<interchange::curl::CurlCommand> {
    curl_for(&state, &input)
}

/// 导入 Postman 文档。
///
/// 来源只有两种：粘贴的文本，或 `pick_upload_file` 登记的一次性句柄。
/// 这里**不接受**任何路径参数（spec: 导入来源与访问边界）。
#[tauri::command]
pub fn import_postman(
    state: State<'_, AppState>,
    workspace_id: String,
    text: Option<String>,
    handle: Option<String>,
) -> AppResult<ImportOutcome> {
    let source = match (text, handle) {
        (Some(text), _) => ImportSource::Text(text),
        (None, Some(handle)) => ImportSource::Handle(handle),
        (None, None) => {
            return Err(AppError::invalid_input(
                "导入需要提供文档文本，或先选择文件以取得一次性句柄",
            ))
        }
    };
    import_into(&state, &workspace_id, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::response::ResponseStore;
    use crate::net::uploads::UploadRegistry;
    use crate::secrets::MemoryKeyProvider;
    use crate::storage::Db;
    use crate::testutil::TempDir;
    use std::sync::Arc;

    pub(super) fn state(tag: &str) -> (TempDir, AppState) {
        let dir = TempDir::new(tag);
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        let app = AppState {
            db,
            key_provider: Arc::new(MemoryKeyProvider::from_bytes([17u8; 32])),
            uploads: Arc::new(UploadRegistry::new()),
            responses: Arc::new(ResponseStore::new(4, dir.join("responses"))),
            cookies: Arc::new(crate::net::cookies::CookieJar::new()),
        };
        (dir, app)
    }

    #[test]
    fn export_writes_to_the_backend_chosen_destination_and_reimports() {
        let (dir, app) = state("cmd-export");
        let workspace_id = workspace::list(&app.db).unwrap().remove(0).id;
        let collection = workspace::create_collection(&app.db, &workspace_id, "导出集合").unwrap();

        // 目的地由调用方（命令层经系统对话框）决定；逻辑函数只接受定好的目的地
        let destination = dir.join("collection.json");
        let outcome = export_collection_to(&app, &collection.id, &destination).expect("导出");
        assert!(destination.exists(), "导出文件应存在");
        assert!(outcome.bytes > 0);
        assert_eq!(outcome.path, destination.display().to_string());

        let text = std::fs::read_to_string(&destination).expect("读取导出文件");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("导出结果是合法 JSON");
        assert_eq!(parsed["info"]["name"], "导出集合");

        // 重新导入：句柄由后端登记，前端仍然拿不到路径
        let handle = app.uploads.register(&destination).expect("登记导出文件");
        let imported = import_into(&app, &workspace_id, ImportSource::Handle(handle))
            .expect("重新导入");
        assert!(imported.collection_id.is_some());
        assert_eq!(
            workspace::list_collections(&app.db, &workspace_id).unwrap().len(),
            2
        );
    }

    #[test]
    fn curl_export_resolves_variables_the_same_way_sending_does() {
        let (_dir, app) = state("cmd-curl");
        let workspace_id = workspace::list(&app.db).unwrap().remove(0).id;
        let collection = workspace::create_collection(&app.db, &workspace_id, "集合").unwrap();

        variables::upsert_variable(
            &app.db,
            Scope::Collection,
            &collection.id,
            "host",
            false,
            Some("api.test"),
            Some("api.test"),
            app.key_provider.as_ref(),
        )
        .expect("写入集合变量");

        let mut request = requests::create_request(
            &app.db,
            &collection.id,
            None,
            "请求",
            "GET",
            "https://{{host}}/users",
        )
        .expect("创建请求");
        request.headers = vec![crate::storage::model::KeyValue::new(
            "Accept",
            "application/json",
        )];
        requests::save_request(&app.db, &request).expect("保存请求");

        let curl = curl_for(
            &app,
            &SendRequestInput {
                saved_id: Some(request.id.clone()),
                inline: None,
                environment_id: None,
                local: Default::default(),
                data: Default::default(),
            },
        )
        .expect("生成 curl");

        assert!(
            curl.command.contains("'https://api.test/users'"),
            "变量应按与发送一致的方式解析：{}",
            curl.command
        );
        assert!(curl.command.contains("-H 'Accept: application/json'"));
        assert!(!curl.contains_secret);
        assert!(curl.is_directly_executable(), "{:?}", curl.warnings);
    }

    #[test]
    fn workspace_tree_aggregates_collections_folders_and_requests() {
        let (_dir, app) = state("cmd-tree");
        let workspace = list_workspaces(&app).unwrap().remove(0);
        let collection = create_collection(&app, &workspace.id, "集合").unwrap();
        let folder = create_folder(&app, &collection.id, None, "文件夹").unwrap();
        create_request(
            &app,
            CreateRequestArgs {
                collection_id: collection.id.clone(),
                folder_id: Some(folder.id.clone()),
                name: "请求".into(),
                method: "GET".into(),
                url: "https://a.test".into(),
            },
        )
        .unwrap();

        let tree = load_workspace_tree(&app, &workspace.id).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].collection.name, "集合");
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].name, "文件夹");
        assert_eq!(tree[0].children[0].children.len(), 1);
        assert_eq!(tree[0].children[0].children[0].name, "请求");
    }

    #[test]
    fn secret_values_are_masked_in_listings_and_revealed_explicitly() {
        let (_dir, app) = state("cmd-mask");
        let workspace = list_workspaces(&app).unwrap().remove(0);

        set_global(&app, &workspace.id, "apiKey", "PLAINTEXT_123", true).expect("写入 secret");
        set_global(&app, &workspace.id, "host", "api.test", false).expect("写入普通变量");

        let globals = list_globals(&app, &workspace.id).unwrap();
        let secret = globals.iter().find(|v| v.name == "apiKey").unwrap();
        assert_eq!(secret.current.plaintext(), Some(MASK), "列表应掩码");
        assert_eq!(secret.initial.plaintext(), Some(MASK));

        let plain = globals.iter().find(|v| v.name == "host").unwrap();
        assert_eq!(plain.current.plaintext(), Some("api.test"), "非 secret 不应掩码");

        let revealed = reveal_secret(&app, &secret.id).unwrap();
        assert_eq!(revealed.current.plaintext(), Some("PLAINTEXT_123"));
    }

    #[test]
    fn degraded_key_store_surfaces_a_clear_error() {
        let dir = TempDir::new("cmd-degraded");
        let db = Db::open(dir.join("reqman.db")).unwrap();
        let app = AppState {
            db,
            key_provider: Arc::new(crate::secrets::UnavailableKeyProvider),
            uploads: Arc::new(UploadRegistry::new()),
            responses: Arc::new(ResponseStore::new(2, dir.join("responses"))),
            cookies: Arc::new(crate::net::cookies::CookieJar::new()),
        };
        let workspace = list_workspaces(&app).unwrap().remove(0);

        let err = set_global(&app, &workspace.id, "apiKey", "x", true).expect_err("应进入降级态");
        assert_eq!(err.code, crate::error::ErrorCode::SecretStoreUnavailable);
    }

    #[test]
    fn backup_export_then_restore_round_trips_through_the_command_layer() {
        let (dir, app) = state("cmd-backup");
        let workspace = list_workspaces(&app).unwrap().remove(0);
        let collection = create_collection(&app, &workspace.id, "集合").unwrap();
        let destination = dir.join("out.backup");

        let outcome = export_backup(&app, &destination).expect("导出");
        assert!(outcome.bytes > 0);
        assert!(destination.exists());

        delete_collection(&app, &collection.id).unwrap();
        assert!(
            load_workspace_tree(&app, &workspace.id).unwrap().is_empty(),
            "清空后集合树应为空"
        );

        restore_backup(&app, &destination).expect("恢复");
        let tree = load_workspace_tree(&app, &workspace.id).unwrap();
        assert_eq!(tree.len(), 1, "恢复后集合应回来");
        assert_eq!(tree[0].collection.name, "集合");
    }

    #[test]
    fn upload_registration_returns_a_handle_not_a_path() {
        let (dir, app) = state("cmd-upload");
        let file = dir.join("payload.bin");
        std::fs::write(&file, b"12345").unwrap();

        let picked = register_upload(&app, &file).expect("登记文件");
        assert_eq!(picked.name, "payload.bin");
        assert_eq!(picked.size_bytes, 5);
        assert_ne!(picked.handle, file.display().to_string());
        assert!(!picked.handle.contains('/'), "句柄不应是路径");
    }

    #[test]
    fn preview_and_send_share_the_same_resolution() {
        let (_dir, app) = state("cmd-preview");
        let workspace = list_workspaces(&app).unwrap().remove(0);
        let collection = create_collection(&app, &workspace.id, "集合").unwrap();
        set_global(&app, &workspace.id, "host", "api.test", false).unwrap();

        let request = create_request(
            &app,
            CreateRequestArgs {
                collection_id: collection.id.clone(),
                folder_id: None,
                name: "请求".into(),
                method: "GET".into(),
                url: "http://{{host}}/x".into(),
            },
        )
        .unwrap();

        let preview = preview_request(&app, SendRequestInput::saved(&request.id)).expect("预览");
        assert_eq!(preview.url, "http://api.test/x");
        assert!(preview.unresolved.is_empty());

        // 内联载荷也能预览
        let preview = preview_request(&app, SendRequestInput::inline(request.clone())).expect("预览");
        assert_eq!(preview.url, "http://api.test/x");
    }

    #[test]
    fn settings_round_trip_including_global_proxy() {
        let (_dir, app) = state("cmd-settings");
        assert!(get_global_proxy(&app).unwrap().is_none());

        set_global_proxy(&app, Some(ProxyConfig::manual("http://127.0.0.1:8080"))).unwrap();
        let proxy = get_global_proxy(&app).unwrap().unwrap();
        assert_eq!(proxy.url.as_deref(), Some("http://127.0.0.1:8080"));

        set_setting(&app, "global", "response_size_limit_bytes", "1024").unwrap();
        assert_eq!(
            get_setting(&app, "global", "response_size_limit_bytes").unwrap(),
            Some("1024".to_string())
        );
    }

    #[test]
    fn environment_switch_is_reflected_in_the_command_surface() {
        let (_dir, app) = state("cmd-env");
        let workspace = list_workspaces(&app).unwrap().remove(0);
        let dev = create_environment(&app, &workspace.id, "开发").unwrap();
        let prod = create_environment(&app, &workspace.id, "生产").unwrap();

        set_active_environment(&app, &workspace.id, Some(dev.id.clone())).unwrap();
        assert_eq!(
            active_environment(&app, &workspace.id).unwrap().unwrap().id,
            dev.id
        );

        set_active_environment(&app, &workspace.id, Some(prod.id.clone())).unwrap();
        assert_eq!(
            active_environment(&app, &workspace.id).unwrap().unwrap().id,
            prod.id
        );

        set_active_environment(&app, &workspace.id, None).unwrap();
        assert!(active_environment(&app, &workspace.id).unwrap().is_none());
    }
}

#[cfg(test)]
mod cookie_tests {
    use super::tests::state;
    use super::*;

    #[test]
    fn cookie_put_list_delete_round_trip() {
        let (_dir, app) = state("cmd-cookie");

        save_cookie(
            &app,
            CookieArgs {
                domain: "api.test".into(),
                name: "sid".into(),
                value: "abc123".into(),
                path: "/".into(),
                host_only: true,
                secure: false,
                http_only: false,
                expires_at: Some(4_102_444_800),
            },
        )
        .expect("写入 Cookie");

        let list = list_cookies(&app).expect("列出");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "sid");
        assert_eq!(list[0].value, "abc123");
        assert_eq!(list[0].domain, "api.test");

        // 立即参与匹配（spec: 手动新增后生效）
        assert_eq!(
            app.cookies.matches_for_url("http://api.test/x"),
            vec![("sid".to_string(), "abc123".to_string())]
        );

        remove_cookie(&app, &list[0].id).expect("删除");
        assert!(list_cookies(&app).expect("列出").is_empty());
        assert!(
            app.cookies.matches_for_url("http://api.test/x").is_empty(),
            "删除后不再携带"
        );
    }

    #[test]
    fn cookie_put_rejects_blank_domain_or_name() {
        let (_dir, app) = state("cmd-cookie-blank");

        let err = save_cookie(
            &app,
            CookieArgs {
                domain: "  ".into(),
                name: "sid".into(),
                value: "v".into(),
                path: "/".into(),
                host_only: true,
                secure: false,
                http_only: false,
                expires_at: None,
            },
        )
        .expect_err("应拒绝");
        assert_eq!(err.code, crate::error::ErrorCode::InvalidInput);
    }
}
