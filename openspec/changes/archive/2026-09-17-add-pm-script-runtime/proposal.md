## Why

`rodemap` 的 MVP/P0 要求「基础 pm 脚本」，验收标准明确要求「`pm.environment`、`pm.globals`、`pm.test`、`pm.response` 可用」与「脚本不能访问 Tauri API、不能直接联网、不能读文件」。当前 `pre_request_script` / `test_script` 已存在于集合、文件夹、请求三层，并经导入导出完整往返；但归档的 `add-postman-io` 把脚本定义为**惰性文本**——存得住、搬得动，就是不执行。

用户从 Postman 搬过来的集合里，恰恰是脚本承载着取号、变量串联与断言。脚本不跑，导入进来的集合就只是「能看不能用」，而这正是本地 API 客户端被采纳的门槛。

现在做这件事的前提已经齐备：变量真值、网络出口、脚本槽位、往返保真都已交付。目标定为**完整兼容**——对齐 `postman-sandbox@6.7.4` 的**实际行为**（而非文档）。半兼容的 pm 运行时会让用户脚本静默产生错误结果，比根本不执行更糟。

## What Changes

- 引入 **pm 脚本运行时**：以 `postman-sandbox@6.7.4`（Apache-2.0）为执行内核，在应用内实现其宿主侧契约，使前置脚本与后置脚本真正执行。
- 新增 **宿主桥**：响应回填、`pm.sendRequest` 转发到 Rust 网络层、变量读写落到对应作用域、`pm.vault` 映射到既有密钥存储、`pm.cookies` 映射到 Cookie Jar、`pm.execution` 与 `pm.iterationData` 按单次请求语义提供、测试结果与 `console` 输出的收集与展示。
- 新增 **Cookie Jar**：作为 `pm.cookies` 与请求自动携带 Cookie 的共同底座——接收响应写入的 Cookie、按域与路径匹配在请求中自动附带、手动管理，并加密落库（引入 schema 迁移 v3）。代码库目前**没有任何 Cookie 存储**，因此 `pm.cookies` 没有底座可用，这块随本变更一起交付。
- 新增 **脚本编辑界面**：请求编辑器的 Scripts / Tests 标签页。当前界面上**没有任何脚本入口**，脚本只能靠导入产生。
- 新增 **测试结果与 console 面板**：`pm.test` 的通过/失败明细，以及脚本运行期间 `console` 输出的展示。
- 修改 **变量作用域契约**：定义脚本经 `pm.*` 读写变量时的作用域归属，并把 secret 掩码边界扩展到脚本可观测的输出通道（脚本能读到明文，但其输出受掩码约束）。
- 收紧 **安全边界**：脚本在「删除全局」后的沙箱内执行，网络与存储原语不在其可用全局之列；脚本对外只有宿主桥这一个出口，且桥的每个出口都受显式校验与策略约束。安全审计新增对应断言。
- 新增 **执行门禁**：脚本可能来自导入的集合，因此脚本在被执行前 SHALL 得到用户确认；`pm.sendRequest` 的目标 SHALL 受可配置策略约束。
- 新增 **依赖**：`postman-sandbox`、`uvm`、`teleport-javascript`、`postman-collection`、`lodash`（Apache-2.0 / MIT）及其内置沙箱标准库进入前端打包产物，并附第三方许可汇总。

**不做**（有意排除，理由见 design.md）：

- **集合运行器与数据文件驱动**。本变更实现脚本侧 API 的完整且正确的行为；`pm.execution.setNextRequest` 在单次发送时本就没有运行器效果（Postman 亦如此），`pm.info.iteration` / `pm.iterationData` 按单次语义取值。跨请求跳转、迭代与数据文件的完整效果属于运行器变更。
- **`pm.require` 的外部注册表导入**（`npm:` / `jsr:` / Postman 团队 Package Library）。这三者都依赖 Postman 的云服务，与「完全离线」直接冲突。只支持内置库清单。
- **非 HTTP 协议下的脚本**（gRPC / GraphQL / WebSocket / SSE）。本变更只覆盖 HTTP 请求的前置与后置脚本。
- **响应预览与脚本沙箱的合并**。两者是相邻但独立的边界，不共用开关。

## Capabilities

### New Capabilities

- `pm-script-runtime`: 定义 pm 脚本运行时的行为契约——前置与后置脚本的执行时机与顺序、`pm.*` 兼容面与沙箱标准库、宿主桥的能力与出口约束、测试断言结果与 console 的收集、脚本超时与错误处置、脚本执行的隔离边界，以及脚本来源的可执行性门禁。
- `cookie-jar`: 定义 Cookie 的接收、匹配、自动附带、手动管理与加密持久化契约，以及脚本经 `pm.cookies` 访问 Cookie 时的可见范围与操作语义。

### Modified Capabilities

- `variable-engine`: 新增「脚本对变量的读写」需求——脚本经 `pm.*` 读写变量时的作用域归属，以及本地作用域写入不落盘；并把 secret 变量的掩码边界从「界面展示与日志输出」扩展到脚本产生的可观测输出。

## Impact

- **代码**：前端新增宿主适配层（实现 `postman-sandbox` 的宿主契约）、脚本编辑标签页、测试结果与 console 面板；Rust 侧新增 Cookie 存储与匹配，并扩展命令面以承接桥的出口（`pm.sendRequest`、变量回写、vault、cookies）。
- **依赖与体积**：`postman-sandbox@6.7.4` 解压约 4.94 MiB / 44 个文件，叠加上四个运行时依赖，前端产物显著增大；需要 `NOTICE` 与第三方许可汇总（bootcode 内打包了 chai、cheerio、ajv、moment、lodash 等多个库）。具体增量待实测。
- **安全边界**：脚本的隔离不再只由「Blob Worker 同源」承担——沙箱会在执行用户代码前沿原型链删除全部非白名单全局，网络与存储原语均不在白名单内。因此新增的信任边界是**宿主桥本身**：桥的每个出口都需要校验，而不是依赖沙箱的删除行为。CSP 的 `connect-src` 需相应收紧，安全审计新增断言。
- **既有承诺的变化**：`pm.sendRequest` 默认不限制目标地址（这是 Postman 的行为，也是「完整兼容」的一部分），因此「导入即装载了一个可外发数据的程序」必须由执行门禁承接，该门禁从 roadmap 的 P1 提前到本变更。
- **兼容性**：不改变任何已发布命令的签名与语义。有三处行为变化需要显式承接，均不得静默发生：已导入集合中的脚本由「从不执行」变为「可执行」（经门禁）；请求开始自动携带 Cookie，可能改变既有请求的实际结果；数据库 schema 推进到 v3，旧版本应用无法读回。
- **数据**：schema 从 v2 迁移到 v3（新增 Cookie 存储）。脚本与变量槽位已存在，脚本测试结果与 console 输出不做持久化。迁移沿用既有的 `user_version` 有序执行器：迁移前备份、逐步单事务、失败不留半迁移状态。
