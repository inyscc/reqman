# Proposal

## Why

脚本的输出目前只能落在响应区「脚本」页签里，而那个页签绑定的是**当前标签的最近一次发送**：切到别的标签就看不见，上一次发送的输出被下一次覆盖，已经关掉的标签连痕迹都没有。更关键的是，请求本身的结果（方法、URL、状态码、耗时、失败原因）从来不留痕——排查「这条请求到底发出去了没有、脚本为什么读不到响应」时，用户只能去翻后端日志。

Postman 的 Console 用一个跨请求的日志面板解决了这两件事：网络日志与脚本输出混排在同一条时间线上，对象可以展开看字段。reqman 需要一个等价物。

## What Changes

- 新增**全局 Console 面板**：底栏新增入口，面板从底部升起，跨请求、跨标签累积；关掉面板只是收起界面，不丢条目。
- 条目分两类，混排在同一条时间线上：
  - **请求日志**：方法、解析后的 URL、状态码与耗时（失败时是分类后的失败原因），可展开看请求头、响应元数据与响应体摘要；
  - **脚本输出**：前置/后置、级别、来源层级（集合 / 目录 / 请求）。
- 脚本输出**保留结构**：对象与数组以可展开的树呈现，不再在收集阶段就拼成字符串。既有的「脚本」页签继续按原样用同一份数据呈现。
- 面板提供**搜索**（按 URL、正文、输出文本匹配）与**按类型过滤**（全部 / 网络 / 输出），以及**清空**。
- 条目数有上限（默认保留最近 500 条），超出丢弃最旧的；**不清空当前在看的条目**。
- 面板高度可拖动，按工作区记住。
- 集合运行器发出的每一条请求同样进 Console——它与手工发送走的是同一条发送路径。

## Capabilities

### New Capabilities

- `request-console`: 全局请求日志与脚本输出的收集、保留、检索与面板呈现：条目模型（网络条目 / 输出条目）、容量与淘汰、搜索与过滤、展开与折叠、面板的开合与高度、清空语义。

### Modified Capabilities

- `pm-script-runtime`: 「脚本 console 输出的收集与呈现」不再只是一次发送的局部产物——输出 SHALL 同时进入全局 Console，且 SHALL 以保留结构的形态交给界面（可展开），而不是在收集阶段就字符串化。
- `ui-layout`: 底部状态条新增 Console 入口；Console 以**底部抽屉**呈现而非模态，不遮挡主区、不受「同一时间至多一个模态」约束；抽屉高度按工作区记住。

## Impact

**前端**

- `src/lib/scriptRuntime.ts`：`ConsoleEntry.args` 从 `string[]` 改为保留结构的值；截断与换行归一留在收集侧。
- `src/lib/requestExecution.ts`：每次发送产出可入 Console 的网络条目与输出条目（URL 用已解析的 `resolved.url`，状态与耗时取自 `ResponsePayload`）。
- 新增 `src/lib/consoleLog.ts`：应用级环形缓冲 + 订阅，容量淘汰与清空。
- 新增 `src/components/ConsolePanel.tsx`：抽屉、条目标题行、可展开树、搜索与过滤条。
- `src/components/ScriptReport.tsx`：消费新的结构化 `args`，对外呈现不变。
- `src/components/BottomBar.tsx`、`src/App.tsx`、`src/App.css`：入口按钮、抽屉布局与样式。
- `src/lib/layout.ts`：复用 settings 表存放抽屉高度（新作用域，或复用 `ui_layout`）。

**测试**

- 新增 `tests/console-log.test.ts`（容量、淘汰、搜索与过滤、清空语义）、`tests/console-panel.test.tsx`（条目渲染、展开、空态）、`tests-browser/console-panel.spec.ts`（抽屉开合与高度持久化）。
- 既有 `tests/script-runtime.test.ts`、`tests/response-panel.test.tsx` 因 `ConsoleEntry` 形态变化需要同步调整。

**不涉及**：Rust 侧无改动，网络层与存储层不动；Console 条目只在内存里，不落库、不跨重启保留。
