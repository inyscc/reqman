// 设置模态的编辑器配置节（change: add-editor-appearance-settings，
// spec: ui-layout「设置模态的编辑器配置」）。
//
// 这一层只管界面：形态、区间、落库。外观真的作用于编辑器与等宽面由
// `tests-browser/editor-appearance.spec.ts` 在真实引擎里验（Monaco 在 happy-dom 跑不了）。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../src/components/SettingsPanel';
import { createCommands } from '../src/lib/commands';

/** 一个真的记住写入的假后端：设置面据此落库，测试据此断言「写没写」。 */
function fakeClient() {
  const store = new Map<string, string>();
  const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'settings_get') {
      return store.get(`${String(args?.scope)}:${String(args?.key)}`) ?? null;
    }
    if (command === 'settings_set') {
      store.set(`${String(args?.scope)}:${String(args?.key)}`, String(args?.value));
      return null;
    }
    return null;
  });

  return { client: createCommands(call as never), store };
}

async function renderSection() {
  const { client, store } = fakeClient();
  render(<SettingsPanel client={client} />);
  const section = await screen.findByTestId('editor-appearance');
  return { section, store };
}

/** 落库是「改动停止后」触发的，断言前要等它发生（或明确地不发生）。 */
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

describe('设置模态的编辑器配置节', () => {
  it('四项以行式列表呈现，缺省即设计值，行内无解释性文案', async () => {
    const { section } = await renderSection();

    expect(section.querySelectorAll('.settings-row')).toHaveLength(4);

    // 字体族：自由文本；空即缺省，因此框里就是那条系统栈，示例同时收在 placeholder 里
    const family = screen.getByTestId('editor-font-family');
    expect(family.tagName).toBe('INPUT');
    expect((family as HTMLInputElement).value).toContain('Cascadia Mono');
    expect(family.getAttribute('placeholder')).toContain('Cascadia Mono');

    expect((screen.getByTestId('editor-font-size') as HTMLInputElement).value).toBe('12');
    expect((screen.getByTestId('editor-indent-count') as HTMLInputElement).value).toBe('4');

    // 缩进类型是互斥项：走通用下拉（触发器是 button，不是原生 select、也不是单选按钮）
    const type = screen.getByTestId('editor-indent-type');
    expect(type.tagName).toBe('BUTTON');
    expect(type.getAttribute('data-value')).toBe('space');

    // 「语义落在操作上」：这一节只有名称与控件，没有解释后果或原理的句子
    expect(section.querySelectorAll('.settings-hint')).toHaveLength(0);
    expect(section.textContent ?? '').not.toMatch(/。/);
  });

  it('缩进类型下拉给出「空格 / Tab」两项', async () => {
    await renderSection();

    fireEvent.click(screen.getByTestId('editor-indent-type'));
    const options = screen.getByRole('listbox', { name: '缩进类型' });
    // 选中项带标记（见 ui-polish「通用下拉」），因此按包含断言
    const labels = Array.from(options.querySelectorAll('[role="option"]')).map(
      (node) => node.textContent ?? '',
    );
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain('空格');
    expect(labels[1]).toContain('Tab');
  });

  it('区间外的输入不成为设置值，合法值照常落库', async () => {
    const { store } = await renderSection();
    const size = screen.getByTestId('editor-font-size');
    const count = screen.getByTestId('editor-indent-count');

    // 字号区间 8–32、缩进数区间 1–8：越界的那一下不进状态，因此也不会落库
    fireEvent.change(size, { target: { value: '40' } });
    fireEvent.change(count, { target: { value: '0' } });
    await settle();

    expect(store.has('editor_appearance:font_size'), '越界字号不该成为设置值').toBe(false);
    expect(store.has('editor_appearance:indent_count'), '越界缩进数不该成为设置值').toBe(false);

    // 区间内的值照常进状态并落库
    fireEvent.change(size, { target: { value: '14' } });
    fireEvent.change(count, { target: { value: '8' } });
    await waitFor(() => expect(store.get('editor_appearance:font_size')).toBe('14'), {
      timeout: 3_000,
    });
    expect(store.get('editor_appearance:indent_count')).toBe('8');
  });
});
