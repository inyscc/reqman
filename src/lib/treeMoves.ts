import type { CollectionTree, TreeNode } from './types';

// ---------------------------------------------------------------------------
// 集合树拖拽的纯逻辑（change: rework-collection-tree-and-variable-model）
//
// 拖拽只做两件事：改顺序、改归属。这里把它拆成两个纯函数——
// `buildMove` 把「拖动项 + 落点」翻译成一次后端写入（不合法返回 null），
// `applyTreeMove` 把同一次写入就地应用到树数据上（乐观重排，失败时由调用方回滚）。
// 两者都不碰后端、不碰 React，因此可以单独验证。
// ---------------------------------------------------------------------------

/** 树中的一个「容器」：工作区根（集合之间）、集合根、或某个文件夹。 */
export type TreeParent =
  | { kind: 'root' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'folder'; collectionId: string; folderId: string };

/** 能承载请求与文件夹的父级（即除了工作区根以外的两种）。 */
export type ContainerParent = Exclude<TreeParent, { kind: 'root' }>;

/** 树中的一行：落点判定需要知道它属于哪个父级、在该父级里排第几。 */
export interface RowRef {
  id: string;
  kind: 'collection' | 'folder' | 'request';
  collectionId: string;
  parent: TreeParent;
  index: number;
}

/** 正在被拖动的节点。`parentFolderId` 为 null 表示它挂在集合根下。 */
export interface DragNode {
  id: string;
  kind: 'collection' | 'folder' | 'request';
  collectionId: string;
  parentFolderId: string | null;
}

/**
 * 落点：把拖动项插入到 `parent` 子列表的 `index` 位置（`Infinity` 表示末尾）。
 *
 * `marker` 只是「指示画在哪一行、画成什么样」的视图信息，`buildMove` 不读它。
 */
export interface DropTarget {
  parent: TreeParent;
  index: number;
  marker: { rowId: string; position: 'before' | 'after' | 'into' };
}

/** 一次拖拽所要求的后端写入；`null` 表示这次拖拽不产生任何改动。 */
export type TreeMove =
  | { kind: 'reorder-collections'; orderedIds: string[] }
  | {
      kind: 'reorder-children';
      collectionId: string;
      parentFolderId: string | null;
      items: { id: string; kind: 'folder' | 'request' }[];
    }
  /** 跨父级移动文件夹；后端把它追加到目标父级末尾。 */
  | { kind: 'move-folder'; id: string; collectionId: string; parentFolderId: string | null }
  /** 跨父级移动请求；同上。 */
  | { kind: 'move-request'; id: string; collectionId: string; folderId: string | null };

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(value, 0), max);
}

function findFolder(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue;
    if (node.id === id) return node;
    const hit = findFolder(node.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 取某个父级下的子条目列表（文件夹与请求混排，顺序即界面顺序）。 */
export function siblingsOf(trees: CollectionTree[], parent: TreeParent): TreeNode[] | null {
  if (parent.kind === 'root') return null;
  const tree = trees.find((item) => item.collection.id === parent.collectionId);
  if (!tree) return null;
  if (parent.kind === 'collection') return tree.children;
  const folder = findFolder(tree.children, parent.folderId);
  return folder ? folder.children : null;
}

/**
 * `target` 就是 `dragged` 本身、或位于它之下。
 *
 * 把文件夹拖进自己的后代会让这棵子树从树上消失，因此既要拒绝目标为自身，
 * 也要拒绝目标为自己的任一后代。
 */
export function isSelfOrDescendant(
  trees: CollectionTree[],
  target: string | null,
  dragged: string,
): boolean {
  if (target === null) return false;
  if (target === dragged) return true;
  for (const tree of trees) {
    const folder = findFolder(tree.children, dragged);
    if (folder && findFolder(folder.children, target)) return true;
  }
  return false;
}

/**
 * 把「拖动项 + 落点」翻译成一次写入。
 *
 * 返回 null 的三种情形：跨集合拖动（界面因此不呈现落点）、把文件夹拖进自己的
 * 后代、以及拖到自己原本的位置（等于没动）。
 */
export function buildMove(
  trees: CollectionTree[],
  drag: DragNode,
  target: DropTarget,
): TreeMove | null {
  if (drag.kind === 'collection') {
    // 集合之间只支持排序：拖进另一个集合不被支持
    if (target.parent.kind !== 'root') return null;

    const current = trees.map((tree) => tree.collection.id);
    const without = current.filter((id) => id !== drag.id);
    const at = clamp(target.index, without.length);
    const next = [...without.slice(0, at), drag.id, ...without.slice(at)];
    if (next.length === current.length && next.every((id, index) => id === current[index])) {
      return null;
    }
    return { kind: 'reorder-collections', orderedIds: next };
  }

  // 请求与文件夹不能落到工作区根上
  if (target.parent.kind === 'root') return null;
  // 跨集合拖动请求或文件夹不被支持
  if (target.parent.collectionId !== drag.collectionId) return null;

  const targetFolderId = target.parent.kind === 'folder' ? target.parent.folderId : null;
  if (drag.kind === 'folder' && isSelfOrDescendant(trees, targetFolderId, drag.id)) return null;

  const siblings = siblingsOf(trees, target.parent);
  if (!siblings) return null;

  // 同一父级内：重排。跨父级：移动（后端追加到目标父级末尾）
  if (targetFolderId === drag.parentFolderId) {
    const from = siblings.findIndex((node) => node.id === drag.id);
    if (from < 0) return null;

    const without = siblings.filter((node) => node.id !== drag.id);
    const at = clamp(from < target.index ? target.index - 1 : target.index, without.length);
    const next = [...without.slice(0, at), siblings[from], ...without.slice(at)];
    if (next.every((node, index) => node.id === siblings[index].id)) return null;

    return {
      kind: 'reorder-children',
      collectionId: drag.collectionId,
      parentFolderId: targetFolderId,
      items: next.map((node) => ({ id: node.id, kind: node.kind })),
    };
  }

  return drag.kind === 'folder'
    ? { kind: 'move-folder', id: drag.id, collectionId: drag.collectionId, parentFolderId: targetFolderId }
    : { kind: 'move-request', id: drag.id, collectionId: drag.collectionId, folderId: targetFolderId };
}

// 下面两个改动函数都要递归进**每一层**文件夹：目标父级可能嵌在任意深度，
// 只在 id 命中时才往下走会让「移进内层文件夹」变成「这条目凭空消失」。

function reorderChildren(
  nodes: TreeNode[],
  parentFolderId: string | null,
  items: { id: string; kind: 'folder' | 'request' }[],
): TreeNode[] {
  if (parentFolderId === null) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return items
      .map((item) => byId.get(item.id))
      .filter((node): node is TreeNode => node !== undefined);
  }

  return nodes.map((node) => {
    if (node.kind !== 'folder') return node;
    const children =
      node.id === parentFolderId
        ? reorderChildren(node.children, null, items)
        : reorderChildren(node.children, parentFolderId, items);
    return children === node.children ? node : { ...node, children };
  });
}

/** 摘下某个节点；找不到时原样返回。 */
function detach(
  nodes: TreeNode[],
  id: string,
): { nodes: TreeNode[]; removed: TreeNode | null } {
  const index = nodes.findIndex((node) => node.id === id);
  if (index >= 0) {
    return { nodes: [...nodes.slice(0, index), ...nodes.slice(index + 1)], removed: nodes[index] };
  }

  let removed: TreeNode | null = null;
  const next = nodes.map((node) => {
    if (removed || node.kind !== 'folder') return node;
    const result = detach(node.children, id);
    removed = result.removed;
    return result.removed ? { ...node, children: result.nodes } : node;
  });
  return { nodes: next, removed };
}

/** 把节点插到目标父级的末尾（`folderId` 为 null 时插到集合根末尾）。 */
function append(nodes: TreeNode[], folderId: string | null, node: TreeNode): TreeNode[] {
  if (folderId === null) return [...nodes, node];
  return nodes.map((item) => {
    if (item.kind !== 'folder') return item;
    const children =
      item.id === folderId
        ? append(item.children, null, node)
        : append(item.children, folderId, node);
    return children === item.children ? item : { ...item, children };
  });
}

/** 把一次写入就地应用到树数据上，用于拖拽后的乐观重排。 */
export function applyTreeMove(trees: CollectionTree[], move: TreeMove): CollectionTree[] {
  switch (move.kind) {
    case 'reorder-collections': {
      const byId = new Map(trees.map((tree) => [tree.collection.id, tree]));
      const next = move.orderedIds
        .map((id) => byId.get(id))
        .filter((tree): tree is CollectionTree => tree !== undefined);
      // 列表里缺了任何集合（理论上不会）就不动，宁可不重排也不丢集合
      return next.length === trees.length ? next : trees;
    }

    case 'reorder-children':
      return trees.map((tree) =>
        tree.collection.id === move.collectionId
          ? { ...tree, children: reorderChildren(tree.children, move.parentFolderId, move.items) }
          : tree,
      );

    case 'move-folder':
    case 'move-request': {
      const targetFolderId = move.kind === 'move-folder' ? move.parentFolderId : move.folderId;
      let node: TreeNode | null = null;
      let detached = trees;

      for (const tree of trees) {
        const result = detach(tree.children, move.id);
        if (result.removed) {
          node = result.removed;
          detached = trees.map((item) =>
            item.collection.id === tree.collection.id ? { ...item, children: result.nodes } : item,
          );
          break;
        }
      }
      if (!node) return trees;

      return detached.map((tree) =>
        tree.collection.id === move.collectionId
          ? { ...tree, children: append(tree.children, targetFolderId, node as TreeNode) }
          : tree,
      );
    }
  }
}
