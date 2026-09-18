## 1. 就地编辑（`src/components/VariablesPanel.tsx`）

- [x] 1.1 新增草稿状态 `drafts: Record<string, string>` 与 `editingSecrets`（哪一行处于 secret 编辑态），值单元格对可读变量（非 secret 或已揭示）渲染受控输入框（`aria-label={`变量值 ${name}`}`、`data-testid` 沿用 `plain-<name>`）；验证方式：单元测试断言该单元格是输入框且预填真实值。
- [x] 1.2 提交逻辑：回车或失焦提交，按 D2 判定「值是否变化」，未变化不发请求；Esc 取消并还原；成功后删草稿并 `onChanged()`，失败时删草稿 + 面板显示错误；验证方式：单元测试覆盖「改值→收到 variable_set」「原样离开/Esc→未收到」「提交失败→输入框还原且出现错误文案」「点删除引起的失焦未写值」。
- [x] 1.3 提交一定要显式带 `is_secret: variable.is_secret`（Rust 侧 `#[serde(default)]` 会把它当 false）；验证方式：单元测试断言编辑非 secret 变量时入参 `is_secret === false`、编辑已揭示的 secret 时 `is_secret === true`，且写入后该变量重新以掩码呈现。
- [x] 1.4 未揭示的 secret：保持掩码文本 + 「修改」入口，点击后换成空输入框（placeholder 说明留空不修改），留空提交不发请求，Esc/留空失焦退回掩码；验证方式：单元测试覆盖「进入前有掩码、无明文与输入框」「进入后为空输入框」「留空失焦未发请求并退回掩码」。
- [x] 1.5 不可读变量（`current.state === 'unreadable'`）保持只读徽章，不渲染输入框与修改入口；验证方式：单元测试断言该行没有输入框、没有修改入口，徽章带出原因。
- [x] 1.6 名称列保持只读；验证方式：单元测试断言该行只有一个输入框（值），名称以文本呈现。

## 2. 样式

- [x] 2.1 在 `.var-editor` 作用域内补编辑态样式（值输入框铺满列宽、掩码行的「修改」按钮轻量呈现、hover 反馈）；验证方式：真实 Chrome 打开环境编辑器，确认值列是输入框、掩码行与「修改」入口同一行不换行、操作列按钮同一行、不可读行没有输入框。

## 3. 测试与校验

- [x] 3.1 迁移依赖「值以文本呈现」的既有断言（`plain-<name>` 从 `textContent` 改为输入框 `value`），意图不变；验证方式：`tests/app.test.tsx` 67/67 通过。
- [x] 3.2 全量校验：`npx tsc --noEmit`、`npm test`、`npm run build`、`openspec validate add-variable-inline-editing --strict` 均通过；验证方式：四条命令均以退出码 0 结束（`npm test` 为 135/135、7 个测试文件全绿）。
