# Tasks

## 1. 取值查找（只此一处判定）

- [x] 1.1 抽出"名称 → 生效条 + 来源作用域"的查询：复用 `src/lib/variables.ts` 的 `effectiveByName`，集合级条目先放、当前作用域（环境或全局）后放，后者覆盖前者（与 `VariablesPeek` 同款，对应 `variable-engine`「作用域优先级」）；按需装载 `variableList` / `globalsList` 并在当前会话内缓存（design D2）。验证：单测覆盖"同名同时存在于 collection 与 environment 时取 environment"与"禁用条目不被当作生效条"。
- [x] 1.2 secret 明文经既有的 `secretReveal(id)` 取得，只在提示显示期间持有该明文（design D5）。验证：单测断言取值路径调用的是 `secret_reveal`，且不产生任何写入命令。

## 2. 四个编辑面的接入

- [x] 2.1 地址栏：在原生 `<input>` 自己的 `mousemove` 上实现字符命中判定——用与 input 同字体的测量把 `clientX` 换算成字符下标（补偿 `scrollLeft`），再用与 `highlightUrl` **同一条正则**切出的区间判断是否命中（design D3；叠层 `pointer-events:none` 不动）。验证：`tests/request-editor.test.tsx` 覆盖"指针落在 `{{host}}` 上命中""落在相邻普通字符上不命中""地址栏横向滚动后仍能命中"。
- [x] 2.2 参数表与请求头表：复用同一个命中判定 hook，接到两张表的 value 输入框上。验证：测试覆盖两处各一次命中；并断言这两处**没有**新增变量高亮（本变更的 Non-Goal）。
- [x] 2.3 Body raw：在 `src/lib/monacoEnv.ts` 注册 `monaco.languages.registerHoverProvider`，`provideHover` 按 offset 判定是否落在 `{{...}}` 内；"当前作用域"经可注入的数据源接入（provider 回调是静态注册的）。验证：`tests-browser/code-surface.spec.ts` 覆盖"悬停在占位符上出现提示""切换请求后悬停仍有效""重复挂载不重复注册 provider"。

## 3. 提示浮层与四条分支

- [x] 3.1 实现提示浮层：绝对定位、`pointer-events: none`、空间不足时上翻，指针移开或离开编辑面即消失。验证：浏览器用例断言提示出现与消失后，请求编辑器与响应区的布局、宽度、滚动位置都不变，且地址栏下方不出现任何常驻的解析结果展示区。
- [x] 3.2 四条分支的呈现：可解析（名称 + 取值 + 来源作用域）、未解析、动态变量（不给具体取值）、secret（明文）。验证：浏览器用例四条各覆盖一次；另断言动态变量的提示里不含任何具体取值，未解析项不呈现看似有效的取值。
- [x] 3.3 样式并入 `src/App.css`，提示不遮挡正在阅读的文本、不影响输入。验证：浏览器用例断言提示带 `pointer-events: none`，出现时输入框仍可继续键入。

## 4. 明文边界与全量验证

- [x] 4.1 明文边界。验证：一条用例断言提示显示某个 secret 的明文之后——（a）变量面板里该条仍以掩码呈现，（b）脚本 console 输出里不出现该明文，（c）该次显示不产生任何持久化写入。
- [x] 4.2 规格与实现一致。验证：`openspec validate "show-variable-values-on-hover" --strict` 返回 `valid: true`；`ui-layout`「变量占位符的悬浮值提示」的七条场景、`ui-layout`「环境变量的只读浮层」的九条场景、`variable-engine`「Secret 变量掩码」的五条场景，各自都有对应用例或明确的人工验证结论。
- [x] 4.3 全量验证。验证：`npx tsc --noEmit`、`npm test`、`npm run build`、`npm run test:browser`（复用本机 Chrome，不下载浏览器二进制）全部通过。

## Workflow follow-up

- 实现与验证全部完成后，归档该 change，并把 `ui-layout` 与 `variable-engine` 的两份 delta 合并进各自的主规格。
- 归档后确认 `openspec/specs/ui-layout/spec.md` 里「变量占位符的悬浮值提示」已就位、「环境变量的只读浮层」的明文出口措辞已改写，且 `variable-engine`「Secret 变量掩码」把两条出口写成可枚举的。
