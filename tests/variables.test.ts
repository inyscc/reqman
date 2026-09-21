// 同名组「谁生效」的共用判定（design D13）。
//
// 这份判定同时被变量表格的遮蔽标记、只读浮层与脚本运行时使用，并与 Rust 侧解析层
// （跳过禁用条目后顺序覆写）保持同一条规则，因此在这里把它钉死。

import { describe, expect, it } from 'vitest';
import { effectiveByName, effectiveVariable, isShadowed } from '../src/lib/variables';
import type { Variable } from '../src/lib/types';

function variable(overrides: Partial<Variable> = {}): Variable {
  return {
    id: 'v-1',
    scope: 'environment',
    owner_id: 'e1',
    name: 'host',
    description: null,
    is_secret: false,
    enabled: true,
    sort_order: 0,
    initial: { state: 'value', value: 'v' },
    current: { state: 'value', value: 'v' },
    ...overrides,
  };
}

describe('同名组的生效判定', () => {
  it('取同名组里最靠下的启用条目', () => {
    const group = [
      variable({ id: 'a', sort_order: 0 }),
      variable({ id: 'b', sort_order: 1 }),
    ];
    expect(effectiveVariable(group)?.id).toBe('b');
  });

  it('生效条被禁用时退回上一条启用的', () => {
    const group = [
      variable({ id: 'a', sort_order: 0 }),
      variable({ id: 'b', sort_order: 1, enabled: false }),
    ];
    expect(effectiveVariable(group)?.id).toBe('a');
  });

  it('全组被禁用时该名字未定义', () => {
    const group = [
      variable({ id: 'a', sort_order: 0, enabled: false }),
      variable({ id: 'b', sort_order: 1, enabled: false }),
    ];
    expect(effectiveVariable(group)).toBeUndefined();
    expect(effectiveByName(group).has('host')).toBe(false);
  });

  it('禁用条目不进入按名的生效视图', () => {
    const list = [
      variable({ id: 'a', name: 'host' }),
      variable({ id: 'b', name: 'off', enabled: false }),
    ];
    const byName = effectiveByName(list);
    expect(byName.get('host')?.id).toBe('a');
    expect(byName.has('off')).toBe(false);
  });

  it('遮蔽判据是「自己启用且存在更靠后的启用条目」', () => {
    const upper = variable({ id: 'a', sort_order: 0 });
    const lower = variable({ id: 'b', sort_order: 1 });
    expect(isShadowed(upper, [upper, lower])).toBe(true);
    expect(isShadowed(lower, [upper, lower])).toBe(false);
  });

  it('靠后的那条禁用后，两个行都不再被判为被遮蔽', () => {
    const upper = variable({ id: 'a', sort_order: 0 });
    const lower = variable({ id: 'b', sort_order: 1, enabled: false });
    expect(isShadowed(upper, [upper, lower])).toBe(false);
    expect(isShadowed(lower, [upper, lower])).toBe(false);
  });

  it('单行不构成遮蔽', () => {
    const only = variable();
    expect(isShadowed(only, [only])).toBe(false);
  });
});
