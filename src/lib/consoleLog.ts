// 全局 Console 的时间线（change: add-console-panel）。
//
// 这里只管「收什么、留多少、怎么筛」：不碰 React、不碰网络、不碰数据库。界面侧订阅它，
// 发送侧把 `trace` 交给它。之所以做成独立的小 store 而不是塞进 App 的 state，是因为
// App 已经很大，任何一条日志都把整棵树重渲染一遍是不必要的（design D5）。

import { useSyncExternalStore } from 'react';
import type { ConsoleEntry, ConsoleValue } from './scriptRuntime';

/** 时间线保留的条数上限；超出从头淘汰。 */
export const CONSOLE_LIMIT = 500;

/** 单条网络日志保留的响应正文上限（字符）。console 是「看一眼发了什么」，不是响应阅读器。 */
export const CONSOLE_BODY_LIMIT = 8 * 1024;

/** 一次发送的终态。四种情形互斥，与 `requestExecution` 的出口一一对应。 */
export type ConsoleResult =
  | { kind: 'response'; status: number; statusText: string; elapsedMs: number }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'not-sent'; reason: string };

/**
 * 发送侧交给时间线的一份事实。
 *
 * `sendId` 是这条记录的身份：网络条目先用它占位（发送中），拿到终态后按同一个 id 结算，
 * 因此时间线上的位置等于**发起**顺序，而不是结果返回的顺序（design D2）。
 */
export interface RequestTrace {
  sendId: string;
  /** 会话标签对应的请求 id；运行器里的请求也有，用于归属。 */
  requestId: string | null;
  method: string;
  /** 已解析变量的目标 URL；连解析都没走到时退回草稿里的原文。 */
  url: string;
  startedAt: number;
  requestHeaders: [string, string][];
  result: ConsoleResult;
  responseHeaders: [string, string][] | null;
  /** 响应正文摘录；没有响应时为 null。 */
  body: string | null;
  bodyTruncated: boolean;
  /** 本次发送产生的脚本输出。 */
  outputs: ConsoleEntry[];
  /** 本次真正配了脚本的层级（按执行顺序）；两阶段各自为空表示该阶段没跑脚本。 */
  segments: { prerequest: string[]; test: string[] };
}

export interface ConsoleNetworkEntry {
  id: string;
  kind: 'network';
  at: number;
  requestId: string | null;
  method: string;
  url: string;
  requestHeaders: [string, string][];
  /** 发送中为 null；`not-sent` 的条目从一开始就是终态。 */
  result: ConsoleResult | null;
  responseHeaders: [string, string][] | null;
  body: { text: string; truncated: boolean } | null;
}

export interface ConsoleOutputEntry {
  id: string;
  kind: 'output';
  at: number;
  requestId: string | null;
  phase: ConsoleEntry['phase'];
  level: string;
  segment: string | null;
  values: ConsoleValue[];
}

export type ConsoleLogEntry = ConsoleNetworkEntry | ConsoleOutputEntry;

/** 发送开始时要交给时间线的信息：此时还没有结果。 */
export interface NetworkStart {
  sendId: string;
  requestId: string | null;
  method: string;
  url: string;
  requestHeaders: [string, string][];
  at?: number;
}

export type ConsoleFilterKind = 'all' | 'network' | 'output';

export interface ConsoleFilter {
  query: string;
  kind: ConsoleFilterKind;
}

/**
 * 正文截断：超长时留前面一段并标记。
 *
 * 上限放在收集侧而不是渲染侧——渲染时再截已经晚了，内存早被占住了（design D7）。
 */
export function clipBody(text: string): { text: string; truncated: boolean } {
  if (text.length <= CONSOLE_BODY_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, CONSOLE_BODY_LIMIT), truncated: true };
}

/**
 * 一次发送的终态在文字上的叫法。
 *
 * 搜索与「复制这一条」共用它：同一个终态在两处不能有两种叫法，否则读起来像两回事
 * （design D3）。
 */
export function resultText(result: ConsoleResult | null): string {
  if (result === null) return '发送中';

  switch (result.kind) {
    case 'response':
      return `${result.status} ${result.statusText} ${result.elapsedMs} ms`;
    case 'failed':
      return `失败：${result.message}`;
    case 'cancelled':
      return '已取消';
    case 'not-sent':
      return `未发出：${result.reason}`;
  }
}

/** 输出的来源标记：阶段 · 脚本层级 · 级别。没有层级（集合层之外的兜底输出）就省略那一段。 */
export function entryTag(entry: Pick<ConsoleOutputEntry, 'phase' | 'level' | 'segment'>): string {
  return [entry.phase === 'prerequest' ? '前置' : '后置', entry.segment, entry.level]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** 条目上用于搜索的那几段文本，拼成一条可匹配的串。 */
function haystack(entry: ConsoleLogEntry): string {
  if (entry.kind === 'network') {
    return `${entry.method} ${entry.url} ${resultText(entry.result)}`;
  }

  return entry.values.map((value) => value.text).join(' ');
}

/**
 * 复制入口写进剪贴板的那一行文本（spec: request-console「条目的复制」）。
 *
 * 与界面上看到的一致：网络条目是「方法 URL — 结果」，输出条目是「[来源] 正文」。
 * 纯函数放在这里而不是组件里——它属于「条目说什么」，单测不必渲染（design D3）。
 */
export function entryToText(entry: ConsoleLogEntry): string {
  if (entry.kind === 'network') {
    return `${entry.method} ${entry.url} — ${resultText(entry.result)}`;
  }

  return `[${entryTag(entry)}] ${entry.values.map((value) => value.text).join(' ')}`;
}

/**
 * 按文本与类型筛条目。纯函数：只决定「显示哪些」，不改时间线本身（spec: request-console）。
 */
export function filterEntries(entries: ConsoleLogEntry[], filter: ConsoleFilter): ConsoleLogEntry[] {
  const query = filter.query.trim().toLowerCase();
  const byKind =
    filter.kind === 'all' ? entries : entries.filter((entry) => entry.kind === filter.kind);

  if (!query) return byKind;
  return byKind.filter((entry) => haystack(entry).toLowerCase().includes(query));
}

export interface ConsoleLogStore {
  snapshot(): ConsoleLogEntry[];
  version(): number;
  subscribe(listener: () => void): () => void;
  /** 发送开始时占位：此时还没有结果，条目标为「发送中」。 */
  beginNetwork(input: NetworkStart): void;
  /** 结算一次发送：更新占位条目，并追加它的脚本输出。 */
  recordOutcome(trace: RequestTrace): void;
  clear(): void;
}

function toOutputEntry(trace: RequestTrace, output: ConsoleEntry, index: number): ConsoleOutputEntry {
  return {
    id: `${trace.sendId}:out:${index}`,
    kind: 'output',
    at: trace.startedAt,
    requestId: trace.requestId,
    phase: output.phase,
    level: output.level,
    segment: output.segment,
    values: output.values,
  };
}

/**
 * 新建一条时间线。
 *
 * 做成工厂而不是直接导出一个模块级单例，是为了让测试各拿各的一份：日志是跨用例累积的
 * 东西，共享一份会让断言互相污染。
 */
export function createConsoleLog(limit: number = CONSOLE_LIMIT): ConsoleLogStore {
  let entries: ConsoleLogEntry[] = [];
  let version = 0;
  const listeners = new Set<() => void>();

  const publish = (next: ConsoleLogEntry[]) => {
    // 超出上限时从头淘汰：最新的那些必须留住，否则「刚发完就找不到」比没有还糟
    entries = next.length > limit ? next.slice(next.length - limit) : next;
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    snapshot: () => entries,
    version: () => version,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    beginNetwork: (input) => {
      const entry: ConsoleNetworkEntry = {
        id: input.sendId,
        kind: 'network',
        at: input.at ?? Date.now(),
        requestId: input.requestId,
        method: input.method,
        url: input.url,
        requestHeaders: input.requestHeaders,
        result: null,
        responseHeaders: null,
        body: null,
      };
      publish([...entries, entry]);
    },

    recordOutcome: (trace) => {
      const settled: ConsoleNetworkEntry = {
        id: trace.sendId,
        kind: 'network',
        at: trace.startedAt,
        requestId: trace.requestId,
        method: trace.method,
        url: trace.url,
        requestHeaders: trace.requestHeaders,
        result: trace.result,
        responseHeaders: trace.responseHeaders,
        body: trace.body === null ? null : clipBody(trace.body),
      };
      if (settled.body && trace.bodyTruncated) settled.body.truncated = true;

      const index = entries.findIndex(
        (entry) => entry.kind === 'network' && entry.id === trace.sendId,
      );
      const next = [...entries];
      if (index >= 0) {
        // 占位条目就位：原地替换，位次不变——时间线的顺序因此等于发起顺序
        next[index] = settled;
      } else {
        // 没占到位的（门禁拦下、解析就失败、刚发出就回来）直接以终态出现
        next.push(settled);
      }
      for (const [position, output] of trace.outputs.entries()) {
        next.push(toOutputEntry(trace, output, position));
      }
      publish(next);
    },

    clear: () => {
      if (entries.length === 0) return;
      publish([]);
    },
  };
}

/** 应用使用的那一份。 */
export const consoleLog = createConsoleLog();

/**
 * 订阅时间线。
 *
 * 快照按引用比较：没变化时 `snapshot()` 返回同一个数组，因此不会触发多余渲染。
 */
export function useConsoleLog(store: ConsoleLogStore = consoleLog): ConsoleLogEntry[] {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
