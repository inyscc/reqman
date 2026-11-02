import { describe, expect, it } from 'vitest';
import { applyScriptBody, diffRequestBody } from '../src/lib/scriptBody';
import { defaultSettings, emptyAuth, emptyBody, type SavedRequest } from '../src/lib/types';

function request(body: Partial<SavedRequest['body']> = {}): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    name: '请求',
    method: 'POST',
    url: 'https://api.test/users',
    params: [],
    headers: [],
    body: { ...emptyBody(), ...body },
    auth: emptyAuth(),
    settings: defaultSettings(),
    sort_order: 0,
  };
}

describe('请求体的差异合并', () => {
  it('一字未改时不算改动', () => {
    expect(
      diffRequestBody({ mode: 'raw', raw: '{"a":1}' }, { mode: 'raw', raw: '{"a":1}' }),
    ).toBeNull();
  });

  it('回读不到正文时不算改动（该段没跑完 / 形态不是 raw）', () => {
    expect(diffRequestBody({ mode: 'raw', raw: '{"a":1}' }, undefined)).toBeNull();
  });

  it('改动取执行后的整份正文', () => {
    expect(
      diffRequestBody({ mode: 'raw', raw: '{"a":1}' }, { mode: 'raw', raw: '{"a":2}' }),
    ).toEqual({ raw: '{"a":2}' });
  });
});

describe('把请求体的改动合并进待发请求', () => {
  it('raw 正文被替换，其它字段原样保留', () => {
    const before = request({ kind: 'raw', raw: '{"a":1}', raw_language: 'json' });

    const result = applyScriptBody(before, { raw: '{"a":2}' });

    expect(result.changed).toBe(true);
    expect(result.request.body).toEqual({ ...before.body, kind: 'raw', raw: '{"a":2}' });
    // 语言不跟着改：脚本改的是内容，不是语法
    expect(result.request.body.raw_language).toBe('json');
  });

  it('本来没有正文的请求被脚本补上正文', () => {
    const result = applyScriptBody(request({ kind: 'none', raw: null }), { raw: 'hello' });

    expect(result.changed).toBe(true);
    expect(result.request.body.kind).toBe('raw');
    expect(result.request.body.raw).toBe('hello');
  });

  it('表单与二进制正文不接受脚本改写，且明确告知', () => {
    const before = request({
      kind: 'url_encoded',
      urlencoded: [{ key: 'a', value: '1', enabled: true, description: null }],
    });

    const result = applyScriptBody(before, { raw: 'a=2' });

    // 同一个对象引用：调用方据此完全走原路径
    expect(result.request).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.ignored).toBe(true);
  });

  it('没有改动时原样返回', () => {
    const before = request({ kind: 'raw', raw: '{"a":1}' });

    const result = applyScriptBody(before, null);

    expect(result.request).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.ignored).toBe(false);
  });
});
