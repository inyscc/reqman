// 分栏比例的读取与落库（change: rework-visual-system-and-app-chrome，design D7）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts 顶部）。作用域名沿用 scriptRuntime 那套 snake_case 约定。

import type { Commands } from './commands';

/** 分栏比例存在 settings 表里的作用域；key 用工作区 id（与 script_gate 的用法一致）。 */
export const SPLIT_SCOPE = 'ui_layout';

/** 两侧都必须留下可读正文的宽度，因此比例被限制在这个区间内。 */
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;

/** 从未调整过时的比例：两列等宽。 */
export const SPLIT_DEFAULT = 0.5;

/** 把任意输入收敛到合法区间；读不懂的值一律回到默认。 */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));
}

/**
 * 读回某个工作区上次调整的比例。
 *
 * 值缺失、读不懂或越界时回落默认——一条显示偏好不该把界面拖进错误态。
 */
export async function readSplitRatio(commands: Commands, workspaceId: string): Promise<number> {
  const raw = await commands.settingsGet(SPLIT_SCOPE, workspaceId);

  if (!raw) return SPLIT_DEFAULT;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clampSplit(parsed) : SPLIT_DEFAULT;
}

/**
 * 写入比例。
 *
 * 写入失败不抛出：比例只是显示偏好，写不进去也不该打断使用——下一次调整会再写一遍。
 */
export async function writeSplitRatio(
  commands: Commands,
  workspaceId: string,
  ratio: number,
): Promise<void> {
  try {
    await commands.settingsSet(SPLIT_SCOPE, workspaceId, String(clampSplit(ratio)));
  } catch {
    // 有意静默：见上面的说明
  }
}

/**
 * Console 抽屉的高度（占应用高度的比例）存在另一个作用域。
 *
 * 与分栏比例同一种单位、同一套读写方式，但**不能共用键**：同一个工作区里这两条偏好
 * 各自独立，合在一个值上会让调整其中一个顺手改掉另一个。
 */
export const CONSOLE_SCOPE = 'ui_console';

/** 下限：再矮就只剩一行标题，等于没打开。 */
export const CONSOLE_MIN = 0.15;

/** 上限：console 是排查工具，不该把主区挤到看不见。 */
export const CONSOLE_MAX = 0.6;

/** 从未调整过时的比例：约三分之一屏，够看几条日志。 */
export const CONSOLE_DEFAULT = 0.3;

export function clampConsoleHeight(value: number): number {
  if (!Number.isFinite(value)) return CONSOLE_DEFAULT;
  return Math.min(CONSOLE_MAX, Math.max(CONSOLE_MIN, value));
}

/**
 * 读回某个工作区上次拖出来的抽屉高度。
 *
 * 与分栏比例一致：读不懂、越界、缺失都回落默认，一条显示偏好不该把界面拖进错误态。
 */
export async function readConsoleHeight(
  commands: Commands,
  workspaceId: string,
): Promise<number> {
  const raw = await commands.settingsGet(CONSOLE_SCOPE, workspaceId);

  if (!raw) return CONSOLE_DEFAULT;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clampConsoleHeight(parsed) : CONSOLE_DEFAULT;
}

/** 写入高度；失败静默（理由同 `writeSplitRatio`）。 */
export async function writeConsoleHeight(
  commands: Commands,
  workspaceId: string,
  ratio: number,
): Promise<void> {
  try {
    await commands.settingsSet(CONSOLE_SCOPE, workspaceId, String(clampConsoleHeight(ratio)));
  } catch {
    // 有意静默：见 writeSplitRatio 的说明
  }
}
