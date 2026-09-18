# 实机探针：任务 1.3 与 1.4

这两项**只能在真实客户端里完成**，自动化测试覆盖不到（`npm test` / `cargo test` / Playwright Chromium
都在别的引擎或别的上下文里跑）。这里给出可直接粘贴运行的探针，以及「看到什么算什么结论」的对照表。

在动手之前，先明确两件事：

- **1.4 是必过项，不是例行检查。** 1.3 已查明应用 CSP 显式放行 `ipc:` 与 `http://ipc.localhost`，
  因此「脚本无法调用后端命令」不能靠 CSP 保证；它只能靠「沙箱内没有原语」＋「宿主桥的事件名校验」
  来保证。任一条逃逸路径成立，都必须先修掉才能继续。
- **1.3 的 WebKitGTK 一侧是环境受限项。** Chromium/Blink 侧已证「会继承」
  （`tests-browser/worker-csp.spec.ts`）。WebKitGTK 侧在 Linux 上未验——Playwright WebKit 需要
  额外系统库（`libgtk-4-1`、`libgstreamer-plugins-bad1.0-0`、`flite1` 等），本机只能经
  `sudo apt-get` 安装。这个缺口已写入 README 的「已知限制」。下面这个探针是为了**不必装库也能拿到结论**
  ——它跑在真实 WebKitGTK 里。

---

## 一、1.4 沙箱逃逸探针

**准备**：`npm run tauri dev` 起客户端，随便建一条请求（地址不重要，比如 `https://api.test/users`）。

**运行**：把 `escape-probe.js` 整段粘进该请求的**「脚本 → 前置脚本」**编辑区，点发送。

**看哪里**：右侧「响应 → 脚本」标签页。会有一条 `ESCAPE-PROBE {...}` 的 console 输出，以及四条断言。
请求本身失败不影响结果——前置脚本的输出在请求失败时同样会呈现。

**跑两遍**：

| 运行 | 设置里的「脚本目标策略」 | 意义 |
|---|---|---|
| **A** | 未配置（默认 = 不限制，与 Postman 一致） | 记录「没有任何策略时脚本能走到哪一步」 |
| **B** | 已配置且只放行一个无关目标（如 `{"mode":"allow","hosts":["api.test"]}`） | 记录「策略生效后哪些路径被挡住」 |

**逐项判读**：

| 探针项 | 预期（A 与 B 都应如此） | 若不符 |
|---|---|---|
| `primitives` | `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`importScripts`/`Worker`/`indexedDB`/`caches`/`localStorage`/`document`/`navigator`/`location`/`window`/`self`/`globalThis` 全部 `undefined` 或 `THROWS`（引用不存在的全局是抛错，两种都算通过） | 有任一项是 `function`/`object` → **逃逸面成立，停下修** |
| 断言「沙箱内没有联网 / 存储 / Worker 原语」 | 通过 | 同上 |
| `recovery`（8 个向量：`Function('return this')`、各类 `.constructor.constructor`、`prepareStackTrace → getThis`、`arguments.callee` …） | 全部 `THROWS` 或 `no-fetch`；其中 `prepareStackTrace → getThis` 稳定为 **`不可写，赋值被拒（writable=false configurable=false）`**——上游用 `Object.defineProperty` 把该属性锁死了，写不进去正是预期结果 | 出现 `LEAKS fetch` → **回收路径成立，停下修**（这正是 design D3 的退路触发条件：改用跨源沙箱） |
| 断言「回收全局对象的向量都不成立」 | 通过 | 同上 |
| `modules` 里 `http`/`https`/`net`/`fs`/`node:fs`/`child_process`/`worker_threads` | 两种引入方式要么 `THROWS`，要么是 `stub（无危险 API）`。**注意别被 stub 骗了**：`fs` / `path` 能 require 到对象，但里面没有 `readFileSync` 之类（实测），按「是否抛错」判定会得到假阳性——判定必须按**能力** | 出现 `CAPABLE: …` → **停下修** |
| 断言「网络与文件系统模块没有可达能力（stub 不算）」 | 通过 | 同上 |
| `fsAttempt`（真的读一次 `/etc/hostname`） | `no readFileSync on module` 或 `THROWS: …` | 出现 `READ: …` → **文件系统可达，停下修** |
| 断言「读文件尝试失败」 | 通过 | 同上 |
| `requireAlias` | `true`（宿主补的 `pm.require` 别名与全局 `require` 同源） | `false` 且脚本里用了 `pm.require` → 记录，见 4.1 |
| `faker`（`postman-collection`、`@faker-js/faker`） | **只记录，不判定**。若 `LOADED` 且 `fake_callable` 为真，即命中了 2.1 的 high 告警路径（GHSA-qxc2-j82w-r537） | 记录到已知限制即可；**除非**它成为新的逃逸跳板 |
| `ipc['http://ipc.localhost/']` | A：多半是连接/DNS 失败（该入口由 webview 内部处理，不经普通 HTTP 客户端）；B：被桥拒绝并给出「不在允许范围内」 | 若**返回 200 且 body 像命令结果** → 严重，停下排查 |
| `ipc['http://probe.invalid/']` | A：失败（DNS）；B：被桥拒绝 | B 里若真发出去 → **策略失效，停下修** |

> A 组里「远程目标尝试失败」**不构成安全结论**——失败原因可能是 DNS。真正的结论在 B 组：策略配置后
> 请求必须在**桥的出口**就被拒（报错文本含「不在允许范围内」），而不是发出去再失败。

**这条探针已经跑过一遍**：`tests/script-phase.test.ts` 的「实机探针自检（1.4）」把探针原文喂进真沙箱
（`uvm` 的 **Node 后端**），断言四条判定全过、报告是可解析 JSON。它证明的是「探针可用、判定标准正确」，
**不能**替代 WebKitGTK 上的实机结论——两者后端不同（`worker_threads` vs blob Worker）。

---

## 二、1.3 blob Worker 的 CSP 继承探针（WebKitGTK）

**准备**：`npm run tauri dev` 起客户端。

**运行**：在应用窗口里打开 devtools（右键 → 检查元素），把 `worker-csp-probe.js` 整段粘进 Console 回车。

**看哪里**：Console 里以 `CSP-PROBE` 开头的对象。同时看一眼 Network 面板里**文档请求的响应头**
是否带 `content-security-policy`（devtools 的 `cspHeader` 字段只能看到 meta，Tauri 是走响应头注入的）。

**逐项判读**：

| 观测 | 结论 |
|---|---|
| `results.sameOriginFetch` = `ok ...` | 正对照成立：worker 有网络。**这一项失败则整轮无效**，需换到能联网的环境重跑 |
| `results.remoteFetch` 失败 **且** `violations` 里有 `connect-src` | **继承成立** —— CSP 可以作为「最后一道墙」 |
| `results.remoteImportScripts` 失败 **且** `violations` 里有 `script-src` | 同上（`script-src` 侧） |
| `results.nestedBlobWorker` = `created: nested-ok` | `worker-src 'self' blob:` 生效：blob Worker 可再建 Worker（与 Blink 侧一致） |
| `violations` 为空、失败原因看不出 CSP 字样 | **无法判定**——记「未验证」，不要写成「不继承」 |
| 远程 fetch / importScripts **成功到达** | **不继承** —— CSP 不能作为最后一道墙，需按 design D3 的退路改用跨源沙箱（对本变更是重大结论，先别继续） |

> dev 构建即可回答「是否继承」：`devCsp` 与生产 CSP 对**远程**的 `connect-src`/`script-src` 都是拒绝的
> （差别只在 dev 额外放行 `localhost:1420` 的 ws/http）。若要复验**生产** CSP 的完整取值，
> 先 `npm run tauri build` 再用构建产物跑一次同样的探针。

---

## 三、WebView2 实机冒烟（任务 10.4，可重复执行）

上面两份探针是「粘进界面里手跑」。这一份把同样的核对**自动化**了：它自己起一个本地目标服务、
拉起**构建产物**、用 CDP 连进 WebView2，然后走真实界面把请求发出去——跑完即得结论，不用手点。

```bash
npm install
npm run tauri build                                   # 产物：src-tauri/target/release/reqman.exe
node openspec/changes/add-pm-script-runtime/probes/webview2-smoke.mjs
node openspec/changes/add-pm-script-runtime/probes/webview2-smoke.mjs --escape    # 含 1.4 的 A/B 两轮
node openspec/changes/add-pm-script-runtime/probes/webview2-smoke.mjs --cleanup   # 清历史遗留的空集合
```

它核对：①9.8 的落地（真机主文档未被冻结，即 D17 的实机复验）；②启动模块图不含沙箱 chunk（9.2 的
真机对照）；③1.3 的 CSP 继承（跑 `worker-csp-probe.js` 原文）；④端到端——建集合 → 建请求 →
填前后置脚本 → 保存 → 发送 → 「脚本」标签页里出现前置/后置的 console 与断言明细；
⑤`--escape` 时跑 1.4 的逃逸探针：**A 轮**未配置策略、**B 轮**临时把策略收紧为 `allow api.test`
并在跑完后恢复为不限制（若检测到用户已配置策略，则只按当前配置跑一轮、不改动你的设置）。

两条使用须知：

- **它会动应用数据，但跑完不留痕**：新建一个集合（名字固定是「新集合」）并在其中建一条请求，
  收尾时把**请求与集合都删掉**——集合靠「创建前后的 id 差集」定位，不靠名字（名字会与既有集合重名）。
  历史遗留的空集合用 `--cleanup` 清：它只删**同时**满足「名为新集合 + 没有任何子项 + 集合级前后置脚本为空」
  的集合，用户自己的集合通常带着脚本，不会被碰（脚本会打印删了哪些、留了哪些及原因）。
  既有集合的**集合级脚本会先于本请求的脚本执行**，所以 console 里可能出现不相干的行——
  脚本会把它们原样打印，不做过滤。
- **CDP 由 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 打开**（WebView2 运行时的官方开关），
  只作用于本次进程，不写配置也不碰注册表，因此它既能冒烟 release 产物，也不改变产品行为。

---

## 四、结果记录（跑完把这张表贴回来，我落档到 tasks.md 与 design）

### 1.4

| 项 | A（未配置策略） | B（策略 allow api.test） |
|---|---|---|
| 客户端 / 引擎 | | |
| 三条断言 | | |
| `postman-collection` | | |
| `@faker-js/faker` | | |
| `http://ipc.localhost/` | | |
| `http://probe.invalid/` | | |
| 有无 `LEAKS` / `LOADED` | | |

### 1.3

| 项 | 观测 |
|---|---|
| 客户端 / 引擎（Linux + WebKitGTK 版本号） | |
| 文档响应头里的 CSP | |
| `sameOriginFetch` | |
| `remoteFetch` | |
| `remoteImportScripts` | |
| `violations` | |
| `nestedBlobWorker` | |
| 结论（继承 / 不继承 / 无法判定） | |
