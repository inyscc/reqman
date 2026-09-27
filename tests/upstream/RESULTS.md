# 上游 postman-sandbox 用例集：本地基线结果

对应任务 **4.5 / 10.2**（`openspec/changes/add-pm-script-runtime/tasks.md`）。

## 这是什么，不是什么

- **是**：`postman-sandbox@6.7.4` 自带的 `test/unit/sandbox-libraries/` 全部 **18 个文件**、**原样拷贝**到 `tests/upstream/postman-sandbox/test/` 后，在本地跑出的结果。来源、版本与许可证见同目录 `NOTICE`。
- **不是**：对宿主实现（`src/lib/scriptRuntime.ts`）的验证。用例经 `index.js` 转发到 npm 实装的**上游包本身**，全程不经过我们的桥。
- **用途**：校准「上游语义基线」。宿主适配层与沙箱交互出现差异时，先用它判断是「上游本来如此」还是「我们改坏了」。

## 怎么跑

```bash
npm run test:upstream
```

等价于：

```bash
mocha --exit --require ./tests/upstream/postman-sandbox/bootstrap.js \
  "tests/upstream/postman-sandbox/test/unit/sandbox-libraries/*.test.js"
```

两处本地新增（均非上游文件）：

| 项 | 为什么需要 |
|---|---|
| `postman-sandbox/bootstrap.js` | 上游 `test/unit/_bootstrap.js` 把 chai 的 `expect` 与 `sinon` 挂成**宿主侧**全局，用例在 mocha 回调里直接用它们（不是在沙箱脚本字符串里）。那份 bootstrap 自带 describe 块并引用上游内部路径，故不整体搬，只做同一件事。另含一份按标题跳过的清单，见下节。 |
| `--exit` | **必需**。用例跑完后沙箱 worker 不回收，node 进程不退出——不加该参数的表现是「用例早已跑完，命令却一直挂着」，容易被误判为卡死。属上游 harness 的遗留行为，非用法问题。 |

## 结果（2026-09-27）

```
212 passing (58s)
  9 pending        ← 上游自带的 it.skip 7 条（例如 pm-require.test.js 的 __module_obj 用例）
                      + 本地跳过的 2 条（见下节）
  0 failing
```

环境：Node **v24.21.0**、mocha **10.8.2**、postman-sandbox **6.7.4**、uvm **4.0.2**、teleport-javascript **1.0.0**。

### 分组明细（2026-09-15 分块跑的中间数据，用于定位）

| 分组 | 文件 | 结果 |
|---|---|---|
| 样本 | xml2Json / postman / tv4 / uuid-vendor / lodash3 | 11 passing |
| A | liquid-json / cheerio / ajv / csv-parse / crypto / sugar | 38 passing |
| B+C | moment-min / postman-collection / deprecation / legacy / pm-require / chai-postman | 78 passing |
| pm.test.js | 单文件 87 例 | 85 passing / 2 跳过 |

合计 11 + 38 + 78 + 85 = **212 passing**，与全量一次跑的数字一致。

## 2 条跳过：Node 后端的 Error 编解码（2026-09-27 定案）

两条同一形态——**宿主向沙箱 `dispatch` 一个 `Error` 后，沙箱回抛的 `execution.error` 里 `message` 变成 `"[object Object]"`**：

```
sandbox library - pm api  vault
  should trigger `execution.error` event if pm.vault.<operation> promise rejects
  expected { type: 'Error', name: 'Error', …(1) } to have property 'message'
  of 'Vault access denied', but got '[object Object]'
  at pm.test.js:374

sandbox library - pm api  datasets
  should trigger `execution.error` event if pm.datasets promise rejects
  expected … 'Dataset not found', but got '[object Object]'
  at pm.test.js:737
```

用例做的事：注册 `execution.vault.<id>` 处理器 → 处理器 `context.dispatch(..., new Error('Vault access denied'))` → 断言沙箱回抛的 `execution.error` 载荷第二个参数带 `message`。

**根因（实测，不再是推测）**：`postman-sandbox@6.7.4` **精确依赖** `teleport-javascript@1.0.0`，uvm 的 Node 后端用它做宿主 ↔ worker 的参数编解码。这个版本的 teleport **不携带 `Error` 的内容**：

```
teleport.stringify([new Error('Vault access denied')])  ===  '[["1"],{}]'
teleport.parse(...)[0].message                          ===  undefined
```

宿主 dispatch 过去的因此是一个空对象，沙箱回抛时 `String(err)` 就成了 `'[object Object]'`。端到端复现（直接 `sandbox.createContext` + `dispatch(new Error(...))`，不经过本仓库任何代码）实测拿到 `{type:'Error',name:'Error',message:'[object Object]'}`——与上面两条失败完全一致。

★ 2026-09-15 那次记录把成因写成「Node 版本差异」；现在可以收窄为**这一对依赖组合本身的缺陷**，与 Node 版本无关：`stringify` 的结果里 `Error` 只剩类型标记、内容为空。

**为什么上游能过**：浏览器后端走 `postMessage` 的**结构化克隆**，`Error` 的 `message` 本来就跨得过去；这两条用例是按那个后端写的。也就是说，这是**测试环境（Node 后端）特有的差异，不是产品行为差异**——产品跑在 WebView 的 Worker 上，且桥的载荷里不含 `Error`（`BRIDGE_EVENTS` 全是普通对象与字符串）。

**处理**：在 `postman-sandbox/bootstrap.js` 里用 mocha 的 root hook（`exports.mochaHooks.beforeEach`）按标题跳过这 2 条，**上游文件保持原样**，跳过清单与原因都写在那个本地文件里。

**不"修好"它的理由**：worker 一侧的编解码在 uvm 的 worker 内部 `require` 自己的模块实例，从 bootstrap 打不到；要让它真通过只能改上游源码或 `node_modules`，代价大于收益。

**对本产品的影响：无。** 两条路径都属 vault / datasets——产品不实现这两个能力，也没有用户脚本入口能触达它们。

**若将来要追到底**：等上游升级 teleport（或换掉 uvm 的 Node 后端编解码），再把这两条从跳过清单里移出。

## 与「我们自己的测试」的分工

| 层 | 文件 | 验什么 |
|---|---|---|
| 上游基线 | 本目录 18 个文件 | 沙箱语义的参照系 |
| 宿主边界 | `tests/bridge-protocol.test.ts` | 事件名白名单、载荷校验、伪造载荷被忽略 |
| 宿主行为 | `tests/script-phase.test.ts` | 作用域读写与写回、console / assertion、执行门禁、`pm.request` / `pm.response` 的填充、脚本内请求的变量解析、中止后的落库 |
