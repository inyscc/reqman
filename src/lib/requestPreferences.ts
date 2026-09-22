// 请求类偏好的应用级配置（spec: ui-layout「设置模态的请求配置」）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。作用域沿用 limits 那两个键所在的 `global`。
//
// 三项都是**应用级**的（不随工作区走）：超时与体积上限描述的是"这台机器怎么发请求"。

import type { Commands } from './commands';

/** 应用设置的落点：与 Rust 侧 `setting_keys` 一一对应。 */
const SCOPE = 'global';
const TIMEOUT_KEY = 'request_timeout_ms';
const SIZE_LIMIT_KEY = 'response_size_limit_bytes';
const PRETTY_THRESHOLD_KEY = 'pretty_print_threshold_bytes';

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

/** 读回三项；任一读不懂时各自回落缺省。 */
export async function readRequestPreferences(commands: Commands): Promise<{
  timeout: AppTimeout;
  limits: RequestLimits;
}> {
  const [timeout, size, threshold] = await Promise.all([
    commands.settingsGet(SCOPE, TIMEOUT_KEY),
    commands.settingsGet(SCOPE, SIZE_LIMIT_KEY),
    commands.settingsGet(SCOPE, PRETTY_THRESHOLD_KEY),
  ]);

  return {
    timeout: parseAppTimeout(timeout),
    limits: parseRequestLimits(size, threshold),
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
  value: { timeout: AppTimeout; limits: RequestLimits },
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
    ]);
  } catch {
    // 有意静默：见上
  }
}
