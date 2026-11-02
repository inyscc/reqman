# Tasks

## 1. console 输出按原文换行

- [x] 1.1 `src/components/ScriptReport.tsx`：console 列表挂 `className="script-console"`（D1）。验证：`tests/response-panel.test.tsx` 的「脚本 console 的多行输出」断言容器带该钩子且文本里的 `\n` 未被改写。
- [x] 1.2 `src/App.css`：`.script-console li` 用 `white-space: pre-wrap` + `overflow-wrap: anywhere`，并改为等宽字体（D1）。验证：CSS 规则存在；多行 JSON 的缩进在真实界面上对齐（happy-dom 不加载样式表，此处靠人工确认）。

## 2. 响应区「脚本」页签的结果点

- [x] 2.1 `src/components/ResponsePanel.tsx`：由 `scriptAssertions` / `scriptError` 现算 `scriptDot`（`fail` 优先于 `pass`，`skipped` 不计失败，D3 / D4 / D6），无断言时不点。验证：`tests/response-panel.test.tsx` 的「响应区脚本页签的结果点」五条用例分别断言全通过、有失败、跳过、脚本报错、仅 console。
- [x] 2.2 点在页签内渲染为 `.tab-dot`（失败态加 `.fail`），带 `role="img"`、`aria-label`、`title` 与 `data-testid="script-tab-dot-pass|fail"`（D2）。验证：用例按 testid 取到点并断言另一种状态不存在；`aria-label` 在用例中断言。
- [x] 2.3 `src/App.css`：新增 `.tab .tab-dot`（8px、`#2ea44f`）与 `.tab .tab-dot.fail`（`var(--danger)`），与集合面板 `.panel-tab .tab-dot` 同规格（D2）。验证：样式规则存在且不影响页签文字排版（人工确认）。

## 3. 请求编辑器 Scripts 页签的已配置绿点

- [x] 3.1 `src/components/RequestEditor.tsx`：按草稿的 `pre_request_script` / `test_script` 的 `trim()` 判定 `hasScripts`，在 Scripts 页签渲染绿点，`data-testid="request-scripts-dot"`（D5）。验证：`tests/request-editor.test.tsx` 的「Scripts 页签的已配置标记」四条用例分别断言无脚本、只有后置、只有前置、纯空白。

## 4. 集成校验

- [x] 4.1 页签名称与点击行为未被圆点破坏：既有用例仍按 `脚本` / `Scripts` 文本取页签。验证：`npx vitest run` 全量通过（含 `tests/app.test.tsx` 的脚本点击路径）。
- [x] 4.2 类型检查与全量测试：`npx tsc --noEmit` 退出码 0；`npx vitest run` 607 条全绿（新增 10 条）。

## Workflow follow-up

- 归档本 change，并把 `pm-script-runtime` / `ui-layout` 的 delta 合并进主规格。
