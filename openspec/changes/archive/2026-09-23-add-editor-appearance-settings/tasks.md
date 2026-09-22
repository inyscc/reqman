## 1. 外观的读写与注入（lib）

- [x] 1.1 新增 `src/lib/editorAppearance.ts`：四项的类型、缺省常量（系统等宽栈 / 12px / 4 / space）、`editor_appearance` 作用域与四个键、读回时坏值与缺失各自回落缺省、`space`/`tab` 编解码往返；新增单测（照 `requestPreferences` 那组形态）覆盖坏值回落与往返，`npm test` 通过
- [x] 1.2 在同一模块提供订阅与 `applyEditorAppearance(value)`：把值写成 `:root` 的等宽字体变量并通知订阅者；单测断言订阅者被通知、`document.documentElement.style` 上出现对应变量

## 2. 编辑面接线（Monaco）

- [x] 2.1 `CodeSurface` 订阅外观并在值变化时 `updateOptions({ fontFamily, fontSize, tabSize, insertSpaces })`；浏览器用例断言改字号后编辑器字号随之变化（`tests-browser/code-surface.spec.ts`）
- [x] 2.2 编辑器创建时以当前外观初始化，并设 `detectIndentation: false`；浏览器用例断言「正文里已有 2 空格缩进时，按 Tab 仍插入设置宽度（4）的缩进」
- [x] 2.3 确认外观不进入创建效应的依赖（`uri` 不变则不重建编辑器）；浏览器用例断言「调字号后正文折叠状态与滚动位置保持」
- [x] 2.4 缩进类型为 Tab 时按 Tab 键插入制表符；浏览器用例断言插入的是一个制表符（而非 4 个空格）

## 3. 等宽表面与启动读回

- [x] 3.1 让 `App.css` 的等宽面字体与字号受 `:root` 变量驱动（缺省即设计值），覆盖 `pre.body`、Hex 视图、二进制回退、cURL 快照文本域与 `.mono`；浏览器用例断言「同一份内容的结构化视图与降级为纯文本的视图字号一致」，并确认缺省字号归一为 12（相对改动前编辑器的 13）
- [x] 3.2 `App.tsx` 启动时读回一次外观并 apply（与既有 `readPresentation` 并列）；浏览器用例断言重载后编辑面与等宽面仍以所设外观呈现

## 4. 设置面

- [x] 4.1 `SettingsPanel` 新增「编辑器」节与四项控件（字体族输入框 + placeholder 示例、字号数值输入限 8–32、缩进数数值输入限 1–8、缩进类型下拉），并纳入既有 `baseline` / `dirty()` / `useEditingSurface` 机制；happy-dom 用例断言四项的渲染形态、区间外输入不改变设置值、行内无解释性文案
- [x] 4.2 落库成功路径同时 apply 外观（不只是写库）；浏览器用例断言改动后当前已打开的编辑面与等宽面立即变化
- [x] 4.3 确认「缩进数 / 缩进类型」与「格式化缩进宽度」相互独立；用例断言改其一不改变另一个，且响应格式化输出仍按「格式化缩进宽度」以空格缩进

## 5. 规格与回归

- [x] 5.1 `openspec validate add-editor-appearance-settings --strict` 通过
- [x] 5.2 `npm test`、`npm run test:browser` 与 `npm run build` 全部通过，既有设置相关用例无回归（过程中修掉一个既有 bug：`useMenuDismiss` 被「打开浮层之前就已排队的滚动事件」关掉菜单，见下方说明）
