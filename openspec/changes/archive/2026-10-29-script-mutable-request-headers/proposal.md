## Why

`pm.request` 现在是一份**只读快照**：前置脚本对它做的一切都留在沙箱里。于是两条在 Postman 里天经地义的用法在 reqman 里都不成立：

- **前置脚本签不了名**。按时间戳/摘要给请求加 `X-Signature`、给某个请求临时补一个 `X-Trace`、按环境改写 `Referer`——这些都得在脚本里改请求头，而现在改了等于没改，实际发出的仍是请求编辑器里那一份。
- **后置脚本读不到刚加的头**。断言"签名头带上了""Content-Type 对不对""Authorization 是不是这一条的"是后置脚本最常见的写法，而现在 `pm.request.headers` 里既没有前置脚本加的头，也没有认证、正文类型这些由请求装配阶段才落定的头。

用户对这两条的诉求是一致的：**脚本改得动请求头，就要看得见结果**。三层脚本（集合 / 目录链 / 请求）都要能改，且后一段要看得到前一段的改动。

## What Changes

- **前置脚本对请求头的改动落到实际发出的请求上**：`pm.request.headers` 的 `add` / `upsert` / `remove` / 成员改写，都会在发送前合并进待发请求。改动经前端合并实现，后端协议不变（仍收一份内联请求）。
- **改动跨脚本段累积可见**：集合层加的头，目录层与请求层的脚本都读得到；后一段的改动同样会传递下去。每段执行完就从沙箱读回 `pm.request` 的请求头，作为下一段的输入。
- **后置脚本读到的是「实际发出的」请求头**：后端在响应载荷里多回一份 `request_headers`（本次真正落到请求上的头，含认证头、正文 `Content-Type` 与发送前的 `Cookie`），后置阶段的 `pm.request` 与 `pm.response.originalRequest` 以它为准。因此前置脚本加的头、认证装配出的 `Authorization` 在后置脚本里都读得到。
- **不在快照里的部分保持原样**：请求方法、URL、正文的改写仍**不**传播到实际请求，也不跨段可见——本变更只打开请求头这一面，其余留作已知差异（与 Postman 的差距仍在，且写进了规格）。
- **编辑器补全跟着改**：`pm.request.headers` 的补全面加上 `add` / `upsert` / `remove` / `has` / `members`，注释说明"改得动的是请求头"。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pm-script-runtime`:
  - 「pm.request 的填充」：从「`pm.request` 是快照，改动不影响发送、不跨段可见」改为「请求头的改动 SHALL 落到实际发出的请求并跨段可见；其余字段仍是快照」。后置阶段看到的请求头 SHALL 是实际发出的那一份（含认证头、正文 `Content-Type`、随请求携带的 `Cookie`）。
  - 「编辑器补全与运行时能力一致」：`pm.request` 的声明面加上请求头的写方法（此前的"少声明"理由随快照语义一并撤销）。

## Impact

- **代码**：`src/lib/scriptRuntime.ts`（回读 `execution.request` 的请求头、跨段传递、结果新增 `request`）；新增 `src/lib/scriptHeaders.ts`（差异比较与合并，纯函数）；`src/App.tsx`（`performSend` 用合并后的内联请求发送、后置阶段改用实际请求头）；`src/lib/pmDts.ts`（补写方法）。
- **后端**：`src-tauri/src/net/mod.rs` 的 `ResponsePayload` 增加 `request_headers`，由 `build_attempt` 收集并在发送前补上 `Cookie`；不改任何命令签名、不改存储格式。
- **行为变化（有意）**：前置脚本改请求头从此真的会改变发出的请求——这是本变更的全部目的，也是唯一可能让既有用户感到不同的地方（此前"改了没用"的脚本现在会生效）。
- **安全取舍**：`request_headers` 会把认证装配出的头（如 `Authorization: Bearer …`）送到前端，后置脚本因此能读到凭据明文。这与 Postman 一致，且脚本本来就能经 `pm.environment.get` 拿到同类明文；但它确实扩大了一处可观察面，故记入 design 的风险项。
- **测试**：`tests/script-phase.test.ts` 里"宿主不接收对 pm.request 的改动"那条用例按新语义重写；新增 `tests/script-headers.test.ts`；`tests/pm-dts.test.ts` 的快照断言改为断言写方法存在。
