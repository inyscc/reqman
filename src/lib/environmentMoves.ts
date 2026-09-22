import type { Environment } from './types';

// ---------------------------------------------------------------------------
// 环境列表拖动排序的纯逻辑（change: rework-environments-list）
//
// 环境是**单层**列表：拖拽只可能改顺序，不存在"改归属"或"移入"这第二种意图。因此
// 这里只有两个纯函数——`moveEnvironmentId` 把「拖动项 + 落点（某行的前 / 后）」翻译成
// 新的 id 顺序（没有变化时原样返回同一个引用），`applyEnvironmentOrder` 把新顺序应用到
// 列表上（乐观重排，失败时由调用方回滚）。两者都不碰后端、不碰 React，可以单独验证。
//
// 落点用**插入线**表达（与集合树同款）：落在某行的上半区 = 插到该行之前，下半区 = 插到
// 该行之后。线指示的就是最终落位，因此指示与实际结果一一对应。
//
// `Globals` 不在这份数据里：它是「未激活环境」的呈现，不是 `Environment`，也不参与
// 排序（spec: Environments tab 环境列表的拖拽排序）。因此调用方永远只传真实环境的 id。
// ---------------------------------------------------------------------------

/** 落点相对目标行的位置：插到它的前面还是后面（插入线的两种画法）。 */
export type DropPosition = 'before' | 'after';

/**
 * 把 `dragged` 插到 `target` 的前 / 后。
 *
 * 换算方式与集合树的 `buildMove` 一致：先在**去掉拖动项**的列表里定位目标行，再按下标
 * 插入。这样"拖动项原本排在目标之前 / 之后"两种情形得到同一个结果，不必分别修下标。
 *
 * 返回**入参原引用**表示"没有变化"，调用方据此不发起写入：拖回原处（含落在自己行的
 * 上半 / 下半区）、或任一 id 不在列表里（例如拖动途中列表被刷新）。
 */
export function moveEnvironmentId(
  ids: string[],
  dragged: string,
  target: string,
  position: DropPosition,
): string[] {
  if (dragged === target) return ids;

  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0) return ids;

  const without = ids.filter((id) => id !== dragged);
  const at = without.indexOf(target) + (position === 'after' ? 1 : 0);
  const next = [...without.slice(0, at), dragged, ...without.slice(at)];

  return next.every((id, index) => id === ids[index]) ? ids : next;
}

/**
 * 按给定顺序重排环境列表。
 *
 * 顺序里没有提到的条目按**原相对次序**接在后面：真后端的重排只重写传入 id 的
 * `sort_order`，乐观结果必须与它同口径，否则会出现「界面先变、后端确认后又跳一下」。
 */
export function applyEnvironmentOrder(
  environments: Environment[],
  orderedIds: string[],
): Environment[] {
  const byId = new Map(environments.map((environment) => [environment.id, environment]));
  const ordered: Environment[] = [];

  for (const id of orderedIds) {
    const environment = byId.get(id);
    if (!environment) continue;
    ordered.push(environment);
    byId.delete(id);
  }

  for (const environment of environments) {
    if (byId.has(environment.id)) ordered.push(environment);
  }

  return ordered;
}
