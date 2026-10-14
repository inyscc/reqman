# Tasks

## 1. 响应头收束

- [x] 1.1 删掉 `src/components/ResponsePanel.tsx` 里的「保存全文」按钮，并去掉它的 `onSaveFull` prop（`ResponsePanelProps` 的声明与函数签名上的解构一并去掉）。验证：`tests/app.test.tsx` 中断言响应头部成员的用例通过，且界面只剩 Body / Headers / 脚本三个标签。
- [x] 1.2 改被截断时的提示文案：去掉指向按钮的半句，只保留「界面只持有前 N MB」这一事实。验证：新增/调整用例构造一份 `truncated` 响应，断言提示文本不再出现「保存全文」。
- [x] 1.3 删掉 `src/App.tsx` 的 `saveFullResponse` 与传给 `ResponsePanel` 的 `onSaveFull`；后端 `response_save_full`、`src/lib/commands.ts` 的 `responseSaveFull` 与 `security_audit.rs` 的白名单条目**保留不动**（design D1）。验证：`npx tsc --noEmit` 通过，`src/App.tsx` 内不再引用 `responseSaveFull`，`npm test` 通过。
- [x] 1.4 确认响应头的其余行为未变：发送中标签仍可切换、遮罩与进度线不受影响。验证：`tests-browser/send-feedback.spec.ts` 全绿。

## 2. 请求编辑器的默认页签

- [x] 2.1 在 `src/App.tsx` 定义默认页签常量并替换五处 `'params'` 字面量：`openRequest`、`createRequest`、`duplicateRequestById`、工作区恢复 effect、渲染层的 `innerTab ?? 'params'` 兜底（design D3）。验证：`grep -n "'params'" src/App.tsx` 无命中，且 `npx tsc --noEmit` 通过。
- [x] 2.2 新增用例覆盖四条入口都落在 Body：新建请求、从集合树展开一个此前未打开的请求、复制请求、重启后恢复的标签。验证：`tests/app.test.tsx` 新增用例通过。
- [x] 2.3 确认已打开标签的页签记忆不被覆盖（不重置为 Body）。验证：新增用例走「切到 Params → 切到另一个标签 → 切回该标签」，断言仍停在 Params。
- [x] 2.4 核对既有断言里依赖"打开请求后看到 Params"这一前提的用例并逐条修正。验证：`npm test` 全绿；`tests-browser/session-bar-and-tables.spec.ts` 与 `tests-browser/fill-request-editor-panes.spec.ts` 全绿。

## 3. 规格一致性与全量验证

- [x] 3.1 规格与实现一致。验证：`openspec validate "trim-response-header-and-default-body-tab" --strict` 返回 `valid: true`；`ui-layout`「请求编辑器的默认标签页」的四条场景与「发送中的响应区反馈」新增的「响应头除标签外没有动作按钮」场景，各自都有对应用例或明确的人工验证结论。
- [x] 3.2 浏览器用例全绿（复用本机 Chrome，不下载 Playwright 的浏览器二进制）。验证：`npm run test:browser` 全部通过。
- [x] 3.3 类型检查、单测与构建。验证：`npx tsc --noEmit`、`npm test`、`npm run build` 三条命令退出码为 0。

## Workflow follow-up

- 实现与验证全部完成后，归档该 change，并把 `ui-layout` 的 delta 合并进主规格。
- 归档后确认 `openspec list` 不再列出该 change，且 `openspec/specs/ui-layout/spec.md` 里「请求编辑器的默认标签页」已就位、「发送中的响应区反馈」不再提及「保存全文」。
