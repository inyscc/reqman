## Why

界面在对照 Postman 参考样式时积累了若干小的交互/视觉不一致：一个无法操作的只读「工作区」头部、多次点击请求名会触发文本选中、侧栏滚动区把搜索框一并卷动、默认滚动条粗且占用布局宽度、以及表格密集横线和常驻删除按钮与 Postman 的清爽风格不符。这些都是打磨项，不改变核心数据流与请求发送行为。

## What Changes

- 移除侧栏顶部只读的「工作区」头部（`sidebar-head`），侧栏从 Collections / Environments 两个 tab 直接开始。
- 禁用集合树行的文本选中，使多次点击 / 双击（双击是递归折叠手势）不再选中名称文字。
- 重构 Collections tab 的滚动范围：仅集合列表滚动，搜索工具栏钉在滚动区上方。
- 新增全局细滚动条样式，使滚动条几乎不占用布局宽度（贴近悬浮观感）。
- 把所有键值 / 参数表刷新为 Postman 风格：更轻的行、行 hover 高亮、表头吸顶；保留启停 checkbox 列（form-data 当前缺这一列，补上）；每行的删除按钮改为仅在行 hover 或行获得焦点 / 处于活动态时显现（原本常驻）。
- 变量表：把操作单元（揭示 / 删除）同样改为行 hover 或焦点时显现，与其它表一致。

## Capabilities

### New Capabilities

- `ui-polish`：侧栏与键值表的视觉 / 交互打磨——移除工作区头部、树文本选中防护、侧栏滚动范围收束、细滚动条、Postman 风格表格渲染（轻行、hover 高亮、表头吸顶、hover / 焦点显现的行删除、form-data 的启停 checkbox）。

### Modified Capabilities

（无——不修改任何既有 requirement 文本。`ui-layout` 从未要求显示工作区头部，表格与滚动条行为在其它 spec 中亦未规定，故属纯打磨，不需要 delta。）

## Impact

- `src/App.tsx`：删除 `sidebar-head` 块。
- `src/App.css`：`.sidebar-body` 滚动范围、`.tree-toolbar` 钉固、`.node` 的 `user-select`、全局细滚动条、`table` / `th` / `td` 轻量化、行 hover 高亮、吸顶 `thead`、行删除按钮显现。
- `src/components/WorkspaceTree.tsx`：把列表包进独立滚动容器，使工具栏固定。
- `src/components/RequestEditor.tsx`：`FormDataEditor` 补启停 checkbox 列；为删除按钮加类名以支持 hover / 焦点显现。
- `src/components/VariablesPanel.tsx`：为操作单元加类名以支持 hover / 焦点显现。
- `src/components/EnvironmentsPanel.tsx` 及 `.env-list`：在新的收束滚动侧栏内仍能正常滚动环境列表。
