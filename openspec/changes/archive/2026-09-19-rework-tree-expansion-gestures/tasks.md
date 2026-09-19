## 1. 行手势改造（单击 = 切换展开）

- [x] 1.1 在 `src/components/WorkspaceTree.tsx` 的 `EntryRow` 中，把行容器 `div.node` 的 `onClick` 由"排程选中"改为调用 `actions.onToggle(id)`；删除 `SELECT_DEBOUNCE_MS` 常量、`selectTimer` ref、`scheduleSelect` / `cancelSelect` 函数及其 `useEffect` 清理逻辑。验证：`npx tsc --noEmit` 通过，且文件中不再出现 `SELECT_DEBOUNCE_MS`。
- [x] 1.2 在行容器的 `onClick` 中忽略双击的第二次点击（`event.detail === 2` 时直接返回），并移除行容器上的 `onDoubleClick` 处理器。验证：模拟 `click` ×2 后触发 `doubleClick`，目标目录的 `aria-expanded` 只翻转一次、不回到原值。
- [x] 1.3 把行容器 `onKeyDown` 的 `Enter` 分支由 `actions.onSelectEntity(entity)` 改为 `actions.onToggle(id)`，与单击同义。验证：对目录行触发 Enter → `aria-expanded` 翻转且主区未出现 `entity-script-panel`。
- [x] 1.4 保持折叠箭头按钮的既有行为（`stopPropagation` 后调用 `actions.onToggle(id)`）与搜索态 `disabled` 不变；确认搜索态下单击行不改变折叠集合。验证：搜索框有输入时单击目录行 → `aria-expanded` 仍为 `true`。

## 2. 递归折叠 / 展开下线

- [x] 2.1 删除 `TreeActions.onToggleRecursive` 声明与 `WorkspaceTree` 中对应的实现，删除模块函数 `collectFolderIds`。验证：`npx tsc --noEmit` 通过，全仓搜索不到 `onToggleRecursive` 与 `collectFolderIds`。
- [x] 2.2 删除 `EntryRow` 的 `childNodes` 属性及其两个调用点（集合渲染处传 `tree.children`、文件夹渲染处传 `node.children`）。验证：`npx tsc --noEmit` 通过，全仓搜索不到 `childNodes`。
- [x] 2.3 更新目录行容器的 `title` 文案——现为「编辑集合脚本 / 编辑文件夹脚本」，而单击与双击均已不再是该语义，改为描述展开 / 折叠。验证：浏览器悬停目录行显示的提示不再出现"编辑…脚本"。

## 3. 脚本面板入口与工具栏「全部折叠」

- [x] 3.1 在 `EntryRow` 的菜单项数组新增「编辑脚本」，`onSelect` 调用 `actions.onSelectEntity(entity)`，位置在「新建子文件夹」之后、「重命名」之前。验证：打开某文件夹的「⋯」菜单并点击「编辑脚本」→ 主区出现 `entity-script-panel`，且 `onSelectEntity` 以该实体被调用。
- [x] 3.2 在 `TreeToolbar` 新增「全部折叠」图标按钮（`aria-label` / `title` 均为「全部折叠」，样式沿用 `icon-button`），点击回调接到 `WorkspaceTree`：把 `trees` 中全部集合 id 与全部文件夹 id 写入 `collapsed`；搜索态下点击不改变折叠集合。验证：点击「全部折叠」→ 所有集合与文件夹的 `aria-expanded` 均为 `false`、集合根节点仍可见；搜索态下点击 → 展开态不变。

## 4. 补齐新建后父级展开（既有需求缺口）

- [x] 4.1 在 `EntryRow` 中，令从「⋯」菜单发起的**新建请求**与**新建子文件夹**在调用对应动作前，先把当前行节点（集合行即集合 id、文件夹行即文件夹 id）从 `collapsed` 中移除，使新条目落在可见层级——既有需求「新文件夹…且该父级处于展开状态」与「新请求出现在树中」在父级已折叠时当前都无法保证。验证：分别折叠一个集合根与一个文件夹后，从各自菜单新建请求与新建子文件夹 → 父级 `aria-expanded` 为 `true` 且新条目可见。

## 5. 测试更新与回归

- [x] 5.1 替换 `tests/app.test.tsx` 中「集合树的双击递归折叠 / 展开」用例组（5 例），改为覆盖：单击目录行折叠、再次单击恢复且后代折叠态保留、双击只切换一次、单击不产生标签与主区切换、Enter 与单击同义、搜索态下单击无效。
- [x] 5.2 更新既有依赖「单击目录行即选中并打开脚本面板」的断言，改为经「⋯」→「编辑脚本」进入面板。验证：`npm test` 全绿。
- [x] 5.3 补充「全部折叠」「新建后父级展开」两组用例，对应 3.2 与 4.1 的验证条件。验证：新增用例通过。
- [x] 5.4 运行 `npm test` 与 `npx tsc --noEmit`，并在浏览器中手工走查：单击目录行即时展开 / 折叠（无延迟）、双击无"展开后折回"闪烁、请求行单击仍打开请求、单击目录名不选中文字、「⋯」菜单可进入脚本面板、工具栏「全部折叠」生效。
      **实际做法（实现期）**：`npm test` 269 通过、`npx tsc --noEmit` 通过。走查改为真实引擎的自动用例 `tests-browser/tree-expansion-gestures.spec.ts`（本机 Chrome 150，6 例全绿），逐条覆盖上面清单——比手工走查更可重复。首轮走查抓到的阻塞与修复见 6.1。
- [x] 5.5 运行 `openspec validate rework-tree-expansion-gestures --strict` 确认变更通过校验，并确认 `openspec/specs/` 下的主规格未被直接修改。

## 6. 实现期发现的既有缺陷

- [x] 6.1 修 `src/components/WorkspaceTree.tsx` 的 `useRowReveal`：焦点或指针在**行内**换元素（行容器 → 行内的「⋯」按钮）时不算离开，避免「⋯」在 mousedown 与 mouseup 之间被卸载、click 落到共同祖先（行容器）上。该缺陷先于本变更存在（原兜底行为是 200ms 后把主区切到脚本面板），但本变更把「编辑脚本」变成脚本面板的唯一入口，因此必须修。验证：`tests-browser/tree-expansion-gestures.spec.ts` 的「行已获得焦点时，⋯ 菜单仍能打开并进入脚本面板」在修复前失败、修复后通过。
- [ ] 6.2 （**待确认，超出已确认范围**）`src/components/EnvironmentsPanel.tsx` 的环境行有同一毛病的另一种形态：焦点在 `.env-item` 按钮上时点它的**兄弟节点**「⋯」，`env-item` 的 `onBlur` 清掉 `activeId` → `.node-more` 被卸载 → 菜单打不开。修法与 6.1 同源，但那里的 `currentTarget` 是按钮而不是行容器，需要按 `.env-row` 判断包含关系。是否本次一并修，待确认。

## 7. 评审后的修正

评审由 `code-reviewer` 子代理独立完成，逐条结论都先经复核（I1、M5 用真实引擎实测复现后才动手）。

- [x] 7.1 `EntryRow` 与 `RequestRow` 的 `onKeyDown` 加 `event.target === event.currentTarget`：Enter 只归行容器自己。不拦住会在真实浏览器下出现三种症状——在折叠箭头上按 Enter 净零无效、在「⋯」上按 Enter 顺手折叠该层、在菜单项上按 Enter 先折叠再执行（评审 I1，实测：`arrow-enter expanded=true`、`more-enter expanded=false`、`menuitem-enter expanded=false`）。验证：`tests/app.test.tsx`「Enter 落在行内控件上不切换行」+ `tests-browser/tree-expansion-gestures.spec.ts`「键盘 Enter 只作用于行容器自身」；两条都在修复前失败。
- [x] 7.2 折叠箭头的 `onClick` 加 `detail === 2` 守卫：双击箭头不再「折了又展开」地往返闪烁（评审 M5，实测 `arrow-dblclick expanded=true` = 确实切了两次）。守卫放在 `stopPropagation` 之后，第二击仍然不会穿到行容器。
- [x] 7.3 `tests/app.test.tsx`「单击目录行不产生标签」补上规格 scenario 的前置：先真的打开一个请求（并断言标签数为 1），再点目录行并断言请求仍在、标签数不变（评审 I3）。原断言是拿 0 比 0，验不到「原本打开的内容保持显示」。
- [x] 7.4 「全部折叠」在搜索态下改为 `disabled`（与折叠箭头同款，而不是「点了没反应」），`TreeToolbar` 因此接收 `searching`；delta 里的措辞与场景名同步收紧（评审 M6）。
- [x] 7.5 delta 文案修正三处：菜单项写作「新建文件夹（在文件夹节点上写作「新建子文件夹」）」（评审 M2）；ui-polish 的「双击名称不选中文字」区分目录与请求，不再要求请求节点有展开态（评审 M3）；补一段说明「搜索态冻结的是展开 / 折叠手势，不包括让新建内容可见这条不变量」（评审 I2）。
      **I2 未按评审的第一选项（给 `onExpand` 加 `searching` 守卫）改**：加了守卫会让「折叠父级 → 搜索态下在里面新建 → 清空搜索」后新条目不可见，直接违反既有需求「新文件夹 SHALL 出现在其父节点之下并被展开可见」。评审把「规格该改」列为可选路线，此处按那条走。
- [x] 7.6 `src/App.css` 的禁选注释不再引用已下线的「双击递归折叠」（评审 M1）；`tests-browser` 补「单击目录名不选中文字」（评审 M8）。

评审中被判定为**不成立、不修改**的两条：M4（主规格「保留既有交互」措辞）——该句列举的是结果而非手势，「选中集合 / 文件夹在主区打开实体脚本面板」经节点菜单仍然成立，不构成矛盾；M7（过时 change / design 编号引用）——引用来由的 change 与 design 段落是本仓库既有写法，且非本次引入。
