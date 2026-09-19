## Why

请求编辑器顶部同时挂着四个请求级操作（另存为、删除、保存、cURL 入口），地址栏下又常驻一整条解析预览；其中只有「发送」是高频动作，其余控件持续挤占正文区的高度与横向宽度。同时「保存」在界面上有三个位置、三种心智（按钮 / `Ctrl+S` / 未保存徽标），而未解析变量的保护依赖用户去读一块可折叠的展示，而不是在真正产生后果的那一刻（发送）被拦住。

## What Changes

- **请求面板头只保留身份**：删除「另存为」「删除」「保存」三个按钮。未保存改动用徽标呈现，保存改由 `Ctrl+S` 完成（快捷键已存在且不依赖焦点位置）。
- **复制入口移到集合树**：请求节点新增右键菜单，其中含「复制」（与集合、文件夹、请求既有的「更多」菜单同一套操作项）。
- **整条「解析预览」区域移除**：地址栏下方不再有可折叠的预览条。
- **cURL 从按钮改为标签**：成为请求编辑器第 7 个标签，位于 Settings 右侧；每次进入该标签即按当前请求重新生成命令（上一次的编辑不保留），正文是可编辑的等宽文本，保留「重新生成」「复制」两个动作，正文铺满正文区。
- **未解析变量从"提示"升级为"拦截"**：发送前解析一次当前请求，存在未解析变量时**不发出请求**，直接报错并列出变量名。**BREAKING**：过去这类请求会被照常发出（占位符原样进入 URL / 头 / 正文），现在不再发出。
- **脚本面板与设置面板改为键入即自动保存**：集合/文件夹脚本面板、设置面板去掉各自的保存按钮；落库成功时不再有"未保存"状态，落库失败时保留可观察的失败状态与退出前的拦截。请求编辑器（含其 Scripts 标签）仍由 `Ctrl+S` 保存。**BREAKING**：这两处的"保存"动作消失。
- **脚本编辑区收尾**：删除编辑器下方的「在本应用中编写并保存的脚本视为已授权，发送时不再弹出脚本确认。」说明段落（请求 Scripts 标签与实体脚本面板两处），编辑器铺满可用高度。

## Capabilities

### New Capabilities

无。本变更不引入新能力，右键菜单与自动保存都是既有界面能力内的交互方式调整。

### Modified Capabilities

- `ui-layout`：删除并重写三条需求——「请求面板头的身份与操作」→「请求面板头的身份」、「地址栏与解析预览条」→「地址栏」、「请求带上的 cURL 快照」→「cURL 快照标签」（被删的需求各自带 Reason 与 Migration）；修改三条需求——「请求标签命名」新增 cURL 标签、「集合树的操作入口默认隐藏」新增请求节点右键入口与「复制」、「脚本编辑区的左右两栏」改为编辑器铺满且不含授权说明段落。
- `variable-engine`：未解析变量提示（由"发出请求前提示"改为"发出请求前拦截并报错"，请求不发出）。
- `pm-script-runtime`：脚本的编辑与保存（集合/文件夹层改为编辑即自动保存；请求层由显式保存动作改为 `Ctrl+S`）。

## Impact

**前端**

- 删除：`src/components/PreviewStrip.tsx`，以及 `src/components/PreviewBar.tsx`——后者的两个导出（`PreviewBar`、`UnresolvedWarning`）只被 PreviewStrip 引用，随之成为死代码。
- 改动：`src/components/RequestEditor.tsx`（面板头、标签集、Scripts 分支）、`src/components/CurlSnapshot.tsx`（由请求带开关容器改为标签正文）、`src/components/ScriptPane.tsx`（铺满）、`src/components/EntityScriptPanel.tsx`（自动保存、删除说明段落）、`src/components/SettingsPanel.tsx`（自动保存）、`src/components/WorkspaceTree.tsx`（右键菜单与「复制」）、`src/App.tsx`（发送前置拦截、`onCurl` 下沉到 `RequestEditor`、按 id 的复制流程、自动保存后的基线前移、`previewError` 状态移除）、`src/App.css`。
- 保留但换消费者：`preview` 状态与防抖轮询仅剩只读变量浮层（`VariablesPeek`）在用——它同时是 `used` / `unresolved` 的唯一消费者。`previewError` 失去唯一呈现位，其状态与赋值一并移除（`tsconfig` 开了 `noUnusedLocals`，留着会编译不过）。

**后端**：不新增命令，复用 `request_duplicate`、`collection_set_script`、`folder_set_script`、`settings_set`。前端命令 `variables_preview`（后端 `preview_request`）仍被只读浮层使用。

**测试**

- `tests/app.test.tsx`：未解析变量（592-606）、解析预览条（608-629）、另存为（653 / 2624 / 3805 / 3867 / 3793）、保存入口（2615-2642）等用例需反转或删除，另需新增右键菜单「复制」与发送拦截用例。
- `tests/request-editor.test.tsx`：cURL 快照整组（408-527）的宿主改为"标签 + `onCurl`"。
- `tests-browser/session-bar-and-tables.spec.ts`：cURL 快照组（379-441）的入口改按标签，长命令用例的 220px 高度上限断言需重写。
- `cargo test` 侧不受影响。

**风险**

- 右键菜单与键入即自动保存都是本项目首次引入的交互机制，没有既有实现可参照。
- 发送前置拦截会让此前"能发出去"的请求不再发出，属可见的行为收紧。
- 两个面板去掉保存按钮后，守卫只在自动保存失败时才为它们触发；正常路径上请求编辑器是唯一会触发守卫的编辑面。
