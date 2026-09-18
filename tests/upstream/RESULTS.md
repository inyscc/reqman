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
| `postman-sandbox/bootstrap.js` | 上游 `test/unit/_bootstrap.js` 把 chai 的 `expect` 与 `sinon` 挂成**宿主侧**全局，用例在 mocha 回调里直接用它们（不是在沙箱脚本字符串里）。那份 bootstrap 自带 describe 块并引用上游内部路径，故不整体搬，只做同一件事。 |
| `--exit` | **必需**。用例跑完后沙箱 worker 不回收，node 进程不退出——不加该参数的表现是「用例早已跑完，命令却一直挂着」，容易被误判为卡死。属上游 harness 的遗留行为，非用法问题。 |

## 结果（2026-09-15）

```
212 passing (31s)
  7 pending        ← 上游自带的 it.skip，例如 pm-require.test.js 的 __module_obj 用例
  2 failing
```

环境：Node **v22.23.2**、mocha **10.8.2**、postman-sandbox **6.7.4**、uvm **4.0.2**、teleport-javascript **1.0.0**。

### 分组明细（分块跑的中间数据，用于定位）

| 分组 | 文件 | 结果 |
|---|---|---|
| 样本 | xml2Json / postman / tv4 / uuid-vendor / lodash3 | 11 passing |
| A | liquid-json / cheerio / ajv / csv-parse / crypto / sugar | 38 passing |
| B+C | moment-min / postman-collection / deprecation / legacy / pm-require / chai-postman | 78 passing |
| pm.test.js | 单文件 87 例 | 85 passing / 2 failing |

合计 11 + 38 + 78 + 85 = **212 passing**，与全量一次跑的数字一致。

## 2 条失败：定位与判断

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

**已排除依赖版本漂移**：实装的 `postman-sandbox 6.7.4` / `uvm 4.0.2` / `teleport-javascript 1.0.0` 与上游 `package.json` 声明**完全一致**。所以不是「装的版本不对」。

**最可能成因**：`Error` 跨 worker 边界的序列化差异随 Node 版本变化（本地 Node 22，上游 CI 的 Node 更早），落在 host→sandbox 的参数编解码上，属**环境层**差异。

**对本变更的影响：无。** 两条路径都属 vault / datasets——本变更**不实现**这两个能力（`BRIDGE_EVENTS` 只登记 `console` / `execution.assertion` / `execution.request.<id>`，见任务 3.6），也没有用户脚本入口能触达它们。判定为「记录并接受」，不作阻塞项。

**若将来要追到底**：写最小复现——`context.execute` 前后各 `dispatch` 一个 `Error`，打印沙箱侧实收载荷；再换 Node 20 / 18 各跑一次对比。工作量大于收益（不涉及本产品路径），暂不做。

## 与「我们自己的测试」的分工

| 层 | 文件 | 验什么 |
|---|---|---|
| 上游基线 | 本目录 18 个文件 | 沙箱语义的参照系 |
| 宿主边界 | `tests/bridge-protocol.test.ts`（4 例，假沙箱） | 事件名白名单、载荷校验、伪造载荷被忽略 |
| 宿主行为 | `tests/script-phase.test.ts`（16 例，真沙箱） | 作用域读写与写回、console/assertion、执行门禁 |
