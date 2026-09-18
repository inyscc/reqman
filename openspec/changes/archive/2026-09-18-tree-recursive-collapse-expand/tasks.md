## 1. 递归辅助与动作接口

- [x] 1.1 在 `src/components/WorkspaceTree.tsx` 新增 `collectFolderIds(nodes: TreeNode[]): string[]` 模块函数，仅收集 `kind === 'folder'` 的节点 id 并深度优先遍历其 `children`；用 `tsc` 类型检查确认无报错。
- [x] 1.2 在 `TreeActions` 接口新增 `onToggleRecursive: (id: string, childNodes: TreeNode[]) => void` 声明，并确认 `WorkspaceTree` 内 `actions` 对象的类型仍满足接口。

## 2. EntryRow 数据透传与双击手势

- [x] 2.1 为 `EntryRow` 组件新增 `childNodes: TreeNode[]` 属性，并在集合调用点（`WorkspaceTree` 渲染 `tree.collection` 处）传入 `tree.children`、在文件夹调用点（`TreeNodes` 渲染 `node.kind === 'folder'` 处）传入 `node.children`。
- [x] 2.2 在 `EntryRow` 的行容器 `div.node` 上增加 `onDoubleClick`：调用 `actions.onToggleRecursive(id, childNodes)`；当 `view.searching` 为真时直接返回，不改折叠集合。通过 `event.target.closest('.tree-toggle' | '.node-more')` 排除箭头与更多按钮，整行（名称文本与行内空白区）均可触发递归切换。
- [x] 2.3 将行容器 `onClick`（选中实体）改为**延迟提交**：用约 200ms 定时器排程 `onSelectEntity`，并在行容器的 `onDoubleClick` 中 `clearTimeout` 取消待提交的选中，使双击只做递归折叠/展开、不切换主区。`tsc` 确认类型无误。箭头按钮的 `onClick` 保持独立且 `stopPropagation`，不参与行选中去抖。

## 3. 递归折叠/展开实现

- [x] 3.1 在 `WorkspaceTree` 的 `actions` 中实现 `onToggleRecursive`：用 `setCollapsed((prev) => …)` 函数式更新，依据 `prev.has(id)` 判定当前态——展开则把 `[id, ...collectFolderIds(childNodes)]` 加入集合，已折叠则一并移除；`tsc` 与现有 vitest 组件测试通过。

## 4. 测试与验证

- [x] 4.1 为 `WorkspaceTree` 新增交互测试：构造一个含两层嵌套文件夹的集合树，模拟双击顶层文件夹名称（`fireEvent.doubleClick(tree().getByText(名称))`）→ 断言该文件夹及其后代目录的折叠箭头 `aria-expanded` 变为 `false`（整棵子树隐藏）。
- [x] 4.2 新增测试：先递归折叠后再次双击同一目录名 → 断言 `aria-expanded` 恢复 `true`、后代节点重新可见。
- [x] 4.3 新增测试：双击目录名后，断言主区**不**出现 `entity-script-panel`（主区保持原请求）、且无实体被选中；再单独单击同一目录名并等待去抖后，断言 `entity-script-panel` 出现（确认单击选中仍生效、仅延迟）。
- [x] 4.4 新增测试：搜索态（搜索框有输入）下双击目录名 → 断言 `collapsed` 集合不变、命中项仍展开；并补一条「祖先展开、后代部分已折叠 → 双击整展开」覆盖递归清理逻辑。
- [x] 4.5 运行 `npm test`（即 `vitest run`）确认 tree 相关测试全绿；手动在浏览器中双击集合/文件夹名确认递归收起与展开、且主区不被切换、单击仍可选中。
