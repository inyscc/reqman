// 后端命令的绑定层。
//
// 前端不直连存储与网络（design D1），全部能力都经这里的具名命令进入 Rust。
// `invoke` 可注入，测试用假的实现替换真实 IPC。

import { invoke } from '@tauri-apps/api/core';
import type {
  AppError,
  Collection,
  CollectionTree,
  CookieArgs,
  CookieView,
  CurlCommand,
  Environment,
  Folder,
  ImportOutcome,
  ImportSourceArgs,
  PickedFile,
  ProxyConfig,
  RequestPreview,
  ResponsePayload,
  ResponseSpan,
  SaveOutcome,
  SavedRequest,
  Scope,
  SendRequestInput,
  Variable,
  Workspace,
} from './types';

export type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const tauriInvoker: Invoker = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(command, args);

export interface CreateRequestArgs {
  collection_id: string;
  folder_id?: string | null;
  name: string;
  method: string;
  url: string;
}

export interface CreateVariableArgs {
  scope: Scope;
  owner_id: string;
  name: string;
  value: string;
  is_secret?: boolean;
  description?: string | null;
}

/**
 * 按 id 更新一个变量：缺省即「不变」。
 *
 * `description` 传空字符串表示清空（与 Rust 侧的约定一致）；
 * `value` 同时写入初始值与当前值。
 */
export interface VariablePatch {
  name?: string;
  value?: string;
  description?: string;
  is_secret?: boolean;
  enabled?: boolean;
}

export interface SetVariableArgs {
  scope: Scope;
  owner_id: string;
  name: string;
  is_secret?: boolean;
  initial?: string | null;
  current?: string | null;
}

export function createCommands(call: Invoker) {
  return {
    // 工作区
    workspaceList: () => call<Workspace[]>('workspace_list'),
    workspaceActive: () => call<Workspace | null>('workspace_active'),
    workspaceCreate: (name: string) => call<Workspace>('workspace_create', { name }),
    workspaceRename: (id: string, name: string) =>
      call<Workspace>('workspace_rename', { id, name }),
    workspaceDelete: (id: string) => call<void>('workspace_delete', { id }),
    workspaceSetActive: (id: string) => call<void>('workspace_set_active', { id }),
    workspaceTree: (workspaceId: string) =>
      call<CollectionTree[]>('workspace_tree', { workspaceId }),

    // 集合与文件夹
    collectionCreate: (workspaceId: string, name: string) =>
      call<Collection>('collection_create', { workspaceId, name }),
    collectionRename: (id: string, name: string) =>
      call<Collection>('collection_rename', { id, name }),
    collectionDelete: (id: string) => call<void>('collection_delete', { id }),
    collectionReorder: (workspaceId: string, orderedIds: string[]) =>
      call<void>('collection_reorder', { workspaceId, orderedIds }),
    collectionTree: (collectionId: string) =>
      call<CollectionTree>('collection_tree', { collectionId }),
    /** 取集合实体本身——集合级前后置脚本挂在实体上，树形接口不给。 */
    collectionGet: (id: string) => call<Collection>('collection_get', { id }),
    /** 更新集合级前后置脚本（5.2）；null 表示清空。 */
    collectionSetScript: (id: string, preRequestScript: string | null, testScript: string | null) =>
      call<Collection>('collection_set_script', { id, preRequestScript, testScript }),
    folderCreate: (collectionId: string, parentFolderId: string | null, name: string) =>
      call<Folder>('folder_create', { collectionId, parentFolderId, name }),
    folderRename: (id: string, name: string) => call<Folder>('folder_rename', { id, name }),
    folderDelete: (id: string) => call<void>('folder_delete', { id }),
    /**
     * 移动文件夹到新父级（`null` = 集合根）。`index` 是它在目标父级子列表里的目标下标，
     * `null` 表示追加到末尾（落在目录行中间区域的「移入」没有位置信息）。
     */
    folderMove: (id: string, newParentId: string | null, index: number | null = null) =>
      call<Folder>('folder_move', { id, newParentId, index }),
    /** 更新文件夹级前后置脚本（5.2）；null 表示清空。 */
    folderSetScript: (id: string, preRequestScript: string | null, testScript: string | null) =>
      call<Folder>('folder_set_script', { id, preRequestScript, testScript }),
    /** 取文件夹实体本身——文件夹级前后置脚本挂在实体上，树形接口不给。 */
    folderGet: (id: string) => call<Folder>('folder_get', { id }),
    /**
     * 重写某个父级下子条目的顺序：入参是一个**有序列表**，下标即 `sort_order`。
     *
     * 传一个有序列表而不是「文件夹列表 + 请求列表」两个独立序列，才能表达
     * 「目录与请求交错」的顺序（渲染侧本来就按共享的 sort_order 混排）。
     */
    childrenReorder: (
      collectionId: string,
      parentFolderId: string | null,
      items: { id: string; kind: 'folder' | 'request' }[],
    ) => call<void>('children_reorder', { collectionId, parentFolderId, items }),

    // 请求
    requestGet: (id: string) => call<SavedRequest>('request_get', { id }),
    requestCreate: (args: CreateRequestArgs) => call<SavedRequest>('request_create', { args }),
    requestSave: (request: SavedRequest) => call<SavedRequest>('request_save', { request }),
    requestDuplicate: (id: string, newName?: string | null) =>
      call<SavedRequest>('request_duplicate', { id, newName: newName ?? null }),
    requestDelete: (id: string) => call<void>('request_delete', { id }),
    /** 移动请求到新位置；`index` 语义同 `folderMove`。 */
    requestMove: (id: string, folderId: string | null, index: number | null = null) =>
      call<SavedRequest>('request_move', { id, folderId, index }),

    // 环境与变量
    environmentList: (workspaceId: string) =>
      call<Environment[]>('environment_list', { workspaceId }),
    environmentActive: (workspaceId: string) =>
      call<Environment | null>('environment_active', { workspaceId }),
    environmentCreate: (workspaceId: string, name: string) =>
      call<Environment>('environment_create', { workspaceId, name }),
    environmentRename: (id: string, name: string) =>
      call<Environment>('environment_rename', { id, name }),
    environmentDelete: (id: string) => call<void>('environment_delete', { id }),
    environmentSetActive: (workspaceId: string, environmentId: string | null) =>
      call<void>('environment_set_active', { workspaceId, environmentId }),
    environmentSetProxy: (environmentId: string, proxy: ProxyConfig | null) =>
      call<Environment>('environment_set_proxy', { environmentId, proxy }),
    variableList: (scope: Scope, ownerId: string) =>
      call<Variable[]>('variable_list', { scope, ownerId }),
    variableSet: (args: SetVariableArgs) => call<Variable>('variable_set', { args }),
    /** 新增一条变量（界面的「新增一行」）；同名时新增而非覆盖。 */
    variableCreate: (args: CreateVariableArgs) => call<Variable>('variable_create', { args }),
    /** 按 id 就地更新：名称、值、描述、启用状态与 secret 标记。 */
    variableUpdate: (id: string, patch: VariablePatch) =>
      call<Variable>('variable_update', { id, patch }),
    /** 按给定顺序重写该归属下全部变量的顺序。 */
    variableReorder: (scope: Scope, ownerId: string, orderedIds: string[]) =>
      call<void>('variable_reorder', { scope, ownerId, orderedIds }),
    variableDelete: (id: string) => call<void>('variable_delete', { id }),
    /** 显式揭示 secret 明文，是拿到明文的唯一入口。 */
    secretReveal: (id: string) => call<Variable>('secret_reveal', { id }),
    globalsList: (workspaceId: string) => call<Variable[]>('globals_list', { workspaceId }),
    globalsSet: (workspaceId: string, name: string, value: string, isSecret: boolean) =>
      call<Variable>('globals_set', { workspaceId, name, value, isSecret }),

    // 设置
    settingsGet: (scope: string, key: string) =>
      call<string | null>('settings_get', { scope, key }),
    settingsSet: (scope: string, key: string, value: string) =>
      call<void>('settings_set', { scope, key, value }),
    globalProxyGet: () => call<ProxyConfig | null>('global_proxy_get'),
    globalProxySet: (proxy: ProxyConfig | null) =>
      call<void>('global_proxy_set', { proxy }),

    // 解析与发送
    variablesPreview: (input: SendRequestInput) =>
      call<RequestPreview>('variables_preview', { input }),
    sendRequest: (input: SendRequestInput) =>
      call<ResponsePayload>('send_request', { input }),
    responseBodySpan: (responseId: string, offset: number, length: number) =>
      call<ResponseSpan>('response_body_span', { responseId, offset, length }),

    // Cookie 手动管理（spec: Cookie 的手动管理）；cookie_query 是脚本的
    // `pm.cookies` 读取出口，与请求自动附带共用同一套匹配
    cookieList: () => call<CookieView[]>('cookie_list'),
    cookiePut: (args: CookieArgs) => call<void>('cookie_put', { args }),
    cookieDelete: (id: string) => call<void>('cookie_delete', { id }),
    cookieQuery: (url: string) => call<CookieView[]>('cookie_query', { url }),

    // 路径从不来自前端：这些命令内部拉起系统对话框
    pickUploadFile: () => call<PickedFile | null>('pick_upload_file'),
    backupExport: () => call<SaveOutcome | null>('backup_export'),
    backupRestore: () => call<boolean>('backup_restore'),
    responseSaveFull: (responseId: string) =>
      call<SaveOutcome | null>('response_save_full', { responseId }),

    // Postman 导入导出。导入只接受文本或一次性句柄；导出的去向由后端对话框决定。
    importPostman: (workspaceId: string, source: ImportSourceArgs) =>
      call<ImportOutcome>('import_postman', {
        workspaceId,
        text: source.text ?? null,
        handle: source.handle ?? null,
      }),
    collectionExport: (collectionId: string) =>
      call<SaveOutcome | null>('collection_export', { collectionId }),
    environmentExport: (environmentId: string) =>
      call<SaveOutcome | null>('environment_export', { environmentId }),
    globalsExport: (workspaceId: string) =>
      call<SaveOutcome | null>('globals_export', { workspaceId }),
    curlExport: (input: SendRequestInput) => call<CurlCommand>('curl_export', { input }),
  };
}

export type Commands = ReturnType<typeof createCommands>;

export const commands = createCommands(tauriInvoker);

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppError).code === 'string' &&
    typeof (value as AppError).message === 'string'
  );
}

export function describeError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) return { code: 'internal', message: value.message };
  return { code: 'internal', message: String(value) };
}
