// 会话标签集合的读写（change: add-multi-tab-sessions，design D6）。
//
// 与 `lib/layout.ts` 同一套纪律：复用 settings 表（前端不直连存储，全部经具名命令
// 进 Rust），作用域名沿用 snake_case 约定，key 用工作区 id。
//
// 标签集合是一条显示偏好，与分栏比例同性质：读不到、读不懂、格式不符一律回落
// 「没有任何标签打开」；写不进去静默吞掉，不打断使用。**明确不持久化未保存草稿**。

import type { Commands } from './commands';

/** 标签集合存在 settings 表里的作用域；key 用工作区 id（与 ui_layout 的用法一致）。 */
export const TABS_SCOPE = 'ui_tabs';

export type PersistedTab =
  | { kind: 'request'; id: string }
  | { kind: 'entity'; entityKind: 'collection' | 'folder'; id: string };

export interface PersistedTabs {
  tabs: PersistedTab[];
  activeId: string | null;
}

/** 读不到或读不懂时的回落值：没有任何标签打开。 */
export const EMPTY_TABS: PersistedTabs = { tabs: [], activeId: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseTab(value: unknown): PersistedTab | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;

  if (value.kind === 'request') return { kind: 'request', id: value.id };

  if (value.kind === 'entity') {
    const kind = value.entityKind;
    if (kind !== 'collection' && kind !== 'folder') return null;
    return { kind: 'entity', entityKind: kind, id: value.id };
  }

  return null;
}

/**
 * 把存储里的字符串解析为标签集合。
 *
 * 任何一步不成立都回落空集合——它是显示偏好，坏了也不该进入错误态（spec:
 * 会话标签集合的持久化「读到无法解析的内容时回落空集合」）。
 */
export function parseTabs(raw: string | null): PersistedTabs {
  if (!raw) return EMPTY_TABS;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return EMPTY_TABS;
  }

  if (!isRecord(decoded) || !Array.isArray(decoded.tabs)) return EMPTY_TABS;

  const tabs: PersistedTab[] = [];
  for (const entry of decoded.tabs) {
    const parsed = parseTab(entry);
    if (parsed) tabs.push(parsed);
  }

  const activeId = typeof decoded.activeId === 'string' ? decoded.activeId : null;
  return { tabs, activeId };
}

/** 读回某个工作区上次打开的标签集合与激活项。 */
export async function readTabs(commands: Commands, workspaceId: string): Promise<PersistedTabs> {
  const raw = await commands.settingsGet(TABS_SCOPE, workspaceId);
  return parseTabs(raw);
}

/**
 * 写入标签集合。
 *
 * 写入失败不抛出：标签集合只是显示偏好，写不进去也不该打断使用——下一次开/关/切
 * 标签会再写一遍。
 */
export async function writeTabs(
  commands: Commands,
  workspaceId: string,
  value: PersistedTabs,
): Promise<void> {
  try {
    await commands.settingsSet(TABS_SCOPE, workspaceId, JSON.stringify(value));
  } catch {
    // 有意静默：见上面的说明
  }
}
