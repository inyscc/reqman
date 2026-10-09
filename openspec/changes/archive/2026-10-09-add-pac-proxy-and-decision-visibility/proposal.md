## Why

内网机上 reqman 频繁连不上公网目标，而同一时刻 Postman 正常。原因是那台机器的代理不是一个静态地址，而是一份 PAC 文件（系统设置里是 `AutoConfigURL`）。两条本可以读到系统代理的路径都读不到它：

- **reqwest 一侧**：本仓库以 `default-features = false` 构建 reqwest，`system-proxy` 特性被一并关掉——而 Windows 上读注册表 `Internet Settings` 的实现（hyper-util 的 `client-proxy-system`）正落在这个特性里。更要紧的是**上游即使打开也只认 `ProxyServer`，从不看 `AutoConfigURL`**，所以打开特性并不解决 PAC。
- **reqman 自己一侧**：`ProxyMode::System` 只读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，它把"系统代理"理解成了"环境变量代理"。

于是请求直连发出，SYN 被出口静默丢弃，卡到系统放弃才失败（`os error 10060`）——这正是"卡了很长时间才失败"的形状。`http-engine`「三级代理」里那条 Scenario「使用系统代理」在 Windows 上**从未被满足过**。

PAC 不是被忽略的：`add-network-config-and-cancel` 的非目标里明确列着"PAC 与自动代理配置脚本"。现在到了兑现它的时候。

第二个问题让上面这一条几乎无法排查：**代理决定从未被暴露**。`ResponsePayload.via_proxy` 是个布尔且只在为真时显示，`RequestPreview.proxy_url` 只覆盖请求级手工代理——两者都不是真实生效的那一份；失败时走 `AppError` 路径，连那个布尔都没有。用户无法回答"这次到底走了哪个代理"。而 PAC 场景下这恰恰是唯一能定位故障的事实：同一个 PAC 对不同 host 返回不同结果，还会按时间（`dateRange` / `timeRange`）与本机网段（`isInNet`）变化，"频繁失败"本身就可能是规则随环境变化的产物。

第三个问题让线索指向了错误的方向：`10060`（连接建立超时）不落在既有分类的任何一支上（DNS 认 `11001..=11004`，拒绝认 `10061`），被报成笼统的连接失败。

## What Changes

- **「跟随系统」真的跟随系统**：Windows 上读 `Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride` **以及 `AutoConfigURL`**；其余平台维持环境变量语义。
- **新增代理模式「PAC 文件」**，可填 PAC 地址并覆盖系统设置；`AutoConfigURL` 与显式 PAC 地址走**同一个**求值器。求值在**后端**的受限环境里进行（无网络、无文件、无系统能力，只有 PAC helper），实现 `FindProxyForURL(url, host)` 所需的 helper 集，解析 `DIRECT` / `PROXY` / `SOCKS` / `SOCKS5` / `HTTPS` 以及 `;` 分隔的降级链，按目标 URL 得出**每一次发送**的代理决定；PAC 内容按 TTL 缓存并刷新。
- **代理决定可见**：把真实生效的那一份做成可读投影——层级（请求 / 环境 / 全局 / 系统）、模式、结果（直连 / 经 `地址`）、以及**为什么**（未配置顺位 / 该层声明直连 / 命中白名单 / 系统设置 / PAC 规则 / PAC 降级）。成功与**失败**两条路径都要能看到；投影中 SHALL NOT 含凭据。
- **直连就是直连**：决定为直连时在客户端上显式禁用代理，不再让 reqwest 的隐式系统代理兜底。**BREAKING**：在设了 `HTTP_PROXY` 的机器上，过去选择「不使用代理」实际仍会经该环境变量代理发出，之后不再——这是让「不使用代理」名副其实所必需的。
- **失败类别补齐**：连接建立阶段超时（Windows `10060`、Linux `ETIMEDOUT`）从笼统的连接失败中分出并单独命名；当本次决定是直连时，消息 SHALL 陈述"本次为直连"这一事实（SHALL NOT 断言代理是唯一成因），使这类失败能被指向代理该在的方向。
- **PAC 失败有据可查**：PAC 拉取失败、求值抛错、返回值解析不出来时按**直连**降级并继续发出请求，但降级这一事实 SHALL 出现在代理决定里，SHALL NOT 静默。

### 非目标

WPAD / DHCP 自动发现、PAC 内容的跨重启持久化、代理失败后的自动重试与故障转移、PAC 自定义扩展函数。

## Capabilities

### New Capabilities

无新增能力。代理求解的契约已经落在 `http-engine` 的「三级代理」上，"系统层怎么求解"是该需求自身边界内的延伸；另立一个代理能力会让"这次走哪个代理"这件事有两个归属地，反而更差。

### Modified Capabilities

- `http-engine`：「三级代理」扩展系统层（读操作系统配置，含 PAC）；新增「PAC 代理的求值与降级」（受限求值、helper、降级链、缓存与刷新、失败按直连降级但可见）；新增「代理决定的可见性」；「响应元数据」补一类可区分的失败并允许消息陈述"本次为直连"
- `ui-layout`：「设置模态的代理配置」增加「PAC 文件」模式与 PAC 地址项；响应区呈现本次发送的代理决定（含失败时）

## Impact

- **代码**：`src-tauri/src/net/proxy.rs`（系统配置读取、PAC 求值入口、决定求解）、`src-tauri/src/net/` 新增 PAC 求值模块、`src-tauri/src/net/mod.rs`（`build_client` 显式落地决定、响应与失败携带决定）、`src-tauri/src/error.rs`（新失败分类）、`src-tauri/src/logging.rs`（代理决定的脱敏出口）、`src-tauri/src/storage/model.rs`（`ProxyConfig` 新模式与字段、序列化形状）、`src-tauri/src/commands.rs`（决定随结果与错误回传）、`src/components/ProxyConfigRows.tsx`、`src/components/ResponsePanel.tsx`、`src/lib/types.ts`
- **命令面**：`send_request` 的成功与失败**两条路径**都要带回代理决定——失败目前只回一个 `AppError`，这是本变更需要动到的接口形状。新增读取"本机系统代理配置"的命令（含 PAC，供界面显示与排查），其返回值 SHALL 不含凭据。
- **依赖**：**新增一个 JS 求值能力，这是本变更最大的不确定项。** 首选纯 Rust 引擎（无新增工具链）；若依赖镜像取不到——README 已记录该镜像缺 `h2 >= 0.4.14` 的先例——回退到 QuickJS 绑定（本项目本就要求 C 编译器，SQLite 是 bundled 编译的）。**实施的第一步必须是可用性验证，而不是先写求值逻辑。** 已评估后否掉的备选：复用前端既有的 `postman-sandbox`——PAC 求值必须在后端，否则渲染进程决定了后端走不走代理，而 `http-engine`「网络访问边界」要求请求必须绕不过后端的代理配置；且 `dnsResolve` / `myIpAddress` 一类 helper 在前端也够不着。
- **数据**：`ProxyConfig` 新增模式与 PAC 地址字段；无该字段的既有行按"未配置"读时升级。`user_version` 是否需要推进由实现确认（预期不需要：只增字段、不改约束）。
- **兼容性**：「不使用代理」在设了 `HTTP_PROXY` 的机器上行为变化（见 What Changes 的 BREAKING）。已导出备份与既有请求的落库形态向后兼容（只增字段）。
- **测试面**：本机可端到端验收，不需要外部网络——本地测试服务器既能提供 PAC 文件，也能充当代理；`testutil.rs` 已记录 `raw_first_line`，正是用来区分"直连形态"与"代理形态"请求的。**内网机上的真实 PAC 文件不在验收范围内**（见下方"未覆盖"）。
- **未覆盖**：内网机真实 PAC 的规则差异只在本机用等价的自造 PAC 覆盖；WPAD；PAC 求值所需的 `dnsResolve` / `isResolvable` / `myIpAddress` 依赖真实 DNS 与本机地址，其超时与失败降级路径以注入式桩覆盖，不依赖真实解析器。
