//! 三级代理的求解（design.md D12）。
//!
//! 请求 > 环境 > 全局的优先级在**一处**求解，产出唯一生效配置；`no_proxy`
//! 白名单在挂载代理之前判定；系统代理在请求时刻读取，而不是启动时固化。

use super::pac;
use crate::error::AppResult;
use crate::secrets::KeyProvider;
use crate::storage::model::{
    ProxyConfig, ProxyDecisionView, ProxyLayer, ProxyMode, ProxyReason, RequestSettings,
};
use crate::storage::{proxy_credentials, variables, Db};
use crate::url_util;

/// 操作系统当前的代理设置（求解之前的事实）。
///
/// 「跟随系统」读的是它，而**不只是环境变量**：Windows 上还有注册表里的静态代理与
/// 自动代理配置脚本（见 [`platform_settings`]）。把「载体上写着什么」与「合并后生效
/// 的是什么」分成两层，是为了让两侧都能被注入式断言——真实注册表在测试里造不出来。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemProxyEnv {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Vec<String>,
    /// 自动代理配置脚本（PAC）的地址。Windows 上来自注册表的 `AutoConfigURL`。
    ///
    /// 存在即优先于静态代理：WinINET 的取向是自动配置压过 `ProxyServer`。
    pub pac_url: Option<String>,
}

/// 从操作系统**载体**上读到的代理设置（Windows 注册表 / 环境变量）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlatformProxySettings {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Vec<String>,
    /// 自动代理配置脚本地址（Windows 的 `AutoConfigURL`）。
    pub pac_url: Option<String>,
}

impl PlatformProxySettings {
    /// 由**注册表里读到的那几个原始值**构造。
    ///
    /// `static_proxy` 是 `ProxyServer` 的原样文本，它有两种写法：单个 `host:port`，
    /// 或 `http=host:port;https=host:port` 的分协议表；两种都要认。`no_proxy_raw`
    /// 是 `ProxyOverride` 的原样文本（分号分隔）。
    pub fn from_raw(
        static_proxy: Option<String>,
        pac_url: Option<String>,
        no_proxy_raw: Option<String>,
    ) -> Self {
        let (http_proxy, https_proxy) = match static_proxy.as_deref() {
            Some(raw) => split_static_proxy(raw),
            None => (None, None),
        };

        Self {
            http_proxy,
            https_proxy,
            pac_url: pac_url
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            no_proxy: no_proxy_raw
                .map(|raw| {
                    raw.split(';')
                        .map(|entry| entry.trim().to_string())
                        .filter(|entry| !entry.is_empty())
                        // `<local>` 指的是「不含点的本机名不走代理」——那是对**名字形态**
                        // 的判定，白名单的模式匹配表达不了，所以丢掉而不是当成一个字面量
                        // 条目留着（留着它谁也命中不了）。
                        .filter(|entry| !entry.eq_ignore_ascii_case("<local>"))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// 把 `ProxyServer` 的两种写法拆成 http / https 两个地址。
///
/// 注册表里的值通常**不带协议头**（本机就是 `127.0.0.1:47134`），而网络栈需要一个
/// 带协议的地址，因此在这里补齐 `http://`。
fn split_static_proxy(raw: &str) -> (Option<String>, Option<String>) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (None, None);
    }

    if !raw.contains('=') {
        let single = normalize_proxy_url(raw);
        return (single.clone(), single);
    }

    let mut http = None;
    let mut https = None;
    for part in raw.split(';') {
        let Some((scheme, value)) = part.split_once('=') else {
            continue;
        };
        match scheme.trim().to_ascii_lowercase().as_str() {
            "http" => http = normalize_proxy_url(value),
            "https" => https = normalize_proxy_url(value),
            // 其余协议（ftp / socks 等）不在本应用的支持面里：忽略，而不是当成 http。
            _ => {}
        }
    }
    (http, https)
}

/// 补齐缺失的协议头。空串视为未配置。
fn normalize_proxy_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.contains("://") {
        Some(value.to_string())
    } else {
        Some(format!("http://{}", value))
    }
}

/// 读操作系统当前的代理设置。Windows 读注册表；其余平台没有第二处可读。
///
/// 测试构建里先看注入点（见 [`use_test_platform_proxy`]）：真实注册表在测试里构造不
/// 出来，而「跟随系统读的是操作系统配置」这条行为不能靠"这台机器恰好配了代理"来验证。
fn platform_settings() -> PlatformProxySettings {
    #[cfg(test)]
    if let Some(injected) = test_platform_override() {
        return injected;
    }

    platform_settings_raw()
}

#[cfg(windows)]
fn platform_settings_raw() -> PlatformProxySettings {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    const INTERNET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let Ok(key) =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(INTERNET_SETTINGS, KEY_READ)
    else {
        return PlatformProxySettings::default();
    };

    // `ProxyEnable` 只管 `ProxyServer`：它关掉不等于没有自动代理配置，PAC 那一项照读
    // （只配了自动配置的机器上 `ProxyEnable` 常是 0）。
    let static_proxy = if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0 {
        key.get_value::<String, _>("ProxyServer").ok()
    } else {
        None
    };

    PlatformProxySettings::from_raw(
        static_proxy,
        key.get_value::<String, _>("AutoConfigURL").ok(),
        key.get_value::<String, _>("ProxyOverride").ok(),
    )
}

/// 非 Windows：环境变量就是该平台的系统代理设置，注册表这一层不存在。
#[cfg(not(windows))]
fn platform_settings_raw() -> PlatformProxySettings {
    PlatformProxySettings::default()
}

/// 测试期注入的"平台代理设置"。生产构建里不存在。
#[cfg(test)]
static TEST_PLATFORM_SETTINGS: std::sync::Mutex<Option<PlatformProxySettings>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
fn test_platform_override() -> Option<PlatformProxySettings> {
    TEST_PLATFORM_SETTINGS
        .lock()
        .expect("平台代理注入锁未中毒")
        .clone()
}

/// 注入平台代理设置，离开作用域时恢复。仅供测试。
#[cfg(test)]
pub(crate) fn use_test_platform_proxy(settings: PlatformProxySettings) -> TestPlatformProxy {
    let mut slot = TEST_PLATFORM_SETTINGS
        .lock()
        .expect("平台代理注入锁未中毒");
    let previous = slot.take();
    *slot = Some(settings);
    TestPlatformProxy { previous }
}

/// 注入守卫：析构时把上一个值放回去（`None` 表示本来就没有注入）。
#[cfg(test)]
pub(crate) struct TestPlatformProxy {
    previous: Option<PlatformProxySettings>,
}

#[cfg(test)]
impl Drop for TestPlatformProxy {
    fn drop(&mut self) {
        let mut slot = TEST_PLATFORM_SETTINGS
            .lock()
            .expect("平台代理注入锁未中毒");
        *slot = self.previous.take();
    }
}

impl SystemProxyEnv {
    /// 在请求时刻读取环境变量。
    pub fn from_env() -> Self {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        };
        Self {
            http_proxy: read("HTTP_PROXY").or_else(|| read("http_proxy")),
            https_proxy: read("HTTPS_PROXY").or_else(|| read("https_proxy")),
            no_proxy: read("NO_PROXY")
                .or_else(|| read("no_proxy"))
                .map(|raw| {
                    raw.split(',')
                        .map(|entry| entry.trim().to_string())
                        .filter(|entry| !entry.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            pac_url: None,
        }
    }

    /// 由显式键值对构造，供测试使用。
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| (*v).to_string())
                .filter(|value| !value.trim().is_empty())
        };
        Self {
            http_proxy: get("http_proxy"),
            https_proxy: get("https_proxy"),
            no_proxy: get("no_proxy")
                .map(|raw| {
                    raw.split(',')
                        .map(|entry| entry.trim().to_string())
                        .filter(|entry| !entry.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
            pac_url: get("pac_url").or_else(|| get("autoconfig_url")),
        }
    }

    /// 在请求时刻读操作系统的代理设置（design D8）。
    ///
    /// 顺序是**环境变量在前、平台设置补齐空缺**——与 hyper-util 的 `with_system`
    /// 同一取向：两者都没配才是"没有代理"。这也让"只配了 PAC"的机器（环境变量为空、
    /// 注册表有 `AutoConfigURL`）拿到 PAC。
    pub fn from_platform() -> Self {
        Self::merge(Self::from_env(), platform_settings())
    }

    /// 合并两侧来源。纯函数：读取留给调用方，合并逻辑因此可被注入式断言。
    pub fn merge(env: Self, platform: PlatformProxySettings) -> Self {
        Self {
            http_proxy: env.http_proxy.or(platform.http_proxy),
            https_proxy: env.https_proxy.or(platform.https_proxy),
            no_proxy: if env.no_proxy.is_empty() {
                platform.no_proxy
            } else {
                env.no_proxy
            },
            pac_url: env.pac_url.or(platform.pac_url),
        }
    }

    pub fn proxy_for(&self, scheme: &str) -> Option<&str> {
        match scheme {
            "https" => self.https_proxy.as_deref().or(self.http_proxy.as_deref()),
            _ => self.http_proxy.as_deref(),
        }
    }

    pub fn bypasses(&self, host: &str) -> bool {
        self.no_proxy
            .iter()
            .any(|entry| url_util::host_matches_pattern(host, entry))
    }

    /// 这份系统代理设置里**没有任何代理来源**——既无静态地址也无 PAC。
    ///
    /// 只有白名单不算"有代理"：白名单是"哪些不走代理"，没有代理可走时它无事可做。
    pub fn is_empty(&self) -> bool {
        self.http_proxy.is_none() && self.https_proxy.is_none() && self.pac_url.is_none()
    }
}

/// 最终要交给网络栈的决定。**携带明文凭据**，因此只存在于发送路径上；
/// 要展示或记录请用 [`ProxyDecisionView`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyDecision {
    /// 明确直连。
    Direct,
    /// 使用该代理。
    Use {
        url: String,
        username: Option<String>,
        password: Option<String>,
    },
}

impl ProxyDecision {
    /// 是否经由代理发出。
    pub fn uses_proxy(&self) -> bool {
        matches!(self, ProxyDecision::Use { .. })
    }
}

/// 求解出的配置**连同它来自哪一层**。
///
/// 层级必须在这里一并返回：代理决定要说出"是哪一层定的"，而这事后无法从一个
/// [`ProxyConfig`] 反推出来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProxy {
    pub layer: ProxyLayer,
    pub config: ProxyConfig,
}

impl ResolvedProxy {
    /// 投影到「生效层级」：某一层选了「跟随系统」时，实际来源是操作系统，层级记作「系统」。
    fn effective_layer(&self) -> ProxyLayer {
        if self.config.mode == ProxyMode::System {
            ProxyLayer::System
        } else {
            self.layer
        }
    }
}

/// 决定，连同它是怎么定下来的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyOutcome {
    /// 依次尝试的跳表：第一项即本次的首选，**永不为空**。
    ///
    /// PAC 的返回值是一条降级链，而网络栈没有"按顺序尝试"的能力，所以链只能由发送路径
    /// 自己走（design D11）。非 PAC 的来源只有一项。
    plan: Vec<ProxyDecision>,
    pub reason: ProxyReason,
    /// 走 PAC 时用到的 PAC 地址；没走 PAC 时为 `None`。
    pub pac_url: Option<String>,
    /// 这次用的 PAC 是上一次成功取回的**旧副本**（这次没取到新的，design D4）。
    pub pac_stale: bool,
}

impl ProxyOutcome {
    /// 只有一跳的决定。
    fn one(decision: ProxyDecision, reason: ProxyReason) -> Self {
        Self {
            plan: vec![decision],
            reason,
            pac_url: None,
            pac_stale: false,
        }
    }

    fn direct(reason: ProxyReason) -> Self {
        Self::one(ProxyDecision::Direct, reason)
    }

    /// 改成"走了 PAC 的直连"：PAC 取不到、求值失败，或规则里没有可用项。
    ///
    /// 三种情形共用一个落点但**都不静默**：理由与 PAC 来源都写进决定里。
    fn direct_via_pac(mut self, source: String, stale: bool, reason: ProxyReason) -> Self {
        self.plan = vec![ProxyDecision::Direct];
        self.reason = reason;
        self.pac_url = Some(source);
        self.pac_stale = stale;
        self
    }

    /// 改成 PAC 给出的跳表。
    fn via_pac(mut self, plan: Vec<ProxyDecision>, source: String, stale: bool) -> Self {
        self.plan = plan;
        self.reason = ProxyReason::Pac;
        self.pac_url = Some(source);
        self.pac_stale = stale;
        self
    }

    /// 首选的那一跳。
    pub fn primary(&self) -> &ProxyDecision {
        &self.plan[0]
    }

    /// 依次尝试的跳表。
    pub fn plan(&self) -> &[ProxyDecision] {
        &self.plan
    }

    /// 以第 `index` 跳为唯一一跳的副本。
    ///
    /// 用于"实际走的是第几跳"的呈现：首选不通而落到后继项时，决定要说的是**实际走的那
    /// 一跳**，否则它会与实走的路径对不上（spec: 代理决定的可见性）。
    pub fn hopping(&self, index: usize) -> Self {
        Self {
            plan: vec![self.plan[index].clone()],
            reason: self.reason,
            pac_url: self.pac_url.clone(),
            pac_stale: self.pac_stale,
        }
    }

    /// 渲染成不含凭据的可读投影。
    pub fn view(&self, resolved: Option<&ResolvedProxy>) -> ProxyDecisionView {
        // 只从**地址**取值：`ProxyDecision::Use` 上还挂着用户名与口令，一个字段都不碰。
        let proxy_url = match self.primary() {
            ProxyDecision::Use { url, .. } => Some(strip_credentials(url)),
            ProxyDecision::Direct => None,
        };

        ProxyDecisionView {
            layer: resolved.map(ResolvedProxy::effective_layer),
            mode: resolved.map(|resolved| resolved.config.mode),
            proxy_url,
            reason: self.reason,
            pac_url: self.pac_url.clone(),
            pac_stale: self.pac_stale,
        }
    }
}

/// 从代理地址里剔除 `user:pass@` 那一段。
///
/// PAC 的返回值允许带凭据（`PROXY 用户:口令@主机:端口`），而投影会进日志与界面回传。
/// 这类凭据不在脱敏出口的登记范围里（它不是"某个 secret 变量"），所以必须在这里就摘掉。
fn strip_credentials(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => match rest.rsplit_once('@') {
            Some((_, host)) => format!("{}://{}", scheme, host),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// 求解唯一生效的代理配置：请求 > 环境 > 全局，取第一个「实际生效」的层。
///
/// 「未配置」的层不生效因而被跳过；「不使用代理」的层生效因而**停下**——它表达的是
/// 直连，不应被更低层级的代理接管（spec: http-engine「三级代理」）。
pub fn resolve_proxy(
    request_proxy: Option<&ProxyConfig>,
    environment_proxy: Option<&ProxyConfig>,
    global_proxy: Option<&ProxyConfig>,
) -> Option<ProxyConfig> {
    resolve_proxy_with_layer(request_proxy, environment_proxy, global_proxy)
        .map(|resolved| resolved.config)
}

/// 同上，但把「来自哪一层」一并返回。
pub fn resolve_proxy_with_layer(
    request_proxy: Option<&ProxyConfig>,
    environment_proxy: Option<&ProxyConfig>,
    global_proxy: Option<&ProxyConfig>,
) -> Option<ResolvedProxy> {
    [
        (ProxyLayer::Request, request_proxy),
        (ProxyLayer::Environment, environment_proxy),
        (ProxyLayer::Global, global_proxy),
    ]
    .into_iter()
    .find_map(|(layer, candidate)| {
        let config = candidate.filter(|config| config.is_effective())?;
        Some(ResolvedProxy {
            layer,
            config: config.clone(),
        })
    })
}

/// 从存储读取三层配置并求解。
///
/// 求解出的那一层在这里解出明文凭据：只有发送路径需要它，读取路径一律不回传凭据。
pub fn resolve_proxy_for_request(
    db: &Db,
    settings: &RequestSettings,
    environment_id: Option<&str>,
    key_provider: &dyn KeyProvider,
) -> AppResult<Option<ResolvedProxy>> {
    let global = variables::global_proxy(db)?;
    let environment = match environment_id {
        Some(id) => variables::get_environment(db, id)?.proxy,
        None => None,
    };

    Ok(resolve_proxy_with_layer(
        settings.proxy.as_ref(),
        environment.as_ref(),
        global.as_ref(),
    )
    .map(|resolved| ResolvedProxy {
        layer: resolved.layer,
        config: proxy_credentials::unseal(resolved.config, key_provider),
    }))
}

/// 结合目标 URL 与系统代理设置，得出最终决定。
pub fn decide(proxy: Option<&ProxyConfig>, url: &str, system: &SystemProxyEnv) -> ProxyDecision {
    decide_outcome(proxy, url, system).primary().clone()
}

/// 同上，并把「怎么定下来的」一并返回。
///
/// 决定与原因是**同一次判定**的两个面向：让两个函数各自推一遍，规则就有两份，迟早
/// 漂移。所以 `decide` 只是丢掉原因的那一面。
pub fn decide_outcome(
    proxy: Option<&ProxyConfig>,
    url: &str,
    system: &SystemProxyEnv,
) -> ProxyOutcome {
    let Some(proxy) = proxy else {
        return ProxyOutcome::direct(ProxyReason::Unconfigured);
    };
    if !proxy.is_effective() {
        return ProxyOutcome::direct(ProxyReason::Unconfigured);
    }

    let host = url_util::host_of(url).unwrap_or_default();

    // 白名单在挂载代理之前判定
    if !host.is_empty() && proxy.bypasses(&host) {
        return ProxyOutcome::direct(ProxyReason::Whitelisted);
    }

    match proxy.mode {
        // 求解过程只产出「生效」的层，因此这两档都以直连收场。
        ProxyMode::Inherit | ProxyMode::None => ProxyOutcome::direct(ProxyReason::DeclaredDirect),
        ProxyMode::Manual => match proxy.url.as_deref().map(str::trim) {
            Some(url) if !url.is_empty() => ProxyOutcome::one(
                ProxyDecision::Use {
                    url: url.to_string(),
                    username: proxy.username.clone(),
                    password: proxy.password.clone(),
                },
                ProxyReason::Manual,
            ),
            _ => ProxyOutcome::direct(ProxyReason::DeclaredDirect),
        },
        ProxyMode::System => {
            if !host.is_empty() && system.bypasses(&host) {
                return ProxyOutcome::direct(ProxyReason::Whitelisted);
            }
            let scheme = url_util::host_of(url).is_some().then(|| {
                url.split_once(':')
                    .map(|(s, _)| s.to_ascii_lowercase())
                    .unwrap_or_default()
            });
            match system.proxy_for(scheme.as_deref().unwrap_or("http")) {
                Some(url) => ProxyOutcome::one(
                    ProxyDecision::Use {
                        url: url.to_string(),
                        username: None,
                        password: None,
                    },
                    ProxyReason::FromSystem,
                ),
                None => ProxyOutcome::direct(ProxyReason::Unconfigured),
            }
        }
        // PAC 要取文件、要跑 JS，因此由 [`decide_with_pac`] 求解。走到这里说明调用方
        // 绕过了那一层——此时我们**没有**PAC 的答案，如实报"未能求值"，不编一个代理出来。
        ProxyMode::Pac => ProxyOutcome::direct(ProxyReason::PacUnavailable),
    }
}

/// 这次求解该用哪份 PAC（design D10）。
///
/// 显式填写的 PAC 覆盖系统配置——两者是同一个求值器的两种来源。反过来不成立：显式的
/// 直连或手工代理不该被系统配置里的 PAC 接管。
fn pac_source(proxy: Option<&ProxyConfig>, system: &SystemProxyEnv) -> Option<String> {
    let explicit = proxy
        .filter(|proxy| proxy.mode == ProxyMode::Pac)
        .and_then(|proxy| proxy.pac_url.clone());

    if let Some(url) = explicit.filter(|url| !url.trim().is_empty()) {
        return Some(url);
    }

    proxy
        .filter(|proxy| proxy.mode == ProxyMode::System)
        .and_then(|_| system.pac_url.clone())
        .filter(|url| !url.trim().is_empty())
}

/// PAC 的跳表转成网络栈要的决定序列。
fn plan_from_hops(hops: &[pac::PacHop]) -> Vec<ProxyDecision> {
    hops.iter()
        .map(|hop| match hop.proxy_url() {
            Some(url) => ProxyDecision::Use {
                url,
                // PAC 的返回值里凭据只可能嵌在地址内（`PROXY user:pass@host:port`）；
                // reqwest 从代理 URL 里自己认它。不在这里再拆一份出来——拆出来就多了一处
                // "记得别写进日志"的明文。
                username: None,
                password: None,
            },
            None => ProxyDecision::Direct,
        })
        .collect()
}

/// 求解一次发送的代理决定，**含 PAC**（design D10 / D11）。
///
/// 与 [`decide_outcome`] 的分工：那个是纯函数，只管三级顺位与白名单；这里再加上
/// 「PAC 怎么说」——它要取文件、要跑 JS，因此是异步的，也因此在纯函数之外。
///
/// PAC 的任何失败（取不到、抛错、规则里没有可用项）都**按直连继续**，但理由与 PAC
/// 来源都写进决定里（spec: PAC 拉取失败按直连继续 / 求值抛错按直连继续）。
pub async fn decide_with_pac(
    proxy: Option<&ProxyConfig>,
    url: &str,
    system: &SystemProxyEnv,
    store: &pac::PacStore,
) -> ProxyOutcome {
    let outcome = decide_outcome(proxy, url, system);

    let Some(source) = pac_source(proxy, system) else {
        return outcome;
    };

    // 已判为白名单直连的不该被 PAC 覆盖：白名单是用户写下的"这些不走代理"。
    if outcome.reason == ProxyReason::Whitelisted {
        return outcome;
    }

    let loaded = match store.load(&source).await {
        Ok(loaded) => loaded,
        Err(_) => {
            return outcome.direct_via_pac(source, false, ProxyReason::PacUnavailable);
        }
    };

    let host = url_util::host_of(url).unwrap_or_default();
    let hops = match loaded.script.evaluate(url, &host) {
        Ok(hops) => hops,
        Err(_) => {
            return outcome.direct_via_pac(source, loaded.stale, ProxyReason::PacUnavailable);
        }
    };

    let plan = plan_from_hops(&hops);
    if plan.is_empty() {
        // 规则里没有认得出的项：同样是降级，但这次是"PAC 没给出可用的答案"
        return outcome.direct_via_pac(source, loaded.stale, ProxyReason::PacUnavailable);
    }

    outcome.via_pac(plan, source, loaded.stale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_level_overrides_environment_which_overrides_global() {
        let request = ProxyConfig::manual("http://request:1");
        let environment = ProxyConfig::manual("http://environment:2");
        let global = ProxyConfig::manual("http://global:3");

        let resolved = resolve_proxy(Some(&request), Some(&environment), Some(&global)).unwrap();
        assert_eq!(resolved.url.as_deref(), Some("http://request:1"));

        let resolved = resolve_proxy(None, Some(&environment), Some(&global)).unwrap();
        assert_eq!(resolved.url.as_deref(), Some("http://environment:2"));

        let resolved = resolve_proxy(None, None, Some(&global)).unwrap();
        assert_eq!(resolved.url.as_deref(), Some("http://global:3"));
    }

    #[test]
    fn unconfigured_layers_are_skipped() {
        let request = ProxyConfig::default(); // 「未配置」不生效
        let environment = ProxyConfig::manual("http://environment:2");
        let resolved = resolve_proxy(Some(&request), Some(&environment), None).unwrap();
        assert_eq!(resolved.url.as_deref(), Some("http://environment:2"));

        assert!(resolve_proxy(Some(&ProxyConfig::default()), None, None).is_none());
    }

    /// 「不使用代理」是该层的最终决定，SHALL NOT 被更低层级的代理接管。
    #[test]
    fn an_explicit_direct_layer_is_not_taken_over_by_a_lower_one() {
        let direct = ProxyConfig::direct();
        let environment = ProxyConfig::manual("http://environment:2");
        let global = ProxyConfig::manual("http://global:3");

        let resolved = resolve_proxy(Some(&direct), Some(&environment), Some(&global)).unwrap();
        assert_eq!(resolved.mode, ProxyMode::None, "请求级直连应停在请求层");
        assert_eq!(
            decide(Some(&resolved), "http://public.test/", &SystemProxyEnv::default()),
            ProxyDecision::Direct,
            "请求级直连应真的直连，而不是落到全局代理"
        );

        let resolved = resolve_proxy(None, Some(&direct), Some(&global)).unwrap();
        assert_eq!(resolved.mode, ProxyMode::None, "环境级直连同样拦得住全局");
    }

    #[test]
    fn no_proxy_whitelist_bypasses_the_proxy() {
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            url: Some("http://proxy:8080".into()),
            no_proxy: vec!["internal.test".into()],
            ..ProxyConfig::default()
        };
        let system = SystemProxyEnv::default();

        assert_eq!(
            decide(Some(&proxy), "http://internal.test/api", &system),
            ProxyDecision::Direct,
            "命中白名单时不应挂代理"
        );
        assert!(matches!(
            decide(Some(&proxy), "http://public.test/api", &system),
            ProxyDecision::Use { .. }
        ));
    }

    #[test]
    fn manual_proxy_carries_credentials() {
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            url: Some("http://proxy:8080".into()),
            username: Some("u".into()),
            password: Some("p".into()),
            ..ProxyConfig::default()
        };
        match decide(Some(&proxy), "http://public.test/", &SystemProxyEnv::default()) {
            ProxyDecision::Use {
                url,
                username,
                password,
            } => {
                assert_eq!(url, "http://proxy:8080");
                assert_eq!(username.as_deref(), Some("u"));
                assert_eq!(password.as_deref(), Some("p"));
            }
            other => panic!("期望 Use，得到 {:?}", other),
        }
    }

    #[test]
    fn socks5_urls_are_passed_through() {
        let proxy = ProxyConfig::manual("socks5://127.0.0.1:1080");
        match decide(Some(&proxy), "http://public.test/", &SystemProxyEnv::default()) {
            ProxyDecision::Use { url, .. } => assert_eq!(url, "socks5://127.0.0.1:1080"),
            other => panic!("期望 Use，得到 {:?}", other),
        }
    }

    #[test]
    fn system_proxy_is_read_at_request_time() {
        let before = SystemProxyEnv::from_pairs(&[("http_proxy", "http://sys-a:3128")]);
        let after = SystemProxyEnv::from_pairs(&[("http_proxy", "http://sys-b:3128")]);
        let proxy = ProxyConfig::system();

        match decide(Some(&proxy), "http://public.test/", &before) {
            ProxyDecision::Use { url, .. } => assert_eq!(url, "http://sys-a:3128"),
            other => panic!("期望 Use，得到 {:?}", other),
        }
        match decide(Some(&proxy), "http://public.test/", &after) {
            ProxyDecision::Use { url, .. } => {
                assert_eq!(url, "http://sys-b:3128", "系统代理应在请求时刻读取")
            }
            other => panic!("期望 Use，得到 {:?}", other),
        }
    }

    #[test]
    fn system_no_proxy_is_honoured() {
        let env = SystemProxyEnv::from_pairs(&[
            ("http_proxy", "http://sys:3128"),
            ("no_proxy", "internal.test,.corp.test"),
        ]);
        let proxy = ProxyConfig::system();

        assert_eq!(
            decide(Some(&proxy), "http://internal.test/x", &env),
            ProxyDecision::Direct
        );
        assert_eq!(
            decide(Some(&proxy), "http://api.corp.test/x", &env),
            ProxyDecision::Direct
        );
        assert!(matches!(
            decide(Some(&proxy), "http://example.com/x", &env),
            ProxyDecision::Use { .. }
        ));
    }

    #[test]
    fn https_uses_the_https_proxy_when_available() {
        let env = SystemProxyEnv::from_pairs(&[
            ("http_proxy", "http://plain:3128"),
            ("https_proxy", "http://secure:3128"),
        ]);
        assert_eq!(env.proxy_for("https"), Some("http://secure:3128"));
        assert_eq!(env.proxy_for("http"), Some("http://plain:3128"));
    }

    #[test]
    fn resolve_for_request_reads_environment_then_global_from_storage() {
        use crate::secrets::MemoryKeyProvider;
        use crate::storage::model::Scope;
        use crate::storage::{variables, workspace, Db};

        let db = Db::open_in_memory().expect("打开数据库");
        let key = MemoryKeyProvider::default();
        let workspace_id = workspace::list(&db).unwrap().remove(0).id;
        let env = variables::create_environment(&db, &workspace_id, "开发").unwrap();

        variables::set_global_proxy(&db, Some(ProxyConfig::manual("http://global:1"))).unwrap();
        variables::set_environment_proxy(&db, &env.id, Some(ProxyConfig::manual("http://env:2")))
            .unwrap();

        let settings = RequestSettings::default();
        let resolved = resolve_proxy_for_request(&db, &settings, Some(&env.id), &key).unwrap();
        assert_eq!(
            resolved.unwrap().config.url.as_deref(),
            Some("http://env:2")
        );

        // 请求级最高
        let settings = RequestSettings {
            proxy: Some(ProxyConfig::manual("http://request:3")),
            ..RequestSettings::default()
        };
        let resolved = resolve_proxy_for_request(&db, &settings, Some(&env.id), &key).unwrap();
        assert_eq!(
            resolved.unwrap().config.url.as_deref(),
            Some("http://request:3")
        );

        // 没有活动环境时用全局
        let resolved =
            resolve_proxy_for_request(&db, &RequestSettings::default(), None, &key).unwrap();
        assert_eq!(
            resolved.unwrap().config.url.as_deref(),
            Some("http://global:1")
        );

        let _ = Scope::Global;
    }

    // -----------------------------------------------------------------------
    // 系统代理：载体上读到的事实 → 合并后生效的取值（design D8）
    // -----------------------------------------------------------------------

    /// 注册表里有静态代理而环境变量为空时，来源必须给出那个静态代理。
    ///
    /// 这正是 Windows 上「跟随系统」长期失效的形状：代理配在「Internet 选项」里
    /// （`ProxyEnable=1`、`ProxyServer=127.0.0.1:47134`），而进程环境变量一个都没有。
    #[test]
    fn a_platform_static_proxy_fills_an_empty_environment() {
        let platform = PlatformProxySettings::from_raw(
            // 注册表里的写法**不带协议头**，必须补上，否则网络栈拿不到可用地址
            Some("127.0.0.1:47134".into()),
            None,
            Some("localhost;127.*;10.*;172.16.*;<local>".into()),
        );

        let merged = SystemProxyEnv::merge(SystemProxyEnv::from_pairs(&[]), platform);

        assert_eq!(merged.http_proxy.as_deref(), Some("http://127.0.0.1:47134"));
        assert_eq!(
            merged.https_proxy.as_deref(),
            Some("http://127.0.0.1:47134"),
            "单个地址的 ProxyServer 对两种协议都生效"
        );

        assert!(merged.bypasses("127.0.0.1"));
        assert!(merged.bypasses("10.1.2.3"), "注册表的 `10.*` 应命中");
        assert!(merged.bypasses("172.16.5.5"));
        assert!(merged.bypasses("localhost"));
        assert!(!merged.bypasses("example.com"));
    }

    /// 环境变量在前、平台设置补齐空缺：两者都没配才是"没有代理"。
    #[test]
    fn the_environment_wins_over_the_platform_setting() {
        let env = SystemProxyEnv::from_pairs(&[("http_proxy", "http://env:3128")]);
        let platform = PlatformProxySettings::from_raw(Some("127.0.0.1:47134".into()), None, None);

        let merged = SystemProxyEnv::merge(env, platform);

        assert_eq!(merged.http_proxy.as_deref(), Some("http://env:3128"));
        assert_eq!(
            merged.https_proxy.as_deref(),
            Some("http://127.0.0.1:47134"),
            "环境变量只填了 http 一侧时，https 一侧仍由平台值补上"
        );
    }

    /// `ProxyServer` 的分协议写法（`http=...;https=...`）按协议拆开。
    #[test]
    fn a_per_scheme_proxy_server_is_split_by_scheme() {
        let platform = PlatformProxySettings::from_raw(
            Some("http=plain:3128;https=secure:3129".into()),
            None,
            None,
        );

        assert_eq!(platform.http_proxy.as_deref(), Some("http://plain:3128"));
        assert_eq!(platform.https_proxy.as_deref(), Some("http://secure:3129"));
    }

    /// 只配了自动代理配置（PAC）的机器：`ProxyEnable` 常是 0，静态代理为空，
    /// 而 PAC 地址必须被读到——否则那台机器上「跟随系统」仍然什么都拿不到。
    #[test]
    fn a_platform_pac_url_is_picked_up_without_a_static_proxy() {
        let platform = PlatformProxySettings::from_raw(
            None,
            Some("  http://xxxxx.com/xxx.pac  ".into()),
            None,
        );

        let merged = SystemProxyEnv::merge(SystemProxyEnv::from_pairs(&[]), platform);

        assert_eq!(merged.pac_url.as_deref(), Some("http://xxxxx.com/xxx.pac"));
        assert_eq!(merged.http_proxy, None, "只配了 PAC 的机器不该凭空多出静态代理");
        assert_eq!(merged.https_proxy, None);
    }

    /// 空串与全空白不算"配了代理"，`<local>` 在读进来时被丢掉。
    #[test]
    fn blank_registry_values_do_not_count_as_configured() {
        let platform = PlatformProxySettings::from_raw(
            Some("   ".into()),
            Some(String::new()),
            Some("<local>".into()),
        );

        let merged = SystemProxyEnv::merge(SystemProxyEnv::from_pairs(&[]), platform);

        assert!(merged.is_empty(), "空值不该被当成配置：{merged:?}");
    }

    // -----------------------------------------------------------------------
    // 代理决定的投影（design D5）
    // -----------------------------------------------------------------------

    /// 投影里**没有凭据**：地址之外什么凭据都不带。
    ///
    /// 发送路径上的 `ProxyDecision::Use` 带着明文用户名与口令，投影是它的另一个面向；
    /// 若两者共用一个类型，"记得剔除凭据"就成了一条纪律而不是结构性事实。
    #[test]
    fn the_decision_view_carries_no_credentials() {
        let mut proxy = ProxyConfig::manual("http://user:pass@10.0.0.1:8080");
        proxy.username = Some("proxy-user".into());
        proxy.password = Some("proxy-pass-8f3a1c".into());
        let resolved = ResolvedProxy {
            layer: ProxyLayer::Request,
            config: proxy.clone(),
        };

        let view = decide_outcome(
            Some(&proxy),
            "http://example.test/x",
            &SystemProxyEnv::default(),
        )
        .view(Some(&resolved));

        assert_eq!(view.layer, Some(ProxyLayer::Request));
        assert_eq!(view.mode, Some(ProxyMode::Manual));
        assert_eq!(view.reason, ProxyReason::Manual);
        assert_eq!(
            view.proxy_url.as_deref(),
            Some("http://10.0.0.1:8080"),
            "地址里的 user:pass@ 也要摘掉"
        );

        let text = serde_json::to_string(&view).expect("可序列化");
        assert!(!text.contains("proxy-user"), "投影里不该出现用户名：{text}");
        assert!(
            !text.contains("proxy-pass-8f3a1c"),
            "投影里不该出现口令：{text}"
        );
        assert!(!text.contains("user:pass"), "地址里的凭据也不该出现：{text}");
    }

    /// 决定要说清「怎么定下来的」——尤其命中白名单时，结果虽是直连，原因不是"没配代理"。
    #[test]
    fn the_decision_view_explains_why() {
        let proxy = ProxyConfig {
            mode: ProxyMode::Manual,
            url: Some("http://proxy:8080".into()),
            no_proxy: vec!["internal.test".into()],
            ..ProxyConfig::default()
        };
        let resolved = ResolvedProxy {
            layer: ProxyLayer::Global,
            config: proxy.clone(),
        };

        let direct = decide_outcome(
            Some(&proxy),
            "http://internal.test/x",
            &SystemProxyEnv::default(),
        )
        .view(Some(&resolved));
        assert_eq!(direct.reason, ProxyReason::Whitelisted);
        assert_eq!(direct.proxy_url, None, "命中白名单时结果是直连");
        assert_eq!(
            direct.layer,
            Some(ProxyLayer::Global),
            "层级仍然说清是哪一层定的"
        );

        let proxied = decide_outcome(
            Some(&proxy),
            "http://public.test/x",
            &SystemProxyEnv::default(),
        )
        .view(Some(&resolved));
        assert_eq!(proxied.reason, ProxyReason::Manual);
        assert_eq!(proxied.proxy_url.as_deref(), Some("http://proxy:8080"));
    }

    /// 各层都没配时，结果是直连且原因写明「未配置」；层级不必硬编一个出来。
    #[test]
    fn nothing_configured_is_reported_as_such() {
        let view =
            decide_outcome(None, "http://example.test/x", &SystemProxyEnv::default()).view(None);

        assert_eq!(view.reason, ProxyReason::Unconfigured);
        assert_eq!(view.proxy_url, None);
        assert_eq!(view.layer, None, "没有生效的层级时不该编一个出来");
        assert_eq!(view.mode, None);
    }

    /// 走系统设置时，层级记作「系统」而不是"配了 System 的那一层"。
    #[test]
    fn the_system_source_is_reported_as_the_system_layer() {
        let proxy = ProxyConfig::system();
        let resolved = ResolvedProxy {
            layer: ProxyLayer::Request,
            config: proxy.clone(),
        };
        let system = SystemProxyEnv::from_pairs(&[("http_proxy", "http://sys:3128")]);

        let view = decide_outcome(Some(&proxy), "http://example.test/x", &system).view(Some(&resolved));

        assert_eq!(view.layer, Some(ProxyLayer::System));
        assert_eq!(view.reason, ProxyReason::FromSystem);
        assert_eq!(view.proxy_url.as_deref(), Some("http://sys:3128"));
        assert_eq!(view.mode, Some(ProxyMode::System));
    }

    /// 代理决定进日志时**不带凭据**——地址里的与字段里的都不带。
    #[test]
    fn the_logged_decision_carries_no_credentials() {
        let sink = crate::logging::MemorySink::new();
        let log = crate::logging::Redactor::new(sink.clone());

        let proxy = ProxyConfig::manual("http://user:pass@10.0.0.1:8080");
        let resolved = ResolvedProxy {
            layer: ProxyLayer::Request,
            config: proxy.clone(),
        };
        let outcome = ProxyOutcome::one(
            ProxyDecision::Use {
                url: "http://user:pass@10.0.0.1:8080".into(),
                username: Some("proxy-user".into()),
                password: Some("proxy-pass-8f3a1c".into()),
            },
            ProxyReason::Manual,
        );

        log.log_proxy_decision(&outcome.view(Some(&resolved)));

        let text = sink.joined();
        assert!(text.contains("proxy decision"), "应当记下这条决定：{text}");
        assert!(text.contains("http://10.0.0.1:8080"), "地址要留下：{text}");
        assert!(!text.contains("proxy-user"), "用户名不该进日志：{text}");
        assert!(
            !text.contains("proxy-pass-8f3a1c"),
            "口令不该进日志：{text}"
        );
        assert!(!text.contains("user:pass"), "地址里的凭据也要摘掉：{text}");
    }

    // -----------------------------------------------------------------------
    // PAC 的接入（design D10 / D11）
    // -----------------------------------------------------------------------

    /// `ProxyMode::Pac` 没填地址时与"手工填写没填地址"同款：不生效，顺位到更低层级。
    #[test]
    fn a_pac_mode_without_an_address_falls_through() {
        let empty = ProxyConfig {
            mode: ProxyMode::Pac,
            ..ProxyConfig::default()
        };
        assert!(!empty.is_effective(), "没填 PAC 地址就没有可执行的意图");

        let resolved = resolve_proxy(
            Some(&empty),
            None,
            Some(&ProxyConfig::manual("http://global:1")),
        );
        assert_eq!(
            resolved.unwrap().url.as_deref(),
            Some("http://global:1"),
            "应当顺位到更低层级"
        );
    }

    /// 显式 PAC 覆盖系统配置里的自动代理——两者是同一个求值器的两种来源（design D10）。
    #[test]
    fn an_explicit_pac_source_beats_the_system_one() {
        let explicit = ProxyConfig::pac("http://explicit/p.pac");
        let system = SystemProxyEnv::from_pairs(&[("pac_url", "http://system/p.pac")]);

        assert_eq!(
            pac_source(Some(&explicit), &system).as_deref(),
            Some("http://explicit/p.pac")
        );
        assert_eq!(
            pac_source(Some(&ProxyConfig::system()), &system).as_deref(),
            Some("http://system/p.pac"),
            "「跟随系统」才读系统配置里的自动代理"
        );
        assert_eq!(
            pac_source(Some(&ProxyConfig::manual("http://p:1")), &system),
            None,
            "显式的手工代理不该被系统配置里的 PAC 接管"
        );
    }

    /// PAC 的跳表转成决定序列：`DIRECT` 项不产生代理，各形态带对协议头。
    #[test]
    fn pac_hops_become_a_decision_plan() {
        let hops = vec![
            pac::PacHop::Direct,
            pac::PacHop::Http("a:8080".into()),
            pac::PacHop::Socks5("b:1080".into()),
        ];

        let plan = plan_from_hops(&hops);
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0], ProxyDecision::Direct);

        match &plan[1] {
            ProxyDecision::Use {
                url,
                username,
                password,
            } => {
                assert_eq!(url, "http://a:8080");
                assert!(
                    username.is_none() && password.is_none(),
                    "PAC 结果里的凭据不在这里再拆一份明文出来"
                );
            }
            other => panic!("期望 Use，得到 {other:?}"),
        }
        match &plan[2] {
            ProxyDecision::Use { url, .. } => assert_eq!(url, "socks5://b:1080"),
            other => panic!("期望 Use，得到 {other:?}"),
        }
    }

    /// PAC 的返回值允许带凭据（`PROXY user:pass@host:port`），决定里**不能**带着它。
    #[test]
    fn a_pac_result_carrying_credentials_shows_none_of_it() {
        let hops = vec![pac::PacHop::Http("user:pass@10.0.0.1:8080".into())];
        let plan = plan_from_hops(&hops);
        let outcome = ProxyOutcome::one(plan[0].clone(), ProxyReason::Pac);
        let resolved = ResolvedProxy {
            layer: ProxyLayer::Request,
            config: ProxyConfig::pac("http://p.ac/p.pac"),
        };

        let view = outcome.view(Some(&resolved));
        assert_eq!(view.proxy_url.as_deref(), Some("http://10.0.0.1:8080"));

        let text = serde_json::to_string(&view).expect("可序列化");
        assert!(!text.contains("user:pass"), "PAC 结果里的凭据不该出现：{text}");
        assert!(!text.contains("pass@"), "口令片段也不该出现：{text}");
    }
}
