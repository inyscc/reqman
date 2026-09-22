// 与 Rust 侧数据模型对应的前端类型（仅本变更用到的部分）。

export interface AppError {
  code: string;
  message: string;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  description?: string | null;
}

export type BodyKind = 'none' | 'raw' | 'form_data' | 'url_encoded' | 'binary';
export type RawLanguage = 'json' | 'xml' | 'html' | 'text' | 'javascript';
export type AuthKind = 'none' | 'inherit' | 'basic' | 'bearer' | 'api_key';
export type ApiKeyLocation = 'header' | 'query';
/** 代理模式：`inherit` = 未配置（顺位到更低层级），`none` = 不使用代理（直连）。 */
export type ProxyMode = 'inherit' | 'none' | 'system' | 'manual';
export type HttpVersion = 'auto' | 'http1' | 'http2';
export type Scope = 'local' | 'data' | 'environment' | 'collection' | 'global';

export interface FormField {
  key: string;
  value?: string | null;
  /** 一次性句柄，不是路径。 */
  file_handle?: string | null;
  description?: string | null;
  kind: 'text' | 'file';
  enabled: boolean;
}

export interface RequestBody {
  kind: BodyKind;
  raw?: string | null;
  raw_language?: RawLanguage | null;
  form: FormField[];
  urlencoded: KeyValue[];
  binary?: { file_handle?: string | null; description?: string | null } | null;
}

export interface AuthConfig {
  kind: AuthKind;
  basic?: { username: string; password: string } | null;
  bearer?: { token: string } | null;
  api_key?: { key: string; value: string; location: ApiKeyLocation } | null;
}

export interface ProxyConfig {
  mode: ProxyMode;
  url?: string | null;
  username?: string | null;
  /**
   * 已保存凭据这一事实。后端只回传它，不回传凭据本身
   * （spec: storage-foundation「敏感值不以明文落盘」）。
   */
  has_password?: boolean;
  /** 凭据当前是否可解密；不可读取时界面要能说出来，而不是显示成「未设置」。 */
  password_readable?: boolean;
  /**
   * **提交用**：缺字段 = 不改写既有凭据；空串 = 清除；非空 = 写入新值。
   * 后端据此决定是保留旧密文还是换新（spec: 三级代理的写入侧三态）。
   */
  password?: string | null;
  no_proxy: string[];
}

/**
 * 超时取值（spec: http-engine「请求级网络设置」）。
 *
 * 三态取代了原先的单值：数字 0 不承担「不限制」——本仓库既有约定把非正数当作无效值，
 * 让同一个数字在相邻设置项里含义相反会更难懂。
 */
export type TimeoutSetting =
  | { mode: 'inherit' }
  | { mode: 'unlimited' }
  | { mode: 'custom'; ms: number };

export interface RequestSettings {
  timeout: TimeoutSetting;
  follow_redirects: boolean;
  verify_tls: boolean;
  http_version: HttpVersion;
  encoding?: string | null;
  proxy?: ProxyConfig | null;
  /**
   * 响应呈现格式的请求级覆盖（spec: ui-layout「请求级响应格式覆盖」）。
   * 缺省 / `inherit` = 跟随全局；旧数据没有这个字段，因此是可选且不迁移。
   */
  response_format?: 'inherit' | 'auto' | 'json';
}

export interface SavedRequest {
  id: string;
  collection_id: string;
  folder_id?: string | null;
  name: string;
  description?: string | null;
  method: string;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  settings: RequestSettings;
  pre_request_script?: string | null;
  test_script?: string | null;
  sort_order: number;
}

export interface Collection {
  id: string;
  workspace_id: string;
  name: string;
  description?: string | null;
  auth: AuthConfig;
  pre_request_script?: string | null;
  test_script?: string | null;
  sort_order: number;
}

export interface Folder {
  id: string;
  collection_id: string;
  parent_folder_id?: string | null;
  name: string;
  description?: string | null;
  auth: AuthConfig;
  pre_request_script?: string | null;
  test_script?: string | null;
  sort_order: number;
}

export type NodeKind = 'folder' | 'request';

export interface TreeNode {
  kind: NodeKind;
  id: string;
  name: string;
  sort_order: number;
  children: TreeNode[];
  request?: SavedRequest | null;
}

export interface CollectionTree {
  collection: Collection;
  children: TreeNode[];
}

export interface Environment {
  id: string;
  workspace_id: string;
  name: string;
  is_active: boolean;
  proxy?: ProxyConfig | null;
  sort_order: number;
}

/** 与 Rust `StoredValue` 对应。 */
export type StoredValue =
  | { state: 'value'; value: string }
  | { state: 'unreadable' }
  | { state: 'not_persisted' };

export interface Variable {
  id: string;
  scope: Scope;
  owner_id: string;
  name: string;
  /** 可选描述，供界面呈现，不参与解析。 */
  description?: string | null;
  is_secret: boolean;
  /** 是否参与解析。被禁用的条目仍留在列表里，但不进入作用域。 */
  enabled: boolean;
  /** 在所属（作用域 + 归属）内的呈现顺序；同名组里最靠后的启用条目生效。 */
  sort_order: number;
  initial: StoredValue;
  current: StoredValue;
}

export interface RequestPreview {
  method: string;
  url: string;
  params: [string, string][];
  headers: [string, string][];
  body_text?: string | null;
  auth_kind: AuthKind;
  auth_key?: string | null;
  proxy_url?: string | null;
  unresolved: string[];
  /** 本请求实际用到的变量名（与发送同源）；只读浮层据此列出「用到」的那一段。 */
  used?: string[];
  masked: boolean;
  insecure_warning: boolean;
  /** 该目标当前会自动携带的 Cookie（Cookie 的可见性，spec: 自动附带）。 */
  cookies?: [string, string][];
}

/** Cookie 管理界面的一条条目（spec: Cookie 的手动管理）。 */
export interface CookieView {
  id: string;
  name: string;
  domain: string;
  path: string;
  host_only: boolean;
  value: string;
  secure: boolean;
  http_only: boolean;
  /** Unix 秒；null 表示会话 Cookie（仅本次应用运行内有效）。 */
  expires_at: number | null;
}

export interface CookieArgs {
  domain: string;
  name: string;
  value: string;
  path?: string;
  host_only?: boolean;
  secure?: boolean;
  http_only?: boolean;
  expires_at?: number | null;
}

export interface ResponsePayload {
  id: string;
  status: number;
  status_text: string;
  elapsed_ms: number;
  size_bytes: number;
  declared_size_bytes?: number | null;
  truncated: boolean;
  headers: [string, string][];
  content_type?: string | null;
  body_text?: string | null;
  body_base64?: string | null;
  pretty_available: boolean;
  pretty_print_threshold: number;
  /** 本次实际生效的正文上限（字节）；上限可配，界面不能拿缺省值当常数。 */
  size_limit_bytes: number;
  insecure_warning: boolean;
  final_url: string;
  via_proxy: boolean;
  http_version: string;
  unresolved: string[];
}

export interface ResponseSpan {
  offset: number;
  length: number;
  total_bytes: number;
  truncated: boolean;
  text?: string | null;
  base64: string;
}

export interface PickedFile {
  handle: string;
  name: string;
  size_bytes: number;
}

export interface SaveOutcome {
  path: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Postman 导入导出
// ---------------------------------------------------------------------------

export type DocumentKind = 'collection_v21' | 'collection_v20' | 'environment' | 'globals';
export type EntryLevel = 'collection' | 'folder' | 'request';

/** 因内部不支持映射而被降级的认证配置。 */
export interface AuthDowngrade {
  level: EntryLevel;
  entry_name: string;
  auth_type: string;
}

/** 被跳过、未导入的内容。 */
export interface SkippedItem {
  name: string;
  reason: string;
}

/** 因源文档以本地路径描述而降级为「未选择文件」的字段。 */
export interface FileFieldDowngrade {
  entry_name: string;
  field_name: string;
}

export interface ImportReport {
  auth_downgrades: AuthDowngrade[];
  skipped_items: SkippedItem[];
  file_field_downgrades: FileFieldDowngrade[];
  dropped_examples: number;
}

export interface ImportOutcome {
  kind: DocumentKind;
  workspace_id: string;
  collection_id?: string | null;
  environment_id?: string | null;
  report: ImportReport;
}

/** 导入来源：粘贴文本或一次性文件句柄，绝不含路径。 */
export interface ImportSourceArgs {
  text?: string | null;
  handle?: string | null;
}

export interface CurlCommand {
  command: string;
  contains_secret: boolean;
  warnings: string[];
}

export interface SendRequestInput {
  saved_id?: string | null;
  inline?: SavedRequest | null;
  environment_id?: string | null;
  local?: Record<string, string>;
  data?: Record<string, string>;
  /**
   * 本次发送的会话标识（spec: http-engine「请求取消」）。
   * 主请求与脚本内 `pm.sendRequest` 发出的请求共用它，取消按它撤销全部在飞请求。
   */
  attempt_id?: string | null;
}

export function emptyBody(): RequestBody {
  return { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null };
}

export function emptyAuth(): AuthConfig {
  return { kind: 'inherit', basic: null, bearer: null, api_key: null };
}

export function defaultSettings(): RequestSettings {
  return {
    timeout: { mode: 'inherit' },
    follow_redirects: true,
    verify_tls: true,
    http_version: 'auto',
    encoding: null,
    proxy: null,
  };
}
