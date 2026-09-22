// 编辑器外观的应用级配置（spec: code-editors「编辑器外观可配置」/
// ui-layout「设置模态的编辑器配置」）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。四项都是**应用级**的（不随工作区走）：它们描述的是
// 「这个人在什么环境里读代码」，与工作区无关。
//
// 与其它显示偏好同纪律（见 responsePresentation / layout）：写入失败不抛出、
// 读不懂的值回落缺省——一条外观坏值不该把编辑器拖进不可用。

import type { Commands } from './commands';

/** 落点：与 Rust 侧无关（`setting_keys` 只服务 Rust 自己读的键），纯前端作用域。 */
const SCOPE = 'editor_appearance';
const FONT_FAMILY_KEY = 'font_family';
const FONT_SIZE_KEY = 'font_size';
const INDENT_COUNT_KEY = 'indent_count';
const INDENT_TYPE_KEY = 'indent_type';

/**
 * 缺省的等宽字体栈：与 `App.css` 里 `--font-mono` 的初值一致。
 *
 * 刻意只写系统栈——应用离线优先，不引入字体文件、不挂 CDN（spec: 离线优先的字体约束）。
 * 用户不填就该拿到本机真实存在的那一族，而不是一个需要额外安装的字体名。
 */
export const DEFAULT_FONT_FAMILY =
  "'Cascadia Mono', Consolas, ui-monospace, SFMono-Regular, Menlo, monospace";

/** 字号与缩进数的可输入区间；区间之外不进入设置值（spec: ui-layout 取值区间）。 */
export const FONT_SIZE_RANGE = { min: 8, max: 32 } as const;
export const INDENT_COUNT_RANGE = { min: 1, max: 8 } as const;

/** 缩进类型：空格或制表符（编辑器专属，不影响响应格式化输出）。 */
export type IndentType = 'space' | 'tab';

export interface EditorAppearance {
  /** 字体族，可写完整字体栈（自由文本）。 */
  fontFamily: string;
  /** 等宽字号（像素）。 */
  fontSize: number;
  /** 一个代码层级的缩进宽度。 */
  indentCount: number;
  indentType: IndentType;
}

/** 缺省：既有的系统等宽栈 / 12px（与 `--text-sm` 对齐）/ 缩进 4 / 空格。 */
export const DEFAULT_EDITOR_APPEARANCE: EditorAppearance = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 12,
  indentCount: 4,
  indentType: 'space',
};

/** 字体族是自由文本：空白视为「未设置」，回落缺省（否则清空输入框会让 CSS 变量变成空串）。 */
export function parseFontFamily(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  return text === '' ? DEFAULT_FONT_FAMILY : text;
}

/**
 * 区间内的整数才收；其余（读不懂、越界、空）回落缺省。
 *
 * 与界面上的控件是同一把尺子：控件不接受区间之外的输入，存储里的坏值也不会进来。
 */
function parseInRange(
  raw: string | null | undefined,
  range: { min: number; max: number },
  fallback: number,
): number {
  const value = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(value) || value < range.min || value > range.max) return fallback;
  return value;
}

export function parseFontSize(raw: string | null | undefined): number {
  return parseInRange(raw, FONT_SIZE_RANGE, DEFAULT_EDITOR_APPEARANCE.fontSize);
}

export function parseIndentCount(raw: string | null | undefined): number {
  return parseInRange(raw, INDENT_COUNT_RANGE, DEFAULT_EDITOR_APPEARANCE.indentCount);
}

export function parseIndentType(raw: string | null | undefined): IndentType {
  return (raw ?? '').trim() === 'tab' ? 'tab' : DEFAULT_EDITOR_APPEARANCE.indentType;
}

/** 读回四项；任一读不懂时各自回落缺省。 */
export async function readEditorAppearance(commands: Commands): Promise<EditorAppearance> {
  const [family, size, count, type] = await Promise.all([
    commands.settingsGet(SCOPE, FONT_FAMILY_KEY),
    commands.settingsGet(SCOPE, FONT_SIZE_KEY),
    commands.settingsGet(SCOPE, INDENT_COUNT_KEY),
    commands.settingsGet(SCOPE, INDENT_TYPE_KEY),
  ]);

  return {
    fontFamily: parseFontFamily(family),
    fontSize: parseFontSize(size),
    indentCount: parseIndentCount(count),
    indentType: parseIndentType(type),
  };
}

/** 写入四项；失败静默（同其它显示偏好，下一次改动会再写一遍）。 */
export async function writeEditorAppearance(
  commands: Commands,
  value: EditorAppearance,
): Promise<void> {
  try {
    await Promise.all([
      commands.settingsSet(SCOPE, FONT_FAMILY_KEY, value.fontFamily),
      commands.settingsSet(SCOPE, FONT_SIZE_KEY, String(value.fontSize)),
      commands.settingsSet(SCOPE, INDENT_COUNT_KEY, String(value.indentCount)),
      commands.settingsSet(SCOPE, INDENT_TYPE_KEY, value.indentType),
    ]);
  } catch {
    // 有意静默：见文件头
  }
}

/** 当前生效的外观。编辑器与等宽 CSS 面共用这一份值。 */
let current: EditorAppearance = DEFAULT_EDITOR_APPEARANCE;

const listeners = new Set<(value: EditorAppearance) => void>();

export function currentEditorAppearance(): EditorAppearance {
  return current;
}

/** 订阅外观变化；返回取消订阅。 */
export function subscribeEditorAppearance(
  listener: (value: EditorAppearance) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 应用一份外观：归一（空字体栈 / 越界数值回落缺省）后更新当前值，写进 `:root` 的等宽变量
 * 并通知订阅者。
 *
 * 两条腿是分开的，因为 Monaco 的字体是**选项驱动**的：它把字体写进 DOM 的
 * `.view-lines` 并用 canvas 量字宽（`domFontInfo.js` / `glyphRasterizer.js`），
 * 改 CSS 变量对它无效。所以这里只负责非编辑器的等宽面，编辑器各自 updateOptions。
 *
 * 返回归一后的值——调用方据此知道实际生效的是什么（界面上显示的应是这个）。
 */
export function applyEditorAppearance(value: EditorAppearance): EditorAppearance {
  const effective: EditorAppearance = {
    fontFamily: parseFontFamily(value.fontFamily),
    fontSize: parseFontSize(String(value.fontSize)),
    indentCount: parseIndentCount(String(value.indentCount)),
    indentType: parseIndentType(value.indentType),
  };

  current = effective;

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.style.setProperty('--font-mono', effective.fontFamily);
    root.style.setProperty('--text-mono', `${effective.fontSize}px`);
  }

  // 复制一份再遍历：订阅者在回调里退订不该影响本次通知
  for (const listener of [...listeners]) listener(effective);

  return effective;
}
