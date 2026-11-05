// 变量候选的交互（change: suggest-variables-while-typing，任务 2.1 / 2.2 / 3.1 / 3.2）。
//
// 这里验的是「用户手能摸到的那一层」：键入 `{{` 是否弹出、键盘与鼠标是否能选中、插入的是
// 不是完整的 `{{name}}`、光标是否停在它之后、以及那些「该收起」的时刻是否真的收起。
//
// 纯判定（触发范围、过滤、替换文本）由 `variableSuggest.test.ts` 覆盖；取值口径由
// `variableHover.test.ts` 覆盖。此处只做接线，不重复那两层。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RequestBand, RequestEditor, type Tab } from '../src/components/RequestEditor';
import type { VariableHoverCommands, VariableHoverWiring } from '../src/lib/variableHover';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type CurlCommand,
  type SavedRequest,
  type Variable,
} from '../src/lib/types';

function variable(name: string, value: string, options: Partial<Variable> = {}): Variable {
  const stored = { state: 'value', value } as const;
  return {
    id: `v-${name}`,
    scope: 'environment',
    owner_id: 'owner',
    name,
    is_secret: false,
    enabled: true,
    sort_order: 0,
    initial: stored,
    current: stored,
    ...options,
  };
}

const ENVIRONMENT = [
  variable('host', 'env.test'),
  variable('baseUrl', 'https://env.test'),
  variable('secret_token', '••••••', { id: 'v-secret', is_secret: true }),
];
const COLLECTION = [variable('token', 'col-token', { scope: 'collection' })];

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
 * 只暴露候选与悬停需要的读出口，并记下调用——`secretReveal` 的断言是这次的安全边界：
 * 输入时随手弹出的列表 SHALL NOT 成为读明文的第三条通道。
 */
function fakeClient(scopeVariables: Variable[] = ENVIRONMENT, collectionVariables: Variable[] = COLLECTION) {
  const variableList = vi.fn(async (scope: string) =>
    scope === 'environment' ? scopeVariables : collectionVariables,
  );
  const globalsList = vi.fn(async () => scopeVariables);
  const secretReveal = vi.fn(async (id: string) =>
    variable('secret_token', 'real-secret', { id, is_secret: true }),
  );

  const wiring: VariableHoverWiring = {
    workspaceId: 'w1',
    environmentId: 'env1',
    collectionId: 'c1',
    client: { variableList, globalsList, secretReveal } as unknown as VariableHoverCommands,
  };

  return { wiring, variableList, secretReveal };
}

async function harness(
  initial: SavedRequest = draft(),
  initialTab: Tab = 'params',
  scopeVariables?: Variable[],
  collectionVariables?: Variable[],
  /** 真实应用是 `<StrictMode>` 挂载的（effect 会走两遍），这里可以照样跑一遍。 */
  strict = false,
) {
  const { wiring, secretReveal, variableList } = fakeClient(scopeVariables, collectionVariables);
  const seen: SavedRequest[] = [];

  function Host() {
    const [value, setValue] = useState(initial);
    const [tab, setTab] = useState<Tab>(initialTab);
    const change = (next: SavedRequest) => {
      seen.push(next);
      setValue(next);
    };

    const generateCurl = async (): Promise<CurlCommand> => ({
      command: `curl '${value.url}'`,
      parts: [`curl '${value.url}'`],
      contains_secret: false,
      warnings: [],
    });

    return (
      <>
        <RequestBand
          draft={value}
          busy={false}
          sending={false}
          onChange={change}
          onSend={() => {}}
          onCancel={() => {}}
          collectionName="我的集合"
          dirty={false}
          variableHover={wiring}
        />
        <RequestEditor
          draft={value}
          tab={tab}
          onTab={setTab}
          onChange={change}
          onCurl={generateCurl}
          variableHover={wiring}
        />
      </>
    );
  }

  render(strict ? <StrictMode><Host /></StrictMode> : <Host />);

  return {
    seen,
    latest: () => seen[seen.length - 1],
    secretReveal,
    variableList,
    url: () => screen.getByLabelText('请求地址') as HTMLInputElement,
  };
}

/** 等候选浮层出现（取值源是异步装载的，第一次打开一定会晚一帧）。 */
async function openSuggest() {
  await waitFor(() => expect(screen.getByTestId('variable-suggest')).toBeTruthy());
}

function names(): string[] {
  return screen
    .getAllByTestId('variable-suggest-item')
    .map((node) => node.getAttribute('data-name') ?? '');
}

/** happy-dom 下把光标放到指定位置（模拟用户在已写好的文本中间点了一下）。 */
function placeCaret(input: HTMLInputElement, index: number) {
  act(() => {
    input.setSelectionRange(index, index);
  });
}

describe('地址栏的候选', () => {
  it('键入两个左花括号即弹出候选，逐项给出名字、值与来源', async () => {
    const { url } = await harness();

    fireEvent.change(url(), { target: { value: 'https://api.test/{{' } });
    await openSuggest();

    // 当前作用域在前（按名称），集合变量在后
    expect(names()).toEqual(['baseUrl', 'host', 'secret_token', 'token']);

    const first = screen.getAllByTestId('variable-suggest-item')[0];
    expect(first.textContent).toContain('baseUrl');
    expect(first.textContent).toContain('https://env.test');
    expect(first.textContent).toContain('环境');

    const collection = screen.getAllByTestId('variable-suggest-item')[3];
    expect(collection.textContent).toContain('集合');
  });

  it('继续键入按名称过滤', async () => {
    const { url } = await harness();

    fireEvent.change(url(), { target: { value: 'https://api.test/{{' } });
    await openSuggest();

    fireEvent.change(url(), { target: { value: 'https://api.test/{{ho' } });
    await waitFor(() => expect(names()).toEqual(['host']));
  });

  it('回车插入完整的占位符，光标停在其后', async () => {
    const { url, latest } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: 'https://api.test/{{base' } });
    await openSuggest();
    expect(names()).toEqual(['baseUrl']);

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.value).toBe('https://api.test/{{baseUrl}}');
    // 光标在插入点之后：接着敲的字符不会落到整段末尾
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    // 写入的是同一份模型（地址栏是查询串的权威）
    expect(latest().url).toBe('https://api.test/{{baseUrl}}');
    expect(screen.queryByTestId('variable-suggest')).toBeNull();
  });

  it('Tab 与 ↑↓ 也能完成选择', async () => {
    const { url } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: '{{' } });
    await openSuggest();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(input.value).toBe('{{host}}');
  });

  it('在已写好的占位符里改名字时替换整个占位符', async () => {
    const { url } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: 'https://api.test/{{host}}' } });
    // 光标落在 `{{` 之后、旧名字之前（用户回头点了一下）
    placeCaret(input, 19);
    fireEvent.click(input);
    await openSuggest();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.value).toBe('https://api.test/{{baseUrl}}');
  });

  it('Esc 收起且不改动文本', async () => {
    const { url, latest } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: 'https://api.test/{{ho' } });
    await openSuggest();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('variable-suggest')).toBeNull();
    expect(input.value).toBe('https://api.test/{{ho');
    // 只收起，不写模型（`latest()` 是键入那次的结果，值没有变过）
    expect(latest().url).toBe('https://api.test/{{ho');
  });

  it('光标移出那个 `{{` 之后收起（按 ←/Home 的路径）', async () => {
    const { url } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: '{{ho' } });
    await openSuggest();

    // 把光标挪到 `{{` 之前，再按一次 Home（真实浏览器里是 Home 自己把光标挪走）
    placeCaret(input, 0);
    fireEvent.keyDown(input, { key: 'Home' });

    await waitFor(() => expect(screen.queryByTestId('variable-suggest')).toBeNull());
  });

  it('用鼠标点选某一项即插入', async () => {
    const { url } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: '{{' } });
    await openSuggest();

    const target = screen.getAllByTestId('variable-suggest-item')[1];
    fireEvent.mouseDown(target);
    fireEvent.click(target);

    expect(input.value).toBe('{{host}}');
  });

  it('点在浮层之外即收起，文本不变', async () => {
    const { url } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: '{{' } });
    await openSuggest();

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByTestId('variable-suggest')).toBeNull());
    expect(input.value).toBe('{{');
  });

  it('secret 只以掩码呈现，候选不调揭示出口', async () => {
    const { url, secretReveal } = await harness();
    const input = url();

    fireEvent.change(input, { target: { value: '{{secret' } });
    await openSuggest();

    const item = screen.getAllByTestId('variable-suggest-item')[0];
    expect(item.textContent).toContain('••••••');
    expect(item.textContent).not.toContain('real-secret');
    expect(secretReveal).not.toHaveBeenCalled();
  });

  it('当前作用域没有变量时呈现空态，回车不插入任何文本', async () => {
    // 环境与集合都空：这才是「这个作用域里一个变量都没有」
    const { url } = await harness(draft(), 'params', [], []);
    const input = url();

    fireEvent.change(input, { target: { value: '{{' } });
    await openSuggest();

    expect(screen.getByTestId('variable-suggest-empty')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('{{');
  });
});

describe('挂载方式', () => {
  it('StrictMode 下（真实应用的挂载方式）依然能弹出候选', async () => {
    // 回归护栏：StrictMode 会把 effect 走「挂载 → 清理 → 再挂载」，只在清理里把
    // 「还活着」的标志置 false、不在挂载时置回，组件就永远拿不到候选——浏览器的表现是
    // 「敲了 `{{`，什么都不弹」，而普通单测渲染不出来。
    const { url } = await harness(draft(), 'params', undefined, undefined, true);

    fireEvent.change(url(), { target: { value: '{{' } });
    await openSuggest();

    expect(names()).toEqual(['baseUrl', 'host', 'secret_token', 'token']);
  });
});

describe('参数表与请求头表的候选', () => {
  it('参数值里键入 `{{` 弹出候选，选中写回该行', async () => {
    const { latest } = await harness(draft({ params: [{ key: 'q', value: '', enabled: true }] }));
    const input = screen.getByLabelText('参数值（可用 {{var}}） 0') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '{{ho' } });
    await waitFor(() => expect(screen.getByTestId('variable-suggest')).toBeTruthy());

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.value).toBe('{{host}}');
    expect(latest().params).toEqual([{ key: 'q', value: '{{host}}', enabled: true }]);
  });

  it('候选打开时回车只补全，不再触发幽灵行的「提交并跳下一行」', async () => {
    await harness();
    const ghost = screen.getByLabelText('新增行的值') as HTMLInputElement;
    ghost.focus();

    fireEvent.change(ghost, { target: { value: '{{ba' } });
    await waitFor(() => expect(screen.getByTestId('variable-suggest')).toBeTruthy());

    fireEvent.keyDown(ghost, { key: 'Enter' });

    // 补全了，而不是「提交这一行并跳到下一行的名称」
    expect(ghost.value).toBe('{{baseUrl}}');
    expect(document.activeElement).toBe(ghost);
  });

  it('候选没打开时回车保持原有语义（提交并跳到下一行）', async () => {
    await harness();
    const ghost = screen.getByLabelText('新增行的值') as HTMLInputElement;

    fireEvent.change(ghost, { target: { value: 'plain' } });
    fireEvent.keyDown(ghost, { key: 'Enter' });

    const ghostKey = screen.getByLabelText('新增行的名称') as HTMLInputElement;
    expect(document.activeElement).toBe(ghostKey);
  });

  it('请求头表的值列也能用候选', async () => {
    const { latest } = await harness(draft(), 'headers');
    // 表格初始没有行：候选接在幽灵行的值输入框上（与参数表同一张组件）
    const input = screen.getByLabelText('新增行的值') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '{{to' } });
    await waitFor(() => expect(screen.getByTestId('variable-suggest')).toBeTruthy());

    // `to` 同时命中 token 与 secret_token：前缀命中的排在包含命中之前
    expect(
      screen.getAllByTestId('variable-suggest-item').map((node) => node.getAttribute('data-name')),
    ).toEqual(['token', 'secret_token']);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(latest().headers).toEqual([{ key: '', value: '{{token}}', enabled: true }]);
  });

  it('切走内层标签时候选收起（输入框被卸载，收不到 blur）', async () => {
    await harness();
    const ghost = screen.getByLabelText('新增行的值') as HTMLInputElement;

    fireEvent.change(ghost, { target: { value: '{{' } });
    await waitFor(() => expect(screen.getByTestId('variable-suggest')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Headers' }));

    await waitFor(() => expect(screen.queryByTestId('variable-suggest')).toBeNull());
  });
});
