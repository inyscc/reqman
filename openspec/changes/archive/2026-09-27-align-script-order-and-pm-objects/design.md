## Context

动机见 proposal.md — Why。影响设计的现状（均已核对过实现）：

1. **拦截在最前面**。`src/App.tsx` 在发送流程的 try 之前先调 `variablesPreview`，有未解析变量就 `setError` 并返回——早于门禁、早于脚本、早于任何网络调用。而后端在 `net/mod.rs` 的发送路径里本来就会再做一次 `resolve_request`（`elapsed_ms` 之前的第 329 行附近），所以**发送用的那份解析与拦截用的那份是两次独立解析**。
2. **`pm.request` 从未被喂进沙箱**。`src/lib/scriptRuntime.ts` 的 `executeOne` 传给 `context.execute` 的 `options.context` 只有 `globals` / `environment` / `collectionVariables` / `cookies` / `response`。上游 `lib/sandbox/execution.js` 会 `new sdk.Request(context.request)`，传 `undefined` 得到空 `Request`（`method` 回落 GET、`url` 空串），且上游测试在 context 无 request 时仍断言 `Request.isRequest(pm.request) === true`——所以上游套件永远不会暴露这个缺口。
3. **`pm.response` 只填 5 个字段**（`toSandboxResponse`）：`code` / `status` / `header` / `stream`(string) / `responseTime`。缺 `downloadedBytes`（`size()` 因此不准）、`originalRequest`、`cookie`；`stream` 传字符串而非二进制形态。
4. **脚本内请求的解析落后一步**。`runScriptPhase` 在该阶段所有脚本跑完后才 `persistWrites`（`scriptRuntime.ts` 末尾），而 `pm.sendRequest` 走 `commands.sendRequest` → 后端从数据库读作用域解析。于是脚本里 `pm.environment.set("x","1")` 之后发起 `{{x}}`，解析到的是**旧值**——沙箱内存作用域是新的、后端解析是旧的。
5. **取消/超时后仍落库**。`persistWrites` 位于 try/finally 之后，无条件执行：取消发生在脚本段时，已执行脚本的写入仍会写进数据库。
6. **preview 是掩码的**。`RequestPreview` 带 `masked` 标记，secret 值被打码（`variables/mod.rs` 的 `mask_secret_values`），它是给界面看的，**不能**用来构造 `pm.request`——脚本按 D15 应读到明文。后端另有 `resolve_for_export`（`net/mod.rs` 约 276 行）返回**未掩码**的 `ResolvedRequest`，供 curl 导出使用的正是这一份。

约束：前端只做界面；网络只能从 `net` 层出去；宿主桥的每个出口都要显式校验（既有约定，本变更不新增桥出口）。

## Goals / Non-Goals

**Goals:**

- 让「变量转换的时机」与 Postman 对齐：脚本执行之后才判定是否可发。
- 让脚本读到的 `pm.request` / `pm.response` 与 Postman 的字段面一致到「不会静默给出错值」。
- 修掉由上面两件事派生出的三个缺陷（脚本内请求解析到旧值、后置阶段 Cookie 目标陈旧、中止后仍落库）。
- 补上宿主侧的断言——上游套件验的是沙箱，验不了宿主喂了什么。

**Non-Goals:**

- 不新增宿主桥出口。`pm.request` / `pm.response` 是**喂进去**的，不是脚本来取的；`pm.sendRequest` 与 `pm.cookies` 的出口形状不变。
- 不实现 `pm.request` 的改写生效（见 D6）。
- 不采集分阶段耗时，`pm.response` 的 `timings` 不填。
- 不改动脚本的层级顺序与 folder 层级深度（已与 Postman 一致）。
- 不核实 `pm.vault` / `pm.iterationData` 的可用性——宿主桥只登记了 console / assertion / sendRequest / cookies 四个出口，这两项另行处理。

## Decisions

### D1. 拦截落在后端：resolve 之后、建连之前

```
[前置脚本 三级]          <- 可以创建变量
       |
       v
[send_request] --> 后端 resolve --> unresolved 非空 --> 返回错误，不建连
```

判定用的就是真正要发出的那一份 `resolved`，「不产生任何网络往返」严格成立。

- **备选 A：前端在脚本之后再做一次 `variablesPreview`。** 否决：那仍是两次独立解析，判定那份与发出那份不同源（动态变量每次求值不同、secret 要再揭示一次）。这类「判定与执行不同源」的结构以后必然出怪事。IPC 开销不是否决理由（用户已明确不以此为准），判定的正确性才是。
- 错误形态：新增一个可辨识的错误码（例如 `unresolved_variables`），沿用既有 `{ code, message }` 归一化路径（`describeError`）。
- 前端处置：该错误**不清空响应区**（请求没发出，响应区里谁在里面就留着），与取消的处置同路，但**要**呈现错误文本。`src/App.tsx` 的 catch 分支里目前只有 `CANCELLED_CODE` 享有「不清响应」待遇，需要把新错误码一并纳入判断。
- 脚本内请求豁免：`SendRequestInput` 增加一个开关（默认严格），宿主桥在替脚本发请求时显式关掉它。这样拦截只作用于用户触发的发送，与 Postman 一致。

### D2. `pm.request` 取自后端的一份**未掩码**解析结果

```
[后端 resolve（未掩码）] ---> 前端据此构造 pm.request ---> 喂进沙箱
       |
       +--> 同时也用于前置阶段 pm.cookies 的当前请求目标
```

- **扩展既有的 `variablesPreview`，加一个「揭示」开关**，而不是新增一条平行命令。理由：掩码与否是同一份解析的两种呈现，做成两条命令就是两份真相——判定范围、动态变量行为、auth/proxy 的解析只要有一处不一致，界面与脚本看到的东西就会分叉。备选（新增独立命令）被否决。
- 取一次、在前置脚本之前：与 Postman 一致，`pm.request` 是脚本执行时刻的请求快照。
- 构造形态用 postman-collection `Request` 的 JSON 形状：`{ url, method, header: [{key, value}], body: { mode, raw } }`。
- **URL 喂解析后的目标，但不对「是否保留模板」作承诺**。上游 `Url` 自己能解析的只有路径变量（`:id` / `{id}`，走 `Url#variables`，`postman-collection/lib/collection/url.js:295-303`）；`{{name}}` 的替换依赖对象上挂变量作用域，没有依据说明 Postman 是这样喂的。因此：spec 只要求「脚本读得出本次请求的目标」，不锁定 `url.raw` / `url.toString()` 的逐字段差异；实现期不为此做额外工作。**备选（喂模板串 + 挂变量列表）**：能同时满足 `raw` 与 `toString`，但需要验证上游是否支持把变量挂到 Request 上并参与替换，收益不确定、成本明确，本次不做。
- 认证只填方式、不填凭据：凭据不参与变量解析（`net/mod.rs` 中已有注释说明其密文原样带过），给脚本也读不出明文。
- 顺带收益：前置阶段 `pm.cookies` 的 URL 不再来自掩码的 preview，`src/App.tsx` 注释里记的那条「URL 中引用 secret 变量会以掩码形态出现」的已知限制随之消失。

**后置阶段的 Cookie 目标**（对应 spec「pm.cookies 的当前请求目标」）：取**后端实际用于发送的请求目标**，由发送结果回带（`ResponsePayload` 新增一个字段），而不是用 `final_url`——后者是重定向之后的地址，当前置脚本改写了目标域时两者并不相同。前端在后置阶段据此查询 Cookie Jar。

### D3. `pm.response` 的填充清单

| 字段 | 来源 | 备注 |
|---|---|---|
| `code` / `status` / `header` | `ResponsePayload` | 现状已有 |
| `responseTime` | `elapsed_ms` | 现状已有 |
| `stream` | 文本用 `body_text`；二进制用 `{ type: 'Base64', data: body_base64 }` | 上游 `normalizeStream` 明确支持 Buffer / `Buffer.toJSON()` / base64 字符串三种形态（`postman-collection/lib/collection/response.js:148-164`），base64 是最确定的一种：字符串可被 teleport 安全序列化，沙箱内自行还原 |
| `downloadedBytes` | 待确认语义后填（候选 `size_bytes`） | 使 `size()` 可用；`responseSize` 是派生字段（`response.js:258`），不自己填。响应被截断时「已下载字节」与「声明大小」不是一回事，实现时先确认 `size_bytes` 属于哪一种（见 Open Questions） |
| `originalRequest` | D2 的解析结果 | 本次请求本身 |
| `cookie` | 响应头的 `set-cookie` | 不从 Cookie Jar 读：jar 的写入时机与本条无关，读头更直接 |

不填：`timings`（后端未采集）、`final_url` / `http_version` / `via_proxy` / `truncated`（Postman 的 `pm.response` 顶层也没有对应字段）。

### D4. 脚本内请求带上当前内存作用域，且必须保住 secret 标记

**实现期的实测（原本设想的「让沙箱自己替换」这条路走不通）**：先试过在 `wrapUserScript` 里包装 `pm.sendRequest`，让它在调用上游之前用沙箱内的 `pm.variables.replaceIn` 替换一遍（那才是 Postman 的语义：替换发生在沙箱内）。三条实测把这扇门关上了：

1. 上游把 `pm` 的成员定义成 **own、`writable: false`、`configurable: false`**（`Object.getOwnPropertyDescriptor(pm, 'sendRequest')` 实测），直接赋值静默失败；
2. 用 `Proxy` 拦截 `get` 也不行——目标属性不可配置，Proxy 必须返回原值，否则抛 invariant 错误；
3. 沙箱确实**不做**占位符替换：`pm.sendRequest({ url: '...{{x}}' })` 派发到宿主时仍是原始占位符。

因此在现有沙箱契约下，「同一段脚本内的写入」传不到该段自己发起的请求。这条限制写进了 spec（宿主只能用「此前各段」的取值），本设计采用下面这条路径最大化对齐。

宿主桥在替脚本发请求时，把该阶段**当前**的三个持久化作用域按既有优先级（`local > data > environment > collection > global`）合并成一张表，经 `SendRequestInput.local` 传入（`src/lib/types.ts` 已有该字段、后端 `build_context` 已经在用它；`local` 目前在 `src/` 下**没有任何调用方**，扩展它的形状不会破坏既有契约）。local 优先级最高，因此脚本刚写入的值立即生效。合并成 local 不会遮蔽数据文件作用域：名字不在合并表里的，后端仍从 data 解析。

**必须一并解决：secret 标记不能丢。** `local` 的类型是 `Record<string, string>`，不带 secret 信息；而后端的脱敏依赖 layers 的 `secret_names`（由数据库构造，见 `src-tauri/src/variables/mod.rs` 的 `mask_secret_values`）。让 secret 明文经这样一条无标记的路径进后端，日志与错误消息的掩码就会失效——脚本内请求的 URL 与请求头里的明文可能被打进日志。这与「脚本读明文、但对外可观测的输出受掩码约束」的既有边界冲突，属于安全回归，不能靠「泄漏面没变化」一句话带过。

做法二选一：

- 把 `local` 的取值形状扩展为可带标记（`{ key, value, secret }`）；
- 或保持形状不变，另加一份名字列表（如 `local_secret_names`），后端构造 layers 时并入 `secret_names`。

倾向后者：改动最小、不动既有形状，且 secret 判定在后端本来就按名字集合做。无论选哪个，spec 里「脚本内请求引用的 secret 仍受掩码保护」那条必须有断言兜底。

- **备选：每段脚本执行后立即落库。** 否决：写入次数变多，且与「取消后不落库」（D5）直接冲突；`pm.variables` 的本地值本来就不落库，这条路也覆盖不到。

### D5. 只有「用户取消」才不落库

`runScriptPhase` 只在脚本阶段**正常结束**时执行 `persistWrites`；用户取消导致的中止直接返回已产生的 console 输出与断言，不落库。

划分依据是**中止来自外部还是脚本自身**：

- **用户取消**（外部原因）→ 不落库。用户中止了这次发送，副作用应当止于中止点。
- **脚本自身原因**（抛出未捕获错误、超出执行上限）→ 此前各段脚本的写入照常落库。超时与抛错同因——都是脚本自己的缺陷（死循环、未结算的 promise、写坏的代码）。把两者分开处理会让「集合层脚本设好的 `base_url`」在超时时丢失、在抛错时保留，用户看不出这两件事为什么不同。

后一类与现状一致（现状抛错即落库），因此这条划分实际改变的只有两处：取消路径由「仍落库」变为「不落库」，以及超时路径维持落库并把这个语义写进契约。

### D6. `pm.request` 是快照，改写不回传

Postman 里 `pm.request` 在同一请求的三段脚本间是同一个实例，`headers.add` / `remove` / `upsert` 会作用于实际发出的请求（`pm.request.body` 官方明写不可变）。做成这个需要：把沙箱执行结果里的 request 回传宿主 → 喂回下一段 → 最终让发送使用它。这与「请求由后端从数据库 / inline 载荷组装」的现有架构冲突，且要新增桥出口。

本次只做填充对齐，三段脚本拿到同一份快照：改动既不跨段可见，也不影响发送。这个差距写在这里，避免在实现期被当成 bug 反复提出。

### D7. 安全边界与既有约定一致

新增的解析出口是「只进不出」：它把解析结果交给前端喂给沙箱，不扩大脚本对外能力。脚本对外仍然只有宿主桥，且本变更不新增桥事件。`pm.request` 里含 secret 明文，与既有 D15「脚本读到明文、真正的防线在门禁与出口策略」一致。

唯一需要显式维护的一处是 D4 的 secret 标记：让 secret 明文经一条不带标记的路径进后端会削弱既有的日志脱敏，因此那条路径必须把标记带上，并有断言兜底。

## Risks / Trade-offs

- **R1：脚本内请求经 `local` 传递的 secret 若丢掉标记，后端日志脱敏会失效** → 由 D4 的标记方案解决，并由「脚本内请求引用的 secret 仍受掩码保护」这条断言兜底。这是本变更里**唯一**有安全含义的风险点，实现时优先级最高。
- **R2：拦截挪后，原本被拦下的请求会真的发出去** → 用户手滑写错变量名时，请求会带着 `{{name}}` 原文打到服务端（这正是 Postman 的行为）。缓解：发送前的变量浮层与预览仍然标示未解析，且拦截对「脚本也没写入」的情况照旧生效。
- **R3：扩展 `variablesPreview` 与新增严格开关可能触碰安全审计断言** → `security_audit.rs` 会读命令注册表与能力配置。扩展既有命令与新增开关都要确认不会让审计断言失败；若审计要求命令白名单，需要同步维护。
- **R4：取消路径由「仍落库」变为「不落库」，改变了既有行为** → 现有测试若断言了「取消后写入仍落库」，需要按新契约更新；这类断言本身是对现状的固化，改动时要在提交里说明。
- **R5：`pm.request` 携带大正文** → 请求体可能很大，会随 context 序列化传进 Worker。不设上限（与 Postman 一致），但实现时留意超大正文下的表现。
- **R6：URL 的文本形态与 Postman 的残余差异** → 本设计喂解析后的目标，因此脚本若依赖 `pm.request.url.raw` 保留 `{{}}` 模板，会看到替换后的文本。spec 已明确不把成员形态作为契约、实现期不做额外工作；若日后确认 Postman 保留模板且用户确有依赖，再单独处理。

## Migration Plan

无数据迁移，无新依赖，无 schema 变化。

1. 先落拦截时机（D1）——它单独就能解掉「pre 脚本创建的变量发不出请求」。
2. 再落 `pm.request` / `pm.response` 填充（D2 / D3）与三个连带修复（D4 / D5）。
3. 断言随各组一起补，不单独收尾。

回滚：两步都是独立开关式改动，撤销后回到「拦截在前、pm 对象部分填充」的既有行为；没有跨版本的数据形态变化。

## Open Questions

- 响应 Cookie 从响应头解析是否需要处理多个 `set-cookie` 与属性（Expires / Max-Age / Secure / HttpOnly / Domain / Path）的完整集合——实现时按 tough-cookie 的 JSON 形态对齐即可，不影响本设计的其它决定。
- `originalRequest` 用 D2 的解析结果还是后端实际发出的那份（重定向之后）——取前者：Postman 的 `originalRequest` 指本次请求本身，不是重定向后的结果。
- 上游套件里与 `pm.request` 相关的断言是否纳入回归——可选，它不覆盖宿主填充，纳入的价值有限。
- `size_bytes` 在响应被截断时表示已下载字节还是声明大小——决定 `downloadedBytes` 取它还是取 `declared_size_bytes`／从 `stream` 长度派生；实现时读 `src-tauri/src/net` 的截断处理确认，不影响本设计的其它决定。
