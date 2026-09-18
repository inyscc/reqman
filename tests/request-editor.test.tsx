import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { RequestEditor } from '../src/components/RequestEditor';
import { defaultSettings, emptyAuth, emptyBody, type SavedRequest } from '../src/lib/types';

type Tab = 'params' | 'headers' | 'body' | 'auth' | 'settings' | 'scripts';

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

/** 受控编辑器的测试宿主：把每次 onChange 的结果记下来，并按新值重新渲染。 */
function harness(initial: SavedRequest, tab: Tab = 'params') {
  const seen: SavedRequest[] = [];

  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <RequestEditor
        draft={value}
        tab={tab}
        busy={false}
        onTab={() => {}}
        onChange={(next) => {
          seen.push(next);
          setValue(next);
        }}
        onSend={() => {}}
      />
    );
  }

  render(<Host />);
  return { seen, latest: () => seen[seen.length - 1] };
}

function bodyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
}

describe('键值表的幽灵行', () => {
  it('空表格末尾即有可输入的空行，且不存在新增按钮', () => {
    harness(draft());

    expect(screen.getByLabelText('新增行的名称')).toBeTruthy();
    expect(screen.getByLabelText('新增行的值')).toBeTruthy();
    expect(screen.queryByText('+ 添加一行')).toBeNull();
    // 只有幽灵行一行
    expect(bodyRows()).toHaveLength(1);
    // 幽灵行不提供删除控件与勾选框
    expect(screen.queryByLabelText('删除该行')).toBeNull();
    expect(document.querySelectorAll('tbody tr.ghost-row input[type="checkbox"]')).toHaveLength(0);
  });

  it('输入即新增：连续输入只产生一行，且正被输入的元素不会被重挂', () => {
    const { latest } = harness(draft());

    const ghostKey = screen.getByLabelText('新增行的名称') as HTMLInputElement;
    ghostKey.focus();

    fireEvent.change(ghostKey, { target: { value: 'X-Trace' } });
    // 元素还是同一个（没有被换掉），焦点也就不会丢
    expect(ghostKey.isConnected).toBe(true);
    expect(screen.getByLabelText('新增行的名称')).toBe(ghostKey);
    // 内容立刻进模型：发送/保存读的就是它，不必等失焦
    expect(latest().params).toEqual([{ key: 'X-Trace', value: '', enabled: true }]);

    // 继续在同一行里输入：不该产生第二行
    fireEvent.change(ghostKey, { target: { value: 'X-Trace-Id' } });

    expect(latest().params).toEqual([{ key: 'X-Trace-Id', value: '', enabled: true }]);
  });

  it('写出内容后即使还没失焦，内容也已经在模型里', () => {
    const { latest } = harness(draft());

    fireEvent.change(screen.getByLabelText('新增行的值'), { target: { value: 'v1' } });

    // 发送/保存读的是模型，因此「还没失焦」不会丢内容
    expect(latest().params).toEqual([{ key: '', value: 'v1', enabled: true }]);
  });

  it('结束一行：下方出现新的空行，焦点回到空行的名称输入', () => {
    harness(draft());

    const ghostKey = screen.getByLabelText('新增行的名称');
    fireEvent.change(ghostKey, { target: { value: 'Accept' } });
    fireEvent.keyDown(ghostKey, { key: 'Enter' });

    // 写出的那一行 + 新的空行
    expect(bodyRows()).toHaveLength(2);
    const nextGhostKey = screen.getByLabelText('新增行的名称') as HTMLInputElement;
    expect(nextGhostKey.value).toBe('');
    expect(document.activeElement).toBe(nextGhostKey);
  });

  it('什么都没写就离开幽灵行时不产生空行', () => {
    const { seen } = harness(draft());

    const ghostKey = screen.getByLabelText('新增行的名称');
    ghostKey.focus();
    fireEvent.blur(ghostKey);

    expect(seen).toHaveLength(0);
    expect(bodyRows()).toHaveLength(1);
  });

  it('失焦结束一行：内容留在模型里，下方补出新的空行', () => {
    const { latest } = harness(draft());

    const ghostKey = screen.getByLabelText('新增行的名称');
    fireEvent.change(ghostKey, { target: { value: 'Accept' } });
    fireEvent.blur(ghostKey);

    expect(latest().params).toEqual([{ key: 'Accept', value: '', enabled: true }]);
    expect(bodyRows()).toHaveLength(2);
    expect((screen.getByLabelText('新增行的名称') as HTMLInputElement).value).toBe('');
  });

  it('清空已有行不使其消失', () => {
    harness(
      draft({
        params: [{ key: 'a', value: '1', enabled: true }],
      }),
    );

    const key = screen.getByLabelText('参数名 0');
    fireEvent.change(key, { target: { value: '' } });

    // 行仍在，只是内容空了
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByLabelText('参数名 0')).toBeTruthy();
  });

  it('幽灵行是表格最后一行，其输入框可以被键盘直接落到', () => {
    harness(draft({ params: [{ key: 'a', value: '1', enabled: true }] }));

    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].className).toContain('ghost-row');

    const ghostValue = screen.getByLabelText('新增行的值') as HTMLInputElement;
    expect(ghostValue.disabled).toBe(false);
    ghostValue.focus();
    expect(document.activeElement).toBe(ghostValue);
  });

  it('form-data 同样有幽灵行，且默认按文本字段起步', () => {
    const { latest } = harness(draft({ body: { ...emptyBody(), kind: 'form_data' } }), 'body');

    expect(screen.queryByText('+ 添加字段')).toBeNull();
    const name = screen.getByLabelText('新增字段的名称') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'avatar' } });
    fireEvent.change(screen.getByLabelText('新增字段的值'), { target: { value: 'x' } });

    expect(latest().body.form).toEqual([
      {
        key: 'avatar',
        value: 'x',
        file_handle: null,
        description: null,
        kind: 'text',
        enabled: true,
      },
    ]);
    expect((screen.getByLabelText('新增字段的类型') as HTMLSelectElement).value).toBe('text');
  });
});
