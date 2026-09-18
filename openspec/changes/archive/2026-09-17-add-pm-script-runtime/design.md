## Context

动机见 proposal.md — Why。影响设计的是三件已存在的事实：

1. **脚本的槽位与往返已交付**。`pre_request_script` / `test_script` 存在于集合、文件夹、请求三层，导入导出完整保真。本变更不为脚本新增数据模型——现有槽位够用；唯一的数据改动来自 D7 引入的 Cookie 存储，它把 schema 推到 v3。
2. **安全边界已被写成可回归断言**。`security_audit.rs` 直接读取 `capabilities/default.json`、CSP 配置与 `src/lib.rs` 的命令注册表；任何放宽都会让测试失败。前端至今没有文件系统、shell 与任意网络能力，网络只能从 `net` 层出去。
3. **归档设计已为脚本沙箱留了接入点**。`foundation-core` 的 D15 写明「后续 `pm.*` 脚本沙箱复用同一隔离机制，使 P2 替换为更严格的沙箱时是替换实现而非重写边界」。

约束：交付目标是 Windows 安装包；完全离线；前端只做界面。

目标定为**完整兼容**（见 proposal.md — Why），这使「兼容面的定义」本身成为设计问题：必须有一个外部可核对的基准，否则"全兼容"无法验收。

### 上游实现的关键事实（本设计的证据基础）

均取自 `postman-sandbox@6.7.4` 及其依赖的实际源码与元数据：

**运行载体。** `uvm@4.0.2` 的 `package.json` 用 `browser` 字段把 `./lib/worker.js` 映射为 `./lib/worker.browser.js`。浏览器侧的实现是：

```js
const url = URL.createObjectURL(new Blob([bootCode], { type: 'text/javascript' }));
this.worker = new Worker(url);
URL.revokeObjectURL(url);
```

即一个**同源 blob 专用 Worker**（`DedicatedWorkerGlobalScope`）。它原本拥有 `fetch`、`XMLHttpRequest`、`WebSocket`、`indexedDB`、`CacheStorage`、`importScripts`。上游源码注释自述这是「执行环境隔离，不是安全沙箱」，要真正隔离不可信代码还需额外的跨源沙箱。**因此同源 Worker 本身不能作为本项目的安全边界。**

**沙箱的自我收缩。** `lib/sandbox/index.js`（bootcode 源码）在用户代码运行前调用 `recreatingTheUniverse()`：沿原型链逐层 `Object.getOwnPropertyNames(...).forEach(delete)`，一路删到 `Object.prototype`，连 `constructor` 一并删除（防止从构造函数回收全局引用），并重写 `Error.prepareStackTrace` 后置为不可配置。白名单来自 `uniscope/lib/allowed-globals`，另加 `require`、`eval`、`console`、`bridge`、`__uvm_emit`、`__uvm_setTimeout`。执行器初始化完成后 `bridge` 被 `delete`。

**用户脚本在哪个 realm 里跑。** `lib/sandbox/execute.js` 用 `uniscope` 建立脚本作用域：

```js
const scope = Scope.create({ eval: true, ignore: ['require'], block: ['bridge'] });
```

用户代码被包装成 async IIFE 后交给 `executeContext(scope, code, execution, new PostmanConsole(...), timers, new PostmanAPI(...), dispatchAssertions, {...})`。也就是说：**脚本跑在 Worker 自己的 realm 里**，`uniscope` 只做作用域层面的屏蔽（`ignore` / `block`），没有再引入一层 realm 边界。隔离的实际承担者就是「全局被删过」+ 作用域屏蔽——这进一步支持 D3：边界必须落在桥上，而不是落在 realm 上。

**超时与中止由沙箱自己的定时器封装完成，不是从外部强杀。** `execute.js` 不使用 `vm` 的超时选项，而是用注入的 `timers`：

```js
_.isFinite(options.timeout) && (waiting = timers.wrapped.setTimeout(function () {
  timers.terminate(new Error('sandbox: ' + (execution.return.async ? 'asynchronous' : 'synchronous') + ' script execution timeout'));
}, options.timeout));
```

超时是**在沙箱内部抛错**触发的，且上游已区分「同步脚本超时」与「异步脚本超时」两种语义。任务 9.5 沿用这套机制，不另造一套。另外 `execute.js` 在未提供 `resolvedPackages` 时会把 `require` 列入 `disabledAPIs`，并对非 legacy 代码加前置标记（`getNonLegacyCodeMarker` / `isNonLegacySandbox`）——这与 4.3 的弃用告警路径同源。

**`window` 这个形参是死代码（任务 1.1 的结论）。** bootcode 确实把真实全局 `window` 传了进去：

```js
require('./execute')(bridge, {
  console: (typeof console !== 'undefined' ? console : null),
  window: (typeof window !== 'undefined' ? window : null)
});
```

但 `execute.js` 的签名是 `module.exports = function (bridge, glob)`，其中 `glob` **只在一处被使用**：

```js
(new PostmanConsole(bridge, options.cursor, options.debug && glob.console))
```

`glob.window` 从未被读取。再加上 Worker 里本就没有 `window`（`self` 才是全局），且 `recreatingTheUniverse()` 已把它从沙箱全局删除，实际传入的是 `null`。**这条泄漏路径不存在。**

**`__uvm_emit` 的生命周期（任务 1.2 的结论）。** `uvm/lib/bridge.js` 的 firmware 里：

```js
__uvm_emit = function (postMessage, args) {
  postMessage({__id_uvm: "<id>", __emit_uvm: args});
}.bind(null, __self.postMessage.bind(__self));
__uvm_setTimeout = setTimeout;
try { <bootCode>; } catch (error) { __uvm_setTimeout(() => { throw error; }, 0); }
__uvm_emit('<flatted-encoded ["load.<id>"]>');
__uvm_emit = null; delete __uvm_emit;
__uvm_setTimeout = null; delete __uvm_setTimeout;
```

它只在 bootcode 的**同步阶段**存在，bootcode 一结束就被删除——这正对应 bootcode 里那句注释「allow uvm internals because these will be cleared by uvm itself at the end」。用户脚本是在之后由 `execute` 事件触发的，那时 `__uvm_emit` 已不可达，且 bootcode 未把它捕获进任何闭包。**因此它不是脚本可利用的通道。**

但宿主侧是另一回事。`uvm/lib/bridge.js` 的 `forwardEmits` 只校验 `__emit_uvm` 是字符串且 `__id_uvm` 与当前沙箱 id 相同，随后直接 `bridge.emit(...Flatted.parse(__emit_uvm))`——**不校验事件名**。通道本身不过滤，当前不可利用只是因为没人能往它写（见 D5 的对应约束）。

**白名单共 91 项，且不含任何输入输出原语。** 逐项核查：

| 原语 | 在白名单 |
|---|---|
| `fetch` / `XMLHttpRequest` / `WebSocket` | 否 |
| `Worker` / `importScripts` | 否 |
| `indexedDB` / `localStorage` / `sessionStorage` | 否 |
| `navigator` / `location` / `window` / `document` / `globalThis` | 否 |

保留的是：语言核心与 Error 体系、TypedArray、`Intl`、`URL`/`URLSearchParams`、`TextEncoder`/`TextDecoder`/`atob`/`btoa`、`Blob`、WebCrypto（`crypto`/`SubtleCrypto`/`CryptoKey`/`Crypto`）、Streams 全家族、`Event`/`EventTarget`/`DOMException`、`AbortController`/`AbortSignal`、`structuredClone`、`queueMicrotask`。白名单里有一组注释为 `// Fetch` 的条目，但其中只有 `AbortController` 与 `AbortSignal`——`fetch` 被刻意剔除。

**宿主侧契约的形状（任务 2.3 实测）。** `createContext(options, callback)` 给出上下文，`context.execute(target, options, callback)` 以 `callback(error, result)` 回传结果。脚本的 `console` 由沙箱派发 `execution.console`、宿主转译后**重发为 `console`**（监听签名 `(cursor, level, ...args)`）——宿主该监听的是 `'console'`，不是 `'execution.console'`。两个名字只差一个前缀，写错的表现是「永远收不到输出」而不是报错，很难查。

另外两条已实测：其一，**上下文释放后再 `execute` 会同步抛出**（uvm 的 `unable to dispatch "execute" post disconnection`），不走回调。就「脚本不会静默地再跑一遍」而言这是正确行为，但宿主适配层必须显式处理，否则它会以未捕获异常的形式冒出去、调用方拿不到任何结果。其二，2.3 的用例跑在 Node 下，`uvm` 走的是 Node 后端（`worker_threads`），**证明的是宿主侧契约，不是浏览器后端的行为**；浏览器后端由 1.3（CSP 继承）与 1.4（逃逸尝试）覆盖，两者不能互相替代。

**宿主侧调用形状（三条都不能靠猜，均已实测）。**

其一，`execute` 的 target 必须是 `{ listen: 'prerequest' | 'test', script: '<代码字符串>' }`。只传代码字符串也能跑，但那样 `event.listen` 为空，沙箱按 `TARGETS_WITH_REQUEST` / `TARGETS_WITH_RESPONSE` 判定后**既不给 `pm.request` 也不给 `pm.response`**。而把 `script` 写成 `{ toSource: () => code }` 会**静默不执行**——没有输出、没有错误、`err` 为 `null`，是所有失败形态里最难查的一种。

其二，变量作用域以 `[{ key, value, type }]` 数组喂进 `options.context` 的 `globals` / `environment` / `collectionVariables`（另有 `_variables` 作为本地作用域）。

其三，脚本的写入从结果的 `execution.<scope>.values` 取回（包含新增与改写后的条目），也可用 `execution.<scope>.mutations.compacted` 只取变更。实测：`pm.environment.set('b','2')` 并改写 `a` 之后，结果的 `environment.values` 为 `[{type:'string',value:'9',key:'a'}, {type:'any',value:'2',key:'b'}]`，`mutations.compacted` 为 `{a:['a','9',{}], b:['b','2',{}]}`。

其三的两条补充（3.3 探针实测）：其一，回传的 `values` 是**完整作用域状态**——喂进去的种子值与本次写入一并返回（种子 `cv` 未动、脚本只写 `cv2`，回传里两者都在），这正是「未变化的不重复写」得以成立的原因。其二，**每次 `execute` 的作用域都是全新的**，沙箱不跨执行保留任何变量；前一段脚本的写入对后一段可见，靠的是宿主把上一段的 `values` 喂回下一段的 `options.context`。由此推出：本地作用域（`pm.variables`）的生命周期是**单次执行**，同阶段的两段脚本之间也不保留——比 spec 的「不落盘」更强；本地值从不被宿主回喂，该语义自然成立，无需额外实现。

其四，`pm.sendRequest` 走事件往返：沙箱派发 `execution.request.<执行 id>`，载荷是 `(cursor, 执行 id, 事件 id, 请求)`；宿主回 `execution.response.<执行 id>`，载荷是 `(事件 id, 错误, 响应, 历史)`。事件名里带着执行 id，所以 id 必须由宿主经 `execute` 的 `options.id` 指定——不指定的话宿主无从监听。而**沙箱给出的 `url` 是 `{protocol, host:['api','test'], path:['ping'], query:[]}`：没有 `raw` 字段，host 与 path 都是数组**。只处理 `raw` 会得到空字符串，请求随即发不出去，且同样不报错。

其四的载荷实测（3.6 探针）：第二参数**确实**是执行 id（`options.id` 的原样回显），可与注册的事件名交叉验证；**事件 id 是自增数字**（从 1 起），不是字符串——宿主的载荷校验必须接受「非空字符串或数字」，按字符串校验会把合法派发全部挡掉。cursor 形如 `{execution: '<执行 id>'}`。

其五，`pm.cookies` 是 tough-cookie Store 的**远程代理**（3.5 探针实测）：`jar.get/set/unset` 的每一步都派发 `execution.cookies.<执行 id>`，载荷 `(事件 id, 'store', Store 方法名, 参数)`——**无 cursor 前缀**，与请求出口不同。Store 方法共 8 个：`findCookie` / `findCookies` / `putCookie` / `updateCookie` / `removeCookie` / `removeCookies` / `getAllCookies` / `removeAllCookies`；宿主按事件 id 回传（事件 id、错误、结果），结果为 cookie JSON（对象或数组，`expires` 用 ISO 串、会话为 `'Infinity'`）。`jar.set` 的内部顺序是先 `findCookie`（判断存在性）再 `putCookie`；已存在的更新走 `updateCookie`。两条 API 语义要点：`jar.get` 回调直接给**取值字符串**；`jar.getAll` 返回 postman-collection 的 CookieList（PropertyList 系，计数用 `.all()`）。宿主侧实现于 `scriptRuntime.ts`，读取与写入分别落到 `cookie_query` / `cookie_put`，匹配语义全部留在 Rust 端。

其六，`pm.require` 在宿主未提供 `options.resolvedPackages` 时**会被上游主动摘掉**（4.2 补验）：`lib/sandbox/execute.js` 中 `if (!options.resolvedPackages) { disabledAPIs.push('require'); }`，实测表现为 `pm.require is not a function`——而沙箱自带的 `require` 全局仍能解析全部内置库。Postman 文档与 spec 都用 `pm.require`，故宿主在 `wrapUserScript` 里补别名 `pm.require = require`；**不新增任何能力**（`require` 本就在脚本作用域内），只对齐文档行为。别名对行号校准脚本同样生效，偏移量因此保持一致。

其六的连带实测（1.4 探针自检）：`require('fs')` / `require('path')` 能拿到**空壳 stub**（对象存在，但没有 `readFileSync` 之类），`require('http')` 则抛 `Cannot find module`。因此「逃逸面判定」**不能**按「是否抛错」来做——按抛错判定会把 `fs` 的 stub 误报成「文件系统可达」。判定必须按**能力**（存在危险 API 才算），这一步已固化进 `probes/escape-probe.js`。

其六的连带实测之二（真机，WebKitGTK）：**各引擎对「给不可写属性赋值」的行为不一致**。上游用 `Object.defineProperty(Error, 'prepareStackTrace', { writable: false, configurable: false })` 把它锁死（探针实测描述符确认），而 V8 下赋值**静默失败**、JavaScriptCore 下抛 `Attempted to assign to readonly property.`——探针的回收向量在真机上因此抛错，看着像脚本崩了，实际是**预期中的拒绝**。两条教训：其一，探针与类似代码对只读属性必须先读描述符、只在可写时才尝试（已固化，自检用例断言结果稳定为「不可写，赋值被拒」）；其二，**宿主级自检（Node 后端）看不见引擎差异**——这类差异只有真机或另一种引擎才会暴露，这正是 1.3 / 1.4 必须实机跑的原因之一。

**兼容面的权威口径（本变更的记录基准）。**

- `pm.require` 可用内置库（9）：`ajv`、`chai`、`cheerio`、`csv-parse/lib/sync`、`lodash`、`moment`、`postman-collection`、`uuid`、`xml2js`
- 同时可用的 Node 模块（11）：`path`、`assert`、`buffer`、`util`、`url`、`punycode`、`querystring`、`string-decoder`、`stream`、`timers`、`events`
- 已弃用但为兼容保留、需要给出告警（4）：`atob`/`btoa`（改用全局方法）、`crypto-js`（改用 Web Crypto）、`tv4`（改用 `ajv`）
- 上游自带一致性测试套件 18 个文件（`test/unit/sandbox-libraries/`，其中 `pm.test.js` 约 83 KB）

**体积。** `postman-sandbox@6.7.4` 解压 5,182,228 B（约 4.94 MiB）/ 44 个文件，大头是 `.cache/bootcode.browser.js` 与 `lib/bundle/index.browser.js` 两个预打包产物。运行时依赖 4 个：`uvm`、`teleport-javascript`、`postman-collection`、`lodash`。

**沙箱不得进入启动模块图（实机确认）。** `postman-sandbox` 与其浏览器 polyfill（`events`/`buffer`/`string_decoder`）一旦被静态 import，就落在启动模块图里；此时 Tauri 的初始化脚本不再生效——`window.__TAURI_INTERNALS__` 不存在，所有 `invoke` 失败，应用整体黑屏。改为动态 `import()`（首次执行脚本时才加载）后客户端恢复正常。实测体积：主包 3,418 kB → **268 kB**，沙箱独立为 3,151 kB 的按需 chunk。这是 `scriptRuntime.ts` 顶部注释记录的结论，也是后续实现的硬约束：**沙箱必须保持动态 import，回归与重构不得改回静态导入**（改回即复现黑屏）。

## Goals / Non-Goals

**Goals:**

- 让导入进来的脚本真正可执行，且**行为**与 Postman 一致到可用上游测试套件验收。
- 把「脚本能做什么」收敛成一条可审计的边界：**唯一出口是宿主桥**，而不是依赖沙箱的删除行为。
- 使「全兼容」有一个可核对、可回归的外部基准，而不是靠主观判断。

**Non-Goals:**

- 不实现集合运行器与数据文件驱动（见 proposal.md — 不做）。`pm.execution.setNextRequest` 在单次发送下无效果，与 Postman 一致。
- 不合并响应预览的隔离与脚本沙箱的隔离。
- 不支持 `pm.require` 的在线注册表导入。
- 不为脚本测试结果与 console 输出建持久化表。
- 不自研 pm 对象或断言库的替代实现。

## Decisions

### D1. 采用 `postman-sandbox` 作为执行内核，不自研 pm 子集

「完整兼容」在工程上等价于「采用 Postman 自己的实现」。理由不是省力，而是兼容面里有**没有通用替代品的自制适配层**：

| 组件 | 作用 | 自研可行性 |
|---|---|---|
| `chai-postman` | Postman fork 的 chai；`pm.response.to.have.jsonSchema` 等断言与**断言失败文案** | 文案属兼容面，自研必然偏差 |
| `liquid-json` | `pm.response.json()` 对非法 JSON 的容错解析 | 行为细节多 |
| `lodash3` | 沙箱内 `_` 是 lodash **3.x**，与 4.x 并存 | 需两个版本共存 |
| `sugar` | 遗留的属性扩展行为 | — |
| `uvm` + `teleport-javascript` | 隔离与跨边界传值 | 这正是「桥」本身 |

*替代方案*：(a) **自研 pm 子集** —— 明确达不到「完整兼容」，且会让用户脚本静默产生错误结果，比不执行更糟，排除；(b) **Node 侧车跑 `postman-runtime`** —— 保真度最高且连运行器都能白拿，但为交付一个 Windows 安装包而引入第二个运行时，代价与「完全离线单机工具」的形态不符，排除；(c) 本方案。

### D2. 沙箱跑在内嵌 webview 内，不引入外部运行时

脚本执行发生在应用的 webview 中（`uvm` 的浏览器后端），网络与存储出口仍全部回落 Rust，因此保住了「前端无网络能力、Rust 是唯一出口」的既有架构：脚本要触达网络或存储，只能经桥回到 Rust。

**CSP 的代价要显式承认（9.1 实测）**：沙箱靠 uniscope 的 eval/Function 编译用户脚本，而 blob Worker 继承文档 CSP——生产 CSP 必须包含 `'unsafe-eval'`，否则**生产构建里所有用户脚本静默失效**（开发 CSP 本就有 unsafe-eval，所以开发期发现不了）。代价是主文档也放开了 eval；缓解靠两层：无远程脚本来源（script-src 'self' + Tauri nonce）、命令面审计——原先列的第三层 `freezePrototype` 已按 **D17** 关闭（它与沙箱宿主侧的运行时不相容）。这条已从「设计前提」升级为审计断言（security_audit 逐指令核对），`tests-browser/worker-csp.spec.ts` 有 eval 的正反对照用例。

注意措辞：「沙箱里没有网络原语」在这里是**纵深**，不是这条结论的依据。依据是桥——见 D3，一旦把删除行为当作依据，沙箱的逃逸面就直接变成数据外发面。

*替代方案*：把 `postman-sandbox` 放进独立 origin 或独立 webview 以获得更强的跨源隔离。留待 D3 的退路讨论。

### D3. 安全边界由「桥」承担，不由 Worker 的同源边界承担

这是本设计最关键的一条。事实是：同源 blob Worker **不是**安全沙箱（上游自述），沙箱的收窄靠 `recreatingTheUniverse()` 的**删除**行为。删除式沙箱历史上被逃逸过，因此：

- **不把「白名单里没有 `fetch`」当作安全承诺的全部**，而是当作一道纵深。
- **真正的边界定为宿主桥**：桥的每个出口都要显式校验与策略约束（D5）。
- **CSP 的 `connect-src` 作为最后一道墙**：即便出现逃逸拿到 `fetch`，也不存在可外发数据的地址。

*前提（已核实，不必再依赖）*：本决策原先依赖「注入的 `window` 是合成对象」。静态核实后该前提解除——`execute.js` 从不读取 `glob.window`，Worker 里也没有 `window` 全局，实际传入的是 `null`（见 Context）。**泄漏路径不存在，不需要为此引入跨源沙箱。**

*退路*：若 1.4 的实机逃逸尝试发现别的回收路径，退路是把 `uvm` 的后端替换为跨源（bootcode 由独立 origin 提供，使 Worker 不与应用同源），代价是额外一套资源与协议。

*替代方案*：一开始就用跨源沙箱。更强的结构边界，但需要自行替换 `uvm` 后端并维护其协议契约，风险与工作量都明显更高；把它留作前提不成立时的退路。

### D4. 兼容面以上游**实现**为准，不以公开文档为准

已发现两处不一致，足以证明文档不能作为验收基准：

- `File` 在 Postman 的沙箱全局文档中列出，但 `uniscope` 白名单里**没有**（上游注释：等 Node < v20 支持终止后再加）。
- `crypto-js` 与 `tv4` 文档标注已弃用，但实现仍保留并需要给出弃用告警。

因此验收基准定为**上游自带的一致性测试套件**（18 个文件）。这也是选 D1 的一个附带收益：测试与实现同源，不会出现「照文档实现却测不过」的错位。

### D5. 桥的每个出口显式校验，不做通用转发

桥要覆盖：响应回填、`pm.sendRequest`、变量读写、密钥、Cookie、测试结果与 console。**`pm.sendRequest` 是危险的出口**——「完整兼容」意味着它默认不限制目标地址（Postman 就是如此）。处理方式是承认它、并把它变成可配置策略，而不是用一个更严的默认值去破坏兼容：

- 默认行为与 Postman 一致（不限制目标）。
- 「脚本可访问的目标」提供可配置策略；命中拒绝时给出可辨识原因。
- 门禁（D6）负责让用户在执行前知道这件事。
- 安全审计新增断言：桥不计入前端的通用网络能力，但断言桥的出口集合是**有限的具名集合**，任何出口的放开都会让测试失败。
- 宿主对 uvm 事件的派发**必须有事件名白名单**。任务 1.2 查明 `uvm` 的 `forwardEmits` 不过滤事件名（见 Context），当前没人能写入只是因为 `__uvm_emit` 已被删除。把「删除了所以安全」当作设计依据，就重复了 D3 要避免的同一个错误。（3.6 已实现：`scriptRuntime.ts` 导出冻结的 `BRIDGE_EVENTS`，宿主只为其中的名字注册分支，9.2 的审计将断言这个集合。）

*替代方案*：默认白名单化。会在用户不知情的情况下让大量既有脚本失败，直接违背「完整兼容」。排除。

### D6. 导入脚本首次执行需确认，粒度按集合

脚本一旦可执行，**导入一份集合就等于装载一个程序**。因此把 roadmap 中「导入脚本首次运行提示」从 P1 提前到本变更，且判定依据是「脚本是否由用户在本应用编写」而非「是否本次导入」——升级前就已导入的集合同样属于导入来源，同样走门禁。

*替代方案*：按请求粒度确认（噪声太大）；导入时一次性确认（用户此刻还没有执行意图，确认缺乏上下文）。

### D7. Cookie Jar 并入本变更，不外包

`pm.cookies` 要做对（域匹配、`jar()`、按 URL 取送）必须有 Cookie Jar，而代码库目前**没有任何 Cookie 存储**（仅有日志脱敏里对 `set-cookie` 的掩码处理）。

原本的判断是把它作为前置依赖外包给另一个变更。改为主张并入：拆开会让 `pm.cookies` 长期停在「要求已声明、行为不可用」的悬空状态——那正是本变更一开始要避免的**半兼容**。代价是新增加一块存储面与一次 schema 迁移；收益是验收闭环。

*替代方案*：单独开一个 `add-cookie-jar` 变更。模块边界更干净，但 `pm.cookies` 的验收要跨两个变更才能完成。

### D8. `pm.visualizer` 复用响应预览的隔离

可视化模板的呈现沿用既有的不可信内容隔离（`sandbox=""` 的 blob iframe，禁脚本）。这样「模板渲染」与「响应预览」共用一个已经过审计的呈现机制。

### D9. 响应预览隔离与脚本沙箱是两条独立边界，不共用开关

`foundation-core` 的 D15 说脚本沙箱「复用同一隔离机制」。实现时要注意两条边界的开关方向**相反**：

```
响应预览   sandbox=""                <- 不授予 allow-scripts（保持现状，审计已断言）
脚本沙箱   执行前删除非白名单全局      <- 必须能执行，但无 I/O 原语
```

把它们当成同一个开关（例如"给预览加上 allow-scripts"）会直接拆掉响应预览的隔离。因此 spec 里专门写了「与响应预览的隔离互不合并」这条场景。

### D10. secret 掩码扩展到 console 输出，复用现有单一脱敏出口

脚本能读到 secret 明文（Postman 语义，必须保留）。新增的可观测通道是脚本 console。既有 `logging.rs` 的 redactor 是「日志输出的单一脱敏点」，console 面板接入同一出口，而不是另写一套匹配逻辑。

### D11. 沿用上游预打包的 bootcode，不自行打包

`postman-sandbox` 的 `npm` 产物里带 `.cache/bootcode.browser.js`。自行打包会改变标准库版本与删除顺序，从而改变行为——这与 D4 的验收基准冲突。因此沿用上游产物，并附第三方许可汇总（bootcode 内打包了 chai、cheerio、ajv、moment、lodash 等多个库）。

### D12. Cookie 的作用域是应用级（按域），不随工作区分区

Cookie 是**目标服务的会话状态**，与「用哪套集合」无关。按工作区分区会导致切换工作区即丢失登录态，与用户预期相反，也与 Postman 不一致（其 cookie jar 按域存在、跨集合共享）。`storage-foundation` 的「本地多工作区」只声明集合与环境互相隔离，未涉及 Cookie，因此不构成冲突。

*替代方案*：按工作区分区。隔离更彻底，但破坏「完整兼容」，并制造「切工作区掉登录态」这类难以解释的行为。

### D13. Cookie 加密落库

Cookie 承载的正是会话凭据，其中 `HttpOnly` 的那些价值最高。`storage-foundation` 的「敏感值不以明文落盘」覆盖的是 secret 变量与被持久化的认证凭据，**不覆盖 Cookie**，因此这里需要一条新的明确决定：Cookie 沿用既有的 AEAD 设施（`secrets`）加密落库。

对兼容性零代价——加密只发生在静态存储层，`pm.cookies` 的读写与界面展示拿到的都是明文，与 Postman 一致。

*替代方案*：明文落库。数据库文件与备份文件都可被直接读取，且本项目已承诺「敏感信息加密」，明文与之直接冲突。

### D14. Cookie 的匹配语义采用成熟实现，不自行实现

域匹配（host-only 与 `Domain` 前缀点）、路径前缀、`Secure`、`HttpOnly`、`Expires`/`Max-Age` 与删除语义的边界情况很多，自研极易出现「能用但不合规」的偏差，而这类偏差只在真实站点上才暴露。技术约束里已写明 `reqwest_cookie_store`，直接采用。

**实测补充（8.3）**：上游的 `CookieStoreMutex` 组装 Cookie 头时不做 RFC 6265 §5.4 排序（按 BTreeMap 字典序），同名不同路径时更泛路径的值会排在更具体的值前面——服务器普遍按出现顺序取第一个，这条偏差会直接改变请求效果。处理：薄包装 `RfcCookieProvider` 实现 reqwest 的提供者接口，**匹配语义仍全部委托 `cookie_store`**，仅在组装头部时按路径长度稳定排序；预览调试信息与实际发送共用同一排序函数。这不是重写匹配逻辑，是对上游缺口的窄修补。

*替代方案*：自研匹配逻辑，引入一类难以测全的偏差。

### D15. 脚本读到 secret 明文；真正的防线不在加密，而在门禁与出口策略

spec 7.3 要求「脚本读取到真实值」——`pm.environment.get('token')` 必须给出明文，否则脚本用它拼出来的认证头就是掩码本身，请求是错的。这是「半兼容」最坏的一种形态。因此选择：把 secret 经既有的 `secretReveal` 揭示后喂进沙箱上下文，**接受明文短暂驻留在前端内存与沙箱上下文中**。

*为什么不选两条替代方案*：

- **沙箱只拿掩码** → 大量既有脚本会静默拿到错误的值并据以发请求，比不执行更糟。
- **揭示后过滤 `pm.sendRequest` 的外发内容** → 躲不过 `console.log` 那条路：掩码是取值匹配，脚本做一次编码变换（`btoa`）就绕过了。这层过滤提供的保护是**虚假的**，而它会让人误以为已经防住了。

*代价要如实承认*：明文驻留只缩小了「谁能在内存里看到」，**没有缩小「脚本能把它送到哪」**。真正起作用的仍是门禁（D6）与 `pm.sendRequest` 的目标策略（D5）。这一条必须写进已知限制，不能让「敏感信息加密」的整体承诺给人错误的安全感。

### D16. 必须显式 polyfill 三个 Node 内置模块，否则产物在浏览器里直接崩

`postman-sandbox` 的**宿主侧**（不是沙箱内）依赖 Node 内置模块：`uvm` 的 `UniversalVM` 继承 `events.EventEmitter`，`postman-collection` 经 iconv-lite 用到 `buffer` 与 `string_decoder`。Vite 默认把这些模块 externalize 成空对象——**构建只给一条警告，不会失败**；产物在运行时以 `Class extends value #<Object> is not a constructor or null` 崩掉，表现为应用整体白屏（`#root` 为空）。从构建日志完全看不出来。

修法是在 `vite.config.ts` 里把三者显式指向浏览器实现（`events` / `buffer` / `string_decoder`），并且**在真实浏览器里加载构建产物做一次冒烟**——只跑 `npm run build` 会漏掉这一类问题。

*替代方案*：把「构建成功」当作「产物可用」。实测证明这条不成立：加 polyfill 之前构建是绿的、产物是坏的；加上之后 `#root` 正常渲染且无控制台错误。

*要注意*：这条决定了本项目的**构建验证方式**——凡涉及脚本运行时的改动，CI 里不能只有 `npm run build`，还得有一次真实浏览器的加载冒烟，否则这类问题会一路带到打包之后。（本轮已把它自动化：`tests-browser/script-runtime.spec.ts` 在真 Chromium 里加载沙箱、执行脚本，并把逃逸探针也跑一遍——浏览器后端是生产实际使用的后端，此前从未被测过。）

### D17. 关闭 `freezePrototype`：Tauri 的冻结原型会让沙箱宿主侧在求值期就崩

**结论**：`tauri.conf.json` 的 `"freezePrototype": true` 与本变更的核心功能**不相容**，必须关闭。这不是偏好问题，是一次可复现的硬冲突——它意味着**脚本功能在真客户端上从未可用**。

机制（每一环都已核实）：Tauri v2 把这条配置实现为在**主文档文档起点注入 `Object.freeze(Object.prototype)`**（`tauri/scripts/freeze_prototype.js`，`scripts/init.js` 里排在第一条，注册时 `for_main_frame_only: true`）。而沙箱**宿主侧**（跑在主文档里的那一半，不是 Worker）打包了 lodash 4.18.1，其 `runInContext()` 引导阶段会把自身方法拷进一个新建的普通对象：

```js
lodash.toString = toString;                                  // 先给自己挂上（函数对象，这一步没问题）
mixin(lodash, function () {
  var source = {};
  baseForOwn(lodash, function (func, methodName) {
    if (!hasOwnProperty.call(lodash.prototype, methodName)) source[methodName] = func;
  });                                                        // 轮到 'toString'：source 没有自有 toString
  return source;
}(), { chain: false });
```

`source` 的 `toString` 沿原型链落到被冻结的 `Object.prototype.toString`（`writable: false`），`[[Set]]` 被拒；而 Vite 产物是 ESM ⇒ **严格模式** ⇒ 不是静默失败，而是抛错：

```text
TypeError: Cannot assign to read only property 'toString' of object '#<Object>'
    at postman-sandbox.js:14404:81   <- source[methodName] = func
    at baseForOwn / at runInContext / …
```

于是整个 `postman-sandbox` chunk **求值失败**，`scriptRuntime.ts` 的 `await import('postman-sandbox')` 直接 reject——用户看到的就是「首次发送带脚本的请求即报错」。

**为什么此前所有测试都没抓到**：冻结只发生在**主文档 realm**（Worker 有自己的 realm，注入不到），而三个测试环境都不带 Tauri 的文档起点注入——`npm test`（Node 后端）、`npm run test:browser`（裸 Chromium）、`npm run test:upstream` 全部通过。这正是 D16 记过的那类「只在真机暴露」的缺口，只是这次的注入项不是 CSP。复现已固化为两条对照命令（见 tasks 9.8）。

**为什么关掉**：
- 关掉后，评测环境与真机重新一致，测试恢复代表性——这是「完整兼容」可验收的前提（D4）。
- 保留它的两条路都不划算。其一，构建期把 lodash 那行拷贝改成 `Object.defineProperty`（或 vendor 一份打补丁的 lodash）：等于给锁定版本的上游打补丁，与 D4「以上游实现为准」相抵，而且冻结会伤到任何 `x.toString = …`、以及任何 `for..in` / `_.assignIn` 式拷贝遇到同名键的写法——3 MB 上游代码里穷举不了，只能靠真机发现下一处。其二，让宿主侧跑在不被冻结的 realm：WebView2 的文档创建期脚本按其文档作用于**顶级文档与子框架**，`sandbox` iframe 也逃不掉，真要成立得跨源——那是 D3 的退路，代价另计（须另开变更）。
- 代价如实记：少一层纵深。它防的是「主文档 realm 里运行的代码污染原型」，而主文档只加载自身产物（`script-src 'self'`，无远程来源），真正的边界是桥与命令面审计（D3 / D5）。`'unsafe-eval'` 的缓解因此由三层降为两层（见 D2）。

**审计要跟着改，且改的是断言口径**：`security_audit.rs` 现在断言 `freezePrototype == true`——那是**按值断言**，不是按不变量断言；它恰好把一条会让沙箱无法加载的配置钉成了「正确」。改为断言真正的不变量：**凡会影响主文档执行环境的注入项（CSP、freezePrototype、未来的同类开关），都必须有自动化用例把它钉住**（由 9.9 落地：浏览器用例从 `tauri.conf.json` 读配置并复现）。这与 9.1 的教训同源——机制没错，是前提过时。

*替代方案*：见上「保留它的两条路」。若将来要换回冻结，前置条件是 9.9 的用例 + 宿主侧运行时 realm 隔离方案一并定下来，不能只改一行配置。

**连带修正的记录（其一已复核完成，2026-09-17，Windows/WebView2 实机）**：其一，1.5 把「静态 import → 黑屏」归因为「Tauri 初始化脚本失效」——**归因已更正**：把沙箱改回静态 import 重建后，真机上应用**启动正常**（`__TAURI_INTERNALS__` 存在、IPC 可用、脚本照常执行，入口 chunk 3,433,553 B）。因此当年的黑屏正是本节机制的另一种表现——**该 chunk 在启动模块图求值期抛错、应用根本没挂载**；动态 import 只是把这次抛错从启动期推迟到首次执行脚本（这也解释了为什么改动态 import 后应用能起来、而脚本仍然全废）。结论随之调整：动态 import 保留，但依据是**体积与纵深**（入口 282 KB vs 3.43 MB，且沙箱不进启动路径），不再是「否则黑屏」；`scriptRuntime.ts` 顶部注释、9.2 的审计说明与 `security_audit.rs` 已同步。真机侧的判据是 `probes/webview2-smoke.mjs` 的**入口 chunk 体积检查**——原先那条「启动阶段有没有请求沙箱 chunk」在静态 import 下**没有区分力**（沙箱被内联进入口，没有那样的 URL），已实测确认并替换。其二（仍待复核）：1.4 里那份 WebKitGTK 探针结论与本节存在时间线冲突——`freezePrototype` 一旦生效，宿主侧根本加载不了、探针不可能跑出结论；要么那次运行早于该配置，要么当时的注入范围不同。

## Risks / Trade-offs

- **[删除式沙箱存在逃逸面]** → 不把删除行为当作唯一防线：桥的出口白名单化（D5）+ CSP `connect-src` 收紧（D3）。由 1.4 在实机上做逃逸尝试；原先担心的 `window` 泄漏这条已排除（见 Context）。
- **[宿主对 uvm 事件不过滤事件名]** → 已核实 `forwardEmits` 只校验沙箱 id 与载荷类型，随后直接 `bridge.emit(...)`。当前不可利用（`__uvm_emit` 在用户脚本运行前已被删除），但这属于「靠删除保平安」。**3.6 已落地缓解**：宿主适配层导出冻结的 `BRIDGE_EVENTS` 协议常量，只为其中的名字注册分支；请求出口逐载荷校验（执行 id 与事件名交叉验证、事件 id 非空），不合格载荷静默忽略。协议外事件名从结构上就不存在处理分支。
- **[脚本 realm 与 Worker 同源同 realm]** → `uniscope` 只做作用域屏蔽，不再引入 realm 边界。因此「被删掉的全局是否真的删干净」是唯一的作用域防线，任何残留引用都直接等价于能力逃逸。这是 1.4 要重点覆盖的方向。
- **[宿主桥成为新的信任边界]** → 桥的出口是有限具名集合，每个出口显式校验；安全审计新增断言，使出口集合的任何扩张都会让测试失败。
- **[secret 掩码是取值匹配，可被编码绕过]** → 脚本 `console.log(btoa(secret))` 之类的变换无法被识别。**承认该限制并写入已知限制，不做"secret 无法从脚本泄漏"的承诺**——真正的防线是门禁（D6）与 `pm.sendRequest` 策略（D5）。
- **[blob Worker 的 CSP 继承（任务 1.3）]** → **Chromium/Blink 侧已实测：会继承。** 证据是 `tests-browser/worker-csp.spec.ts`：正对照（放宽 `connect-src` 与 `script-src`）下 Worker 的 `fetch` 与 `importScripts` 都到达目标；换成从 `tauri.conf.json` 直接读取的应用 CSP 后两者都被拦、目标零请求。WebView2 同属 Blink，结论可沿用。**WebKitGTK 一侧未验**——需要 `libgtk-4-1` 等系统库，本机只能经 `sudo apt-get` 安装（超出工作区）。若该侧不继承，CSP 便不能作为最后一道墙，需改由跨源沙箱承担。
- **[应用 CSP 显式放行 `ipc:` 与 `http://ipc.localhost`]** → 1.3 顺带查明：`connect-src` 包含这两个来源，因此沙箱即使被逃逸，CSP 也**不会**阻止它尝试走 Tauri 的 IPC 入口（`tests-browser/worker-csp.spec.ts` 最后一条用例把这个事实钉住，避免以后被当成「已经被拦住了」）。这把「脚本无法调用后端命令」从「沙箱 + CSP 共同保证」收窄为**只能靠 1.4 的逃逸验证与宿主桥的事件名校验来保证**，因此 1.4 是必过项，不是例行检查。
- **[上游版本锁定]** → 「完整兼容」= 「与 `postman-sandbox@6.7.4` 行为一致」。升级上游等于改变验收基准，需整轮回归（这正是保留上游测试套件的价值）。
- **[引入上游带来已知漏洞，且无法在不放弃锁定的前提下修掉（任务 2.1 发现）]** → 安装后 `npm audit` 报 3 high + 1 moderate：`@faker-js/faker <= 10.4.0`（`helpers.fake` 可被诱导为任意代码执行，GHSA-qxc2-j82w-r537）经 `postman-collection@5.3.1` 传入，另有 `uuid < 11.1.1` 的缓冲区边界检查缺失（GHSA-w5hq-g745-h8pq）。`npm audit fix` 给出的解法是把 `postman-sandbox` **降级到 4.1.1**，与 D1/D4 的「对齐 6.7.4」直接冲突，不可采用。缓解方向有三条，都要落进实现：其一，1.4 的逃逸尝试必须覆盖 `pm.require('postman-collection')` 这条链——它是沙箱内可触达的、带 high 告警的代码路径；其二，宿主适配层不把该依赖用于处理不可信输入（动态变量由既有的 Rust `variables` 引擎解析，不经 `postman-collection` 的替换机制）；其三，把这条列入已知限制，发布说明中写明来源与不可修的原因。
- **[固定的版本组合不会被 npm 自动升级]** → 依赖树被精确锁定（`lodash 4.18.1`、`postman-collection 5.3.1`、`teleport-javascript 1.0.0`、`uvm 4.0.2`），这是 D4 的要求。代价是上游的安全修复不会自动到达，需要按整轮回归的节奏主动评估。
- **[体积]** → 前端产物增加约 5 MiB 解压体积（叠加上四个运行时依赖后更多）。已实测（见 Context）：主包 268 kB，沙箱为 3,151 kB 的按需 chunk，仅首次执行脚本时加载。对桌面应用不构成阻塞。附带收益：启动不再为脚本能力买单。
- **[静态 import 会把沙箱塞进启动包]** → 沙箱及其 polyfill 一旦静态引入，入口 chunk 从约 282 KB 涨到约 3.43 MB，且沙箱代码进入启动路径（纵深上不该如此：启动不需要执行脚本的能力）。防线上是 `scriptRuntime.ts` 的动态 import 与其顶部注释；审计用例断言任何引用该包的 `import` 语句都必须是 `import type`，真机冒烟另断言**入口 chunk < 1 MB**（后者是能真正区分两种形态的判据）。（原先这条写的是「静态 import 会破坏 Tauri 初始化、`__TAURI_INTERNALS__` 缺失、应用黑屏」——2026-09-17 复核更正：那轮黑屏的成因是 `freezePrototype` 冻结原型导致的**求值期抛错**，与静态 import 无关；静态 import 的产物在关掉冻结原型后实机启动、IPC 与脚本执行全部正常，见 D17。）
- **[异步脚本的中止语义]** → 脚本内的 Promise 会让超时与中止变复杂（`uvm` 的 `terminate()` 是粗粒度的销毁）。验收需覆盖「无限循环」与「未结算的 Promise」两类。
- **[升级前的既有集合]** → 脚本由「从不执行」变为「可执行」是可观察的行为变化。门禁判定要覆盖「升级前已导入」的集合，否则会出现静默执行。
- **[Cookie 的自动携带会改变既有请求的实际效果]** → 引入 Cookie Jar 后，之前「不带 Cookie」的请求可能开始携带 Cookie，请求结果因此改变。这不是缺陷（这正是 Cookie Jar 的意义），但属于用户可感知的变化，需要在发布说明中写明，并由「请求调试信息可看到实际发出的头」这一既有要求兜住可观察性。
- **[Cookie 的删除与过期语义只在真实站点上暴露偏差]** → 采用成熟匹配实现（D14），并以真实场景（域前缀、路径、`Secure`、过期与显式删除）覆盖，而非只测"存进去再取出来"。
- **[应用级 Cookie 与工作区隔离的观感冲突]** → 用户可能预期切工作区即隔离 Cookie。界面需明确标注 Cookie 的作用域是应用级、按域共享（D12），避免"数据串了"的误判。

## Migration Plan

- **数据迁移**：schema 从 v2 推进到 v3，新增 Cookie 存储。沿用既有迁移器：迁移前把数据库文件复制到同目录、逐步单事务、成功后才清理备份、失败回滚并保留备份。脚本与变量槽位不变，无数据改写。
- **部署**：新增命令与前端依赖，随应用版本一起发布；无服务端，无灰度。
- **回滚**：移除脚本执行入口即可让脚本回到「脚本是惰性文本」的状态，功能层可退。但**数据层退不回去**——schema 迁移只向前，一旦推进到 v3，旧版本应用不认识 Cookie 表，且 `backup_restore` 会明确拒绝「备份文件版本高于应用支持版本」。这是本项目既有的已知限制，本变更使它第一次真正生效，需要在发布说明中写明。
- **用户可感知的变化**：两处。其一，升级后首次发送带脚本的请求会触达门禁，需要一次确认。其二，请求开始自动携带 Cookie，可能改变既有请求的实际结果。两者都属于有意为之，不做静默处理。

## Open Questions

- 门禁的呈现位置与形态（发送前对话框 / 请求区提示条 / 集合级标记）——不改变行为契约与任务拆分，实现时定。
- 脚本编辑器是否在本变更内提供语法高亮与补全——属界面增强，可延后。
- 测试结果与 console 面板是同一次发送共用一个面板还是按脚本类型分栏——界面细节，实现时定。
