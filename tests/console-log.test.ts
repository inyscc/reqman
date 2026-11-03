// 全局 Console 的时间线（change: add-console-panel）。
//
// 这里验的是「收什么、留多少、怎么筛」——不涉及界面。每条用例各拿一份 `createConsoleLog()`，
// 免得日志在用例之间互相污染。

import { describe, expect, it } from 'vitest';
import {
  CONSOLE_BODY_LIMIT,
  CONSOLE_LIMIT,
  clipBody,
  createConsoleLog,
  filterEntries,
  type ConsoleLogEntry,
  type RequestTrace,
} from '../src/lib/consoleLog';

function trace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    sendId: 'send-1',
    requestId: 'req-1',
    method: 'POST',
    url: 'https://api.test/device/stream',
    startedAt: 1,
    requestHeaders: [['accept', 'application/json']],
    result: { kind: 'response', status: 200, statusText: 'OK', elapsedMs: 99 },
    responseHeaders: [['content-type', 'application/json']],
    body: '{"ok":true}',
    bodyTruncated: false,
    outputs: [],
    ...overrides,
  };
}

describe('时间线的追加与结算', () => {
  it('按产生顺序排列，最新的在后', () => {
    const log = createConsoleLog();

    log.recordOutcome(trace({ sendId: 'a', url: 'https://a.test/x' }));
    log.recordOutcome(trace({ sendId: 'b', url: 'https://b.test/x' }));

    expect(log.snapshot().map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('先占位再结算：只更新同一条，位次不变', () => {
    const log = createConsoleLog();

    log.beginNetwork({
      sendId: 'a',
      requestId: 'req-1',
      method: 'GET',
      url: 'https://api.test/slow',
      requestHeaders: [],
    });
    log.recordOutcome(trace({ sendId: 'b', url: 'https://api.test/fast' }));

    const pending = log.snapshot().find((entry) => entry.id === 'a');
    // 占位时还没有结果
    expect(pending?.kind === 'network' && pending.result).toBeNull();

    log.recordOutcome(trace({ sendId: 'a', url: 'https://api.test/slow' }));

    const entries = log.snapshot();
    // 慢的先进，就排在前面——顺序等于发起顺序，不是结果返回的顺序
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(entries.filter((entry) => entry.kind === 'network')).toHaveLength(2);
  });

  it('结算时同一条发送的脚本输出追加在后面', () => {
    const log = createConsoleLog();

    log.beginNetwork({
      sendId: 'a',
      requestId: 'req-1',
      method: 'GET',
      url: 'https://api.test/x',
      requestHeaders: [],
    });
    log.recordOutcome(
      trace({
        sendId: 'a',
        outputs: [
          { level: 'log', phase: 'prerequest', segment: '集合层', values: [{ text: '前置' }] },
          { level: 'log', phase: 'test', segment: '请求层', values: [{ text: '后置' }] },
        ],
      }),
    );

    const entries = log.snapshot();
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe('network');
    expect(entries[1]).toMatchObject({ kind: 'output', phase: 'prerequest', segment: '集合层' });
    expect(entries[2]).toMatchObject({ kind: 'output', phase: 'test', segment: '请求层' });
  });

  it('清空后回到空快照，重复清空不发通知', () => {
    const log = createConsoleLog();
    let notifications = 0;
    log.subscribe(() => {
      notifications += 1;
    });

    log.recordOutcome(trace());
    expect(log.snapshot()).toHaveLength(1);

    const before = log.version();
    log.clear();
    expect(log.snapshot()).toHaveLength(0);
    expect(log.version()).toBe(before + 1);

    log.clear();
    expect(log.version()).toBe(before + 1);
    expect(notifications).toBe(2);
  });
});

describe('容量与正文上限', () => {
  it('超出上限时淘汰最旧的，总数停在上限', () => {
    const log = createConsoleLog(3);

    for (const id of ['a', 'b', 'c', 'd']) {
      log.recordOutcome(trace({ sendId: id }));
    }

    expect(log.snapshot().map((entry) => entry.id)).toEqual(['b', 'c', 'd']);
  });

  it('默认上限是 500 条', () => {
    expect(CONSOLE_LIMIT).toBe(500);
  });

  it('正文超长只留前 8 KiB 并标记截断', () => {
    const log = createConsoleLog();
    const long = 'x'.repeat(20 * 1024);

    log.recordOutcome(trace({ body: long }));

    const entry = log.snapshot()[0];
    const body = entry.kind === 'network' ? entry.body : null;

    expect(body?.text).toHaveLength(CONSOLE_BODY_LIMIT);
    expect(body?.truncated).toBe(true);
  });

  it('短正文原样保留', () => {
    expect(clipBody('{"a":1}')).toEqual({ text: '{"a":1}', truncated: false });
  });
});

describe('搜索与过滤', () => {
  function seed(): ConsoleLogEntry[] {
    const log = createConsoleLog();
    log.recordOutcome(
      trace({
        sendId: 'a',
        method: 'POST',
        url: 'https://open.cloud-dahua.com/open-api/api/iot/device/createDeviceStreamUrl',
        result: { kind: 'response', status: 200, statusText: 'OK', elapsedMs: 99 },
      }),
    );
    log.recordOutcome(
      trace({
        sendId: 'b',
        method: 'GET',
        url: 'https://api.test/health',
        result: { kind: 'failed', message: '找不到主机' },
      }),
    );
    log.recordOutcome(
      trace({
        sendId: 'c',
        outputs: [
          { level: 'log', phase: 'test', segment: '请求层', values: [{ text: 'accessKey 已就绪' }] },
        ],
      }),
    );
    return log.snapshot();
  }

  it('按 URL 片段命中，大小写不敏感', () => {
    const hit = filterEntries(seed(), { query: 'CLOUD-DAHUA', kind: 'all' });

    expect(hit.map((entry) => entry.id)).toEqual(['a']);
  });

  it('按输出文本命中', () => {
    const hit = filterEntries(seed(), { query: 'accesskey', kind: 'all' });

    // 三次发送各有一条网络日志，输出只有第三条带的那一条
    expect(hit.map((entry) => entry.id)).toEqual(['c:out:0']);
  });

  it('按状态与失败原因命中', () => {
    const failed = filterEntries(seed(), { query: '找不到主机', kind: 'all' });

    expect(failed.map((entry) => entry.id)).toEqual(['b']);
  });

  it('过滤与搜索叠加', () => {
    // 输出条目里“api.test”不存在，所以「输出 + 该词」应当没有命中
    const combined = filterEntries(seed(), { query: 'api.test', kind: 'output' });

    expect(combined).toEqual([]);
  });

  it('切回 all 时被过滤掉的条目全部回来', () => {
    const entries = seed();

    // 三次发送各一条网络条目，第三条另带一条输出条目
    expect(filterEntries(entries, { query: '', kind: 'network' })).toHaveLength(3);
    expect(filterEntries(entries, { query: '', kind: 'output' })).toHaveLength(1);
    expect(filterEntries(entries, { query: '', kind: 'all' })).toHaveLength(4);
  });

  it('无命中返回空数组，而不是全量', () => {
    expect(filterEntries(seed(), { query: '没有这个词', kind: 'all' })).toEqual([]);
  });
});
