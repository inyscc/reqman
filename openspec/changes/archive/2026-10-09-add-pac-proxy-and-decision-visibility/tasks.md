# Tasks

## 1. 依赖与可行性（先落地引擎，再写求值逻辑）

- [x] 1.1 按 design D2 实测并选定 JS 引擎：以最小特性面把引擎加入 `src-tauri/Cargo.toml`（首选 `boa_engine`，`default-features = false`，只留 `js`，避开 `intl` / `intl_bundled` / `temporal`），验证 `cd src-tauri && cargo build --lib` 与 `cargo test --lib` 通过、依赖树里没有引入 `icu_*` / `temporal_rs`（`cargo tree -i icu_provider` 报无匹配），并记录产物体积与编译耗时
- [x] 1.2 若 1.1 不可接受（特性组合装不上、体积或编译时间超预算），按 design D2 的梯子回退到 `rquickjs` 或 `quick-js`；无论走哪条，把最终选择、实测数据与否决理由写回 `design.md` 的 D2，验证 `openspec validate add-pac-proxy-and-decision-visibility --strict` 仍通过

## 2. 系统代理的实际读取与「直连即直连」

- [x] 2.1 把平台读取隔离成可注入的代理配置来源（design D8）：Windows 读注册表 `Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride` / `AutoConfigURL`，其余平台维持环境变量语义；验证 注入式单测断言「注册表有静态代理而环境变量为空」时来源给出静态代理，且既有 `net/proxy.rs` 的环境变量单测全部仍绿
- [x] 2.2 `build_client` 在决定为直连时调用 `.no_proxy()`（design D7）；验证 在设置 `HTTP_PROXY` 的进程里对一个本地测试服务器发请求，断言 `raw_first_line` 是直连形态（`testutil.rs` 记录的正是这个字段），覆盖 spec「直连不落回隐式代理」
- [x] 2.3 「跟随系统」改为消费 2.1 的来源，静态代理配置生效；验证 注入一个静态代理并把本地 `TestServer` 当作代理，断言请求经它发出（`raw_first_line` 为代理形态），覆盖 spec「跟随系统读的是操作系统配置而非环境变量」

## 3. 代理决定的投影与传递

- [x] 3.1 定义不含凭据的决定投影与原因枚举（design D5）：生效层级、生效模式、结果（直连 / 经 `<地址>`）、原因（未配置顺位 / 该层声明直连 / 命中白名单 / 取自系统配置 / PAC 取得 / PAC 降级）；验证 单测断言对带凭据的代理配置，投影中只出现地址不出现凭据，覆盖 spec「决定中不含凭据」
- [x] 3.2 在 `send_request` 里求解一次并挂到成功路径（`ResponsePayload` 新增字段）（design D6）；验证 `net/tests.rs` 断言决定与实走路径一致——经代理时层级与地址对得上，命中白名单时为直连，覆盖 spec「成功时决定可见」「决定说明原因」「直连被显式呈现」
- [x] 3.3 把同一份决定挂到失败路径：`AppError` 的手写 `Serialize`（`error.rs`）扩展可选字段，前端 `AppError` 接口同步加可选字段；验证 后端单测断言失败时的错误载荷带决定，前端单测断言 `describeError` 仍然给出 `{code, message}` 且决定可读，覆盖 spec「失败时决定同样可见」
- [x] 3.4 代理决定进入日志前经过脱敏出口；验证 断言日志行里不出现代理凭据，与既有 `logging.rs` 的脱敏单测同一形态

## 4. 连接建立超时可区分

- [x] 4.1 新增 `ErrorCode::ConnectionTimedOut` 并按最内层 OS 错误码判定（Windows `10060`、Linux `ETIMEDOUT` = `110`），与既有 DNS（`11001..=11004` / 负 `EAI_*`）和连接被拒（`111` / `10061`）的判定并列；验证 单测覆盖 `10060`、`110` 归入新类别，`10061`、`111` 仍归连接被拒，`11001` 仍归 DNS，覆盖 spec「与连接被拒绝可区分」
- [x] 4.2 消息在本次决定为直连时陈述「本次未经代理」并保留底层原始文本，经代理时不作该陈述；验证 单测覆盖两条分支，断言保留原始文本且不出现对成因的断言，覆盖 spec「直连时消息陈述该事实」「经代理时不作该陈述」

## 5. PAC 求值

- [x] 5.1 受限求值环境与 helper 集（design D3）：把 `isPlainHostName` / `dnsDomainIs` / `localHostOrDomainIs` / `isResolvable` / `isInNet` / `dnsResolve` / `myIpAddress` / `dnsDomainLevels` / `shExpMatch` / `weekdayRange` / `timeRange` / `alert` 注入为全局（12 个）；**`dateRange` 经确认的取舍不实现**——它在规范里有多达十种参数形式、各实现语义并不一致，写一个"看起来对"的版本比不写更危险；用到它的 PAC 会在求值时抛错，从而落到"按直连降级且决定中可见"（README 那条记在 6.3）。验证 单测断言被求值的脚本够不到宿主对象、够不到网络与文件，且各 helper 的语义正确（`shExpMatch` 的通配、`isInNet` 的网段、`dnsDomainIs` 的后缀），覆盖 spec「被求值的代码够不着宿主能力」
- [x] 5.2 结果解析与降级链：`DIRECT` / `PROXY` / `SOCKS` / `SOCKS4` / `SOCKS5` / `HTTPS`，以及 `;` 分隔的依序尝试；验证 单测覆盖每种形态与降级顺序（首选不可用时用后继项），覆盖 spec「PAC 返回单个代理」「PAC 返回直连」「降级链依序尝试」
- [x] 5.3 PAC 拉取直连、内存缓存 + TTL、拉取失败沿用上一次成功副本、从未成功则按直连降级（design D4）；验证 用本地 `TestServer` 提供 PAC 正文，断言短时间内重复发送只拉取一次、拉取失败后仍按上次副本求值、无副本时按直连继续且决定写明降级，覆盖 spec「PAC 拉取失败按直连继续」
- [x] 5.4 求值限额：wall-clock 上限、返回值长度与形态校验、`dnsResolve` 一类带超时与求值内缓存且失败按规范语义回落；验证 单测断言死循环的 `FindProxyForURL` 在规定时间内被中止并按直连降级，且解析失败不让整次求值失败，覆盖 spec「死循环不挂起应用」「求值抛错按直连继续」
- [x] 5.5 边界收紧：结果地址剔除 `user:pass@`，PAC 正文不进日志；验证 断言日志中既不出现 PAC 正文也不出现结果里的凭据，覆盖 spec「PAC 正文不进日志」「结果地址中的凭据不外泄」
- [x] 5.6 接入求解：`ProxyConfig` 新增 PAC 模式与 PAC 地址字段，`AutoConfigURL` 与显式 PAC 地址归一成同一种来源走同一求值器，显式配置优先；验证 后端单测断言两种来源走同一路径、显式配置优先、无 PAC 地址时该模式按未配置顺位，覆盖 spec「显式 PAC 覆盖系统配置」「系统配置为 PAC 时按其求值」「同一份 PAC 对不同目标给出不同结果」
- [x] 5.7 有界逐跳重试（design D11，spec「降级链依序尝试」）：发送路径按跳表逐跳尝试，连接阶段失败就换下一跳；**正文不可重放时只试第一跳**（含文件的多段表单与二进制是一次性句柄）；超时按整次发送计；每跳都与取消令牌竞争；拿到响应即停止换跳；实际走的那一跳才是决定里呈现的那一跳。验证 本机起两个代理服务器：首选不可用时请求经后继项发出、决定呈现的是实际走的那一跳；首选可用时不碰后继项（`net/tests.rs` 的 `a_pac_chain_is_walked_hop_by_hop`）

## 6. 界面与文档

- [x] 6.1 代理设置的「PAC 文件」模式与 PAC 地址项（`ProxyConfigRows.tsx`、`src/lib/types.ts`，三个层级共用同一组件）；验证 前端单测断言选中 PAC 模式后出现 PAC 地址项、且认证用户名/密码/凭据状态/白名单项都不出现，覆盖 spec「PAC 文件模式出现 PAC 地址项」「PAC 文件模式不出现凭据项」
- [x] 6.2 响应区呈现代理决定：直连显式写明、经代理给出地址、降级写明、失败时同样出现，且归属到产生它的那条请求；验证 浏览器用例覆盖直连 / 经代理 / 降级三个呈现与「失败时仍在」，覆盖 spec「响应区的代理决定」全部场景
- [x] 6.3 更新 README 的「已知限制」：PAC 的支持范围（含未实现的 helper 会如何降级）、「不使用代理」的直连语义变更、内网真实 PAC 未纳入验收；验证 照文档描述的步骤在本机能复现「直连不落回环境变量代理」这一条

## 7. 集成验收

- [x] 7.1 端到端：本机同时起「提供 PAC 的测试服务器」与「充当代理的测试服务器」，让系统配置来源注入该 PAC 地址，断言请求经 PAC 指定的代理发出、代理决定呈现的层级与地址与实际一致（`net/tests.rs` 的 `the_system_pac_can_send_the_request_through_a_proxy`）
- [x] 7.2 端到端：PAC 地址不可达时，断言请求仍直连发出且代理决定写明该降级（应用不呈现为失败）——由 `net/tests.rs` 的 `an_unreachable_pac_continues_directly_and_says_so` 覆盖（真起 PAC 服务器与目标服务器，走完整发送路径）
- [x] 7.3 全量检查：`npm test`、`cd src-tauri && cargo test --lib`、`npx tsc --noEmit`、`npm run test:browser` 全绿，且 `openspec validate add-pac-proxy-and-decision-visibility --strict` 通过

## Workflow follow-up

- 走 `/opsx:apply` 实施本变更。
- 按项目的评审要求完成后归档本变更。
- 归档后确认 `openspec/specs/http-engine/spec.md` 与 `openspec/specs/ui-layout/spec.md` 已并入本次增量。
