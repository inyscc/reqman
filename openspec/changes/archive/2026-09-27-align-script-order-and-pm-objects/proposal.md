## Why

脚本的执行顺序（集合 → 文件夹 → 请求、前置 → 后置）已经与 Postman 一致，但**变量转换的时机不一致**：未解析变量的拦截发生在脚本之前（`src/App.tsx:1371`），于是「前置脚本写入变量、请求体引用该变量」这一 Postman 文档里作为示例给出的一等用法，在本应用中**永远发不出请求**——脚本是唯一会创建该变量的东西，却因为该变量不存在而跑不到。用户只能先在环境面板手工建一条同名变量，否则同一段脚本表现为「第一次不行、后来突然行了」。

同一类偏差还出现在 `pm` 对象上：`pm.request` 从未被喂进沙箱（`src/lib/scriptRuntime.ts` 的 `options.context` 只有变量作用域、cookies 与 response），脚本读到的是一个空 `Request`（`method` 回落 GET、`url` 空串）；`pm.response` 只填了 `code` / `status` / `header` / `stream` / `responseTime` 五个字段，`size()` 因缺失 `downloadedBytes` 而不准、二进制响应的 `stream` 传的是字符串。半兼容的 pm 对象会让用户脚本**静默产生错误结果**，这比不执行更糟——`add-pm-script-runtime` 把目标定为「完整兼容、对齐上游**实际**行为」正是为此。

现在做这件事的前提已经齐备：变量解析、网络出口、宿主桥、脚本槽位与门禁都已交付，缺的只是把「脚本看到的请求与响应」和「判定发生在哪一刻」对齐到 Postman。

## What Changes

- **拦截时机改为「发送前那一刻」**：未解析变量的拦截从「脚本之前、早于一切」移到前置脚本执行之后、真正建连之前。前置脚本写入的变量因此算已定义，不再触发拦截。Postman 不拦截未解析变量（原文照发），本应用**保留拦截**，这与 Postman 的已知差异由本变更显式承接（理由见 design.md）。
- **`pm.request` 填充**：把本次请求的真实形态（`url` / `method` / `header` / `body`）喂进沙箱，使前置与后置脚本都能读到它。这同时补上了 `pm-script-runtime` 现有「pm 兼容面」里 `pm.request` 一项的未兑现。
- **`pm.response` 填充对齐**：补齐 `downloadedBytes`、`originalRequest` 与响应 Cookie；`stream` 改用上游原生支持的二进制形态（base64），使 `pm.response.size()` 与二进制响应的 `text()` 给出正确结果。
- **修复三个连带缺陷**：
  - 脚本内 `pm.sendRequest` 的请求里 `{{name}}` 解析到的是脚本写入**之前**的旧值（变量在该脚本阶段末尾才落库，而后端从数据库解析）；
  - 后置阶段的 `pm.cookies` 用脚本执行前解析出的 URL 查询 Cookie Jar，脚本改过目标域时读到的是旧域的集合；
  - 用户取消发生在脚本段时，已执行脚本的变量写入仍会被落库（脚本自身抛错或超时则保留落库，并写进契约）。
- **补齐宿主侧断言**：现有测试对 `pm.request` 零覆盖，对 `pm.response` 只断言了 `code` 与 `text()`；`status` / `headers` / `responseTime` / `size()` / `json()` / `to.have.*` 全是空白。上游套件验的是沙箱本身，不会暴露宿主填充的错误，因此断言必须自己补。
- **失败提示可读（实机试用时发现）**：用 `https://` 访问一个只提供 HTTP 的服务时，rustls 报的是 `received corrupt message of type InvalidContentType`——用户完全看不懂，而且它没被认成 TLS 失败，落进了笼统的连接失败。改为归入 TLS 类别，并把消息换成点名成因的中文提示（保留原始文本以备排查）。
- **编辑器补全随实现同步（实机试用时发现）**：`pm` 的补全声明把 `pm.request` / `pm.response` / `pm.cookies` 收成了 `unknown`，脚本里打到 `pm.request` 之后就没有任何提示。按本次实现（`pm.request` 的填充、`pm.response` 的新字段）改成自足的具体形态，并加一条防漂移用例，把「声明须跟着实现走」变成可执行的约束。

**不做**（有意排除，理由见 design.md）：

- **`pm.request` 的改写生效**。Postman 里 `pm.request.headers.add/remove/upsert` 会作用于实际发出的请求（`pm.request.body` 官方明写不可变）。本变更只做**填充对齐**，`pm.request` 是一份快照：脚本对它的改动既不跨脚本段可见，也不影响发送。
- **响应分阶段耗时（`pm.response.timings`）**。后端未采集各阶段耗时，本变更不为此新增埋点。
- **`pm.vault` / `pm.iterationData` 的出口核实**。宿主桥目前只登记了 console / assertion / sendRequest / cookies 四个出口，这两个成员是否真的可用尚未核实；不在本变更范围内，另行处理。
- **嵌套文件夹的祖先脚本**。Postman 官方措辞是文件夹脚本作用于**直接子请求**，本应用现状与之相符，不改。
- **脚本内 `pm.sendRequest` 的未解析拦截**。拦截只作用于主请求，脚本内请求照发（与 Postman 一致，脚本自己处理错误）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `variable-engine`: 修正「未解析变量提示」的拦截时机——拦截 SHALL 发生在前置脚本执行之后、请求建连之前，且脚本写入后已定义的变量不再触发拦截；新增脚本内请求（`pm.sendRequest`）以本次执行的内存作用域作为本地变量参与解析的语义。
- `pm-script-runtime`: 新增 `pm.request` 与 `pm.response` 的字段填充契约（含各自的填充面与不填字段）；明确后置脚本阶段 `pm.cookies` 的当前请求目标取自实际发出的请求；明确取消或超时后不再落库脚本写入。

## Impact

- **代码**：前端 `src/lib/scriptRuntime.ts`（填充 `pm.request` / `pm.response`、脚本内请求带本地作用域、取消后不落库）与 `src/App.tsx`（拦截位置、后置阶段的 Cookie 目标）；Rust 侧 `net` 发送路径在建连前判定未解析变量，并扩展既有的变量预览命令提供一份**未掩码**的解析结果供 `pm.request` 使用——同一次解析的两种呈现，不做成两条命令。
- **既有行为变化**：原本被拦下的请求（变量由前置脚本创建）现在会正常发出——这是修正，不是回归；反过来，变量确实未定义且脚本也没写入的请求仍在发送前被拦下，行为不变。脚本读到的 `pm.request` 由「空对象」变为真实请求，依赖空值的脚本会改变行为。
- **测试**：新增宿主侧断言（喂给沙箱的 context 形状、`pm.request` / `pm.response` 的字段面、拦截时机）；`npm run test:upstream` 覆盖的沙箱行为不受影响。
- **安全边界**：不变。`pm.request` 携带的是解析后但未掩码的请求形态（脚本按既有约定可读 secret 明文），与 D15 一致；新增的解析出口不扩大脚本能力，脚本对外仍只有宿主桥一个出口。
