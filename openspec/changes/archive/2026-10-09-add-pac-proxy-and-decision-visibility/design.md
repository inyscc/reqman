# Design

## Context

动机见 `proposal.md`；行为契约见本变更的 `specs/http-engine/spec.md` 与 `specs/ui-layout/spec.md`。这里只记决定这件事所依据的现状与约束。

**代理求解现状**：`net/proxy.rs` 把三层配置求解成唯一生效的一份（`resolve_proxy_for_request`，`proxy.rs:125`）并解出明文凭据，`decide`（`proxy.rs:148`）结合目标主机与系统设置得出 `ProxyDecision::{Direct, Use}`，`build_client`（`net/mod.rs:571`）据此挂载代理。`SystemProxyEnv::from_env()`（`proxy.rs:22`）只读 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`。

**reqwest 一侧**：`Cargo.toml:28` 以 `default-features = false` 构建，`system-proxy`（= `hyper-util/client-proxy-system`）不在特性表里，因此 hyper-util 里读 Windows 注册表的那段实现（`matcher.rs:245`，函数体在 `matcher.rs:665`）不参与编译；且它只读 `ProxyEnable` / `ProxyServer` / `ProxyOverride`，从不看 `AutoConfigURL`。reqwest 的 `auto_sys_proxy` 默认 true（`client.rs:309`），只有挂过显式代理才会被关掉（`client.rs:1416`）——所以今天 `Direct` 的实际含义是"若环境变量有代理则走它"。

**可见性现状**：`ResponsePayload.via_proxy` 是布尔（`net/mod.rs:144`），`RequestPreview.proxy_url` 只取请求级手工代理的地址（`variables/mod.rs:599`）——两者都不是真实生效的那一份。

**失败路径**：错误统一是 `AppError { code, message }`，其 `Serialize` 是手写实现（`error.rs:141`）；前端 `describeError`（`commands.ts:255`）对已是 AppError 形态的值**原样返回同一个对象**。

**测试基建**：`testutil.rs` 的 `TestServer` 自带本地 HTTP 服务器并记录 `raw_first_line`——它的注释写明"用于判断请求是直连形态还是代理形态"；HTTPS 测试服务器用 `rcgen` 现场签证书，不依赖机器上装了什么。

**依赖源**：`crates-io` 被替换为镜像 `rsproxy-sparse`，因此 `cargo search` / `cargo info` 都不可用（会以 "crates-io is replaced with non-remote-registry source" 拒绝）。直接查 sparse 索引实测结果：`boa_engine` 可取得，最高 **0.22.0**（共 13 个版本）；`rquickjs` 最高 0.14.0（43 个版本）；`quick-js` 最高 0.4.1（14 个版本）；`duktape` 只有 0.0.x，不可用。

## Goals / Non-Goals

**Goals:**

- 「跟随系统」名副其实：Windows 上读操作系统配置，并且能处理配置指向 PAC 的情形。
- PAC 的求值、helper、降级链与缓存刷新都在后端完成，且求值环境受限。
- 每一次发送都有一条可读的代理决定，**成功与失败都能拿到**。
- 连接建立超时可与其它失败区分，并且这类失败的消息能指出"本次是直连"这一事实。
- 决定为直连时，请求真的直连。

**Non-Goals:**

- WPAD / DHCP 自动发现、PAC 内容的跨重启持久化、代理失败后的自动重试与故障转移、PAC 自定义扩展函数。
- **把 PAC 求值放到前端**——理由见 D1。
- 重新设计既有三层代理的求解与凭据保护（本次只扩展系统层的来源与新增 PAC 模式）。

## Decisions

### D1. PAC 求值在后端，不复用前端既有的 `postman-sandbox`

前端已经有一个 JS 运行时（`postman-sandbox`）。考虑过的备选是：后端只负责把 PAC 文本取回来，交给前端沙箱求值，再把结果回传。**否掉**，两条理由：(a) 随机请求由**后端**挂载代理，若由渲染进程给出"这次走哪个代理"，一个被攻破的渲染进程就能指定 `DIRECT`，`http-engine`「网络访问边界」所要求的"请求绕不过后端的代理配置"随之失效；(b) PAC helper 里 `dnsResolve` / `isResolvable` / `myIpAddress` 需要真实 DNS 与本机地址，前端够不着，仍需绕回后端。前后端各留一半求值逻辑是最差的分法。

### D2. 引擎选 `boa_engine`，并关掉 `intl` / `temporal`

纯 Rust，不新增工具链；本机与 Windows CI 都不需要额外的 C 构建步骤（QuickJS 那一族需要，虽然本项目已因 bundled SQLite 有 C 编译器）。

实测 `boa_engine` 0.22.0 的特性面后，定为 `default-features = false` 且**不加任何特性**。实施期的实测纠正了规划期的三处假设：

1. 「只留 `js`」这一表述有误：`js` 是 wasm 目标用的弱特性（其定义只是 `dep:web-time` / `dep:getrandom` / `getrandom/wasm_js` / `time/wasm-bindgen`），不是核心开关。原生构建真正的最小面就是不加特性。
2. `default` = `["float16", "xsum", "temporal"]`——`intl` 本就不在 `default` 里，但 **`temporal` 在**，所以关掉默认特性是必需的（它会拖入 `temporal_rs` + `timezone_provider`）。
3. 「依赖树里没有引入 `icu_*`（`cargo tree -i icu_provider` 报无匹配）」这条判据的前提不成立：`icu_provider` / `icu_normalizer` / `icu_properties` / `icu_collections` / `icu_locale_core` / `icu_normalizer_data` / `icu_properties_data` 在**改动前的 `Cargo.lock` 里就已存在**（经 `url → idna → idna_adapter`）。本引擎复用同一批 crate、版本同为 2.3.x，没有新增任何一个。真正的判据是 **`intl` 那一族是否被引入**——实测 `icu_calendar` / `icu_collator` / `icu_datetime` / `icu_decimal` / `icu_list` / `icu_plurals` / `icu_segmenter` / `icu_time` / `fixed_decimal` / `sys-locale` / `timezone_provider` 全部不在树里。

实测数据（本机 `cargo 1.98.1`，debug profile）：`cargo build --lib` 通过，104s（含本引擎首次编译）；`cargo tree -i temporal_rs` 报无匹配；`reqman_lib.dll` 2.02 MB；`cargo test --lib` 352 通过 / 0 失败。

**顺带修掉了一个与本变更无关的既有失败**（经用户同意）。`net::tests::failure_classes_are_distinguishable` 曾断言 `does-not-exist.invalid` 应当解析失败，而本机跑着 Mihomo Meta Tunnel（TUN 模式 + fake-IP DNS），任意域名都被解析成 `198.18.0.x`（实测 `does-not-exist.invalid → 198.18.0.44`），这条断言在那类机器上不可能成立——它依赖的是"某个名字一定解析不出来"这个与本机环境绑定的假设。改法是把「解析失败」这件事**由测试自己制造**：新增 `dns_failure_is_reported_as_a_dns_failure`（`net/tests.rs`），经 `reqwest::dns::Resolve` 注入一个一律失败的解析器，断言真实的 `reqwest::Error` 仍被归为 `DnsFailure`。`reqwest::dns` 是公开模块且不依赖 `hickory-dns` 特性，因此**没有新增依赖、也没有改动产品代码**——失败的事实由测试制造，覆盖的仍是「真实 reqwest 错误 → 分类」这同一跳。

回退梯子：`rquickjs`（0.14.0，需 C 编译器）→ `quick-js`（0.4.1）。已在镜像上确认三者都可取得。**本次未触发回退**——首选方案达标。

### D3. 求值环境受限 + 硬性限额

只把 PAC 规范定义的 helper 注入为全局（`isPlainHostName`、`dnsDomainIs`、`localHostOrDomainIs`、`isResolvable`、`isInNet`、`dnsResolve`、`myIpAddress`、`dnsDomainLevels`、`shExpMatch`、`weekdayRange`、`dateRange`、`timeRange`、`alert`），不暴露任何宿主对象。理由：PAC 是**从网络取回的代码**，求值它等于在应用进程里执行远端内容。

求值带 wall-clock 上限；`FindProxyForURL` 的返回值做长度上限与形态校验。`dnsResolve` / `isResolvable` / `myIpAddress` 由后端实现，各自带超时与一次求值内的小缓存；解析失败按 PAC 规范的语义回落（`dnsResolve` 返回 `null`、`isResolvable` 返回 `false`），**不**让整次求值失败——否则一次 DNS 抖动就会变成"连不上网"。`alert` 丢弃，不进日志。

不做的是：不给 PAC 一个"受限但通用"的 JS 环境（例如顺手把 `JSON`/`Date` 之外的东西也开出来）——暴露面只按 helper 清单给。

### D4. PAC 拉取直连、内存缓存 + TTL、失败沿用上次成功副本

拉取**不走代理**：PAC 地址通常在内网，走代理会形成自举循环（要认代理得先有 PAC）。不校验 MIME（现实中大量 PAC 以 `text/plain` 或 `application/octet-stream` 发出），按正文处理。

缓存只放内存、按 TTL 刷新。备选与其代价：每次发送都重新拉取——把 PAC 服务器变成每次请求的单点；把 PAC 落到磁盘——新增存储面，且 PAC 可能含内网拓扑，落盘是新的泄漏面。

拉取失败时**沿用上一次成功的副本**；连一次都没成功过就按直连降级。降级与"用的是陈旧副本"都写进代理决定，不静默。

### D5. 代理决定用一个**不含凭据**的独立投影类型

发送路径上的 `ProxyDecision::Use` 携带明文凭据——`resolve_proxy_for_request`（`proxy.rs:143`）就是在这里解封的。展示用的决定**另立一个类型**，只含：生效层级、生效模式、结果（`direct` 或 `proxied { url }`）、原因（未配置顺位 / 该层声明直连 / 命中白名单 / 取自系统配置 / PAC 取得 / PAC 降级）、以及 PAC 相关事实（来源地址、是否降级）。

理由：复用同一类型就会让"要显示的东西"持有明文，而它的下一个去处是界面与日志——那等于把一条脱敏纪律押在"每个调用点都记得剔除"上。类型不同，这件事就变成结构性的。结果地址来自 PAC 时同样要剔除其中的 `user:pass@`。

### D6. 决定在 `send_request` 里求解一次，同时挂到成功与失败两条路径

选这个是因为它只有一个真相：决定是**这一次发送的产物**，不是对未来的预测。

- 成功：`ResponsePayload` 增加 `proxy_decision`。
- 失败：手写的 `AppError::Serialize`（`error.rs:141`）扩展一个可选字段，成功时缺省。前端 `describeError`（`commands.ts:255`）对 AppError 形态的值原样返回同一个对象，所以只有发送路径需要读这个字段，`AppError` 接口加一个可选字段即可，既有错误处理一行不用改。

考虑过并否掉的三个备选：

1. **把 `send_request` 的错误类型换成结构体**（`{ error, decision }`）——`describeError` 与各处错误处理都按 `{code, message}` 解析，形状一变就要在多处加特判，为一条信息付的代价太大。
2. **按 attempt_id 另开一条诊断旁路**——发送会话的登记项在发送结束时按 RAII 摘除（`cancel::SendRegistry`），旁路要独立于它另做一套保留策略；多一条通道就是多一个生命周期要守，而决定本就随这次发送生灭。
3. **单独一条"预览决定"的命令**——那是**另一份**真相：PAC 可能两次求值不同（`dateRange` / `timeRange` 本就会随时间变），失败之后再预览得到的可能不是当时那个决定。仓库在别处已经明确反对这种做法（`variables/mod.rs:280`：做成两条命令就会有两份真相）。

### D7. 直连就在客户端上显式禁用代理

`build_client` 在 `Direct` 时调用 `.no_proxy()`。reqwest 的 `auto_sys_proxy` 默认 true（`client.rs:309`），只在挂过显式代理时才被关掉（`client.rs:1416`）。不调用它，「不使用代理」就等于"沿用环境变量代理"——`http-engine`「三级代理」要求声明直连的那一层"直接发出请求"，这条在今天是有条件成立的。

这是**行为变更**：在设了 `HTTP_PROXY` 的机器上，过去选「不使用代理」实际仍会经该代理，之后不会。它同时消掉了一个隐患——否则本次把系统代理接进来以后，"直连"会被隐式系统代理二次接管。

### D8. 平台读取做成可注入的接缝，与求解逻辑分离

把"读操作系统代理配置"（Windows 注册表 `Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride` / `AutoConfigURL`；其余平台维持环境变量语义）隔离成一个可替换的来源，求解逻辑只消费它的结果。

理由有两条：(a) 测试不能改注册表，也不能假设 CI 上有注册表；(b) 本机验收需要能构造"系统配置就是 PAC"这一情形。同时保留**显式 PAC 模式**（`pac_url`），它既是产品能力（用户的机器配置不是他想要的那个），也是验收手段。

`AutoConfigURL` 与显式 PAC 地址归一成同一种"PAC 来源"，进入同一个求值器（D2/D3）。

### D9. 连接建立超时按 OS 错误码判定，不按文案

新增 `ErrorCode::ConnectionTimedOut`。判定用最内层 `io::Error` 的错误码（Windows `10060`、Linux `ETIMEDOUT` = `110`），与既有 DNS（`11001..=11004` / 负值 `EAI_*`）和连接被拒（`111` / `10061`）的判定同一取向——`error.rs:175` 那段注释已经写明文案会随系统语言变、错误码不会。

消息上，当且仅当本次决定为直连时，陈述"本次未经代理"这一**事实**，并保留底层原始错误文本。SHALL NOT 断言代理是唯一成因——我们只知道这次是直连，不知道对端是不是本来就不通。

### D11. PAC 降级链在发送路径上**逐跳重试**，且只在请求体可重放时进行

> 这一条是实施到「接入求解」时才发现的缺口：spec 要求链中首选不可用时依序尝试后继项并
> SHALL NOT 直接失败，而规划期没有为它设计任何机制。经确认后补上。

reqwest 的客户端没有"按顺序尝试"这种能力（`.proxy()` 只能挂匹配规则），所以这条只能由
发送路径自己兑现：代理决定里带上**有序跳表**，逐跳尝试，连接阶段失败就换下一跳。

实现必须守住的几条边界：

- **有界**：最多尝试前若干跳（当前取 3）。一条长链逐跳串行尝试会把一次发送拖成多个连接
  超时相加，那比直接失败更难用。
- **只在请求体可重放时才换跳**：含文件的多段表单与二进制正文在内部是**一次性句柄**
  （路径从不进入后端），已经写出去就没法再写一次。这类请求只尝试第一跳，并在失败时如实
  报告——假装它也能降级只会造出一个比失败更坏的错误。无正文、字节、URL 编码表单照常逐跳。
- **超时按整次发送计**，不是每跳各给一份：每跳只享有剩余预算。
- **取消照旧精确到会话**：每一跳都在同一个 `tokio::select!` 里与取消令牌竞争，跳与跳之间
  也检查一次已取消——取消不因多跳而延迟或被吞掉。
- **「不可用」只指连接阶段**：拿到响应就不再换跳。后端的 5xx 是服务的回答而不是代理不通，
  换个代理重发同一个请求会改变语义。
- 跳表里的一项直连（`DIRECT`）**不终止**后续尝试：它只是"这一跳不走代理"，连接失败时仍
  依序看下一项，与浏览器的取向一致。

考虑过并否掉的备选：把整条链交给 reqwest（做不到）；做成应用级故障转移（spec 明确不做
自动故障转移，且那会让"这次到底走了哪个代理"更难说清）。

## Risks / Trade-offs

- **`boa_engine` 的编译时间与产物体积** → 关掉 `intl` / `temporal`；release 已有 `lto` / `opt-level=3` / `strip`。若实测仍不可接受，退回 `rquickjs`（更小，但引入 C 构建单元）。**先实测再动手写求值逻辑**（`tasks.md` 首条）。
- **真实 PAC 用到未实现的 helper** → 求值抛错 → 按直连降级且决定中写明。这是可接受的降级，不是静默；代价是用户仍连不上，但这次能看到原因。
- **PAC 引入 DNS 依赖**（`dnsResolve` / `isResolvable` / `myIpAddress`）→ 各自带超时与求值内缓存；解析失败按规范语义回落而不让整次求值失败。
- **直连语义变化会让"以前能通、现在不通"出现** → 这正是修正本身。README 的已知限制需要写明这条行为变更与 PAC 的支持范围。
- **PAC 是新的攻击面**（执行远端代码）→ D3 的受限环境与限额 + spec「PAC 求值的边界」规定的日志边界。
- **缓存副本可能陈旧** → TTL 刷新；拉取失败沿用上次成功副本这一事实写进决定。
- **内网真实 PAC 无法在本机验证** → 用等价的自造 PAC 覆盖（本地测试服务器既提供 PAC 也充当代理）。残余风险是真实 PAC 的规则形态超出已实现 helper，其失败是可诊断的降级。
- **`AppError` 加字段** → 它是全项目共用的错误类型，加一个可选字段会让"存储层错误"类型上挂着一个网络概念。接受这个不纯，换取不动既有错误处理链；备选方案的代价（D6 里那三条）更高。

## Migration Plan

- **无 schema 迁移**：`ProxyConfig` 只新增模式与字段，`user_version` 预期不动（不需要改约束或重建表），因此不触碰 README 里"迁移只向前"那条限制。旧行缺少新字段按"未配置"读时升级。
- **回滚**：改动集中在后端求解、决定的传递与界面呈现；回滚到旧版本不会去读新字段，也不需要还原数据。回滚后「不使用代理」会退回"可能经环境变量代理"的旧语义。
- **发布前**：更新 README 的已知限制（PAC 支持范围、直连语义变更、未覆盖项）。

## Open Questions

- PAC 求值的 wall-clock 上限与缓存 TTL 的具体取值——可后续调，不影响 spec 与任务分解。
- 是否把"当前机器的系统代理配置"做成一条命令供设置界面显示——影响的是设置界面上一行提示，不影响 spec 与任务分解。
