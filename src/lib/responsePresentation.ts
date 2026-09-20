// 响应呈现的应用级配置与三层解析（change: response-format-selector，design D3）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。作用域名沿用 scriptRuntime / layout 那套 snake_case 约定。
//
// 这一层是**应用级**的（不随工作区走）：格式检测与缩进宽度是个人阅读偏好，
// 与「哪个工作区」无关。

import type { Commands } from './commands';
import { INDENT_WIDTHS, type IndentWidth } from './sandbox';

/** 应用设置存在 settings 表里的作用域；key 是下面两个常量。 */
export const PRESENTATION_SCOPE = 'response_presentation';
export const FORMAT_DETECTION_KEY = 'format_detection';
export const INDENT_WIDTH_KEY = 'indent_width';

/** 全局默认的呈现格式：Auto（跟随检测）或强制 JSON。 */
export type FormatDetection = 'auto' | 'json';

/** 请求级覆盖：跟着全局走，或自行指定（spec: ui-layout「请求级响应格式覆盖」）。 */
export type RequestResponseFormat = 'inherit' | 'auto' | 'json';

export interface ResponsePresentation {
  formatDetection: FormatDetection;
  indentWidth: IndentWidth;
}

/** 与改动前的行为一致：跟随检测、缩进 2（design 迁移方案）。 */
export const DEFAULT_PRESENTATION: ResponsePresentation = {
  formatDetection: 'auto',
  indentWidth: 2,
};

/** 读不懂的值一律回到默认——一条显示偏好不该把界面拖进错误态。 */
export function parseFormatDetection(raw: string | null | undefined): FormatDetection {
  return raw === 'json' ? 'json' : 'auto';
}

export function parseIndentWidth(raw: string | null | undefined): IndentWidth {
  const parsed = Number.parseInt(raw ?? '', 10);
  return INDENT_WIDTHS.find((width) => width === parsed) ?? 2;
}

/** 读回应用级呈现配置；缺失或读不懂时回落默认。 */
export async function readPresentation(commands: Commands): Promise<ResponsePresentation> {
  const [detection, indent] = await Promise.all([
    commands.settingsGet(PRESENTATION_SCOPE, FORMAT_DETECTION_KEY),
    commands.settingsGet(PRESENTATION_SCOPE, INDENT_WIDTH_KEY),
  ]);

  return {
    formatDetection: parseFormatDetection(detection),
    indentWidth: parseIndentWidth(indent),
  };
}

/**
 * 写入应用级呈现配置。
 *
 * 与 layout / sessionTabs 同纪律：写入失败不抛出——它只是显示偏好，下一次改动会再写一遍。
 */
export async function writePresentation(
  commands: Commands,
  value: ResponsePresentation,
): Promise<void> {
  try {
    await Promise.all([
      commands.settingsSet(PRESENTATION_SCOPE, FORMAT_DETECTION_KEY, value.formatDetection),
      commands.settingsSet(PRESENTATION_SCOPE, INDENT_WIDTH_KEY, String(value.indentWidth)),
    ]);
  } catch {
    // 有意静默：见上面的说明
  }
}

/**
 * 响应面板的**初始**呈现格式（spec: http-engine 三层解析；design D3）。
 *
 * 请求级覆盖优先于全局；`inherit` / 缺失都表示「跟全局走」。注意这里只产出
 * `auto` 或 `json`——Hex 等格式只能来自用户在下拉里的临时选择，不外溢到下一次。
 */
export function resolveInitialFormat(
  global: FormatDetection,
  request: RequestResponseFormat | null | undefined,
): 'auto' | 'json' {
  if (request === 'auto' || request === 'json') return request;
  return global;
}
