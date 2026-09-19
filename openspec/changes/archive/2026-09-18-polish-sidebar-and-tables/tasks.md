## 1. 侧栏头部与树行禁选

- [x] 1.1 删除 `src/App.tsx` 中 `sidebar-head` 块（约 905-908 行），使侧栏从 `sidebar-tabs` 起 — 验证：启动后在侧栏顶部看不到「工作区」标签或工作区名，tab 行紧贴侧栏上沿
- [x] 1.2 在 `src/App.css` 的 `.node` 上加 `user-select: none` — 验证：双击集合/请求名称不出现文本选中，双击递归折叠仍生效，搜索框内仍可拖选文字

## 2. Collections tab 滚动范围收束

- [x] 2.1 将 `.sidebar-body`（`App.css:144`）改为 `display:flex; flex-direction:column; overflow:hidden; padding:0` — 验证：侧栏 body 自身不再整体滚动
- [x] 2.2 令 `.sidebar-body > .stack`（仅匹配 `WorkspaceTree` 根；`.stack` 是共享工具类，勿全局改）占满（`flex:1; min-height:0`），把 `.tree-root`（`ul`，`WorkspaceTree.tsx:573`）设为滚动容器 `flex:1; min-height:0; overflow:auto; padding:0 10px 10px`，`.tree-toolbar` 保持 `flex:none` 并确认有上内边距（`.sidebar-body` 的 `padding:10px` 去掉后工具栏不能贴着 tabs）— 验证：长集合列表滚动时顶部搜索工具栏不动、不被卷走
- [x] 2.3 让 `.env-panel` 为 `flex:1; min-height:0; flex-direction:column` 且 `.env-list` 加 `flex:1; overflow:auto; min-height:0` — 验证：切到 Environments tab 时环境列表在收束后的侧栏内可滚动，新建/切换到 Globals 不受布局影响

## 3. 全局细滚动条

- [x] 3.1 在 `src/App.css` 加 `::-webkit-scrollbar` 细样式（`width/height:6px`、透明轨道、半透明 thumb）及 `* { scrollbar-width:thin; scrollbar-color:... transparent }` — 验证：侧栏树、响应正文、表格、模态出现纤细滚动条且不明显压缩内容宽度

## 4. 表格 Postman 风格

- [x] 4.1 轻量化 `table`：淡化 `td` 分隔线、`th` 更淡更小，并加 `tbody tr:hover { background: var(--panel-2) }` — 验证：行 hover 有可区分高亮，分隔线更轻
- [x] 4.2 表头吸顶：`thead th { position: sticky; top:0; background: var(--panel); z-index:1 }` — 验证：高出容器的表体滚动时表头钉在顶部（确认表格所在容器为滚动祖先，否则补滚动包裹层）
- [x] 4.3 `FormDataEditor`（`RequestEditor.tsx:452`）每行首列补启停 checkbox 并绑定 `row.enabled`（`update(index,{enabled})` 即更新草稿、保存时持久化），表头补首列空 `th`；新增发送专用 `cleanForSend`（`src/lib/rows.ts`）：在剔空行基础上**再按 `enabled` 过滤**（params/headers/urlencoded/form 一并），用于 `App.tsx` 的 4 个发送/预览/导出出口，使停用行不进入发送。落库保存仍走 `withoutEmptyRows`（只剔空行），停用的行以 `enabled:false` 持久化、不被删除 — 验证：form-data 每行出现 checkbox，切换改变该行 `enabled` 且保存后保留；停用行不进入发送（跑 `app.test.tsx`/`request-editor.test.tsx`：120 passed，无回归）
- [x] 4.4 给 `KeyValueTable` / `FormDataEditor` 的删除按钮加 `row-delete` 类，用 CSS 在 `tr:hover` / `tr:focus-within` 时显现、默认隐藏 — 验证：hover 或正编辑（焦点）的行显示删除按钮，未 hover 且无焦点的行不显示；checkbox 列始终可见
- [x] 4.5 变量表 `.var-actions` 沿用同款 hover / `focus-within` 显现规则 — 验证：变量行 hover 或含焦点时显示「揭示 / 删除」，否则隐藏

## 5. 校验

- [x] 5.1 运行既有测试（`app.test.tsx`、`request-editor.test.tsx`）通过 — 验证：无回归（120 passed）
- [x] 5.2 类型检查 / 构建通过（`npm run build`）— 验证：无类型与编译错误
