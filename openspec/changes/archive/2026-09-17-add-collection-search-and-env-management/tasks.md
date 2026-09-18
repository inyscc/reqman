## 1. 命令层与环境激活持久化

- [x] 1.1 在 `src/lib/commands.ts` 的「环境与变量」段落补 `environmentRename: (id: string, name: string) => call<Environment>('environment_rename', { id, name })`，与既有 `environmentCreate` / `environmentDelete` 的写法与参数名保持一致；验证方式：`npx tsc --noEmit` 通过，且 `grep environmentRename src/lib/commands.ts` 命中该绑定。
- [x] 1.2 在 `src/App.tsx` 新增统一的 `activateEnvironment(id: string | null)`：先乐观 `setEnvironmentId(id)`，再 `await client.environmentSetActive(workspaceId, id)`；失败时回滚到调用前的值并 `setError(describeError(caught).message)`；把侧栏 `EnvironmentsPanel` 的 `onActivate` 与后续主区选择器都指向它；验证方式：在 `tests/app.test.tsx` 新增用例——点击环境后断言假 client 收到 `environment_set_active`，且失败时界面出现 `data-testid="app-error"`。

## 2. Collections tab 搜索过滤

- [x] 2.1 在 `src/components/WorkspaceTree.tsx` 内实现纯函数 `filterTrees(trees, query)`（自底向上裁剪：请求按 `name` 或 `url` 子串匹配；集合/文件夹名命中则整棵子树保留，否则只保留命中的后代；空 query 返回入参引用）；验证方式：为该函数写单元测试，覆盖请求名命中、URL 命中、文件夹名命中保留整棵、无命中返回空、空 query 返回同一引用五种情形。
- [x] 2.2 在 `WorkspaceTree` 顶部渲染搜索框（`aria-label="搜索请求"`），`query` 作为组件内部 state，过滤结果经 `useMemo` 计算后用于渲染；验证方式：单元测试中输入关键字后断言树中只出现命中请求的节点。
- [x] 2.3 搜索态下强制全部展开并禁用折叠控件（渲染时忽略 `collapsed`、折叠按钮 `disabled`），清空搜索后恢复用户原有折叠状态；验证方式：单元测试——先折叠某文件夹，搜索命中其子请求时该文件夹可见且折叠按钮为 disabled，清空后该文件夹回到折叠。
- [x] 2.4 搜索无结果时在树区域显示空态提示，且不清空当前选中；验证方式：单元测试断言空态文案出现，且 `onSelectRequest` 未被调用、既有选中项不变。

## 3. Collections tab 工具栏与导入入口

- [x] 3.1 把工具栏改为「搜索框 + 两个图标按钮」（对齐 Postman）：去掉与 tab 名重复的「集合」标题行；新建集合保留现有行为，导入新增 `onImport` 回调 prop；文字只留在 `aria-label` / `title`；验证方式：单元测试断言工具栏不存在重复的「集合」标题、存在搜索框与 `新建集合` / `导入` 两个图标按钮。
- [x] 3.2 在 `src/App.tsx` 把 `onImport` 接到 `setModal('import-export')`，复用既有 `ImportExportPanel` 模态（不新建组件）；验证方式：`tests/app.test.tsx` 中点击集合树工具栏的「导入」后断言出现 `data-testid="import-export-panel"`，且从底栏打开的是同一个面板。
- [x] 3.3 在 `src/App.css` 补工具栏与搜索框样式（含窄侧栏下的收缩与省略号），验证方式：真实 Chrome 中确认侧栏（280px，比 300px 更窄）工具栏单行、搜索框宽度 207px、两个图标按钮不换行。
- [x] 3.4 导入完成后集合树刷新且搜索框内容保持不变；验证方式：`tests/app.test.tsx` 在搜索态下触发一次导入，断言新集合出现且搜索框仍保留原关键字。

## 4. Environments tab 的环境管理

- [x] 4.1 把 `WorkspaceTree` 内部的 `NodeMenu` 提取为 `src/components/NodeMenu.tsx`（导出 `NodeMenu` 与 `MenuItem` 类型，保留 `.node-menu` / `.node-more` 类名与外部点击 / Esc / 滚动关闭行为），`WorkspaceTree` 改为从该文件导入；验证方式：`tests/app.test.tsx` 中与树菜单相关的既有用例全部通过且未修改定位器。
- [x] 4.2 在 `src/components/EnvironmentsPanel.tsx` 头部新增「+ 环境」，调用 `client.environmentCreate(workspaceId, '新环境')` 后刷新列表并让新环境就地进入可编辑状态；验证方式：`tests/app.test.tsx` 点击「+ 环境」后断言列表多出一项「新环境」。
- [x] 4.3 环境项的操作菜单提供「重命名」与「删除」：重命名走列表内就地输入（回车或失焦提交，空名称拒绝并还原并提示），删除前渲染确认行（复用 `.node-confirm` 样式与「确认/取消」语义）；验证方式：`tests/app.test.tsx` 覆盖重命名成功、空名称被拒、删除需确认、取消不删除四类断言。
- [x] 4.4 删除当前激活环境后回落 Globals：`App` 在 `environment_delete` 返回后若被删项正是 `environmentId`，调用 `activateEnvironment(null)`；验证方式：`tests/app.test.tsx` 断言删除激活环境后变量区域显示全局变量、选择器为「无环境」。

## 5. 主区会话标签行的环境选择器

- [x] 5.1 在 `src/App.tsx` 的 `session-bar` 行右侧渲染环境选择器（受控 `<select>`，`aria-label="环境"`，选项为「无环境」+ 全部环境，值绑定 `environmentId ?? ''`，`onChange` 调 `activateEnvironment`）；未选中请求时同样渲染；验证方式：`tests/app.test.tsx` 断言空态下选择器仍存在，且切换选项会触发 `environment_set_active`。
- [x] 5.2 在 `src/App.css` 让标签行与选择器同排：选择器固定最大宽度、标签区域 `min-width: 0` 并可省略；验证方式：真实 Chrome 在 1280 / 900 / 760px 三档宽度下确认两者居中同一行、无横向溢出，且选择器没有把标签行撑高（移除选择器后行高不变）。
- [x] 5.3 确认切换环境后解析预览与发送使用新环境：验证方式：`tests/app.test.tsx` 在切换环境后断言 `variablesPreview` 与 `sendRequest` 收到的 `environment_id` 为新环境 id。

## 6. 回归与验证

- [x] 6.1 迁移因工具栏与 `session-bar` 结构调整而失效的既有定位器与用例（`tests/app.test.tsx`），确保终态断言仍覆盖原行为；验证方式：`npm test` 中 `tests/app.test.tsx` 58/58 通过。
- [x] 6.2 全量校验：`npx tsc --noEmit`、`npm test`、`npm run build` 均通过；验证方式：三条命令均以退出码 0 结束（`npm test` 为 126/126、7 个测试文件全绿）。顺带修掉一处与本变更无关的既有失败：`tests/script-phase.test.ts` 的探针自检写死了 `openspec/changes/add-pm-script-runtime/probes/escape-probe.js`，而该变更已归档进 `changes/archive/`；现改为在活动目录与 `archive/` 两处解析路径（用户确认后修改）。
- [x] 6.3 按本变更的 `specs/ui-layout/spec.md` 逐条核对实现覆盖（5 条新增需求 + 2 条修改需求的全部场景，以及 1 条被移除需求的迁移说明都有对应断言或手动验证记录）；验证方式：`openspec validate add-collection-search-and-env-management --strict` 通过，并在实现总结中列出场景与测试的对应关系。

## 7. 对齐与落点修正（反馈后追加）

- [x] 7.1 Environments tab 的工具栏与 Collections 同款式：去掉与 tab 名重复的「环境」标题与「+ 环境」文字按钮，改为图标按钮（`aria-label="新建环境"`，样式类 `icon-button` 两处共用）；验证方式：单元测试断言栏内不存在「环境」标题、存在「新建环境」图标按钮。
- [x] 7.2 会话标签行的环境选择器旁去掉重复的可见「环境」标签（选择器自身已显示「无环境」或环境名）；验证方式：单元测试断言 `.env-select` 内除 `<select>` 外没有可见文字标签。
- [x] 7.3 变量编辑从侧栏移到主区（`environment-editor`）：侧栏只留环境列表；停在 Environments 时主区显示环境编辑器，会话标签显示「环境 + 环境名」、面包屑显示「环境 / 名称」、响应栏让位；切回 Collections 恢复原请求且未保存编辑不丢；验证方式：单元测试断言变量表在主区且侧栏内没有变量表，另有一条往返用例断言未保存编辑与响应栏都恢复。
