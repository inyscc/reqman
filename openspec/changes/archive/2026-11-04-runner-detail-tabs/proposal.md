# Proposal

## Why

运行器的明细只有一块内容：console 输出与断言。跑挂之后最该回答的三个问题——**发出去的到底是什么、回来的是什么、脚本看见了什么**——只有第三个有地方看。

前两个现在只能靠碰运气：签名头、`AccessKey`、脚本改过的正文都只在 `pm.request` 里，要么脚本自己 `console.log` 打出来，要么去请求编辑器里看一份**还没解析变量的草稿**；响应正文与响应头则完全不在运行器里，得回到全局 Console 时间线里去找那一轮对应的条目，而那里是混排的、还会被 500 条上限淘汰。

## What Changes

- 明细新增**请求 / 响应 / 脚本**三个页签，默认停在「脚本」——点开一条先看它为什么通过或失败。
- 「请求」页呈现本次**实际发出**的那一份：方法 + 解析后的目标 URL、请求体、请求头（含认证落成的头与前置脚本改写的头）。
- 「响应」页呈现响应体（按 Content-Type 格式化）与响应头；正文被体积上限截断时如实说明。
- 执行结果增加一份 `sent` 快照，由流水线在出口处给出，界面不再用草稿"重现"一次发送。
- 「脚本」页仍是 console 输出与断言（`ScriptReport` 不变），页签上带一枚状态点（绿＝断言全通过、红＝有失败或脚本报错），避免断言退到页签后面之后失败只剩名单上那个数字。
- 页签选择属于面板而不是某一条：切到「响应」后逐条点过去看的都是响应，不因换行跳回默认页。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `collection-runner`: 「每条请求的结果与输出」增加明细的三个页签与各自呈现的内容；明确请求页呈现的是**实际发出**的那一份，正文形态不是 `raw` 时说明形态而不是留白。

## Impact

**前端**

- `src/lib/requestExecution.ts`：`RequestExecutionOutcome` 增加 `sent`（`SentRequest`：方法、目标、请求头、正文形态与正文）。顺带修掉一处出口上的 TDZ：变量解析就失败时 `finish` 会去读尚未初始化的解析快照。
- `src/components/RunnerPanel.tsx`：结果列首加页签，明细按页签三分；新增 `RequestDetail` / `ResponseDetail` / `HeaderRows` 三个纯呈现组件。
- `src/App.css`：新增 `.runner-tabs`、`.runner-block*`、`.runner-pre`、`.runner-headers`、`.runner-request-line`。

**测试**

- `tests/runner-panel.test.tsx`：既有「点开一条能看到断言与 console」改为先切「脚本」页签；新增三页签的呈现与空态用例。
- `tests/request-execution.test.ts`：新增「实际发出的请求」快照的四个出口（成功、失败、表单正文、解析失败）。

**不涉及**：Rust 侧无改动；执行语义、门禁、取消、Console 接线都不动。
