# Design

## Context

动机见 `proposal.md - Why`。与设计相关的现状：

- `pm.request` 由 `runScriptPhase` 经 `options.context.request` 喂进沙箱（`toSandboxRequest`，取自解析后的预览结果），**一个阶段一份快照**，三个层级共用（上一版 design 的 D6）。沙箱为每段脚本 `new sdk.Request(context.request)`，因此脚本的改动只影响那一段。
- 实际发送用的是 `client.sendRequest({ inline: cleanForSend(draft) })`——沙箱之外的另一份真相。且后端 `resolve_request_source` 的优先级是 **`saved_id` 优先于 `inline`**（`net/mod.rs`）：未标脏的请求带 `saved_id` 发送时，`inline` 会被完全忽略。这一点决定了下文的落地方式。
- 后端装配请求的地方是 `build_attempt`：`resolved.headers` → 认证头 → 正文 `Content-Type`；`Cookie` 由 reqwest 的 cookie store 在发送时才附加。`ResponsePayload` 目前只回 `request_url`，没有请求头。
- 沙箱 `execute` 的回调里带着 `execution` 的序列化结果，其中含 `request`（已实测：`{ url, header, method, body, auth }`）。也就是说，宿主**能**在每段脚本结束后读回改动后的请求头，不需要新增桥事件。

## Goals / Non-Goals

**Goals:**

- 三层前置脚本都能改请求头，改动按「集合 → 目录链 → 请求」累积，最终落到实际发出的请求上。
- 后置脚本能读到**实际发出的**请求头（含前置脚本加的、认证装配出的、正文类型与 Cookie）。

**Non-Goals:**

- 不打开 URL / 方法 / 正文的改写。它们仍不传播、不跨段可见——一并打开会把本变更扩成"脚本可任意改写请求"，牵动后端解析次序、变量未解析拦截与批量运行语义。
- 不新增桥事件、不改 `pm.sendRequest` 的语义（脚本内请求仍是独立的一份，不受主请求改动影响）。
- 不改脚本内请求（`pm.sendRequest`）的请求头捕获。

## Decisions

### D1 只打开「请求头」这一面，其余字段仍是快照

规格里"快照"那句被拆成两半：**请求头可改且传播**，其余字段（方法 / URL / 正文 / 认证）仍是快照。

理由：用户的两条诉求都落在请求头上；而 URL 与正文的传播要牵动后端——实际发送走的是 `inline` 请求，脚本改出来的 URL 若含未解析变量，谁来决定拦不拦？认证又该按哪一份算？这些问题的答案会改变 `unresolved` 拦截与代理决定的位置。请求头没有这些牵连：它不参与变量未解析拦截之外的解析次序，也不影响代理、重定向与认证判定（认证头本来就是"装配阶段的追加"，脚本改过的同名头会覆盖它——见 D4 的顺序说明）。

**替代方案（否）**：整份请求可写（对齐 Postman 的完整能力）。范围一开，就得把"脚本改写后的 resolved 与实际发送的 resolved 是同一份"这件事做成架构级约束，本变更没有这个预算。

### D2 跨段传播靠"读回 `execution.request`"，不靠共享对象

每段脚本执行完后，宿主从 `execution.request.header` 读回请求头，作为**下一段**的 `context.request.header`。沙箱为每段 `new sdk.Request(...)`，所以跨段可见性只能由宿主接力，不能指望沙箱内的同一引用。

只接力请求头、不接力整份请求：读回的是 postman-collection 的序列化形态（URL 变成 `{protocol, host:[…], path:[…]}` 对象），整份回灌会引入一次有损往返（`auth`、`body` 的形态都在变），而请求头本身是 `[{key,value,disabled}]` 的稳定形状。

读回时**过滤 `disabled` 的头**：脚本可以把某个头置为 disabled，那等价于"这次不发它"，与实际发送的口径一致。

### D3 合并落在前端，且以「差异」为准

`runScriptPhase` 结果新增 `request`（该阶段结束时的请求形态）。`App` 用它和喂进去的快照做差异比较（`diffRequestHeaders`），只有**真的变了**才把改动合并进待发请求（`applyScriptHeaders`）：

- 未变化 → 完全走原路径（`saved_id`、`inline` 都不动）。这让绝大多数请求的发送路径一字不变，也让"脚本没碰头"的情形不可能引入回归。
- 有变化 → 合并后以 `inline` 发送，并把 `saved_id` 置空。**`saved_id` 必须置空**：后端 `saved_id` 优先于 `inline`（见 Context），不置空的话合并结果会被无视——这正是"改了没用"最容易再次发生的地方。

合并以"键"为单位套在**草稿的原始头列表**上（不是套在已解析的那份上）：脚本没碰的头保持原样（`{{var}}` 仍交给后端解析），脚本改过的头写入脚本给的值。这样既不会把整份头提前解析、也不会让未解析变量拦截对无关的头失效。

同名头出现多次时按"第一个同名行"改写、按"键"整体移除——脚本侧 `headers.upsert`/`remove` 的语义本就是按名操作，多值同名头在请求编辑器里也不是常规用法。

**替代方案（否）**：把沙箱回读的整份头直接当作内联请求的头。省掉差异逻辑，代价是所有头的值都被提前解析成明文（含 secret），且脚本没碰的头失去后端的解析与掩码路径。

**替代方案（否）**：改后端，给 `send_request` 加一个 `overrides` 参数。多一条命令形态要维护，而"合并"这件事前端已经握有全部素材（草稿 + 回读的头）。

### D4 后置阶段以「实际发出的请求头」为准

`ResponsePayload` 增加 `request_headers`，由 `build_attempt` 收集：`resolved.headers` + 认证头 + 正文 `Content-Type`；`Cookie` 在**发送前**用 jar 的匹配结果补一条（必须早于 `jar.sync_to_db`，否则会把本次响应 `set-cookie` 的头也算进去——那是响应带来的，不是请求发出的）。

后置阶段构造 `pm.request` 时用这份头**覆盖**快照的头（`withSentHeaders`），`pm.response.originalRequest` 同源。这样后置脚本看到的请求头与实际发出的那一份一致，与 `http-engine` 里"预览与发送同源"的一贯口径相同。

已知缺口（写进规格的措辞里避开承诺）：`Host` / `Content-Length` / `User-Agent` 由 reqwest 与 hyper 在更底层补齐，本应用不设置它们，因此不在 `request_headers` 里；multipart 的 `Content-Type`（带 boundary）同理不补。

### D5 `Authorization` 等认证头进入前端：接受，并记入风险

`request_headers` 会把认证装配出的头送到前端，后置脚本因此读到凭据明文。这与 Postman 一致，且脚本本来就能经作用域变量拿到同类明文（`secretReveal` 是既有通道）；但它确实让凭据多了一处可观察面，故：

- 不进日志（`logging` 侧的 `register_secret_value` 机制原样生效，`request_headers` 不打日志）；
- 不进存储、不进响应历史；
- console 输出仍按既有 secret 名单脱敏——认证头的明文不在该名单里，这一条与"脚本自己 `console.log` 变量值"同级，属于用户脚本的自觉范围。

## Risks / Trade-offs

- [`saved_id` 未置空导致合并结果被后端忽略] → 实现处与用例都盯住这条：用例构造"未标脏 + 前置脚本改头"，断言后端收到的是改过的头（走 `inline`）。
- [同名多值头被折叠成一个] → 已在 D3 说明取舍；规格里只承诺"按名改写/移除"，不承诺多值语义。
- [认证头覆盖次序变化] → `build_attempt` 先写 `resolved.headers` 再写认证头，认证头在后，因此脚本若自己设了 `Authorization`，仍会被认证配置覆盖（与现状一致）。规格不承诺"脚本头优先于认证"，避免把一处实现次序变成契约。
- [既有用例"pm.request 是快照"会红] → 该用例断言的正是被本变更推翻的语义，按新语义重写（改成断言改动被回传并跨段可见）。
- [读回请求头增加一次每段的 IPC] → 只是把已经回传的 `execution` 多读一个字段，不新增往返。

## Migration Plan

无数据迁移：不涉及存储格式，不涉及既有脚本的解析。已保存的脚本在新语义下行为可能变化（此前"改了没用"的脚本现在会生效），这是本变更的目的，已在 proposal 里写明。
