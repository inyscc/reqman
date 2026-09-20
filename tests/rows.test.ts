import { describe, expect, it } from 'vitest';
import {
  cleanForSend,
  hasRequestData,
  isDescriptionOnlyRow,
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

  it('FormField 的保留判定以名称与描述为准', () => {
    // file 类型的字段本来就没有值，不能因为 value 为空就删掉
    expect(isEmptyFormField(field('avatar', null, 'file'))).toBe(false);
    expect(isEmptyFormField(field('', null, 'file'))).toBe(true);
    // 只写了描述的行不是空行（保留档与键值行同构）
    const noted: FormField = { ...field('', null), description: '只写了说明' };
    expect(isEmptyFormField(noted)).toBe(false);
    expect(isEmptyFormField({ ...noted, description: '   ' })).toBe(true);
    expect(
      withoutEmptyFormFields([field('avatar', null, 'file'), noted, field('', '')]),
    ).toEqual([field('avatar', null, 'file'), noted]);
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

describe('描述列带来的两档判定', () => {
  const note: KeyValue = { key: '', value: '', enabled: true, description: '只写了说明' };

  it('保留判定看三列：只写描述的行不是空行', () => {
    expect(isEmptyKeyValue(note)).toBe(false);
    expect(isEmptyKeyValue({ ...note, description: '   ' })).toBe(true);
    expect(isEmptyKeyValue({ ...note, description: null })).toBe(true);
    expect(isEmptyKeyValue(kv('a', ''))).toBe(false);
    expect(isEmptyKeyValue(kv('', ''))).toBe(true);
  });

  it('发出判定不看描述：只写描述的行不构成请求数据', () => {
    expect(hasRequestData(note)).toBe(false);
    expect(isDescriptionOnlyRow(note)).toBe(true);
    expect(hasRequestData(kv('a', ''))).toBe(true);
    expect(isDescriptionOnlyRow(kv('a', ''))).toBe(false);
  });

  it('只写描述的行被保留下来（保存与打开走的是这一档）', () => {
    const source = request({ params: [kv('a', '1'), note], headers: [note] });

    expect(withoutEmptyRows(source).params).toEqual([kv('a', '1'), note]);
    expect(withoutEmptyRows(source).headers).toEqual([note]);
  });

  it('只写描述的行不进发送载荷，同表其它行照旧', () => {
    const source = request({ params: [kv('a', '1'), note], headers: [note, kv('b', '2')] });

    expect(cleanForSend(source).params).toEqual([kv('a', '1')]);
    expect(cleanForSend(source).headers).toEqual([kv('b', '2')]);
  });

  it('名称为空但有值的行照旧进入发送载荷（让后端明确报错，不静默丢弃）', () => {
    const source = request({ headers: [kv('', '有值没名')] });

    expect(cleanForSend(source).headers).toEqual([kv('', '有值没名')]);
  });

  it('form 行：描述-only 的行被保留，但无名（含文件）字段不进发送载荷', () => {
    const noted: FormField = { ...field('', null), description: '只写了说明' };
    // 模拟导入链路的形态：文件名写在 description 里，字段名还空着
    const namelessFile: FormField = {
      ...field('', null, 'file'),
      file_handle: 'h1',
      description: '导入的文件',
    };
    const source = request({
      body: {
        ...emptyBody(),
        kind: 'form_data',
        form: [field('a', '1'), noted, namelessFile],
      },
    });

    // 保留档：描述-only 的行不清洗
    expect(withoutEmptyRows(source).body.form).toEqual([field('a', '1'), noted, namelessFile]);
    // 发出档：名称为空的字段（包括带文件的）不进入载荷
    expect(cleanForSend(source).body.form).toEqual([field('a', '1')]);
  });
});
