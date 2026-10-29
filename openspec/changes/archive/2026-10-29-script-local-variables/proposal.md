## Why

Postman 里最常见的写法是「前置脚本里算一个值，请求里引用它」——算时间戳、拼签名、从别的响应里取 token 存起来。而在 reqman 里，这条路只有一半能用：

- **`pm.environment` / `pm.globals` / `pm.collectionVariables` 行得通**：写入先落库，再发送，后端的解析取到的是新值。
- **`pm.variables` 不行**：它写的是本地作用域，既不落库，也没有交给本次请求的解析。脚本里 `pm.variables.set('nonce', …)` 之后，body 里的 `{{nonce}}` 在发送时仍然解析不出来——严格模式下直接拦截，请求压根不发出。用户看到的是一条"未解析变量"的错误，而脚本明明写了。

两个作用域在这里的分工是真实存在的（本地不落盘、一次执行后失效，适合放临时值），差别不该是"能用的那三个"和"不生效的那一个"。Postman 的语义是：本地变量影响当前请求，只是不持久化。

## What Changes

- **本地作用域参与本次请求的解析**：前置脚本经 `pm.variables.set` 写入的取值，随这次发送一起交给后端解析；`{{name}}` 出现在 URL、query、请求头、请求体或认证字段都同样生效。取值 SHALL NOT 被持久化。
- **优先级最高**：同名时本地 > 环境 > 集合 > 全局，与后端 `load_scope_layers` 的层次顺序一致（`local` 已是最内层，此前只是没人往里写）。
- **一次执行里连续**：同一请求的前置与后置脚本共用一份本地作用域——前置写的东西后置读得到；跨脚本段同理（集合层写、请求层读）。
- **严格模式不误伤**：本地写入的名字在数据库里没有对应的行，但 SHALL 按已定义处理，不触发「未解析变量」拦截。
- **脱敏跟着走**：本地取值可能抄自 secret（`pm.variables.set('x', pm.environment.get('token'))`），这类名字经 `local_secret_names` 一并告知后端，否则明文会以普通变量的身份进日志与错误消息。

不新增命令、不改存储格式：`SendRequestInput.local` / `local_secret_names` 两个字段后端早已有（此前只有 `pm.sendRequest` 在用）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `variable-engine`:
  - 「本地变量与迭代数据」：从「只在单次执行期间有效、不落盘」补上「SHALL 参与本次请求的解析，优先级高于环境 / 集合 / 全局」，并给出四条场景（脚本写入的本地变量参与当前请求、本地遮蔽同名变量、上层脚本的写入对下层可见、后置读得到前置写入的值）。
  - 「脚本对变量的读写」：`pm.variables` 的写入「SHALL NOT 被持久化」之后补一句「但 SHALL 参与本次请求的解析」。

## Impact

- **代码**：`src/lib/scriptRuntime.ts`（`ContextScope` 加 `local`；`executeOne` 喂入并回读本地作用域；`runScriptPhase` 逐段接力本地取值、结果新增 `local` 与 `localSecretNames`、新增 `initialLocal` 入参）；`src/App.tsx`（把前置阶段交回的 `local` 随 `sendRequest` 送出，并交给后置阶段）。
- **后端**：无改动。`SendRequestInput.local` / `local_secret_names` 已存在，`load_scope_layers` 里 Local 本就是最高层。
- **行为变化（有意）**：`pm.variables.set` 从此真的影响本次请求。此前依赖"写了不生效"的脚本不存在（那等于坏掉），因此没有兼容负担。
- **仍是已知差异**：同一段脚本内的写入对它自己发起的 `pm.sendRequest` 不可见（上游沙箱限制，本变更不触碰）。
- **测试**：`tests/script-phase.test.ts` 新增「本地作用域」四条用例；`tests/app.test.tsx` 断言 `sendRequest` 带上脚本写入的本地值；`src-tauri/src/net/tests.rs` 断言严格模式下本地取值参与解析且不拦截。
