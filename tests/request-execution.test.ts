// 一次执行的 trace（change: add-console-panel）。
//
// 全局 Console 只认这份事实：方法、解析后的 URL、终态、实际发出的头与正文。因此这里逐个
// 出口验它的字段是否齐全——尤其是失败与取消那两路，那才是用户回头要查的。

import { describe, expect, it, vi } from 'vitest';
import type { Commands } from '../src/lib/commands';
import { executeRequest, type RequestExecutionOutcome } from '../src/lib/requestExecution';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type RequestPreview,
  type ResponsePayload,
  type SavedRequest,
} from '../src/lib/types';

function makeRequest(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    folder_id: null,
    name: '我的请求',
    method: 'POST',
    url: 'https://api.test/{{path}}',
    params: [],
    headers: [{ key: 'accept', value: 'application/json', enabled: true }],
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
    ...overrides,
  };
}

function preview(overrides: Partial<RequestPreview> = {}): RequestPreview {
  return {
    method: 'POST',
    url: 'https://api.test/device',
    params: [],
    headers: [['accept', 'application/json']],
    body_text: null,
    auth_kind: 'none',
    unresolved: [],
    masked: false,
    insecure_warning: false,
    ...overrides,
  };
}

function payload(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    id: 'resp-1',
    status: 200,
    status_text: 'OK',
    elapsed_ms: 99,
    size_bytes: 11,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{"ok":true}',
    pretty_available: true,
    pretty_print_threshold: 100_000,
    size_limit_bytes: 5_000_000,
    insecure_warning: false,
    final_url: 'https://api.test/device',
    request_url: 'https://api.test/device',
    request_headers: [
      ['accept', 'application/json'],
      ['authorization', 'Bearer t'],
    ],
    ...overrides,
  };
}

function attempt(id = 'a1') {
  return { attemptId: id, signal: new Promise<void>(() => {}), isCancelled: () => false };
}

function fakeClient(overrides: Partial<Record<keyof Commands, unknown>> = {}) {
  const client = {
    variablesPreview: vi.fn(async () => preview()),
    sendRequest: vi.fn(async () => payload()),
    ...overrides,
  };

  return client as unknown as Commands;
}

async function run(
  client: Commands,
  input: { skipScripts?: boolean; onBegin?: (pending: unknown) => void; attemptId?: string } = {},
): Promise<RequestExecutionOutcome> {
  return executeRequest(
    { client, workspaceId: 'w1', environmentId: 'e1' },
    {
      request: makeRequest(),
      dirty: true,
      // 默认跳过脚本：这些用例只关心 requestExecution 自己的 trace，脚本侧另有覆盖
      skipScripts: input.skipScripts ?? true,
      attempt: attempt(input.attemptId),
      onBegin: input.onBegin as never,
    },
  );
}

describe('成功响应的 trace', () => {
  it('状态、耗时、实际发出的头与正文都齐', async () => {
    const outcome = await run(fakeClient());
    const { trace } = outcome;

    expect(trace.sendId).toBe('a1');
    expect(trace.requestId).toBe('r1');
    expect(trace.method).toBe('POST');
    // 用解析后的 URL，而不是草稿里带 {{path}} 的原文
    expect(trace.url).toBe('https://api.test/device');
    expect(trace.result).toEqual({
      kind: 'response',
      status: 200,
      statusText: 'OK',
      elapsedMs: 99,
    });
    // 成功时以后端回带的「实际发出」为准：认证头只有它知道
    expect(trace.requestHeaders).toEqual([
      ['accept', 'application/json'],
      ['authorization', 'Bearer t'],
    ]);
    expect(trace.responseHeaders).toEqual([['content-type', 'application/json']]);
    expect(trace.body).toBe('{"ok":true}');
    expect(trace.bodyTruncated).toBe(false);
  });

  it('发送开始时先报到，此时还没有结果', async () => {
    const onBegin = vi.fn();
    await run(fakeClient(), { onBegin });

    expect(onBegin).toHaveBeenCalledTimes(1);
    expect(onBegin.mock.calls[0][0]).toMatchObject({
      sendId: 'a1',
      requestId: 'r1',
      method: 'POST',
      url: 'https://api.test/device',
    });
  });

  it('后端因体积上限截断正文时，trace 如实标出来', async () => {
    const client = fakeClient({
      sendRequest: vi.fn(async () => payload({ body_text: '前段…', truncated: true })),
    });

    const outcome = await run(client);

    expect(outcome.trace.bodyTruncated).toBe(true);
  });
});

describe('失败与取消的 trace', () => {
  it('DNS 失败记成 failed，且没有伪造的响应', async () => {
    const client = fakeClient({
      sendRequest: vi.fn(async () => {
        throw { code: 'dns_failure', message: '找不到主机' };
      }),
    });

    const outcome = await run(client);
    const { trace } = outcome;

    expect(trace.result).toEqual({ kind: 'failed', message: '找不到主机' });
    expect(trace.responseHeaders).toBeNull();
    expect(trace.body).toBeNull();
    // 失败时没有后端回带的头，退回解析快照——总比空白有用
    expect(trace.requestHeaders).toEqual([['accept', 'application/json']]);
  });

  it('取消记成 cancelled，而不是失败', async () => {
    const client = fakeClient({
      sendRequest: vi.fn(async () => {
        throw { code: 'cancelled', message: '已取消' };
      }),
    });

    const outcome = await run(client);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.trace.result).toEqual({ kind: 'cancelled' });
  });

  it('未解析变量算「未发出」，与失败分开', async () => {
    const client = fakeClient({
      sendRequest: vi.fn(async () => {
        throw { code: 'unresolved_variables', message: '存在未解析的变量：path' };
      }),
    });

    const outcome = await run(client);

    expect(outcome.trace.result).toEqual({
      kind: 'not-sent',
      reason: '存在未解析的变量：path',
    });
  });
});
