// 变量候选的判定、过滤与替换（change: suggest-variables-while-typing，任务 1.1）。
//
// 与 `placeholders.ts` 的分工：那里回答「指针落在哪个**已闭合**的占位符上」，这里回答
// 「光标是否正在输入一个**未闭合**的占位符」。两者不能合成一条正则——`{{ho` 根本不匹配
// `\{\{[^{}]*\}\}`，用它做触发条件的话，用户刚敲下 `{{` 时什么都不会发生。
//
// 但两者的替换范围必须一致：光标落在已闭合的 `{{host}}` 里时，插入的是「替换整个占位符」
// 而不是「在光标处插一段」。否则改名字会得到 `{{{{name}}st}}`。

/** 一次候选的触发上下文。 */
export interface SuggestContext {
  /** `{{` 的起始下标（含）——替换范围从这里开始。 */
  start: number;
  /** 替换范围的结束下标（不含）。通常就是光标；光标后紧跟 `名字}}` 时延到 `}}` 之后。 */
  end: number;
  /** `{{` 与光标之间已经键入的名字片段，用于过滤。 */
  query: string;
}

/** 名字片段里不允许出现的字符：出现即说明光标不在一个「正在输入的名字」里。 */
const NAME_BREAK = /[{}]/;

/**
 * 光标处是否正在输入一个变量的名字。
 *
 * 三步：回溯到最近的 `{{`；确认它与光标之间没有花括号与换行；再看光标之后是否已经写好了
 * `}}`——写好了就把替换范围延到它之后（这次输入是「改名字」，不是「第一次写」）。
 */
export function suggestContext(text: string, caret: number): SuggestContext | null {
  if (caret < 0 || caret > text.length) return null;

  const start = text.lastIndexOf('{{', Math.max(caret - 1, 0));
  // 光标必须在 `{{` 之后：停在两个花括号之间或更前面时不算「正在输入名字」
  if (start < 0 || caret < start + 2) return null;

  const query = text.slice(start + 2, caret);
  if (query.includes('\n') || NAME_BREAK.test(query)) return null;

  // 光标之后若紧跟 `名字}}`，把这个 `}}` 一并纳入替换范围；否则替换范围止于光标
  const closing = /^[^{}\n]*\}\}/.exec(text.slice(caret));
  const end = closing ? caret + closing[0].length : caret;

  return { start, end, query };
}

/** 一条候选：名字、当前解析所用的取值、来源作用域，以及它是否标记为 secret。 */
export interface Suggestible {
  name: string;
  value: string;
  scope: 'environment' | 'collection' | 'global';
  secret: boolean;
}

/**
 * 按键入内容过滤候选。
 *
 * 前缀匹配排在包含匹配之前——用户敲 `{{ho` 时想要的几乎总是 `host`，而不是 `x-hook`。
 * 两组内部保持传入顺序（调用方已按作用域与名称排好），因此同一份输入每次得到同一个顺序。
 */
export function filterCandidates<T extends Suggestible>(candidates: T[], query: string): T[] {
  if (query === '') return candidates;

  const needle = query.toLowerCase();
  const prefix: T[] = [];
  const contains: T[] = [];

  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(candidate);
    else if (name.includes(needle)) contains.push(candidate);
  }

  return [...prefix, ...contains];
}

/** 替换结果：新文本，以及插入后光标应落到的下标。 */
export interface SuggestEdit {
  text: string;
  caret: number;
}

/**
 * 把候选写进文本。
 *
 * 插入的是完整的 `{{name}}`——`}}` 由这里补，因此用户不必再敲；替换范围由
 * `suggestContext` 给出，改名字时旧花括号与旧名字一并被覆盖。
 */
export function applySuggestion(text: string, context: SuggestContext, name: string): SuggestEdit {
  const inserted = `{{${name}}}`;
  return {
    text: text.slice(0, context.start) + inserted + text.slice(context.end),
    caret: context.start + inserted.length,
  };
}
