// 底部状态条上的 Console 入口（change: add-console-panel）。
//
// 它是抽屉而不是模态：入口必须让用户看出抽屉此刻是开是合，否则「我上次到底关了没有」
// 每次都要点一下才知道。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BottomBar } from '../src/components/BottomBar';

function renderBar(overrides: Partial<Parameters<typeof BottomBar>[0]> = {}) {
  const props = {
    sending: false,
    error: null,
    optimisticErrors: 0,
    onShowOptimisticErrors: () => undefined,
    onOpenModal: () => undefined,
    importExportDisabled: false,
    consoleOpen: false,
    onToggleConsole: vi.fn(),
    ...overrides,
  };

  render(<BottomBar {...props} />);
  return props;
}

describe('底部状态条的 Console 入口', () => {
  it('抽屉收起时入口呈现为「未打开」', () => {
    renderBar();

    const entry = screen.getByTestId('console-toggle-closed');
    expect(entry.textContent).toBe('Console');
    expect(entry.getAttribute('aria-pressed')).toBe('false');
  });

  it('抽屉打开时入口呈现为「已打开」，两态的 testid 不同', () => {
    renderBar({ consoleOpen: true });

    const entry = screen.getByTestId('console-toggle-open');
    expect(entry.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('console-toggle-closed')).toBeNull();
  });

  it('点一下切换开合', () => {
    const props = renderBar();

    fireEvent.click(screen.getByTestId('console-toggle-closed'));

    expect(props.onToggleConsole).toHaveBeenCalledTimes(1);
  });

  it('三个模态入口照旧在，Console 没有把它们挤掉', () => {
    renderBar();

    expect(screen.getByText('Cookie')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText('导入/导出')).toBeTruthy();
  });
});
