// 编辑器外观的应用级配置（spec: code-editors「等宽面的外观与缩进」/
// ui-layout「设置模态的编辑器与折行配置」）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。这几项都是**应用级**的（不随工作区走）：它们描述的是
// 「这个人在什么环境里读代码」，与工作区无关。
//
// 与其它显示偏好同纪律（见 responsePresentation / layout）：写入失败不抛出、
// 读不懂的值回落缺省——一条外观坏值不该把编辑器拖进不可用。

import type { Commands } from './commands';
import type { WrapLinesOverride } from './types';

/** 落点：与 Rust 侧无关（`setting_keys` 只服务 Rust 自己读的键），纯前端作用域。 */
const SCOPE = 'editor_appearance';
const FONT_FAMILY_KEY = 'font_family';
const FONT_SIZE_KEY = 'font_size';
const INDENT_COUNT_KEY = 'indent_count';
const INDENT_TYPE_KEY = 'indent_type';
const WRAP_KEY = 'wrap';

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

/** 缩进类型：空格或制表符。它同时作用于代码编辑面与 JSON / XML 的格式化输出。 */
export type IndentType = 'space' | 'tab';

export interface EditorAppearance {
  /** 字体族，可写完整字体栈（自由文本）。 */
  fontFamily: string;
  /** 等宽字号（像素）。 */
  fontSize: number;
  /** 一个代码层级的缩进宽度。 */
  indentCount: number;
  indentType: IndentType;
  /** 代码编辑面的折行缺省（spec: code-editors「代码编辑面的折行」）。 */
  wrap: boolean;
}

/** 缺省：既有的系统等宽栈 / 12px（与 `--text-sm` 对齐）/ 缩进 4 / 空格 / 折行开。 */
export const DEFAULT_EDITOR_APPEARANCE: EditorAppearance = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 12,
  indentCount: 4,
  indentType: 'space',
  wrap: true,
};

/**
 * 「缩进数 + 缩进类型」换算成**格式化输出**用的缩进单元——一层缩进是几个空格，或一个制表符。
 *
 * Tab 档下每层只写一个 `\t`，它的显示宽度由编辑面的 `tabSize`（即缩进数）呈现，因此同一份
 * 格式化输出在编辑面与纯文本面里的观感自动一致，不必把缩进数写进文本里。
 *
 * 这是全应用唯一一处把缩进配置翻译成格式化参数的入口：`prettyJson` / `prettyXml` /
 * `renderBody` / `formatRawBody` 都吃它的产物（spec: code-editors「等宽面的外观与缩进」）。
 */
export function indentUnit(
  value: Pick<EditorAppearance, 'indentCount' | 'indentType'>,
): string {
  return value.indentType === 'tab' ? '\t' : ' '.repeat(value.indentCount);
}

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

/**
 * 折行缺省：只有明确的 `'false'` 才关，其余（读不懂、缺失、空）一律回缺省（开）。
 *
 * 也接受布尔值——`applyEditorAppearance` 拿到的可能是还没落库的界面状态。
 */
export function parseWrap(raw: string | boolean | null | undefined): boolean {
  if (typeof raw === 'boolean') return raw;
  return (raw ?? '').trim() === 'false' ? false : DEFAULT_EDITOR_APPEARANCE.wrap;
}

/**
 * 折行的**生效值**：应用级缺省 + 请求级覆盖（spec: ui-layout「折行」）。
 *
 * 解析规则只有这一处；`RequestEditor` / `ResponsePanel` 只消费结果（`inherit` 与缺失都
 * 表示「跟全局走」，与「响应格式」的三层解析同形）。
 */
export function resolveWrapLines(
  globalWrap: boolean,
  request: WrapLinesOverride | null | undefined,
): boolean {
  if (request === 'on') return true;
  if (request === 'off') return false;
  return globalWrap;
}

/** 读回五项；任一读不懂时各自回落缺省。 */
export async function readEditorAppearance(commands: Commands): Promise<EditorAppearance> {
  const [family, size, count, type, wrap] = await Promise.all([
    commands.settingsGet(SCOPE, FONT_FAMILY_KEY),
    commands.settingsGet(SCOPE, FONT_SIZE_KEY),
    commands.settingsGet(SCOPE, INDENT_COUNT_KEY),
    commands.settingsGet(SCOPE, INDENT_TYPE_KEY),
    commands.settingsGet(SCOPE, WRAP_KEY),
  ]);

  return {
    fontFamily: parseFontFamily(family),
    fontSize: parseFontSize(size),
    indentCount: parseIndentCount(count),
    indentType: parseIndentType(type),
    wrap: parseWrap(wrap),
  };
}

/** 写入五项；失败静默（同其它显示偏好，下一次改动会再写一遍）。 */
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
      commands.settingsSet(SCOPE, WRAP_KEY, String(value.wrap)),
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
    wrap: parseWrap(value.wrap),
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
