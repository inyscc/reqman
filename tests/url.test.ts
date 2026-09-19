import { describe, expect, it } from 'vitest';
import {
  alignUrlAndParams,
  composeUrl,
  splitUrlQuery,
  withParams,
  withUrl,
} from '../src/lib/url';
import { defaultSettings, emptyAuth, emptyBody, type KeyValue, type SavedRequest } from '../src/lib/types';

function row(key: string, value: string, enabled = true): KeyValue {
  return { key, value, enabled };
}

function draft(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    folder_id: null,
    name: '我的请求',
    method: 'GET',
    url: 'https://api.test/users',
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
    ...overrides,
  };
}

describe('拆分 URL 的查询串', () => {
  it('把查询串拆成参数行，并给出不含查询串的基础部分', () => {
    const split = splitUrlQuery('https://api.test/users?page=1&size=10');

    expect(split.hasQuery).toBe(true);
    expect(split.base).toBe('https://api.test/users');
    expect(split.params).toEqual([row('page', '1'), row('size', '10')]);
  });

  it('没有查询串时不产生参数，基础部分原样保留', () => {
    const split = splitUrlQuery('https://api.test/users');

    expect(split.hasQuery).toBe(false);
    expect(split.base).toBe('https://api.test/users');
    expect(split.params).toEqual([]);
  });

  it('fragment 归基础部分，不参与查询串', () => {
    const split = splitUrlQuery('https://api.test/users?page=1#section');

    expect(split.base).toBe('https://api.test/users#section');
    expect(split.params).toEqual([row('page', '1')]);
  });

  it('保留重复键与空值', () => {
    const split = splitUrlQuery('https://api.test/users?tag=a&tag=b&flag');

    expect(split.params).toEqual([row('tag', 'a'), row('tag', 'b'), row('flag', '')]);
  });

  it('未解析的 {{var}} 与相对地址都不需要能构造 URL 对象', () => {
    const split = splitUrlQuery('/users/:id?q={{kw}}');

    expect(split.base).toBe('/users/:id');
    expect(split.params).toEqual([row('q', '{{kw}}')]);
  });
});

describe('用参数表重建 URL', () => {
  it('把参数表写成查询串', () => {
    expect(composeUrl('https://api.test/users', [row('page', '1'), row('size', '10')])).toBe(
      'https://api.test/users?page=1&size=10',
    );
  });

  it('参数表为空时去掉查询串', () => {
    expect(composeUrl('https://api.test/users?page=1', [])).toBe('https://api.test/users');
  });

  it('整体替换原有查询串，不残留旧参数', () => {
    expect(composeUrl('https://api.test/users?old=1', [row('page', '2')])).toBe(
      'https://api.test/users?page=2',
    );
  });

  it('保留 fragment，且不编码 {{var}}', () => {
    expect(composeUrl('https://api.test/users?a=1#top', [row('q', '{{kw}}')])).toBe(
      'https://api.test/users?q={{kw}}#top',
    );
  });

  it('值里的空格与特殊字符按查询串规则编码', () => {
    expect(composeUrl('https://api.test/users', [row('q', 'a b&c')])).toBe(
      'https://api.test/users?q=a+b%26c',
    );
  });
});

describe('地址栏编辑：URL 为准', () => {
  it('URL 里写查询串，参数表跟随', () => {
    const next = withUrl(draft(), 'https://api.test/users?page=1&size=10');

    expect(next.url).toBe('https://api.test/users?page=1&size=10');
    expect(next.params).toEqual([row('page', '1'), row('size', '10')]);
  });

  it('URL 里删掉查询串，参数表清空', () => {
    const next = withUrl(
      draft({ url: 'https://api.test/users?a=1', params: [row('a', '1')] }),
      'https://api.test/users',
    );

    expect(next.params).toEqual([]);
  });

  it('同键的旧行保留启用状态与描述', () => {
    const next = withUrl(
      draft({
        url: 'https://api.test/users?a=1',
        params: [{ key: 'a', value: '1', enabled: false, description: '备注' }],
      }),
      'https://api.test/users?a=1',
    );

    expect(next.params).toEqual([{ key: 'a', value: '1', enabled: false, description: '备注' }]);
  });

  it('URL 里新出现的键按启用处理', () => {
    const next = withUrl(draft({ params: [row('old', '1')] }), 'https://api.test/users?fresh=2');

    expect(next.params).toEqual([row('fresh', '2')]);
  });
});

describe('参数表编辑：URL 跟随', () => {
  it('改参数表即重写 URL 的查询串', () => {
    const next = withParams(draft(), [row('page', '1')]);

    expect(next.params).toEqual([row('page', '1')]);
    expect(next.url).toBe('https://api.test/users?page=1');
  });

  it('清空参数表即去掉 URL 的查询串', () => {
    const next = withParams(draft({ url: 'https://api.test/users?a=1' }), []);

    expect(next.url).toBe('https://api.test/users');
  });
});

describe('打开请求时对齐两份数据', () => {
  it('URL 带查询串时以 URL 为准，替换掉表格里的旧参数', () => {
    const aligned = alignUrlAndParams(
      draft({
        url: 'http://localhost:8899/smoke?a=a&b=c',
        params: [row('12', '2'), row('1', '1')],
      }),
    );

    expect(aligned.url).toBe('http://localhost:8899/smoke?a=a&b=c');
    expect(aligned.params).toEqual([row('a', 'a'), row('b', 'c')]);
  });

  it('URL 没有查询串时把已有参数补写进 URL，不丢数据', () => {
    const aligned = alignUrlAndParams(draft({ params: [row('page', '1')] }));

    expect(aligned.url).toBe('https://api.test/users?page=1');
    expect(aligned.params).toEqual([row('page', '1')]);
  });

  it('已经一致时返回原引用', () => {
    const request = draft({ url: 'https://api.test/users?page=1', params: [row('page', '1')] });

    expect(alignUrlAndParams(request)).toBe(request);
  });

  it('既没有查询串也没有参数时原样返回', () => {
    const request = draft();

    expect(alignUrlAndParams(request)).toBe(request);
  });
});
