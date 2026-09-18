## Context

动机见 `proposal.md`。当前形态：`WorkspaceTree.tsx` 是一个递归组件，文件夹分支渲染一个装饰性的 `▸`，子节点恒展开；集合行常驻 `+`（新建请求）与 `×`（删除集合），文件夹行常驻 `+`。`App.tsx` 中选中集合/文件夹时面包屑行只渲染「未选择请求」，改名无入口。脚本在 `RequestEditor.tsx` 的 `tab === 'scripts'` 分支与 `EntityScriptPanel.tsx` 中各以两个纵向堆叠的 `textarea` 呈现。

关键现状：**后端能力齐备**。`collection_rename`、`folder_create`（接受任意父级、校验同集合）、`folder_rename`、`folder_delete`、`folder_move`、`children_reorder` 均已在 `src-tauri/src/storage/workspace.rs` 实现并经 `src/lib/commands.ts` 暴露，`collection_tree` 已是递归构建。本变更**不改动 Rust 侧**。

## Goals / Non-Goals

**Goals:**

- 把后端已有的目录能力接到界面上：嵌套创建、重命名、删除
- 让树可折叠，并在视觉与密度上对齐 Postman 的紧凑观感
- 把脚本编辑从纵向堆叠改为左右两栏切换

**Non-Goals:**

- 不新增后端命令，不做数据迁移
- 不做拖拽排序、文件夹移动（`folder_move` 已有，UI 暂不接）、复制/重复
- 不持久化折叠状态
- 不改变「请求可以挂在集合根」——`requestCreate` 的 `folder_id: null` 路径保持不变

## Decisions

### D1 折叠状态是纯视图态，放组件本地

`WorkspaceTree` 内用一个 `Set<string>` 记录**被折叠**的节点 id，未记录的即为展开。默认全部展开，因此初始集合为空。

- 替代：写入 `settings` 表持久化 —— 折叠不是数据，重启后回到全展开更符合预期，且避免为视图态引入读写往返
- 副作用可控：`loadTree` 刷新后节点 id 稳定，Set 仍然有效；导入替换整棵树后残留 id 命中不到，等价于展开

### D2 操作入口：hover / 聚焦显示单个「⋯」，点击开小菜单

节点行不再常驻按钮。行在 `:hover` 与 `:focus-within` 时显示一个「⋯」按钮，点击展开一个绝对定位的小菜单。

- 替代 A：常驻一排图标 —— 动作增至 4 个后会挤占名称空间，与「按钮不应默认展示」的诉求冲突
- 替代 B：右键菜单 —— 需自己接管 `contextmenu`，且与 hover 入口是两套命中区域；先只做 hover 按钮，保留后续扩展
- 菜单关闭：监听文档 `mousedown` 的点击外部 + `Esc`

### D3 重命名走面包屑，不做树内联编辑

选中集合/文件夹时，面包屑行渲染名称输入框 + 保存按钮（现在那里是「未选择请求」），保存调用 `collectionRename` / `folderRename`。

- 替代：树节点双击变 input —— 需处理失焦提交、`Esc` 取消、宽度受限，且请求的改名已经是面包屑方案，两套并存不一致
- 保存后要同步三处：树（`loadTree`）、`entityDraft`、`selectedEntity`（会话标签取 `entityDraft?.name`）

### D4 删除用行内确认条，不用 `window.confirm`

菜单点「删除」后，在该节点下方插入一行确认条（复用 `.notice.danger`）：「删除「X」及其全部内容？[删除] [取消]」。

- 替代：`window.confirm` —— 在 Tauri webview 中可用但样式与整套自绘 UI 断裂
- 级联删除的真实代价是后代请求一起消失，因此确认文案必须点明「及其全部内容」

### D5 抽一个共用的 `ScriptPane` 组件

新增 `src/components/ScriptPane.tsx`，props 为 `pre` / `test` / 各自的 onChange；`RequestEditor` 的 Scripts 分支与 `EntityScriptPanel` 同时改为使用它。

- 替代：两处各自实现 —— 两栏结构 + 切换状态 + 已配置标记会重复
- 「已配置」标记 = 该段脚本 `trim()` 后非空，在左栏项上以小圆点呈现；这是两栏化后唯一能提示「另一段写了东西」的信号
- 切换不丢内容：两段脚本是两个独立 state，切换只换右栏展示源

### D6 CSS 收在侧栏作用域内

字号/行高/缩进的修改限定在 `.sidebar-body`（更保守则只到 `.tree`），新增 `.tree-*` 类名。方法标签用独立的 `.method` 类按方法着色，不动既有的 `.badge`（会话标签仍在用它）。缩进参考线用 `ul.tree` 的 `border-left` 实现。

### D7 零 Rust 改动，但级联依赖外键

`folders.parent_folder_id` 与 `requests.folder_id` 都是 `ON DELETE CASCADE`，`delete_folder` 是单条 `DELETE`。级联是否真发生取决于连接是否启用 `PRAGMA foreign_keys`——已确认 `storage/db.rs` 的 `configure` 里执行了 `pragma_update(None, "foreign_keys", "ON")`，因此级联删除生效，无需为此改动后端。

## Risks / Trade-offs

- **[级联删除的破坏性]** 删除一个文件夹会连带删除其全部后代与其中的请求，且不可撤销 → 删除前必须有说明「及其全部内容」的确认（D4）；建议同时补一个 Rust 侧用例断言级联，防止未来误关 `foreign_keys`
- **[hover-only 入口的可达性]** 触屏无 hover、纯键盘用户可能摸不到入口 → 用 `:focus-within` 兜底，菜单支持 `Esc` 与外部点击关闭
- **[侧栏字号下调的波及面]** 同一 `.sidebar-body` 内还有 Environments tab 的变量表格 → 收小字号后需一并看一眼可读性；若影响过大，把作用域收窄到 `.tree`
- **[两栏化后丢失同屏可见性]** 两段脚本不再同时可见，用户可能忘记另一段的存在 → 左栏「已配置」小圆点缓解；已知局限，接受
- **[菜单定位]** 侧栏 `overflow: auto`，绝对定位的菜单可能被裁切 → 菜单挂在行内、用 `position: absolute` 配 `z-index`，并在侧栏滚动时关闭菜单

## Migration Plan

纯前端改动，无数据迁移、无后端发布顺序问题。分三步验证：

1. 前端改动 + `tests/app.test.tsx` 的假命令用例（级联已确认生效，无需为外键改动后端）
2. 补一个 Rust 侧用例断言删除文件夹会级联删除后代，作为回归保护
3. 手工在 Tauri 窗口里过一遍：建三层目录 → 改名 → 折叠 → 删除确认

回滚即还原前端提交，无持久化副作用。

## Open Questions

- 方法标签是否要为全部 7 种方法各配一色，还是只区分 GET / POST、其余统一灰色？（可后续定，不影响任务拆分）
- 菜单是否要额外支持右键唤起？（可后续定）
