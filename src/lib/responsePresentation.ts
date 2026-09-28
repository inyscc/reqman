// 响应呈现的应用级配置与三层解析（change: response-format-selector，design D3）。
//
// 复用既有的 settings 表——前端不直连存储，全部能力都经具名命令进 Rust
// （见 src/lib/commands.ts）。作用域名沿用 scriptRuntime / layout 那套 snake_case 约定。
//
// 这一层是**应用级**的（不随工作区走）：格式检测是个人阅读偏好，与「哪个工作区」无关。
// 缩进**不在这里**——它由编辑器外观的「缩进数 + 缩进类型」统一管辖
// （spec: code-editors「等宽面的外观与缩进」）。

import type { Commands } from './commands';

/** 应用设置存在 settings 表里的作用域；key 是下面这个常量。 */
export const PRESENTATION_SCOPE = 'response_presentation';
export const FORMAT_DETECTION_KEY = 'format_detection';

/**
 * 已退场的键：`indent_width`（旧的「格式化缩进宽度」设置）。
 *
 * 缩进改为全应用唯一的一份（编辑器外观）之后，它既不被读也不被写。存储里若还留着这一行，
 * **不清理、不迁移**——两个设置的语义不可通约，把旧值灌回会驱动编辑面的新值
 * （design D2）。这个常量只为让"不再读写它"这件事可被断言。
 */
export const RETIRED_INDENT_WIDTH_KEY = 'indent_width';

/** 全局默认的呈现格式：Auto（跟随检测）或强制 JSON。 */
export type FormatDetection = 'auto' | 'json';

/** 请求级覆盖：跟着全局走，或自行指定（spec: ui-layout「请求级响应格式覆盖」）。 */
export type RequestResponseFormat = 'inherit' | 'auto' | 'json';

export interface ResponsePresentation {
  formatDetection: FormatDetection;
}

/** 与改动前的行为一致：跟随检测。 */
export const DEFAULT_PRESENTATION: ResponsePresentation = {
  formatDetection: 'auto',
};

/** 读不懂的值一律回到默认——一条显示偏好不该把界面拖进错误态。 */
export function parseFormatDetection(raw: string | null | undefined): FormatDetection {
  return raw === 'json' ? 'json' : 'auto';
}

/** 读回应用级呈现配置；缺失或读不懂时回落默认。 */
export async function readPresentation(commands: Commands): Promise<ResponsePresentation> {
  const detection = await commands.settingsGet(PRESENTATION_SCOPE, FORMAT_DETECTION_KEY);

  return { formatDetection: parseFormatDetection(detection) };
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
    await commands.settingsSet(PRESENTATION_SCOPE, FORMAT_DETECTION_KEY, value.formatDetection);
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
