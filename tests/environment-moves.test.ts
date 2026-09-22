import { describe, expect, it } from 'vitest';
import { applyEnvironmentOrder, moveEnvironmentId } from '../src/lib/environmentMoves';
import type { Environment } from '../src/lib/types';

function environment(id: string, name = id): Environment {
  return { id, workspace_id: 'w1', name, is_active: false, sort_order: 0 };
}

describe('环境列表拖拽排序的纯逻辑（spec: Environments tab 环境列表的拖拽排序）', () => {
  it('插到目标行的前 / 后：两种落点各自得到对应位置', () => {
    expect(moveEnvironmentId(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
    expect(moveEnvironmentId(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
  });

  it('拖动项原本在目标的前 / 后时换算都不偏差（先在去掉拖动项的列表里定位目标）', () => {
    // a 原本排在 b 之前 → 插到 b 之后
    expect(moveEnvironmentId(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    // c 原本排在 b 之后 → 插到 b 之前
    expect(moveEnvironmentId(['a', 'b', 'c'], 'c', 'b', 'before')).toEqual(['a', 'c', 'b']);
  });

  it('没有变化时原样返回同一个引用（调用方据此不发起写入）', () => {
    const ids = ['a', 'b', 'c'];

    // 落在自己行的上 / 下半区
    expect(moveEnvironmentId(ids, 'b', 'b', 'before')).toBe(ids);
    expect(moveEnvironmentId(ids, 'b', 'b', 'after')).toBe(ids);
    // 落在相邻行"朝自己的那一侧"同样是原位：b 在 a 之后、在 c 之前
    expect(moveEnvironmentId(ids, 'b', 'a', 'after')).toBe(ids);
    expect(moveEnvironmentId(ids, 'b', 'c', 'before')).toBe(ids);
    // id 不在列表里（例如拖动途中列表被刷新）
    expect(moveEnvironmentId(ids, '不存在', 'b', 'before')).toBe(ids);
    expect(moveEnvironmentId(ids, 'b', '不存在', 'before')).toBe(ids);
  });

  it('按新顺序重排列表；顺序里缺失的条目按原相对次序接在后面', () => {
    const list = [environment('a'), environment('b'), environment('c')];

    expect(applyEnvironmentOrder(list, ['c', 'a', 'b']).map((entry) => entry.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    // 缺失项不丢：真后端只重写传入 id 的 sort_order，乐观结果必须与它同口径
    expect(applyEnvironmentOrder(list, ['b']).map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
  });
});
