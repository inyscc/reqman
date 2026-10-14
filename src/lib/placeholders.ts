// 占位符的解析与命中判定（change: show-variable-values-on-hover，任务 2.1）。
//
// 「哪些字符是 `{{name}}`」只有一处实现：地址栏的着色叠层与悬停命中判定都用 `variableRanges`
// 切区间。两处各写一条正则，迟早会出现「高亮得到的范围」与「能悬停的范围」不一致——那种
// 不一致在界面上表现为「明明高亮了却悬停不出提示」，是最难被报告、也最难查的一类。
//
// 命中判定按**字符下标**做，而不是给叠层里的 `.var` 开 `pointer-events: auto`：叠层一旦吃到
// 指针事件，点击就落不到 input 上，光标定位与选取都会废掉——地址栏这种位置不可接受
// （design D3）。因此这里把 clientX 换算成字符下标，再问区间。

/** 占位符：`{{` 与 `}}` 之间不含花括号。地址栏着色与命中判定共用这一条。 */
const VARIABLE_SOURCE = '\\{\\{[^{}]*\\}\\}';

export interface VariableRange {
  /** 占位符里的名字（去掉两层花括号与 `$` 之外的原文）。 */
  name: string;
  /** 起始下标（含）。 */
  start: number;
  /** 结束下标（不含）。 */
  end: number;
}

/** 文本里所有 `{{name}}` 的区间，按出现顺序。 */
export function variableRanges(text: string): VariableRange[] {
  const ranges: VariableRange[] = [];
  if (!text.includes('{{')) return ranges;

  // 每次新建正则：`g` 正则自带 lastIndex 状态，复用同一个对象会漏掉后续匹配
  const pattern = new RegExp(VARIABLE_SOURCE, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    ranges.push({
      name: match[0].slice(2, -2),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return ranges;
}

/** 字符下标落在哪个占位符区间里；不在任何区间里时返回 null。 */
export function rangeAtIndex(text: string, index: number): VariableRange | null {
  return (
    variableRanges(text).find((range) => index >= range.start && index < range.end) ?? null
  );
}

/** 文本宽度测量：由调用方给出，测试因此不必依赖真实排版。 */
export type TextMeasure = (text: string) => number;

/** 复用的测量画布：每次 mousemove 都新建一个 canvas 是纯浪费。 */
let measureCanvas: HTMLCanvasElement | null = null;

/**
 * 与 input 同字体的测量。
 *
 * 用 canvas 按计算样式取字宽，而不是假设等宽：地址栏用的是等宽字体，表格里的输入框却
 * 不是——同一条判定要能同时服务这两处（任务 2.2）。
 */
export function inputTextMeasure(input: HTMLInputElement): TextMeasure {
  measureCanvas ??= document.createElement('canvas');
  const context = measureCanvas.getContext('2d');
  const style = window.getComputedStyle(input);

  if (context) {
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  }

  return (text: string) => (context ? context.measureText(text).width : 0);
}

/** 文本起点相对 input 边框盒左缘的内缩（边框 + 内边距）。 */
function textInset(input: HTMLInputElement): number {
  const style = window.getComputedStyle(input);
  // happy-dom 下取不到这两个值时按 0 处理，而不是让 NaN 把整个判定污染掉
  const border = Number.parseFloat(style.borderLeftWidth);
  const padding = Number.parseFloat(style.paddingLeft);
  return (Number.isFinite(border) ? border : 0) + (Number.isFinite(padding) ? padding : 0);
}

/**
 * 把「相对文本起点的像素偏移」换算成字符下标。
 *
 * 前缀宽度随下标单调不减，因此二分即可；落在第 i 个字符占的区间里就返回 i。
 */
export function charIndexAtWidth(measure: TextMeasure, text: string, offset: number): number | null {
  if (offset < 0 || text.length === 0) return null;

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (measure(text.slice(0, mid)) <= offset) low = mid;
    else high = mid - 1;
  }

  // 落在文本末尾之后（空白区）时归到最后一个字符——那样它自然不在任何占位符区间里
  return Math.min(low, text.length - 1);
}

export interface PlaceholderHit extends VariableRange {
  /** 占位符在**视口**里的矩形，用来把提示锚到它下面。 */
  rect: { left: number; top: number; bottom: number; width: number };
}

export interface HitTestOptions {
  /** 文本宽度测量；缺省按 input 的计算样式测。 */
  measure?: TextMeasure;
  /** 文本起点相对边框盒左缘的内缩；缺省从计算样式取。 */
  textInset?: number;
}

/**
 * 指针落在哪个占位符上。
 *
 * `scrollLeft` 必须补偿：地址栏的文字会横向滚动，而 `getBoundingClientRect()` 只给边框盒
 * 的位置——不补偿的话，滚过之后命中的会整体偏移一段（看起来像「提示指向了旁边的字符」）。
 */
export function placeholderAtClientX(
  input: HTMLInputElement,
  clientX: number,
  options: HitTestOptions = {},
): PlaceholderHit | null {
  const text = input.value;
  if (!text.includes('{{')) return null;

  const measure = options.measure ?? inputTextMeasure(input);
  const inset = options.textInset ?? textInset(input);
  const bounds = input.getBoundingClientRect();
  const textLeft = bounds.left + inset - input.scrollLeft;

  const index = charIndexAtWidth(measure, text, clientX - textLeft);
  if (index === null) return null;

  const range = rangeAtIndex(text, index);
  if (!range) return null;

  return {
    ...range,
    rect: {
      left: textLeft + measure(text.slice(0, range.start)),
      top: bounds.top,
      bottom: bounds.bottom,
      width: measure(text.slice(range.start, range.end)),
    },
  };
}
