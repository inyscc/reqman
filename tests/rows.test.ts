import { describe, expect, it } from 'vitest';
import {
  isEmptyFormField,
  isEmptyKeyValue,
  withoutEmptyFormFields,
  withoutEmptyKeyValues,
  withoutEmptyRows,
} from '../src/lib/rows';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type FormField,
  type KeyValue,
  type SavedRequest,
} from '../src/lib/types';

function kv(key: string, value: string, enabled = true): KeyValue {
  return { key, value, enabled };
}

function field(key: string, value: string | null, kind: 'text' | 'file' = 'text'): FormField {
  return { key, value, file_handle: null, description: null, kind, enabled: true };
}

function request(overrides: Partial<SavedRequest> = {}): SavedRequest {
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

describe('空行清洗', () => {
  it('KeyValue 的名称与值皆空才算空行', () => {
    expect(isEmptyKeyValue(kv('', ''))).toBe(true);
    expect(isEmptyKeyValue(kv('  ', '   '))).toBe(true);
    expect(isEmptyKeyValue(kv('a', ''))).toBe(false);
    expect(isEmptyKeyValue(kv('', 'b'))).toBe(false);
  });

  it('enabled 为 false 但仍有内容的行被保留', () => {
    const rows = [kv('x-disabled', 'v', false), kv('', '')];
    expect(withoutEmptyKeyValues(rows)).toEqual([kv('x-disabled', 'v', false)]);
  });

  it('FormField 的空行只以名称为准', () => {
    // file 类型的字段本来就没有值，不能因为 value 为空就删掉
    expect(isEmptyFormField(field('avatar', null, 'file'))).toBe(false);
    expect(isEmptyFormField(field('', null, 'file'))).toBe(true);
    expect(withoutEmptyFormFields([field('avatar', null, 'file'), field('', '')])).toEqual([
      field('avatar', null, 'file'),
    ]);
  });

  it('没有空行时返回原引用', () => {
    const source = request({ params: [kv('a', '1')], headers: [kv('b', '2')] });
    expect(withoutEmptyRows(source)).toBe(source);
  });

  it('params、headers、urlencoded、form 各自清洗', () => {
    const source = request({
      params: [kv('a', '1'), kv('', '')],
      headers: [kv('', ''), kv('b', '2')],
      body: {
        ...emptyBody(),
        kind: 'form_data',
        // 只有名字没有值的行不算空行（用户可能正打算填值）
        urlencoded: [kv('only-key', ''), kv('', '')],
        form: [field('', ''), field('file', null, 'file')],
      },
    });

    const cleaned = withoutEmptyRows(source);

    expect(cleaned.params).toEqual([kv('a', '1')]);
    expect(cleaned.headers).toEqual([kv('b', '2')]);
    expect(cleaned.body.urlencoded).toEqual([kv('only-key', '')]);
    expect(cleaned.body.form).toEqual([field('file', null, 'file')]);
    // 其余字段不受影响
    expect(cleaned.url).toBe(source.url);
    expect(cleaned.body.kind).toBe('form_data');
  });
});
