//! PAC（代理自动配置）的求值、解析与取用（本变更 design D2 / D3 / D4）。
//!
//! PAC 是**从网络取回的代码**，求值它等于在应用进程里执行远端内容。因此这里做三件事：
//! 把求值关进只带 PAC helper 的上下文、给求值加硬性限额、把返回值解析成可执行的降级链。
//!
//! 求值必须在后端：请求由后端挂载代理，若由渲染进程给出"这次走哪个代理"，
//! `http-engine`「网络访问边界」所要求的"请求绕不过后端的代理配置"就会失效。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use boa_engine::{Context, JsResult, JsString, JsValue, NativeFunction, Source};

/// 一次求值的 wall-clock 预算。
///
/// 它是**兜底**：真正拦住死循环的是下面的循环迭代上限（事后看表拦不住已经卡住的东西）。
/// 但仍要留着——一次不含循环的巨型字符串运算同样能耗掉可观的时间。
const EVAL_BUDGET: Duration = Duration::from_secs(2);

/// 循环迭代上限：死循环由它兜住，且它是确定性的（可断言）。
const LOOP_ITERATION_LIMIT: u64 = 1_000_000;
const RECURSION_LIMIT: usize = 256;
const STACK_SIZE_LIMIT: usize = 1024 * 1024;

/// 求值结果的长度上限。PAC 的返回值只该是一小段 `PROXY a:8080; DIRECT`。
const MAX_RESULT_LEN: usize = 4096;

/// 解析主机名时的等待上限。系统解析器自己不给时限，因此这里给它一个。
const DNS_TIMEOUT: Duration = Duration::from_secs(3);

/// PAC 缓存存活时长。到期重新取一次——PAC 是会变的（运维改规则、切服务器），
/// 永久缓存会让"改了 PAC 却还是老样子"变成一个查不出来的怪现象。
const PAC_TTL: Duration = Duration::from_secs(300);
const PAC_FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// PAC 正文的体积上限。它是"配置"，不是数据文件。
const MAX_PAC_BYTES: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// 返回值解析（降级链）
// ---------------------------------------------------------------------------

/// PAC 返回值里的一项。`;` 分隔的降级链就是这些按序排列。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PacHop {
    Direct,
    /// HTTP 代理（`PROXY` / `HTTP`）。
    Http(String),
    /// HTTPS 代理（`HTTPS`）。
    Https(String),
    /// SOCKS4（`SOCKS` 与 `SOCKS4`；与 Chromium 的取向一致）。
    Socks4(String),
    /// SOCKS5（`SOCKS5`）。
    Socks5(String),
}

impl PacHop {
    /// 转成网络栈能直接用的代理地址；`Direct` 没有地址。
    pub fn proxy_url(&self) -> Option<String> {
        match self {
            PacHop::Direct => None,
            PacHop::Http(host) => Some(format!("http://{}", host)),
            PacHop::Https(host) => Some(format!("https://{}", host)),
            PacHop::Socks4(host) => Some(format!("socks4://{}", host)),
            PacHop::Socks5(host) => Some(format!("socks5://{}", host)),
        }
    }
}

/// 解析 PAC 的返回值：分号分隔，按序即为降级顺序。
///
/// 认不出的项被**丢掉**，而不是当成 `DIRECT`：把 `FOO bar` 读成"直连"会让用户以为
/// 走了代理的事情静默变成直连，而丢掉它至少会让"没有可用项"这一事实浮出来。
pub fn parse_result(raw: &str) -> Vec<PacHop> {
    raw.split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }

            let (keyword, rest) = match entry.split_once(char::is_whitespace) {
                Some((keyword, rest)) => (keyword, rest.trim()),
                None => (entry, ""),
            };

            match keyword.to_ascii_uppercase().as_str() {
                "DIRECT" => Some(PacHop::Direct),
                "PROXY" | "HTTP" if !rest.is_empty() => Some(PacHop::Http(rest.to_string())),
                "HTTPS" if !rest.is_empty() => Some(PacHop::Https(rest.to_string())),
                "SOCKS" | "SOCKS4" if !rest.is_empty() => Some(PacHop::Socks4(rest.to_string())),
                "SOCKS5" if !rest.is_empty() => Some(PacHop::Socks5(rest.to_string())),
                _ => None,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

/// 求值失败的原因。
///
/// **每一项都不带求值器给的原文**：那段文本是 PAC 自己写的，让它流进日志等于给远端
/// 内容开了一条往应用日志里写字的通道（spec: PAC 求值的边界「PAC 正文不进日志」）。
/// 排查需要的"哪一类失败"由变体本身给出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacError {
    /// PAC 求值抛错（含触及限额被中止）。
    Threw,
    /// 返回值不是字符串，或超出长度上限。
    BadResult,
    /// 取 PAC 失败：网络、状态码，或正文超出体积上限。
    FetchFailed,
}

/// 一份已经取到手的 PAC 正文。
pub struct PacScript {
    source: String,
}

impl PacScript {
    pub fn new(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
        }
    }

    /// 对一次目标求值 `FindProxyForURL(url, host)`，得到降级链。
    pub fn evaluate(&self, url: &str, host: &str) -> Result<Vec<PacHop>, PacError> {
        Ok(parse_result(&self.evaluate_raw(url, host)?))
    }

    /// 求值并返回**原始返回值**（尚未解析成代理项）。
    ///
    /// 单独留出来是为了让 helper 的语义、以及"被求值的代码够得着什么"可以被直接断言
    /// ——把结果解析成代理项之后再断言，就只能靠"把答案编进代理地址"这类绕法了。
    ///
    /// 求值在只带 PAC helper 的上下文里进行：没有网络、没有文件、没有宿主对象。
    pub fn evaluate_raw(&self, url: &str, host: &str) -> Result<String, PacError> {
        // DNS 缓存的作用域是**这一次求值**：上一次的解析结果不该影响这一次。
        DNS_CACHE.with(|cache| cache.borrow_mut().clear());

        let mut context = Context::default();
        context
            .runtime_limits_mut()
            .set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
        context
            .runtime_limits_mut()
            .set_recursion_limit(RECURSION_LIMIT);
        context
            .runtime_limits_mut()
            .set_stack_size_limit(STACK_SIZE_LIMIT);

        install_helpers(&mut context);

        let started = Instant::now();

        // 先装上 helper 与 PAC 本身，再单独调用——分两步是为了让"求值 PAC"与"调用它"
        // 各自失败得清楚。
        let program = format!("{}\n{}", PAC_HELPERS, self.source);
        if context
            .eval(Source::from_bytes(program.as_bytes()))
            .is_err()
        {
            return Err(PacError::Threw);
        }

        // 参数按 JSON 字面量拼进去：字符串里的引号因此破坏不了语法。
        let call = format!(
            "FindProxyForURL({}, {})",
            json_literal(url),
            json_literal(host)
        );
        let Ok(value) = context.eval(Source::from_bytes(call.as_bytes())) else {
            return Err(PacError::Threw);
        };

        if started.elapsed() > EVAL_BUDGET {
            return Err(PacError::Threw);
        }

        let Some(text) = value.as_string().map(|text| text.to_std_string_escaped()) else {
            return Err(PacError::BadResult);
        };
        if text.len() > MAX_RESULT_LEN {
            return Err(PacError::BadResult);
        }

        Ok(text)
    }
}

/// 把字符串写成 JS 字符串字面量。
fn json_literal(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// PAC 规范里**纯逻辑**的那一部分 helper。
///
/// 写成 JS 而不是逐个注册 Rust 闭包：它们本身就是一段算法（IP 换算、通配、时间区间），
/// 用 JS 写更贴近规范原文；需要主机信息的那几个（`dnsResolve` / `isResolvable` /
/// `myIpAddress`）另由 Rust 提供。
///
/// **未实现的一项**：`dateRange`。它在规范里有多达十种参数形式、语义在实现之间并不
/// 一致，写一个"看起来对"的版本比不写更危险。因此它是**未定义**的：用到它的 PAC 会在
/// 求值时抛错，从而落到"按直连降级且决定中写明"，而不是给出一个错的答案。
const PAC_HELPERS: &str = r#"
function isPlainHostName(host) {
  return String(host).indexOf('.') === -1;
}

function dnsDomainIs(host, domain) {
  host = String(host);
  domain = String(domain);
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}

function localHostOrDomainIs(host, hostdom) {
  host = String(host);
  hostdom = String(hostdom);
  return host === hostdom || hostdom.indexOf(host + '.') === 0;
}

function dnsDomainLevels(host) {
  var count = 0;
  var text = String(host);
  for (var i = 0; i < text.length; i++) {
    if (text.charAt(i) === '.') count++;
  }
  return count;
}

function shExpMatch(str, shexp) {
  // 先把正则元字符按字面转义，再把规范的 `*` / `?` 换成对应的正则片段。
  var pattern = String(shexp).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + pattern + '$').test(String(str));
}

function _pacToLong(ip) {
  var parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  var value = 0;
  for (var i = 0; i < 4; i++) {
    var text = parts[i].trim();
    if (text === '' || !/^\d+$/.test(text)) return null;
    var octet = Number(text);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isInNet(host, pattern, mask) {
  var address = _pacToLong(host);
  if (address === null) {
    // 主机名先解析成地址；解析不出来按"不在网段内"处理（规范如此）
    var resolved = dnsResolve(host);
    if (resolved === null || resolved === undefined) return false;
    address = _pacToLong(resolved);
    if (address === null) return false;
  }

  var net = _pacToLong(pattern);
  var bits = _pacToLong(mask);
  if (net === null || bits === null) return false;
  return ((address & bits) >>> 0) === ((net & bits) >>> 0);
}

function _pacClock(gmt) {
  var now = new Date();
  return {
    day: gmt ? now.getUTCDay() : now.getDay(),
    seconds: (gmt ? now.getUTCHours() : now.getHours()) * 3600
      + (gmt ? now.getUTCMinutes() : now.getMinutes()) * 60
      + (gmt ? now.getUTCSeconds() : now.getSeconds())
  };
}

function _pacStripGmt(args) {
  if (args.length > 0 && String(args[args.length - 1]).toUpperCase() === 'GMT') {
    args.pop();
    return true;
  }
  return false;
}

function weekdayRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = _pacStripGmt(args);
  var days = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

  var from = days[String(args[0]).toUpperCase()];
  if (from === undefined) return false;
  var to = args.length > 1 ? days[String(args[1]).toUpperCase()] : from;
  if (to === undefined) return false;

  var today = _pacClock(gmt).day;
  // 允许跨周（如 FRI 到 MON）
  return from <= to ? (today >= from && today <= to) : (today >= from || today <= to);
}

function timeRange() {
  var args = Array.prototype.slice.call(arguments);
  var gmt = _pacStripGmt(args);
  if (args.length === 0 || args.length % 2 !== 0) return false;

  var half = args.length / 2;
  var nums = [];
  for (var i = 0; i < args.length; i++) nums.push(Number(args[i]));

  function toSeconds(part) {
    var h = part[0] || 0;
    var m = part[1] || 0;
    var s = part[2] || 0;
    return h * 3600 + m * 60 + s;
  }

  var now = _pacClock(gmt).seconds;
  return now >= toSeconds(nums.slice(0, half)) && now <= toSeconds(nums.slice(half));
}
"#;

/// 注册需要**主机信息**的那几个 helper。
///
/// 只有这几个用 Rust：它们够得着系统的解析器与本机地址，必须由我们给，而不能由被求值的
/// 代码自己去拿。除它们之外不注册任何东西——暴露面按清单给。
fn install_helpers(context: &mut Context) {
    let helpers: [(&str, usize, fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>); 4] = [
        ("dnsResolve", 1, js_dns_resolve),
        ("isResolvable", 1, js_is_resolvable),
        ("myIpAddress", 0, js_my_ip_address),
        ("alert", 1, js_alert),
    ];

    for (name, length, body) in helpers {
        // 注册失败只可能来自"这个上下文已经不可用"，那时后面的求值同样会失败，
        // 所以这里不单独报错——失败会从那一步的 `Err` 上体现出来。
        let _ = context.register_global_callable(
            JsString::from(name),
            length,
            NativeFunction::from_fn_ptr(body),
        );
    }
}

fn arg_string(args: &[JsValue], index: usize) -> Option<String> {
    args.get(index)
        .and_then(JsValue::as_string)
        .map(|text| text.to_std_string_escaped())
}

/// `dnsResolve(host)`：解析成 IPv4 字符串，解析不出返回 `null`（规范语义）。
fn js_dns_resolve(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let Some(host) = arg_string(args, 0) else {
        return Ok(JsValue::null());
    };

    Ok(match resolve_cached(&host) {
        // 规范里的 `dnsResolve` 只处理 IPv4
        Some(IpAddr::V4(ip)) => JsValue::from(JsString::from(ip.to_string())),
        _ => JsValue::null(),
    })
}

/// `isResolvable(host)`：能否解析出地址。解析失败**不让整次求值失败**——一次 DNS
/// 抖动不该变成"连不上网"。
fn js_is_resolvable(_this: &JsValue, args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    let resolvable = arg_string(args, 0)
        .map(|host| resolve_cached(&host).is_some())
        .unwrap_or(false);

    Ok(JsValue::from(resolvable))
}

/// `myIpAddress()`：本机在默认出口方向上的地址。
///
/// 用"对外连一个 UDP 套接字再看本地端点"的经典办法：UDP 的 connect 不发包，只让内核
/// 选一条路由，因此不会真的产生流量。取不到就回落回环地址。
fn js_my_ip_address(
    _this: &JsValue,
    _args: &[JsValue],
    _context: &mut Context,
) -> JsResult<JsValue> {
    let ip = UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("198.51.100.1:9")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));

    Ok(JsValue::from(JsString::from(ip.to_string())))
}

/// `alert`：丢弃。
///
/// 它的内容由 PAC 写，而我们**不**把 PAC 写的东西放进日志（spec: PAC 正文不进日志），
/// 所以这里只吞掉、不转发。
fn js_alert(_this: &JsValue, _args: &[JsValue], _context: &mut Context) -> JsResult<JsValue> {
    Ok(JsValue::undefined())
}

thread_local! {
    /// 一次求值内的解析结果缓存。
    ///
    /// 求值跑在一条线程上，因此 thread_local 就是"这一次求值"的作用域——比给每个
    /// helper 传一个宿主对象更简单，也不给被求值的代码留下任何可触达的宿主状态。
    static DNS_CACHE: RefCell<BTreeMap<String, Option<IpAddr>>> = RefCell::new(BTreeMap::new());
}

fn resolve_cached(host: &str) -> Option<IpAddr> {
    DNS_CACHE.with(|cache| {
        if let Some(cached) = cache.borrow().get(host) {
            return *cached;
        }

        let resolved = resolve_host(host);
        cache.borrow_mut().insert(host.to_string(), resolved);
        resolved
    })
}

/// 解析主机名，带时限。
///
/// 走的是系统解析器（与网络栈同一条路径），因此它给出的正是真正会去连的地址。
/// 系统解析器本身不给时限，所以放到一条线程上等——超时就当解析不出来。
fn resolve_host(host: &str) -> Option<IpAddr> {
    let host = host.trim();
    if host.is_empty() {
        // 空名字交给系统解析器会拿到"任意地址"（0.0.0.0 / ::）——那是通配，不是解析成功。
        // 放过去会让 `isResolvable('')` 说 true、`isInNet` 拿 0.0.0.0 去比网段。
        return None;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }

    let owned = host.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(resolve_addresses(&owned));
    });

    rx.recv_timeout(DNS_TIMEOUT).ok().flatten()
}

/// 解析出地址，**优先 IPv4**。
///
/// `dnsResolve` 与 `isInNet` 都只处理 IPv4；一个名字同时有 AAAA 与 A 记录时，按"遇到
/// 的第一个"取很可能拿到 IPv6，于是这两个 helper 一起失灵（实测 `localhost` 就是这种
/// 情形）。优先取 A 记录更贴近 PAC 的预期——这不是忽略 IPv6，而是这两个 helper 的语义
/// 本来就只覆盖 IPv4。
fn resolve_addresses(host: &str) -> Option<IpAddr> {
    let addrs: Vec<SocketAddr> = (host, 0u16).to_socket_addrs().ok()?.collect();
    addrs
        .iter()
        .find(|addr| addr.is_ipv4())
        .or_else(|| addrs.first())
        .map(|addr| addr.ip())
}

// ---------------------------------------------------------------------------
// 取用与缓存
// ---------------------------------------------------------------------------

/// 一次取用的结果。
pub struct PacLoad {
    pub script: PacScript,
    /// 用的是不是**上一次成功取回的旧副本**（这次取新失败了）。
    ///
    /// 这个事实由调用方写进代理决定——降级与"用的是陈旧副本"都不静默。
    pub stale: bool,
}

/// PAC 的取用与缓存（design D4）。
pub struct PacStore {
    entries: Mutex<BTreeMap<String, CachedPac>>,
    ttl: Duration,
}

struct CachedPac {
    source: String,
    fetched_at: Instant,
}

impl Default for PacStore {
    fn default() -> Self {
        Self::new()
    }
}

impl PacStore {
    pub fn new() -> Self {
        Self::with_ttl(PAC_TTL)
    }

    /// 指定缓存存活时长。
    ///
    /// 留这个入口是为了让"回落上一次成功副本"这条能被**确定性**验证：正常 TTL 是五分钟，
    /// 测试等不起；给 `Duration::ZERO` 就等于每次都要重取。
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            ttl,
        }
    }

    /// 取回 PAC 正文，带 TTL 缓存。
    ///
    /// 取新失败时回落到上一次成功的那一份（`stale = true`）；一次都没成功过才报错。
    /// 拉取**直连**、不挂代理：否则要认代理得先有 PAC，循环。
    pub async fn load(&self, url: &str) -> Result<PacLoad, PacError> {
        if let Some(cached) = self.fresh(url) {
            return Ok(PacLoad {
                script: PacScript::new(cached),
                stale: false,
            });
        }

        match fetch(url).await {
            Ok(source) => {
                self.remember(url, &source);
                Ok(PacLoad {
                    script: PacScript::new(source),
                    stale: false,
                })
            }
            Err(error) => match self.last_known(url) {
                Some(source) => Ok(PacLoad {
                    script: PacScript::new(source),
                    stale: true,
                }),
                None => Err(error),
            },
        }
    }

    fn fresh(&self, url: &str) -> Option<String> {
        let entries = self.entries.lock().ok()?;
        let cached = entries.get(url)?;
        (cached.fetched_at.elapsed() < self.ttl).then(|| cached.source.clone())
    }

    fn last_known(&self, url: &str) -> Option<String> {
        self.entries.lock().ok()?.get(url).map(|c| c.source.clone())
    }

    fn remember(&self, url: &str, source: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                url.to_string(),
                CachedPac {
                    source: source.to_string(),
                    fetched_at: Instant::now(),
                },
            );
        }
    }
}

/// 直连取一份 PAC 正文。
async fn fetch(url: &str) -> Result<String, PacError> {
    let client = reqwest::Client::builder()
        // 拉 PAC 本身必须直连：走代理就成了"要认代理得先有 PAC"
        .no_proxy()
        .timeout(PAC_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| PacError::FetchFailed)?;

    let response = client.get(url).send().await.map_err(|_| PacError::FetchFailed)?;
    if !response.status().is_success() {
        return Err(PacError::FetchFailed);
    }

    // 不校验 MIME：现实中大量 PAC 以 text/plain 或 application/octet-stream 发出
    let body = response.bytes().await.map_err(|_| PacError::FetchFailed)?;
    if body.len() > MAX_PAC_BYTES {
        return Err(PacError::FetchFailed);
    }

    Ok(String::from_utf8_lossy(&body).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 包一份只写正文的 PAC。
    fn pac(body: &str) -> PacScript {
        PacScript::new(format!(
            "function FindProxyForURL(url, host) {{ {body} }}"
        ))
    }

    // -----------------------------------------------------------------------
    // 返回值解析与降级链（5.2）
    // -----------------------------------------------------------------------

    #[test]
    fn result_forms_are_parsed() {
        assert_eq!(parse_result("DIRECT"), vec![PacHop::Direct]);
        assert_eq!(
            parse_result("PROXY p:8080"),
            vec![PacHop::Http("p:8080".into())]
        );
        assert_eq!(
            parse_result("proxy p:8080"),
            vec![PacHop::Http("p:8080".into())],
            "关键字大小写不敏感"
        );
        assert_eq!(
            parse_result("HTTPS p:8443"),
            vec![PacHop::Https("p:8443".into())]
        );
        assert_eq!(
            parse_result("SOCKS p:1080"),
            vec![PacHop::Socks4("p:1080".into())]
        );
        assert_eq!(
            parse_result("SOCKS4 p:1080"),
            vec![PacHop::Socks4("p:1080".into())]
        );
        assert_eq!(
            parse_result("SOCKS5 p:1080"),
            vec![PacHop::Socks5("p:1080".into())]
        );
        assert_eq!(
            parse_result("  PROXY   p:8080  "),
            vec![PacHop::Http("p:8080".into())],
            "前后与中间的多余空白要容忍"
        );
    }

    #[test]
    fn the_chain_keeps_its_order() {
        assert_eq!(
            parse_result("PROXY a:8080; PROXY b:8080; DIRECT"),
            vec![
                PacHop::Http("a:8080".into()),
                PacHop::Http("b:8080".into()),
                PacHop::Direct,
            ]
        );
    }

    /// 认不出的项被丢掉，**不是**被读成直连。
    #[test]
    fn unknown_entries_are_dropped_rather_than_read_as_direct() {
        assert_eq!(parse_result("FOO bar"), Vec::<PacHop>::new());
        assert_eq!(
            parse_result("PROXY"),
            Vec::<PacHop>::new(),
            "缺地址不算一个可用项"
        );
        assert_eq!(parse_result(""), Vec::<PacHop>::new());
        assert_eq!(
            parse_result("FOO bar; DIRECT"),
            vec![PacHop::Direct],
            "认得出的项仍要留下"
        );
    }

    #[test]
    fn hop_urls_carry_the_scheme_the_network_stack_needs() {
        assert_eq!(
            PacHop::Http("p:8080".into()).proxy_url().as_deref(),
            Some("http://p:8080")
        );
        assert_eq!(
            PacHop::Https("p:8443".into()).proxy_url().as_deref(),
            Some("https://p:8443")
        );
        assert_eq!(
            PacHop::Socks4("p:1080".into()).proxy_url().as_deref(),
            Some("socks4://p:1080")
        );
        assert_eq!(
            PacHop::Socks5("p:1080".into()).proxy_url().as_deref(),
            Some("socks5://p:1080")
        );
        assert_eq!(PacHop::Direct.proxy_url(), None);
    }

    /// 同一份 PAC 对不同目标给出不同结果——求值是**按目标**进行的。
    #[test]
    fn the_same_pac_can_answer_differently_per_target() {
        let script = PacScript::new(
            r#"
            function FindProxyForURL(url, host) {
              if (isInNet(host, '10.0.0.0', '255.0.0.0')) return 'DIRECT';
              return 'PROXY p:8080; DIRECT';
            }
            "#,
        );

        assert_eq!(
            script.evaluate("http://10.1.2.3/", "10.1.2.3").unwrap(),
            vec![PacHop::Direct]
        );
        assert_eq!(
            script.evaluate("http://public.test/", "public.test").unwrap(),
            vec![PacHop::Http("p:8080".into()), PacHop::Direct]
        );
    }

    // -----------------------------------------------------------------------
    // helper 与受限求值（5.1）
    // -----------------------------------------------------------------------

    #[test]
    fn host_helpers_follow_the_pac_semantics() {
        let script = PacScript::new(
            r#"
            function FindProxyForURL(url, host) {
              return [
                isPlainHostName('intranet'),
                isPlainHostName('a.test'),
                dnsDomainIs('x.foo.test', '.foo.test'),
                dnsDomainIs('foo.test', 'notfoo.test'),
                localHostOrDomainIs('foo', 'foo.test'),
                localHostOrDomainIs('bar', 'foo.test'),
                dnsDomainLevels('a.b.c'),
                shExpMatch('http://a.test/x', '*a.test/*'),
                shExpMatch('http://a.test/x', '*.other/*'),
                shExpMatch('a1.test', 'a?.test'),
                isInNet('10.1.2.3', '10.0.0.0', '255.0.0.0'),
                isInNet('11.1.2.3', '10.0.0.0', '255.0.0.0')
              ].join(',');
            }
            "#,
        );

        assert_eq!(
            script.evaluate_raw("http://a.test/x", "a.test").unwrap(),
            "true,false,true,false,true,false,2,true,false,true,true,false"
        );
    }

    /// 被求值的代码够不着宿主：没有进程、没有模块加载、没有网络 API。
    #[test]
    fn the_evaluated_script_cannot_reach_the_host() {
        let script = PacScript::new(
            r#"
            function FindProxyForURL(url, host) {
              return [
                typeof process,
                typeof require,
                typeof fetch,
                typeof XMLHttpRequest,
                typeof Deno,
                typeof globalThis
              ].join(',');
            }
            "#,
        );

        assert_eq!(
            script.evaluate_raw("http://a.test/", "a.test").unwrap(),
            // 最后一项是 object：JS 环境本身是正常的，少的是**宿主**那一层
            "undefined,undefined,undefined,undefined,undefined,object"
        );
    }

    /// 未实现的 helper 让求值抛错——于是落到"按直连降级且可见"，
    /// 而不是给出一个看起来对的错答案。
    #[test]
    fn an_unimplemented_helper_makes_the_evaluation_throw() {
        let script = pac("return dateRange(1, 31) ? 'PROXY a:1' : 'DIRECT';");
        assert_eq!(
            script.evaluate("http://a.test/", "a.test").unwrap_err(),
            PacError::Threw
        );
    }

    // -----------------------------------------------------------------------
    // 限额与失败（5.4）
    // -----------------------------------------------------------------------

    #[test]
    fn a_death_loop_is_aborted_instead_of_hanging() {
        let script = pac("while (true) {}");

        let started = Instant::now();
        let error = script.evaluate("http://a.test/", "a.test").unwrap_err();

        assert_eq!(error, PacError::Threw);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "应当被限额中止，而不是一直转下去"
        );
    }

    #[test]
    fn a_non_string_result_is_rejected() {
        assert_eq!(
            pac("return 42;")
                .evaluate("http://a.test/", "a.test")
                .unwrap_err(),
            PacError::BadResult
        );
        assert_eq!(
            pac("return undefined;")
                .evaluate("http://a.test/", "a.test")
                .unwrap_err(),
            PacError::BadResult
        );
    }

    #[test]
    fn an_over_long_result_is_rejected() {
        assert_eq!(
            pac("return 'PROXY ' + 'x'.repeat(5000);")
                .evaluate("http://a.test/", "a.test")
                .unwrap_err(),
            PacError::BadResult
        );
    }

    /// 求值抛错时**不把 PAC 自己写的文本**带上来：那等于给远端内容开了一条往
    /// 应用日志里写字的通道（spec: PAC 求值的边界「PAC 正文不进日志」）。
    #[test]
    fn a_throwing_pac_does_not_leak_its_own_text() {
        let script = pac("throw new Error('PAC_SENTINEL_9f3a');");

        let error = script.evaluate("http://a.test/", "a.test").unwrap_err();
        assert_eq!(error, PacError::Threw);

        let described = format!("{:?}", error);
        assert!(
            !described.contains("PAC_SENTINEL_9f3a"),
            "PAC 写的字符串不该跟着错误上来：{described}"
        );
    }

    /// 解析失败只影响用到它的那一项，**不让整次求值失败**——
    /// 否则一次 DNS 抖动就会变成"连不上网"。
    #[test]
    fn a_failed_host_lookup_does_not_fail_the_whole_evaluation() {
        let script = PacScript::new(
            r#"
            function FindProxyForURL(url, host) {
              if (isResolvable('')) return 'PROXY bad:1';
              if (isInNet('not-an-ip-literal', '10.0.0.0', '255.0.0.0')) return 'PROXY bad:2';
              if (dnsResolve('') !== null) return 'PROXY bad:3';
              return 'DIRECT';
            }
            "#,
        );

        assert_eq!(
            script.evaluate("http://a.test/", "a.test").unwrap(),
            vec![PacHop::Direct]
        );
    }

    /// 解析结果按"一次求值"缓存，且缓存给出的就是第一次的答案。
    ///
    /// 判据是**结果**而不是计时：计时在 CI 上不可靠，而缓存的作用正是让第二次与第一次
    /// 给出同一个答案。这里直接断言取用层，因此不依赖机器的解析行为。
    #[test]
    fn the_lookup_cache_answers_from_the_first_result() {
        DNS_CACHE.with(|cache| cache.borrow_mut().clear());

        assert_eq!(
            resolve_cached("127.0.0.1"),
            Some(IpAddr::from([127, 0, 0, 1]))
        );
        assert_eq!(
            resolve_cached("127.0.0.1"),
            Some(IpAddr::from([127, 0, 0, 1])),
            "第二次应给出同一个答案"
        );
    }

    /// `dnsResolve` 对 IP 字面量直接给回 IPv4 字符串；这不是 DNS 行为，因此与机器无关。
    #[test]
    fn dns_resolve_answers_for_an_ip_literal() {
        let script = PacScript::new(
            r#"
            function FindProxyForURL(url, host) {
              return [dnsResolve('10.1.2.3'), isResolvable('10.1.2.3')].join(',');
            }
            "#,
        );

        assert_eq!(
            script.evaluate_raw("http://a.test/", "a.test").unwrap(),
            "10.1.2.3,true"
        );
    }
}
