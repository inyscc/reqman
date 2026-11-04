# Tasks

## 1. 文本表示（D3）

- [x] 1.1 `src/lib/consoleLog.ts`：把终态措辞抽成 `resultText(result)`，`haystack` 改用它；新增导出 `entryToText(entry): string`（网络含方法 / URL / 结果，输出含 `[阶段 · 层级 · 级别]` 前缀与正文）。验证：`tests/console-log.test.ts` 新增「复制用的一行文本」四个用例（成功 / 失败 / 取消 / 输出带前缀与不带层级）。

## 2. 行结构可选中（D1、D2）

- [x] 2.1 `src/components/ConsolePanel.tsx`：`NetworkRow` / `OutputRow` 的标题行由 `<button>` 改为 `<div role="button" tabIndex={0}>`，Enter / 空格触发展开；不可展开的输出行改用 `aria-disabled="true"` 且不响应（D1）。验证：`tests/console-panel.test.tsx` 的禁用断言改读 `aria-disabled`，并新增「不可展开的行仍可聚焦」。
- [x] 2.2 `src/components/ConsolePanel.tsx`：行级点击先判断 `window.getSelection()?.toString()`，非空则不切换（D2）。验证：同文件新增「选中文字后点击不切换展开」。
- [x] 2.3 `src/components/ConsolePanel.tsx`：`JsonNode` 的折叠行同样改为 `role="button"` 的容器，键盘可达（D1）。验证：既有 `console-json-toggle` 用例仍通过（`tests/console-panel.test.tsx` 的展开树用例）。

## 3. 复制入口（D4、D5）

- [x] 3.1 `src/components/ConsolePanel.tsx`：两种行都加「复制」按钮，`stopPropagation`，写入 `entryToText(entry)`；成功切「已复制」1.5 秒，失败把原因说出来（D4）。验证：`tests/console-panel.test.tsx` 新增「点复制写进剪贴板并给出回执」「剪贴板失败要说出来」。
- [x] 3.2 `src/App.css`：`.console-copy` 默认不可见，`.console-entry:hover` / `.console-entry:focus-within` 时显形；`visibility: hidden` 占位避免重排；`.console-line` 加 `user-select: text`，`.console-line[aria-disabled='true']` 接替原 `:disabled` 的样式（D5）。验证：浏览器用例「复制按钮在悬停时显形，点击后剪贴板内容等于该行文本」。

## 4. 集成校验

- [x] 4.1 `npx tsc --noEmit` 退出码 0；`npx vitest run` 全绿。验证：命令输出。
- [x] 4.2 `npx vitest run --config vitest.browser.config.ts tests-browser/console-panel.spec.ts --maxWorkers=1` 全绿（含新增的复制用例）。验证：命令输出。
- [x] 4.3 `openspec validate console-entry-copy --strict` 通过。验证：命令输出。

## Workflow follow-up

- 归档本 change，并把 `request-console` 的 delta 合并进主规格。
