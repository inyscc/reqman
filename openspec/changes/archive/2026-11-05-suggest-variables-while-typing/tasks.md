# Tasks

## 1. 判定与取值（不写第二套作用域规则）

- [x] 1.1 `src/lib/variableSuggest.ts`：`suggestContext(text, caret)` 按「回溯到最近的未闭合 `{{`」判定触发，并把替换范围向右延伸覆盖已写出的 `}}`（design D2）；`filterCandidates` 做前缀优先的过滤；`applySuggestion` 产出新文本与新光标位置。验证：`tests/variableSuggest.test.ts` 17 条覆盖「刚键入 `{{`」「`{{ho` 继续过滤」「光标在已闭合的 `{{ho|st}}` 内」「光标在 `}}` 之后」「`{{{`」「跨行」「名字片段里出现右花括号」「selectionStart 越界」。
- [x] 1.2 `src/lib/variableHover.ts`：取值源补 `candidates()`，读同一份 `load()` 的映射（同名只剩生效条、禁用不出现），取值走 `displayValue`（secret 即掩码），排序为「当前作用域在前、各自按名称」。验证：`tests/variableHover.test.ts` 新增 7 条——遮蔽只出一条且来源 environment、禁用缺席、排序、secret 掩码且不调 `secretReveal`、默认走缓存、`refresh` 重新装载、装载失败退化为空列表。

## 2. 交互与浮层

- [x] 2.1 `src/lib/useVariableSuggest.ts`：打开/关闭、高亮项、`↑`/`↓`/`Enter`/`Tab`/`Esc` 接管、失焦与外部按下收起、祖先容器滚动收起、组字期间挂起、`←`/`→`/`Home`/`End` 后按新光标复核（移出该 `{{` 即收起）；插入用 `flushSync` 提交后同步 `setSelectionRange`。验证：`tests/variable-suggest.test.tsx` 的键位、光标归位、外部点击、光标移出各一条。
- [x] 2.2 `src/components/VariableSuggest.tsx`：portal + `position: fixed` 的候选列表，锚在 `{{` 起始处下方、放不下上翻、左右夹在视口内；条目 `mousedown` 阻止默认以保持焦点。验证：组件测试「点选插入后输入框仍聚焦」；浏览器用例断言锚点在输入框下方且左缘落在输入框内。
- [x] 2.3 `src/App.css`：`.variable-suggest` 系列样式（与悬停提示同一档阴影与圆角，`pointer-events` 保持可点）。验证：浏览器用例断言浮层出现与收起前后，请求带高度、地址栏与正文区上沿都不变。

## 3. 三处接入

- [x] 3.1 地址栏（`RequestBand`）：接上候选，插入写回 `withUrl`。验证：组件测试「键入 → 选中 → URL 变成 `{{name}}`」、浏览器用例「回车插入后接着键入的字符落在插入点之后」。
- [x] 3.2 `KeyValueTable` 的取值列：候选的插入按行写回（真实行 `update(index)`、幽灵行 `editGhost`）；幽灵行的回车先问候选，被接管时让位（design D3）。验证：组件测试「参数值列补全」「候选打开时回车只补全、不跳行」「候选未打开时回车仍提交并跳下一行」。
- [x] 3.3 只有参数表与请求头表接上（Body 的 x-www-form-urlencoded 与 form-data 不接，属 Non-Goal）。验证：`suggest` 只在两处传入，代码路径上 form-data 与 urlencoded 无该 prop。

## 4. 规格一致与全量验证

- [x] 4.1 规格与实现一致。验证：`openspec validate "2026-11-05-suggest-variables-while-typing" --strict` 返回 `valid: true`；delta 的 17 条 Scenario 均有用例或明确的实现结论对应。
- [x] 4.2 全量验证。验证：`npx tsc --noEmit` 通过、`npx vitest run` **794 条全绿**、`npm run build` 通过、`npx vitest run --config vitest.browser.config.ts tests-browser/variable-suggest.spec.ts` **7 条全绿**（本机 Chrome）；`ghost-row-and-reload`、`variable-hover-tip` 复跑无回归（两文件并行时 hover 的 Body raw 一条有一次超时，单文件复跑全绿——已知的并行环境噪声）。
- [x] 4.3 归档：把 `ui-layout` 的 delta 合并进主规格，change 目录移入 `openspec/changes/archive/`。

## 验证中发现的问题（值得记住）

- **StrictMode 把「还活着」标志永久置 false**：`aliveRef` 原来只在 effect 的清理里置 false。真实应用由 `<StrictMode>` 挂载，effect 走「挂载 → 清理 → 再挂载」，第二次挂载后标志再也不会被置回 true，表现为**浏览器里敲 `{{` 什么都不弹**，而单测（非 StrictMode）全绿。修法是在 effect 体内置回 true；`tests/variable-suggest.test.tsx` 的「挂载方式」一条用 StrictMode 渲染，改回错误写法即失败（已实测）。
- 教训沿用：**涉及挂载/卸载时序的交互，单测之外必须有真浏览器用例**，并且单测里补一条 StrictMode 渲染的回归。

## Workflow follow-up

- 归档后确认 `openspec/specs/ui-layout/spec.md` 里「变量输入时的候选提示」「候选的过滤、插入与键盘操作」「候选里的 secret 只以掩码呈现」「候选提示的叠加性与失效边界」四节已就位，且与「变量占位符的悬浮值提示」措辞不矛盾（一个说悬停看值、一个说输入时给候选）。
