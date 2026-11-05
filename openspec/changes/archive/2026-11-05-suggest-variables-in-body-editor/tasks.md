## 1. 编辑器里的候选

- [x] 1.1 在 `monacoEnv` 注册补全 provider：触发字符 `{`，判定走 `suggestContext`、过滤走 `filterCandidates`，插入 `{{name}}` 并替换整个占位符
- [x] 1.2 `filterText` 带上 `{{` 前缀（Monaco 用「range 到光标」的文本做匹配），`sortText` 固定成候选下标（前缀命中不被重排）
- [x] 1.3 打开时（`query === ''`）重新装载一次变量列表，继续键入走同一份列表

## 2. 接线

- [x] 2.1 登记表从「悬停取值函数」换成「取值源」（`resolve` + `candidates`），悬停与候选共用一份
- [x] 2.2 登记的是读 ref 的代理：换环境 / 换集合时源被重建，模型与 provider 不重建，代理每次取当下的源
- [x] 2.3 `CodeSurface` 的 prop 改为 `variableSource`；`RequestEditor` 交出取值源本身

## 3. 验证

- [x] 3.1 浏览器用例（真 Blink）：正文里键入 `{{` 弹出面板、回车写入 `{{host}}`、单敲 `{` 不弹、改名字替换整个占位符
- [x] 3.2 既有单测、浏览器用例、`tsc --noEmit`、`npm run build` 全绿
