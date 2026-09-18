# Tasks: rework-app-layout

## 1. 布局骨架与样式

- [x] 1.1 `src/App.css` 重构 `.app` 为两段式（`280px 1fr` 列、`1fr 32px` 行，底栏跨列），主区为「会话标签/面包屑跨列 + 请求区左 / 响应区右」的栅格（仅在 `.main.with-response` 时启用第二列），新增侧栏 tab 条、面包屑、折叠条、模态遮罩、底栏样式；验证：选中请求时右侧出现响应栏，未选中请求时请求区独占整宽，且无横向滚动条
- [x] 1.2 `src/App.tsx` 按 D1 重排 JSX：侧栏容器（tab 条 + 内容）/ 主区 / 底栏三区骨架，先以占位内容渲染；验证：`npm run test -- app` 中「渲染集合树」用例之外的结构性断言先跳过（见任务 5），`tsc --noEmit` 通过

## 2. 侧栏双 tab

- [x] 2.1 `App` 增加 `sidebarTab` 受控状态，Collections tab 内渲染现有 `WorkspaceTree`（props 不变）；验证：默认显示集合树，点击请求仍在主区打开
- [x] 2.2 新增 `src/components/EnvironmentsPanel.tsx`：环境列表（点击 `setEnvironmentId` 激活、激活项高亮）+ Globals 固定项（点击 `setEnvironmentId(null)`），右半部复用 `VariablesPanel`；验证：Environments tab 内点击环境后主区发送走该环境（`variablesPreview` 的 `environment_id` 随动）
- [x] 2.3 移除工作区选择器与环境选择下拉（保留 `workspaces`/`workspaceId` state 与加载逻辑，D8）；验证：界面不存在 `aria-label="工作区"` 与 `aria-label="环境"` 的 select
- [x] 2.4 `VariablesPanel` 增加可选 `hideHeader` prop（默认 false）并在 Environments tab 内使用；验证：默认渲染下头部行仍在（既有测试不受影响）

## 3. 主区重构

- [x] 3.1 会话标签视觉壳：方法徽标 + 当前请求/实体名 + `×`（清空选中），空态占位；验证：选中请求显示对应标签，点 `×` 后主区回到空态
- [x] 3.2 面包屑行：集合名（从 `trees` 按 `draft.collection_id` 查找）/ 请求名 + 保存/另存为/删除按钮（从 `RequestEditor` pane-header 上移，`RequestEditor` 删除这三颗按钮与 `onSave/onDuplicate/onDelete` 外的遗留渲染）；验证：改名/保存/另存为/删除行为与改造前一致
- [x] 3.3 地址栏保留在 `RequestEditor` 内（方法/URL/发送），URL 中 `{{var}}` 用透明叠层高亮（失败则降级为仅预览条展示，见 D4/风险）；验证：输入 `{{host}}` 时该片段呈高亮样式
- [x] 3.4 请求 tab 文本改为 Params/Authorization/Headers/Body/Scripts/Settings（值不变）；验证：六个标签按此顺序显示且可切换
- [x] 3.5 `PreviewStrip`：折叠控件 + 默认展开，内部渲染 `PreviewBar`，`unresolved-warning` 提到折叠体外常驻（D4）；验证：折叠后警告仍可见（`data-testid="unresolved-warning"` 可定位），展开/折叠往返正常
- [x] 3.6 响应区内嵌 `ResponsePanel`（保留其内部 header 与 tabs），位于主区右列且**仅选中请求时渲染**（`.main.with-response`）；验证：选中请求后右侧出现响应区，发送后状态徽章、Body/Headers/脚本 tabs 行为不变，取消选中后响应区消失

## 4. 模态与底栏

- [x] 4.1 新增 `src/components/Modal.tsx`：遮罩 + 卡片 + 关闭按钮 + Escape 关闭；`App` 增加 `modal` 状态（`'cookies' | 'settings' | 'import-export' | null`）；验证：打开/关闭/单例（开一个再开另一个时前一个关闭）
- [x] 4.2 底栏组件：左侧状态/提示（`busy`、错误摘要、`optimisticErrors` 查看入口从右栏 header 搬入），右侧 Cookie/设置/导入导出三个按钮；验证：三个按钮分别打开对应模态，`ImportExportPanel` 导入后 `reloadAfterImport` 仍被调用
- [x] 4.3 移除左栏旧面板开关（变量/导入导出/Cookie/设置按钮）与 pane-body 内的叠放渲染；验证：侧栏仅剩 tab 条与 tab 内容

## 5. 测试迁移与回归

- [x] 5.1 重写 `tests/app.test.tsx` 中依赖旧布局的定位器：删除 `getByLabelText('工作区'/'环境')` 断言；`导入/导出` 改为「点底栏按钮开模态 → 操作 → 关闭」；`变量` 相关用例改为「点 Environments tab → 选环境/Globals」；tab 文本定位从 `scripts` 改为 `Scripts`；验证：修改后的用例覆盖 spec 场景（双 tab、环境激活、模态、折叠条、面包屑）
- [x] 5.2 全量回归：`npm run test`（vitest 全绿）、`tsc --noEmit`、浏览器测试 `npm run test:browser` 不受影响（若存在该脚本）；验证：无与布局相关的失败
- [x] 5.3 `openspec validate rework-app-layout --strict` 通过；验证：无错误输出

## 6. 浅色配色（追加范围，D9）

- [x] 6.1 `src/App.css` 的 `:root` 令牌整体换为浅色（D9 表）并令 `color-scheme: light`；验证：预览中侧栏/面板为浅底深字，无深色残留
- [x] 6.2 处理三处硬编码深色：新增 `--accent-fg` 供 `button.primary` 文字、模态遮罩与阴影改浅色主题取值、`pre.body` 代码底改浅色；验证：主按钮文字在蓝底上可读，模态遮罩不压黑
- [x] 6.3 状态色按浅底重取（`--warn` / `--danger` / `--ok`）并复核 `color-mix` 选中态；验证：未解析警告、错误提示、响应状态徽标在浅底上可读
- [x] 6.4 回归：`npx tsc --noEmit` 与 `npx vitest run tests/app.test.tsx`；验证：34 个用例全绿（配色不参与 DOM 断言）
