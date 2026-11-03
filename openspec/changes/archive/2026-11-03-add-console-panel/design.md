# Design

## Context

脚本输出已经在收集，但落点是「本次发送」的局部结果：`executeRequest` 把 `ScriptPhaseResult.console` 累进 `RequestExecutionOutcome.console`，`App.tsx` 再把它写进当前会话标签的 `scriptReport`（`src/App.tsx:1905`），响应区的「脚本」页签读它。这套结构有三个既定事实影响本次设计：

1. **收集时就已经是字符串**：`formatConsoleArg`（`src/lib/scriptRuntime.ts:134`）把沙箱送来的结构化值就地字符串化——沙箱其实送的是真对象（`scriptRuntime.ts:125` 的实测注释），结构是在宿主这一侧被丢掉的。
2. **输出条目没有层级信息**：`ConsoleEntry` 只有 `level / args / phase`，集合层与请求层的输出无法区分（`scriptRuntime.ts:1471`）。
3. **两条发送路径共用一个漏斗**：手工发送（`App.tsx:1870`）与运行器（`App.tsx:1957`）都调 `executeRequest`，但结果分别落到标签与运行器面板，谁都没有留下跨请求的日志。

规格见 `proposal.md` 与 `specs/`。

## Goals / Non-Goals

**Goals**

- 一次发送产生的所有可回看的实情（发出去什么、回来什么、脚本说了什么）集中在一条时间线上，且与界面状态解耦——切标签、关标签都不影响。
- 结构化值的展开能力不依赖「重新执行脚本」，只依赖收集时留下的数据。

**Non-Goals**

- 不落库、不写日志文件、不跨重启（spec: request-console「条目的生命周期与清空」）。
- 不记录 `pm.sendRequest` 发起的子请求：它走的是脚本的桥出口，与本次发送不是同一层，纳入会让「一次发送」的归属变复杂。留作后续。
- 不做导出、复制全部、快捷键。快捷键与既有全局键位的冲突需要单独梳理，不塞进这次。
- 不动 Rust 侧。

## Decisions

### D1: 新条目的收集点放在 `executeRequest` 的返回值上，由调用方写入

`executeRequest` 保持纯函数式：它多返回一份 `trace`（本次发送要记录的事实），由 `App.tsx` 的两个调用点交给 `consoleLog` 的 `recordOutcome`。

- 备选：在 `executeRequest` 内部直接写全局 store。否决——它现在能被单测在无 DOM、无全局状态的条件下跑，注入单例会把这些测试变成有副作用的；而且默认单例会要求每个测试显式关掉记录，忘一处就是脏数据。
- 备选：调用方各自组装条目。否决——字段多（方法、URL、状态、头、正文、耗时），两处各写一遍必然漂移。
- 代价：新增第三个发送入口时容易漏记。用一条测试兜住「运行器的发送也进时间线」来防止漂移。

### D2: 网络条目在发送开始时建、结束时更新

条目先以 `pending` 落进时间线（方法 + 已解析 URL 已知），响应到达 / 失败 / 取消 / 未发出时按同一个 id 更新为终态。

- 理由：时间线的顺序必须等于**发起**顺序。若等结果再插入，一条慢请求会排在它之后发起的快请求后面，与用户的心智不符（Postman 也是先出现后补状态）。
- 复用既有的 `onResponse` 回调时机，但它只覆盖响应到达；失败与取消要在 `executeRequest` 返回后补更新。
- `consoleLog` 因此需要 `append` 与 `settle(id, patch)` 两个动作，而不是只 append。

### D3: 输出条目同时保留「文本」与「结构」

`ConsoleEntry` 从 `args: string[]` 改为 `values: ConsoleValue[]`，每项含 `{ text, json }`：

- `text` 是 `formatConsoleArg` 的结果（脱敏、换行归一、超长截断），响应区脚本页签直接用，呈现行为与今天完全一致。
- `json` 是脱敏后的结构（可序列化时才有），全局 Console 据此渲染可展开树。

- 备选：只留结构，让两处都从结构渲染。否决——响应区要的是「按原文、紧凑/缩进自适应」的文本，那是既有规格（pm-script-runtime「结构化参数的呈现兼顾可读与紧凑」）的行为，改成树会是一次回归；而且不可序列化的值（循环引用、函数）根本没有结构可用。
- 脱敏在**结构层**逐叶子做，再做文本化：先文本化再脱敏会漏掉对象里的 secret（今天是先序列化再整体匹配，能挡住原样打印，但把值拆开拼接就漏；多一层结构脱敏不会更差）。

### D4: 输出条目补上脚本层级

`runScriptPhase` 里每段脚本顺序执行，用一个 `currentSegment: string | null` 在 `executeOne` 之前置位；console 监听器读它写进 `ConsoleEntry.segment`。弃用提示这类宿主自己造的条目，`segment` 置空。

### D5: 时间线是一个独立的微型 store，不进 App 的 state

`src/lib/consoleLog.ts` 导出与既有 `EntityStore` 同款用法的 `subscribe / snapshot / version`，配一个 `useConsoleLog()`（`useSyncExternalStore`）。

- 理由：`App.tsx` 已经四千行，任何一次 console push 都触发它重渲染的话，连请求编辑器都会跟着走一遍。面板订阅自己的 store，重渲染被关在面板内部。
- 容量淘汰在同一次 `set` 里完成（超过 500 条从头切掉），订阅者只会看到一次新快照。

### D6: 每次发送一条发送标识，把输出与网络条目串起来

`trace` 带 `sendId`（`attempt.attemptId` 可直接用），网络条目与本次的输出条目共享它。界面据它给条目分组着色/缩进，而不是靠「相邻」猜。

### D7: 正文与结构都有体积上限，且上限独立于响应上限

- 网络条目只存正文前 8 KiB，超出标 `truncated`。500 条 × 完整响应体会把内存吃穿，而 console 的用途是「看一眼发了什么」，不是响应阅读器。
- 结构值的 `json` 只在序列化后不超过 32 KiB 时保留，否则置空、只留 `text`。
- 上限在收集侧，不在渲染侧：渲染侧再截就晚了，内存已经占了。

### D8: 过滤与搜索是纯函数

`filterEntries(entries, { query, kind })` 放在 `consoleLog.ts`，不碰 React。搜索匹配方法、URL、状态、输出条目的 `text`；`kind` 三态互斥。面板只把它套在快照上。这样过滤语义可在单测里逐条验，不必起界面。

### D9: 抽屉高度复用 settings 表，独立作用域

`readSplitRatio` 那套的平行实现：`CONSOLE_SCOPE = 'ui_console'`，key 用 workspace id，值区间 `[0.15, 0.6]`（相对主区的比例，与分栏比例同一种单位，拖动时不必换算像素再存）。

- 开合状态**不持久化**，启动默认收起：console 是排查工具，不是常驻面板，每次启动占掉三成屏幕会很讨厌。

### D10: 抽屉占位而非浮层

抽屉在 `<main>` 与状态条之间插入一个高度带，主区用 flex 收缩。

- 备选：绝对定位浮在主区上。否决——它会盖住响应区正文，而排查时恰恰要同时看响应和日志；规格也明确写了「不覆盖」（ui-layout「底部 Console 抽屉占位」）。

## Risks / Trade-offs

- [500 条 × 正文 8 KiB 仍可能到 4 MB 量级] → 上限按条数而非字节；先观察实际使用，必要时再改为按字节淘汰。
- [结构脱敏挡不住编码变换] → 与既有 D15 同一个已知缺口，不新增风险面；面板不额外承诺「一定不含明文」。
- [「先建 pending 再更新」引入了条目可变状态] → 只有 `network` 条目可被 settle，且只在同一次发送内；`output` 条目一经写入不可变，因此列表渲染的 key 稳定。
- [两个调用点漏记] → 由「运行器的请求也进时间线」这条测试兜底（它同时覆盖手工与运行器两条路径）。
- [App.css 与布局改动可能波及响应区满高与折行] → 主区用 flex 收缩而不是固定高度；按既有「请求编辑器正文区的满高与区域内滚动」的约束做，浏览器测试里补一条「抽屉打开时编辑器仍可输入」。

## Migration Plan

纯前端改动，无数据迁移。`ConsoleEntry` 的形态变化会让 `tests/script-runtime.test.ts`、`tests/script-phase.test.ts`、`tests/response-panel.test.tsx` 中读 `args` 的断言失败——这些先改，再动界面。发布不需要开关：面板默认收起，对既有使用路径零打扰。

## Open Questions

- 是否给 Console 一个全局快捷键（Postman 是 Ctrl+Alt+C）：需要先梳理现有键位，会改变 `ui-layout` 的快捷键要求，留给后续变更。
- 网络条目要不要显示 `pm.sendRequest` 的子请求：属 Non-Goal，后续单独评估。
