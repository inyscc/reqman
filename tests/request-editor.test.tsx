import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RequestBand, RequestEditor, type Tab } from '../src/components/RequestEditor';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type CurlCommand,
  type SavedRequest,
} from '../src/lib/types';

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

/**
 * 受控编辑器的测试宿主：把每次 onChange 的结果记下来，并按新值重新渲染。
 *
 * 请求带（身份行 + 地址栏）与列内容（内层标签与正文）是两块——前者由主区作为通栏项
 * 渲染，因此这里也分开挂，测试才拿得到地址栏。内层标签由宿主持有，测试点标签按钮切换。
 */
function harness(
  initial: SavedRequest,
  initialTab: Tab = 'params',
  curlResult?: CurlCommand | 'reject',
) {
  const seen: SavedRequest[] = [];
  let curlCalls = 0;
  let setDraft: (next: SavedRequest) => void = () => {};

  function Host() {
    const [value, setValue] = useState(initial);
    const [tab, setTab] = useState<Tab>(initialTab);
    const change = (next: SavedRequest) => {
      seen.push(next);
      setValue(next);
    };
    setDraft = setValue;

    /** 命令生成：按**当前**草稿生成（换请求后必须跟着变），测试可换成带 warnings 或抛错。 */
    const generateCurl = async (): Promise<CurlCommand> => {
      curlCalls += 1;
      if (curlResult === 'reject') throw { code: 'io', message: '生成失败' };
      return (
        curlResult ?? {
          command: `curl -X ${value.method} '${value.url}'`,
          contains_secret: false,
          warnings: [],
        }
      );
    };

    return (
      <>
        <RequestBand
          draft={value}
          busy={false}
          onChange={change}
          onSend={() => {}}
          collectionName="我的集合"
          dirty={false}
        />
        <RequestEditor
          draft={value}
          tab={tab}
          onTab={setTab}
          onChange={change}
          onCurl={generateCurl}
        />
      </>
    );
  }

  render(<Host />);
  return {
    seen,
    latest: () => seen[seen.length - 1],
    curlCalls: () => curlCalls,
    /** 换一条请求：内层标签保持不动，用来验证「命令始终对应当前请求」。 */
    switchRequest: (next: SavedRequest) => act(() => setDraft(next)),
  };
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

describe('URL 与参数表同步（spec: URL 与参数表保持同步）', () => {
  const urlField = () => screen.getByLabelText('请求地址') as HTMLInputElement;

  it('在地址栏输入带查询串的 URL：参数表跟着出现这些行', () => {
    const { latest } = harness(draft());

    fireEvent.change(urlField(), { target: { value: 'https://api.test/users?page=1&size=10' } });

    expect(latest().params).toEqual([
      { key: 'page', value: '1', enabled: true },
      { key: 'size', value: '10', enabled: true },
    ]);
    expect((screen.getByLabelText('参数名 1') as HTMLInputElement).value).toBe('size');
  });

  it('地址栏里删掉查询串：参数表清空', () => {
    const { latest } = harness(
      draft({
        url: 'https://api.test/users?a=1',
        params: [{ key: 'a', value: '1', enabled: true }],
      }),
    );

    fireEvent.change(urlField(), { target: { value: 'https://api.test/users' } });

    expect(latest().params).toEqual([]);
  });

  it('改参数行的值：地址栏的查询串同步更新', () => {
    const { latest } = harness(
      draft({
        url: 'https://api.test/users?a=1',
        params: [{ key: 'a', value: '1', enabled: true }],
      }),
    );

    fireEvent.change(screen.getByLabelText('参数值（可用 {{var}}） 0'), { target: { value: '2' } });

    expect(latest().url).toBe('https://api.test/users?a=2');
  });

  it('新增参数行：地址栏立刻带上它', () => {
    const { latest } = harness(draft());

    fireEvent.change(screen.getByLabelText('新增行的名称'), { target: { value: 'kw' } });

    expect(latest().url).toBe('https://api.test/users?kw=');
  });

  it('删除参数行：地址栏的查询串跟着去掉', () => {
    const { latest } = harness(
      draft({
        url: 'https://api.test/users?a=1&b=2',
        params: [
          { key: 'a', value: '1', enabled: true },
          { key: 'b', value: '2', enabled: true },
        ],
      }),
    );

    fireEvent.click(screen.getAllByLabelText('删除该行')[0]);

    expect(latest().url).toBe('https://api.test/users?b=2');
  });
});

describe('请求体类型的选择行（spec: 请求体类型的选择行）', () => {
  const bodyTab = (body: Partial<SavedRequest['body']>) =>
    harness(draft({ body: { ...emptyBody(), ...body } }), 'body');

  it('五种类型以同一行内的互斥单选呈现，不再有占满整行的下拉', () => {
    bodyTab({});

    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([
      'none',
      'form_data',
      'url_encoded',
      'raw',
      'binary',
    ]);
    expect((screen.getByRole('radio', { name: 'none' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('combobox', { name: '请求体类型' })).toBeNull();
  });

  it('切换类型即切换编辑器，并清掉其它类型的残留内容', () => {
    const { latest } = bodyTab({ kind: 'raw', raw: '{"a":1}', raw_language: 'json' });

    fireEvent.click(screen.getByRole('radio', { name: 'form-data' }));

    expect(latest().body.kind).toBe('form_data');
    expect(latest().body.raw).toBeNull();
    expect(screen.getByLabelText('新增字段的名称')).toBeTruthy();
  });

  it('raw 的语言选择紧跟 raw 单选项，且只在 raw 时出现', () => {
    const { latest } = bodyTab({ kind: 'raw', raw: '', raw_language: 'json' });

    const dropdown = screen.getByLabelText('raw 语言').closest('.dropdown') as HTMLElement;
    // 位置：紧跟 raw 单选项之后，而不是被甩到这一行的最右端
    const rawLabel = screen.getByRole('radio', { name: 'raw' }).closest('label') as HTMLElement;
    expect(rawLabel.nextElementSibling).toBe(dropdown);
    expect(dropdown.closest('.body-kind-row')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('raw 语言'));
    fireEvent.click(screen.getByRole('option', { name: 'xml' }));
    expect(latest().body.raw_language).toBe('xml');

    fireEvent.click(screen.getByRole('radio', { name: 'none' }));
    expect(screen.queryByLabelText('raw 语言')).toBeNull();
    expect(screen.queryByLabelText('raw 正文')).toBeNull();
  });
});

describe('raw 正文的格式化动作（spec: raw 正文的格式化动作）', () => {
  const bodyTab = (body: Partial<SavedRequest['body']>) =>
    harness(draft({ body: { ...emptyBody(), ...body } }), 'body');

  it('Beautify 把 JSON 重排为缩进形式，Minify 压回紧凑形式', () => {
    const { latest } = bodyTab({ kind: 'raw', raw: '{"a":1,"b":[1,2]}', raw_language: 'json' });

    fireEvent.click(screen.getByTestId('body-beautify'));
    expect(latest().body.raw).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');

    fireEvent.click(screen.getByTestId('body-minify'));
    expect(latest().body.raw).toBe('{"a":1,"b":[1,2]}');
  });

  it('非 JSON 语言下入口不存在（不是禁用态）', () => {
    bodyTab({ kind: 'raw', raw: '{"a":1}', raw_language: 'xml' });

    expect(screen.queryByTestId('body-beautify')).toBeNull();
    expect(screen.queryByTestId('body-minify')).toBeNull();
  });

  it('非 raw 类型下入口不存在', () => {
    bodyTab({ kind: 'form_data' });

    expect(screen.queryByTestId('body-beautify')).toBeNull();
    expect(screen.queryByTestId('body-minify')).toBeNull();
  });

  it('正文不是合法 JSON：不改写正文，并就地说明原因', () => {
    const { latest } = bodyTab({ kind: 'raw', raw: '{"a":', raw_language: 'json' });

    fireEvent.click(screen.getByTestId('body-beautify'));

    // 没有产生 onChange（正文没动），错误信息就地呈现
    expect(latest()).toBeUndefined();
    expect((screen.getByLabelText('raw 正文') as HTMLTextAreaElement).value).toBe('{"a":');
    expect(screen.getByTestId('body-format-error')).toBeTruthy();
  });

  it('正文为空时入口不可用', () => {
    bodyTab({ kind: 'raw', raw: '', raw_language: 'json' });

    expect((screen.getByTestId('body-beautify') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('body-minify') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('描述列（spec: 键值表的列与描述列）', () => {
  it('Params 的描述列可就地编辑，写入的是 description 字段', () => {
    const { latest } = harness(
      draft({ params: [{ key: 'a', value: '1', enabled: true, description: '原来的说明' }] }),
    );

    const field = screen.getByLabelText('描述 0') as HTMLInputElement;
    expect(field.value).toBe('原来的说明');

    fireEvent.change(field, { target: { value: '改过的说明' } });

    expect(latest().params[0]).toEqual({
      key: 'a',
      value: '1',
      enabled: true,
      description: '改过的说明',
    });
  });

  it('清空描述写成 null，不留空字符串', () => {
    const { latest } = harness(
      draft({ params: [{ key: 'a', value: '1', enabled: true, description: '说明' }] }),
    );

    fireEvent.change(screen.getByLabelText('描述 0'), { target: { value: '' } });

    expect(latest().params[0].description).toBeNull();
  });

  it('Headers 表同样有描述列', () => {
    harness(
      draft({ headers: [{ key: 'Accept', value: '*/*', enabled: true, description: '头说明' }] }),
      'headers',
    );

    expect((screen.getByLabelText('描述 0') as HTMLInputElement).value).toBe('头说明');
  });

  it('urlencoded 表同样有描述列', () => {
    harness(
      draft({
        body: {
          ...emptyBody(),
          kind: 'url_encoded',
          urlencoded: [{ key: 'f', value: '1', enabled: true, description: '字段说明' }],
        },
      }),
      'body',
    );

    expect((screen.getByLabelText('描述 0') as HTMLInputElement).value).toBe('字段说明');
  });

  it('幽灵行的描述输入即把这一行写进模型，且不打断正在输入的元素', () => {
    const { latest } = harness(draft());

    fireEvent.change(screen.getByLabelText('新增行的描述'), { target: { value: '只写说明' } });

    // 物化：描述已经进入模型，而不是留在本地待丢的临时态
    expect(latest().params).toEqual([
      { key: '', value: '', enabled: true, description: '只写说明' },
    ]);
    // 仍由幽灵行自己承载这一行（元素没被重挂），其下方补出新的空行
    expect((screen.getByLabelText('新增行的描述') as HTMLInputElement).value).toBe('只写说明');
    expect(screen.getByLabelText('下一行的描述')).toBeTruthy();
  });

  it('描述不进入地址栏的查询串', () => {
    const { latest } = harness(draft());

    fireEvent.change(screen.getByLabelText('新增行的描述'), { target: { value: '只写说明' } });

    expect(latest().url).toBe('https://api.test/users');
  });
});

describe('cURL 快照标签（spec: cURL 快照标签）', () => {
  const command = "curl -X GET 'https://api.test/users'";
  const plain = { command, contains_secret: false, warnings: [] };

  it('切换到标签即生成可编辑的命令，切到别的标签后不再显示', async () => {
    harness(draft(), 'params', plain);

    expect(screen.queryByTestId('curl-block')).toBeNull();

    fireEvent.click(screen.getByText('cURL'));

    const field = (await screen.findByLabelText('curl 命令')) as HTMLTextAreaElement;
    expect(field.value).toBe(command);
    // 可编辑的多行文本，而不是只读展示
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.disabled).toBe(false);

    fireEvent.click(screen.getByText('Params'));
    expect(screen.queryByTestId('curl-block')).toBeNull();
  });

  it('编辑命令不影响请求', async () => {
    const { seen } = harness(draft(), 'params', plain);

    fireEvent.click(screen.getByText('cURL'));
    fireEvent.change(await screen.findByLabelText('curl 命令'), {
      target: { value: 'curl -X DELETE 改过的' },
    });

    expect((screen.getByLabelText('curl 命令') as HTMLTextAreaElement).value).toBe(
      'curl -X DELETE 改过的',
    );
    // 请求侧一次 onChange 都没有发生
    expect(seen).toHaveLength(0);
  });

  it('「重新生成」覆盖编辑并重新生成一次', async () => {
    const { curlCalls } = harness(draft(), 'params', plain);

    fireEvent.click(screen.getByText('cURL'));
    fireEvent.change(await screen.findByLabelText('curl 命令'), { target: { value: '改过的' } });

    fireEvent.click(screen.getByTestId('curl-regenerate'));

    await waitFor(() =>
      expect((screen.getByLabelText('curl 命令') as HTMLTextAreaElement).value).toBe(command),
    );
    expect(curlCalls()).toBe(2);
  });

  it('切走再切回即重新生成，编辑不保留', async () => {
    const { curlCalls } = harness(draft(), 'params', plain);

    fireEvent.click(screen.getByText('cURL'));
    fireEvent.change(await screen.findByLabelText('curl 命令'), { target: { value: '改过的' } });
    fireEvent.click(screen.getByText('Params'));

    fireEvent.click(screen.getByText('cURL'));

    await waitFor(() =>
      expect((screen.getByLabelText('curl 命令') as HTMLTextAreaElement).value).toBe(command),
    );
    expect(curlCalls()).toBe(2);
  });

  it('切换请求后命令对应当前请求，而不是上一条', async () => {
    // 不给固定结果：这里要验的正是"按当前草稿生成"
    const { switchRequest } = harness(draft(), 'curl');

    expect((await screen.findByLabelText('curl 命令') as HTMLTextAreaElement).value).toBe(command);

    // 内层标签仍停在 cURL：换请求也必须重新生成
    switchRequest({ ...draft(), id: 'r2', url: 'https://api.test/other' });

    await waitFor(() =>
      expect((screen.getByLabelText('curl 命令') as HTMLTextAreaElement).value).toBe(
        "curl -X GET 'https://api.test/other'",
      ),
    );
  });

  it('「复制」写入的是改动后的内容', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    harness(draft(), 'params', plain);

    fireEvent.click(screen.getByText('cURL'));
    fireEvent.change(await screen.findByLabelText('curl 命令'), {
      target: { value: 'curl 改过的' },
    });
    fireEvent.click(screen.getByTestId('curl-copy'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('curl 改过的'));
    expect(screen.getByTestId('curl-copy').textContent).toBe('已复制');
  });

  it('生成结果给出的不可执行原因会显示出来', async () => {
    harness(draft(), 'params', {
      command: "curl -X POST 'https://api.test/users' --data-binary @<需自行替换为本地文件路径>",
      contains_secret: false,
      warnings: ['请求体为二进制文件，命令中的文件位置是占位符'],
    });

    fireEvent.click(screen.getByText('cURL'));

    // 命令里是占位符（要用户自己替换），提示里说明原因
    expect((await screen.findByLabelText('curl 命令') as HTMLTextAreaElement).value).toContain(
      '需自行替换',
    );
    expect((await screen.findByTestId('curl-warnings')).textContent).toContain('占位符');
  });

  it('生成失败时给出可见的错误，而不是静默', async () => {
    harness(draft(), 'params', 'reject');

    fireEvent.click(screen.getByText('cURL'));

    expect((await screen.findByTestId('curl-error')).textContent).toContain('生成失败');
  });
});
