import { createElement } from 'react';
import { vi } from 'vitest';

/**
 * happy-dom 层的 CodeSurface **保形 mock**（design 决策 8）。
 *
 * Monaco 在 happy-dom 跑不了（要真实 layout，`getBoundingClientRect` 全 0），而且
 * 真身会去解析 `monaco-editor`（node 环境解析不到）。所以在单元测试里把它换成
 * 保形元素，让既有断言的读法原样保留、**一行不改**：
 *
 * - 可写面（body raw / 脚本 pre·test）：`<textarea aria-label=…>`，保住 `.value` 读写；
 * - 只读响应正文：保 `data-testid` 且 `textContent` 等于正文的元素（既有断言读的是
 *   `getByTestId('response-body').textContent`，不是 `.value`——mock 成 textarea 会让
 *   `textContent` 为空、断言挂掉）。
 *
 * 编辑器真身由 `tests-browser/**` 在本机 Chrome 上验证。
 */
vi.mock('../src/components/CodeSurface', () => ({
  CodeSurface: (props: {
    value: string;
    readOnly?: boolean;
    ariaLabel?: string;
    testId?: string;
    placeholder?: string;
    /** 折行的生效值：落到 DOM 上，供「请求侧与响应侧拿到同一个值」的断言读取。 */
    wrap?: boolean;
    onChange?: (value: string) => void;
  }) => {
    const wrap = props.wrap === false ? 'off' : 'on';
    return props.readOnly
      ? createElement('pre', { 'data-testid': props.testId, 'data-wrap': wrap }, props.value)
      : createElement('textarea', {
          'aria-label': props.ariaLabel,
          placeholder: props.placeholder,
          'data-wrap': wrap,
          value: props.value,
          onChange: (event: { target: { value: string } }) => props.onChange?.(event.target.value),
        });
  },
}));
