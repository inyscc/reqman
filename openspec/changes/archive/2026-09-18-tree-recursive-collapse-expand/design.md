## Context

集合树的折叠为纯前端视图态，存于 `WorkspaceTree` 组件内的 `collapsed: Set<string>`（记录被折叠的集合/文件夹 id，未记录即展开，默认全展开）。当前折叠只通过 `EntryRow` 行内左侧的箭头按钮（`tree-toggle`）触发，调用 `actions.onToggle(id)`，每次只切换单个节点。

`TreeNode` / `CollectionTree` 已具备递归遍历所需的 `children: TreeNode[]` 结构（`TreeNode.kind` 为 `'folder' | 'request'`），不需要改动 `src/lib/types.ts`。本次在 `EntryRow` 上新增双击目录名手势，复用同一份 `collapsed` 视图态做整棵子树的递归切换。搜索态下 `expanded` 被强制为 `true` 且箭头控件已 `disabled`，双击应同样不生效。

## Goals / Non-Goals

**Goals:**
- 双击集合/文件夹行（名称文本或行内空白区，箭头与更多按钮除外）时，对该节点自身及全部后代目录做递归折叠或递归展开。
- 复用既有 `collapsed` 集合与全部既有约束（不改选中、不关主区、不跨重启保留）。
- 与搜索态强制展开、箭头禁用保持一致：搜索态下双击无效。

**Non-Goals:**
- 不改变箭头按钮的单节点折叠语义。
- 不引入折叠状态的后端持久化。
- 不为双击增加键盘等价手势（键盘用户仍用箭头逐层切换，属既有能力，超出本次范围）。

## Decisions

**D1. 折叠态继续用单一 `collapsed: Set<string>`。**
不新增数据结构。递归折叠 = 把当前节点 id 与其后代目录 id 一并加入集合；递归展开 = 一并移除。与既有单节点 `onToggle` 完全兼容，判定规则一致：节点 id 在集合中即折叠。

**D2. `EntryRow` 新增 `childNodes: TreeNode[]` 数据属性（仅用于计算后代）。**
当前 `EntryRow` 只接收渲染好的 `children` ReactNode，无法在事件里拿后代 id。新增 `childNodes` 透传源数据：集合节点传 `tree.children`，文件夹节点传 `node.children`。这样递归切换无需回查整棵树，调用点已有的数据即可满足。

**D3. 新增 `collectFolderIds(nodes)` 递归辅助函数。**
仅收集 `kind === 'folder'` 的节点 id（请求叶子无后代、也不进入折叠集合），深度优先遍历 `children`。返回当前子树内全部后代目录 id。

**D4. `TreeActions` 增加 `onToggleRecursive(id, childNodes)`。**
在 `WorkspaceTree` 内实现，使用 `setCollapsed` 的函数式更新避免闭包读到旧 state：

```
const subtree = [id, ...collectFolderIds(childNodes)];
setCollapsed((prev) => {
  const next = new Set(prev);
  if (prev.has(id)) subtree.forEach((x) => next.delete(x)); // 已折叠 → 展开
  else subtree.forEach((x) => next.add(x));                  // 展开 → 折叠
  return next;
});
```

用 `prev.has(id)` 判定当前态，确保双击发生在最新渲染之外也正确（双击事件里的 `prev` 为最新集合）。

**D5. 双击挂在整个行容器，并抑制选中副作用。**
- `EntryRow` 的行容器 `div.node` 增加 `onDoubleClick`：调用 `actions.onToggleRecursive(id, childNodes)`。整行（名称文本与行内空白区）均可触发；箭头按钮与更多按钮通过 `event.target.closest('.tree-toggle' | '.node-more')` 排除，不触发递归切换（避免与单层折叠冲突）。
- **抑制选中副作用（审查问题①）**：浏览器双击 = 两次 `click` + 一次 `dblclick`，而行 `onClick` 当前直接 `onSelectEntity`，会把主区切到脚本面板，与 spec「不切换主区」矛盾。因此行容器 `onClick` 改为**延迟提交选中**：用约 200ms 定时器排程 `onSelectEntity`；行容器 `onDoubleClick` 触发时 `clearTimeout` 取消待提交的选中，只执行递归折叠/展开。由此双击不会选中实体、不会切换主区，只改折叠态。
  - 代价：行内单击选中现在有约 200ms 延迟——这是区分单击/双击的标准代价，同类树 UI 通用；箭头按钮的折叠仍即时（其 `onClick` 独立且 `stopPropagation`，不参与行选中去抖）。
- 搜索态守卫：`view.searching` 为真时 `.tree-name` 的 `onDoubleClick` 直接返回，不改 `collapsed`，与箭头 `disabled` 表现一致；延迟选中的定时器在搜索态下随单击正常提交（选中不受搜索影响）。

## Risks / Trade-offs

- [Risk] 行内单击选中延迟约 200ms（为区分单击/双击而对选中做去抖所致）。 → 仅影响集合/文件夹行的选中即时性，请求行选中不受影响；同类树 UI 通用，可接受。若后续要求单击零延迟，可改为仅在 `click` 的 `detail === 2` 时跳过第二次选中，但首击仍会选中、无法完全消除「双击切主区」的观感，故维持去抖方案。
- [Risk] 极深嵌套子树递归遍历带来一次性 O(n) 集合写入。 → 树规模有限（单个工作区的集合/文件夹/请求），一次性写入 `Set` 成本可忽略，无需缓存。
- [Trade-off] 键盘用户无双击等价手势。 → 已在 Non-Goals 明确，沿用箭头逐层切换，不阻塞本次交付。

## Open Questions

（无 — 上述取舍均不改动需求、方案或任务拆分。）
