// 请求类偏好的应用级配置（spec: ui-layout「设置模态的请求配置」）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。作用域沿用 limits 那两个键所在的 `global`。
//
// 六项都是**应用级**的（不随工作区走）：超时与体积上限描述的是"这台机器怎么发请求"，
// 两项 cURL 缺省描述的是"生成的命令默认长什么样"。

import type { Commands } from './commands';
import type { CurlBodyCompress, CurlLayout, CurlLineLayout } from './types';

/**
 * 应用设置的落点。多数键与 Rust 侧 `setting_keys` 一一对应；`curl_line_layout` 是例外——
 * 布局只在界面上呈现，Rust 侧不读它（键仍登记在 `setting_keys` 里，两条 cURL 配置因此
 * 作用域一致）。
 */
const SCOPE = 'global';
const TIMEOUT_KEY = 'request_timeout_ms';
const SIZE_LIMIT_KEY = 'response_size_limit_bytes';
const PRETTY_THRESHOLD_KEY = 'pretty_print_threshold_bytes';
const CURL_BODY_COMPRESS_KEY = 'curl_body_compress';
const CURL_LINE_LAYOUT_KEY = 'curl_line_layout';

/** 「不限制」的写法：0（Rust 侧 `limits::UNLIMITED`）。超时与体积上限同义。 */
export const UNLIMITED = '0';

/** 「不限制」的旧写法，只为兼容这一改动早期写进开发库的值。 */
export const UNLIMITED_TIMEOUT = 'unlimited';

/** 与 Rust 侧 `limits::DEFAULT_TIMEOUT_MS` 一致。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 与 Rust 侧 `limits::DEFAULT_RESPONSE_SIZE_LIMIT` 一致（50 MiB）。 */
export const DEFAULT_SIZE_LIMIT_MB = 50;

/** 与 Rust 侧 `limits::DEFAULT_PRETTY_PRINT_THRESHOLD` 一致（5 MiB）。 */
export const DEFAULT_PRETTY_THRESHOLD_MB = 5;

/** 应用级超时的两态：不限制，或给定毫秒数。 */
export type AppTimeout = { mode: 'unlimited' } | { mode: 'custom'; ms: number };

export interface RequestLimits {
  /** 响应正文的硬上限（MB）；0 与负数同为坏值——这一项没有「不限制」（`大响应保护`）。 */
  sizeLimitMb: number;
  /** 超过该体积不再提供结构化视图（MB）。 */
  prettyThresholdMb: number;
}

export const DEFAULT_APP_TIMEOUT: AppTimeout = { mode: 'custom', ms: DEFAULT_TIMEOUT_MS };

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  sizeLimitMb: DEFAULT_SIZE_LIMIT_MB,
  prettyThresholdMb: DEFAULT_PRETTY_THRESHOLD_MB,
};

/** cURL 正文压缩的应用级缺省（spec: ui-layout「cURL 正文压缩」）。 */
export const DEFAULT_CURL_BODY_COMPRESS = true;

/** cURL 命令布局的应用级缺省（spec: ui-layout「cURL 命令布局」）：缺省多行。 */
export const DEFAULT_CURL_LINE_LAYOUT: CurlLayout = 'multi';

/** 读回的六项请求类偏好。 */
export interface RequestPreferences {
  timeout: AppTimeout;
  limits: RequestLimits;
  /** cURL 正文压缩的应用级缺省。 */
  curlBodyCompress: boolean;
  /** cURL 命令布局的应用级缺省。 */
  curlLineLayout: CurlLayout;
}

/**
 * 应用级压缩缺省：只有明确的 `'false'` 才关，其余（缺失、空、读不懂）回落缺省（开）。
 *
 * 与 Rust 侧 `interchange::curl::parse_compress_default` 是同一条规则的两次实现——
 * 两侧必须一致（后端是命令的真实生成处）。
 */
export function parseCurlBodyCompress(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() !== 'false';
}

/**
 * 压缩的**生效值**：请求级三态覆盖应用级缺省（与 `resolveWrapLines` 同形）。
 *
 * 解析规则只有这一处；工具条开关与 Settings 三态行都消费它。
 */
export function resolveCurlBodyCompress(
  globalDefault: boolean,
  request: CurlBodyCompress | null | undefined,
): boolean {
  if (request === 'compress') return true;
  if (request === 'raw') return false;
  return globalDefault;
}

/**
 * 应用级布局缺省：只有明确的 `'single'` 才是单行，其余（缺失、空、读不懂）回落多行。
 */
export function parseCurlLineLayout(raw: string | null | undefined): CurlLayout {
  return (raw ?? '').trim() === 'single' ? 'single' : DEFAULT_CURL_LINE_LAYOUT;
}

/**
 * 布局的**生效值**：请求级三态覆盖应用级缺省（与 `resolveWrapLines` 同形）。
 *
 * 解析规则只有这一处；cURL 标签与导入 / 导出模态都消费它，两处因此必然一致。
 */
export function resolveCurlLineLayout(
  globalDefault: CurlLayout,
  request: CurlLineLayout | null | undefined,
): CurlLayout {
  if (request === 'single') return 'single';
  if (request === 'multi') return 'multi';
  return globalDefault;
}

/** 格式化阈值的可选档位（MB）。超过当前上限的档位不可选（spec: 请求配置的依赖）。 */
export const THRESHOLD_CHOICES_MB = [1, 2, 5, 10, 20, 50, 100] as const;

const MB = 1024 * 1024;

/**
 * 读不懂的值一律回到缺省——一条网络设置不该因为一个坏值把每个请求都拖进「立刻超时」。
 * 这条与 Rust 侧 `limits::app_timeout_ms` 是同一条规则的两次实现，两侧必须一致。
 */
export function parseAppTimeout(raw: string | null | undefined): AppTimeout {
  const text = (raw ?? '').trim();
  if (text === UNLIMITED_TIMEOUT) return { mode: 'unlimited' };

  const ms = Number.parseInt(text, 10);
  // 负数与读不懂的值回落缺省；0 是不限制
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_APP_TIMEOUT;
  return ms === 0 ? { mode: 'unlimited' } : { mode: 'custom', ms };
}

export function encodeAppTimeout(value: AppTimeout): string {
  return value.mode === 'unlimited' ? UNLIMITED : String(value.ms);
}

/** 界面上的超时就是一个数字，0 表示不限制——输入框里显示的也是 0。 */
export function timeoutMsOf(value: AppTimeout): number {
  return value.mode === 'unlimited' ? 0 : value.ms;
}

/** 数字 → 落库用的两态：0 即不限制。 */
export function appTimeoutFromMs(ms: number): AppTimeout {
  return ms <= 0 ? { mode: 'unlimited' } : { mode: 'custom', ms };
}

/**
 * 落库的是**字节**，界面用的是 MB——这一对换算只在这里发生。
 *
 * 这一节里只有超时的 0 表示「不限制」：体积上限的 0 会让整份正文进内存（`大响应保护`
 * 要求上限存在），格式化阈值的 0 会让每一份响应都失去结构化视图。两者的 0 与负数同属坏值。
 */
function parseMegabytes(raw: string | null | undefined, fallback: number): number {
  const bytes = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return fallback;
  return Math.max(1, Math.round(bytes / MB));
}

export function parseRequestLimits(
  sizeRaw: string | null | undefined,
  thresholdRaw: string | null | undefined,
): RequestLimits {
  return {
    sizeLimitMb: parseMegabytes(sizeRaw, DEFAULT_SIZE_LIMIT_MB),
    prettyThresholdMb: parseMegabytes(thresholdRaw, DEFAULT_PRETTY_THRESHOLD_MB),
  };
}

/** 读回六项；任一读不懂时各自回落缺省。 */
export async function readRequestPreferences(commands: Commands): Promise<RequestPreferences> {
  const [timeout, size, threshold, curlBodyCompress, curlLineLayout] = await Promise.all([
    commands.settingsGet(SCOPE, TIMEOUT_KEY),
    commands.settingsGet(SCOPE, SIZE_LIMIT_KEY),
    commands.settingsGet(SCOPE, PRETTY_THRESHOLD_KEY),
    commands.settingsGet(SCOPE, CURL_BODY_COMPRESS_KEY),
    commands.settingsGet(SCOPE, CURL_LINE_LAYOUT_KEY),
  ]);

  return {
    timeout: parseAppTimeout(timeout),
    limits: parseRequestLimits(size, threshold),
    curlBodyCompress: parseCurlBodyCompress(curlBodyCompress),
    curlLineLayout: parseCurlLineLayout(curlLineLayout),
  };
}

/**
 * 写入三项。
 *
 * 与 layout / sessionTabs / responsePresentation 同纪律：写入失败不抛出——它只是网络偏好，
 * 下一次改动会再写一遍。
 */
export async function writeRequestPreferences(
  commands: Commands,
  value: RequestPreferences,
): Promise<void> {
  try {
    await Promise.all([
      commands.settingsSet(SCOPE, TIMEOUT_KEY, encodeAppTimeout(value.timeout)),
      commands.settingsSet(SCOPE, SIZE_LIMIT_KEY, String(value.limits.sizeLimitMb * MB)),
      commands.settingsSet(
        SCOPE,
        PRETTY_THRESHOLD_KEY,
        String(value.limits.prettyThresholdMb * MB),
      ),
      commands.settingsSet(SCOPE, CURL_BODY_COMPRESS_KEY, String(value.curlBodyCompress)),
      commands.settingsSet(SCOPE, CURL_LINE_LAYOUT_KEY, value.curlLineLayout),
    ]);
  } catch {
    // 有意静默：见上
  }
}

/**
 * 「cURL 正文压缩」应用级缺省的当前值。
 *
 * 与 `editorAppearance` 同款的一套：应用级设置有多处消费方（设置模态、请求 Settings 行、
 * cURL 动作行的快捷开关），因此这里也维持一份进程内当前值与订阅。唯一写入口是
 * [`applyCurlBodyCompress`]（启动读取与设置模态保存都经它）。
 */
let currentCompress = DEFAULT_CURL_BODY_COMPRESS;
const compressListeners = new Set<(value: boolean) => void>();

export function currentCurlBodyCompress(): boolean {
  return currentCompress;
}

/** 订阅缺省值变化；返回取消订阅。 */
export function subscribeCurlBodyCompress(listener: (value: boolean) => void): () => void {
  compressListeners.add(listener);
  return () => {
    compressListeners.delete(listener);
  };
}

/** 归一后更新当前值并通知订阅者；返回归一后的值（界面显示的应是这个）。 */
export function applyCurlBodyCompress(value: boolean): boolean {
  currentCompress = parseCurlBodyCompress(String(value));
  // 复制一份再遍历：订阅者在回调里退订不该影响本次通知
  for (const listener of [...compressListeners]) listener(currentCompress);
  return currentCompress;
}

/** 「cURL 命令布局」应用级缺省的当前值；与压缩缺省同款的一套（当前值 + 订阅 + 唯一写入口）。 */
let currentLayout: CurlLayout = DEFAULT_CURL_LINE_LAYOUT;
const layoutListeners = new Set<(value: CurlLayout) => void>();

export function currentCurlLineLayout(): CurlLayout {
  return currentLayout;
}

/** 订阅缺省值变化；返回取消订阅。 */
export function subscribeCurlLineLayout(listener: (value: CurlLayout) => void): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}

/** 归一后更新当前值并通知订阅者；返回归一后的值。 */
export function applyCurlLineLayout(value: CurlLayout): CurlLayout {
  currentLayout = parseCurlLineLayout(value);
  for (const listener of [...layoutListeners]) listener(currentLayout);
  return currentLayout;
}
