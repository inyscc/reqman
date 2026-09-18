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
export type ProxyMode = 'none' | 'system' | 'manual';
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
  password?: string | null;
  no_proxy: string[];
}

export interface RequestSettings {
  timeout_ms?: number | null;
  follow_redirects: boolean;
  verify_tls: boolean;
  http_version: HttpVersion;
  encoding?: string | null;
  proxy?: ProxyConfig | null;
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
  is_secret: boolean;
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
}

export function emptyBody(): RequestBody {
  return { kind: 'none', raw: null, raw_language: null, form: [], urlencoded: [], binary: null };
}

export function emptyAuth(): AuthConfig {
  return { kind: 'inherit', basic: null, bearer: null, api_key: null };
}

export function defaultSettings(): RequestSettings {
  return {
    timeout_ms: null,
    follow_redirects: true,
    verify_tls: true,
    http_version: 'auto',
    encoding: null,
    proxy: null,
  };
}
