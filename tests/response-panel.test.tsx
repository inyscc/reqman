import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResponsePanel } from '../src/components/ResponsePanel';
import type { ConsoleEntry, TestAssertion } from '../src/lib/scriptRuntime';
import type { ResponsePayload } from '../src/lib/types';

function response(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    id: 'resp-1',
    status: 200,
    status_text: 'OK',
    elapsed_ms: 12,
    size_bytes: 2,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{}',
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 1024,
    size_limit_bytes: 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/users',
    request_url: 'https://api.test/users',
    ...overrides,
  };
}

function passed(name: string): TestAssertion {
  return { name, passed: true, skipped: false, error: null };
}

function failed(name: string, error = '断言不成立'): TestAssertion {
  return { name, passed: false, skipped: false, error };
}

/**
 * 「脚本」标签页上的结果点（spec: pm-script-runtime「脚本 console 输出的收集与呈现」）。
 *
 * 点只有三种合法状态：没有断言时不点、全通过绿、有失败红。因此断言同时检查"该出现
 * 的那一个在"与"另一个不在"——只查前者的话，两种颜色共存的回归会漏掉。
 */
describe('响应区脚本页签的结果点', () => {
  it('全部断言通过时是绿点', () => {
    render(
      <ResponsePanel
        response={response()}
        error={null}
        scriptAssertions={[passed('状态码为 200'), passed('响应时间可读')]}
      />,
    );

    expect(screen.getByTestId('script-tab-dot-pass')).toBeTruthy();
    expect(screen.queryByTestId('script-tab-dot-fail')).toBeNull();
  });

  it('任一断言失败时是红点', () => {
    render(
      <ResponsePanel
        response={response()}
        error={null}
        scriptAssertions={[passed('状态码为 200'), failed('正文为 JSON')]}
      />,
    );

    expect(screen.getByTestId('script-tab-dot-fail')).toBeTruthy();
    expect(screen.queryByTestId('script-tab-dot-pass')).toBeNull();
  });

  it('跳过的断言不算失败', () => {
    render(
      <ResponsePanel
        response={response()}
        error={null}
        scriptAssertions={[{ name: '暂不校验', passed: false, skipped: true, error: null }]}
      />,
    );

    expect(screen.getByTestId('script-tab-dot-pass')).toBeTruthy();
  });

  it('脚本抛错时是红点', () => {
    render(
      <ResponsePanel
        response={response()}
        error={null}
        scriptError="后置脚本 · 请求层（第 2 行）：boom"
      />,
    );

    expect(screen.getByTestId('script-tab-dot-fail')).toBeTruthy();
  });

  it('只有 console 输出、没有断言时不点', () => {
    render(
      <ResponsePanel
        response={response()}
        error={null}
        scriptConsole={[{ level: 'log', args: ['随便看看'], phase: 'test' }]}
      />,
    );

    // 页签照常出现（有输出可看），但"有没有测试通过"这件事无从谈起
    expect(screen.getByText('脚本')).toBeTruthy();
    expect(document.querySelector('[data-testid^="script-tab-dot"]')).toBeNull();
  });
});

/**
 * console 的多行输出。
 *
 * 换行由 CSS（`.script-console` 的 white-space: pre-wrap）保住，happy-dom 不加载
 * 样式表，因此这里两侧各验一半：文本本身带换行没被拆掉，且容器挂着那个样式钩子。
 */
describe('脚本 console 的多行输出', () => {
  it('一条输出里的换行原样保留，容器带按原文呈现的样式钩子', () => {
    const entries: ConsoleEntry[] = [
      { level: 'log', args: ['第一行\n第二行\n  缩进'], phase: 'prerequest' },
    ];

    render(<ResponsePanel response={response()} error={null} scriptConsole={entries} />);
    fireEvent.click(screen.getByText('脚本'));

    const list = screen.getByTestId('script-console');
    expect(list.classList.contains('script-console')).toBe(true);
    expect(list.textContent).toContain('第一行\n第二行\n  缩进');
  });
});
