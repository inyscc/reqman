// 前置脚本改请求头之后，改动如何落到待发请求上（design D3）。
//
// 这里只测纯函数：差异比较与合并。真正的"合并后的请求被发出去"由 App 的用例覆盖，
// 沙箱侧的回读由 `tests/script-phase.test.ts` 覆盖。

import { describe, expect, it } from 'vitest';
import {
  applyScriptHeaders,
  diffRequestHeaders,
  withSentBody,
  withSentHeaders,
} from '../src/lib/scriptHeaders';
import { emptyAuth, emptyBody, defaultSettings, type SavedRequest } from '../src/lib/types';

function draft(headers: [string, string][]): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    folder_id: null,
    name: 'R',
    method: 'GET',
    url: 'https://api.test/x',
    params: [],
    headers: headers.map(([key, value]) => ({ key, value, enabled: true, description: null })),
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
  };
}

describe('diffRequestHeaders', () => {
  it('请求头未被改动时返回 null', () => {
    const fed = [
      { key: 'X-Trace', value: 'abc' },
      { key: 'Accept', value: 'json' },
    ];

    // 顺序变化不算改动：多重集相同
    expect(diffRequestHeaders(fed, [{ key: 'Accept', value: 'json' }, { key: 'X-Trace', value: 'abc' }])).toBeNull();
    // 大小写不同的同名头也不算改动
    expect(diffRequestHeaders([{ key: 'Content-Type', value: 'a' }], [{ key: 'content-type', value: 'a' }])).toBeNull();
  });

  it('新增的头进入 set', () => {
    const change = diffRequestHeaders(
      [{ key: 'X-Trace', value: 'abc' }],
      [
        { key: 'X-Trace', value: 'abc' },
        { key: 'X-Injected', value: '1' },
      ],
    );

    expect(change).not.toBeNull();
    expect(change?.set).toEqual([{ key: 'X-Injected', value: '1' }]);
    expect(change?.remove).toEqual([]);
  });

  it('按名改写的头进入 set，且忽略大小写匹配同名', () => {
    const change = diffRequestHeaders(
      [{ key: 'X-Trace', value: 'abc' }],
      [{ key: 'x-trace', value: 'zzz' }],
    );

    expect(change?.set).toEqual([{ key: 'x-trace', value: 'zzz' }]);
    expect(change?.remove).toEqual([]);
  });

  it('被移除的头进入 remove，且键为小写', () => {
    const change = diffRequestHeaders(
      [
        { key: 'X-Trace', value: 'abc' },
        { key: 'X-Drop', value: '1' },
      ],
      [{ key: 'X-Trace', value: 'abc' }],
    );

    expect(change?.set).toEqual([]);
    expect(change?.remove).toEqual(['x-drop']);
  });

  it('被脚本置为禁用的头等价于移除', () => {
    const change = diffRequestHeaders(
      [{ key: 'X-Drop', value: '1' }],
      [{ key: 'X-Drop', value: '1', disabled: true }],
    );

    expect(change?.remove).toEqual(['x-drop']);
  });
});

describe('applyScriptHeaders', () => {
  it('没有改动时原样返回同一个对象', () => {
    const request = draft([['X-Trace', 'abc']]);
    const result = applyScriptHeaders(request, null);

    expect(result.changed).toBe(false);
    expect(result.request).toBe(request);
  });

  it('新增头追加在末尾，且为启用状态', () => {
    const result = applyScriptHeaders(draft([['X-Trace', 'abc']]), {
      set: [{ key: 'X-Injected', value: '1' }],
      remove: [],
    });

    expect(result.changed).toBe(true);
    expect(result.request.headers).toEqual([
      { key: 'X-Trace', value: 'abc', enabled: true, description: null },
      { key: 'X-Injected', value: '1', enabled: true, description: null },
    ]);
    // 草稿不被就地改写
    expect(draft([['X-Trace', 'abc']]).headers).toHaveLength(1);
  });

  it('改写同名的既有头时保留它的位置，不复用占位符的值', () => {
    const result = applyScriptHeaders(draft([['X-Trace', '{{old}}'], ['Accept', 'json']]), {
      set: [{ key: 'x-trace', value: 'fresh' }],
      remove: [],
    });

    expect(result.request.headers.map((header) => header.value)).toEqual(['fresh', 'json']);
  });

  it('移除按名过滤，且不影响其它头', () => {
    const result = applyScriptHeaders(
      draft([['X-Drop', '1'], ['X-Keep', '2']]),
      { set: [], remove: ['x-drop'] },
    );

    expect(result.request.headers.map((header) => header.key)).toEqual(['X-Keep']);
  });
});

describe('withSentHeaders', () => {
  const snapshot = {
    url: 'https://api.test/x',
    method: 'GET',
    header: [{ key: 'X-Trace', value: 'abc' }],
  };

  it('用实际发出的头覆盖快照的头，其余字段原样保留', () => {
    expect(withSentHeaders(snapshot, [['Authorization', 'Bearer t']])).toEqual({
      ...snapshot,
      header: [{ key: 'Authorization', value: 'Bearer t' }],
    });
  });

  it('后端没给这份头时原样返回快照（不清空请求头）', () => {
    expect(withSentHeaders(snapshot, undefined)).toBe(snapshot);
    expect(withSentHeaders(snapshot, [])).toBe(snapshot);
  });
});

describe('withSentBody', () => {
  const snapshot = {
    url: 'https://api.test/x',
    method: 'POST',
    header: [{ key: 'X-Trace', value: 'abc' }],
    body: { mode: 'raw' as const, raw: '{"channelId":"0"}' },
  };

  it('用实际发出的正文覆盖快照的正文，其余字段原样保留', () => {
    // 快照是脚本执行前的解析结果，前置脚本刚写的变量在其中还是旧值
    expect(withSentBody(snapshot, '{"channelId":"1"}')).toEqual({
      ...snapshot,
      body: { mode: 'raw', raw: '{"channelId":"1"}' },
    });
  });

  it('快照里没有正文时也照样补上：确实发出了一段正文', () => {
    const bare = { url: 'https://api.test/x', method: 'POST', header: [] };
    expect(withSentBody(bare, '{"a":1}')).toEqual({
      ...bare,
      body: { mode: 'raw', raw: '{"a":1}' },
    });
  });

  it('后端没给正文（表单、多段、二进制）时原样返回快照', () => {
    expect(withSentBody(snapshot, null)).toBe(snapshot);
    expect(withSentBody(snapshot, undefined)).toBe(snapshot);
  });

  it('正文为空串是有效取值：发出去了一个空正文', () => {
    expect(withSentBody(snapshot, '')).toEqual({ ...snapshot, body: { mode: 'raw', raw: '' } });
  });
});
