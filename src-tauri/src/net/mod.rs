//! 网络层：由 Rust 侧发起请求（design.md D9 / D11 / D12 / D13）。
//!
//! 前端没有任何发起网络请求的能力，所有出站流量都经 [`send_request`] 进入这里，
//! 并且必然经过变量解析、代理求解与脱敏日志出口。

pub mod auth;
pub mod body;
pub mod cancel;
pub mod cookies;
pub mod headers;
pub mod limits;
pub mod pac;
pub mod proxy;
pub mod response;
pub mod uploads;

#[cfg(test)]
mod tests;

use crate::error::{
    classify_reqwest_error, describe_failure, describe_net_error, AppError, AppResult, ErrorCode,
};
use crate::logging;
use crate::secrets::KeyProvider;
use crate::storage::model::{
    AuthConfig, Environment, HttpVersion, KeyValue, ProxyDecisionView, SavedRequest,
};
use crate::storage::variables::ScopeLayers;
use crate::storage::{variables, workspace, Db};
use crate::url_util;
use crate::variables::{self as engine, ResolvedAuth, ResolvedBody, ResolvedRequest, RequestPreview};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use proxy::ProxyDecision;
use response::ResponseStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use uploads::UploadRegistry;

/// 内联返回给前端的正文前缀上限；更多内容经分段命令取回。
pub const INLINE_PREVIEW_LIMIT: usize = 1024 * 1024;

/// 一次发送请求的输入。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendRequestInput {
    /// 已保存请求的 id；与 `inline` 二选一（design D9）。
    pub saved_id: Option<String>,
    /// 内联载荷：未保存的编辑态，不落库。
    pub inline: Option<SavedRequest>,
    /// 指定环境；为空则用该工作区的活动环境。
    pub environment_id: Option<String>,
    /// 仅在本次执行期间有效的本地变量。
    #[serde(default)]
    pub local: BTreeMap<String, String>,
    /// `local` 里哪些名字来自 secret 变量。
    ///
    /// 这些取值由调用方在运行时提供（脚本阶段的内存作用域），数据库里没有它们的行，
    /// 因此脱敏所需的 `secret_names` 拿不到——必须由调用方一并给出，否则经此路径
    /// 参与解析的 secret 明文会以普通变量的身份进入日志与错误消息。
    #[serde(default)]
    pub local_secret_names: Vec<String>,
    /// 迭代数据。
    #[serde(default)]
    pub data: BTreeMap<String, String>,
    /// 变量未能解析时是否拒绝发出（spec: variable-engine「未解析变量提示」）。
    ///
    /// 缺省为**严格**：用户触发的发送在变量解析不出来时不发。脚本经 `pm.sendRequest`
    /// 发起的请求显式关掉它——与 Postman 一致，脚本自己的请求照发，占位符保留原文。
    #[serde(default = "default_strict_variables")]
    pub strict_variables: bool,
    /// 本次发送的会话标识（spec: http-engine「请求取消」）。
    ///
    /// 同一次发送里的主请求与脚本内 `pm.sendRequest` 发出的请求共用一个标识，取消按它
    /// 撤销该会话下的全部在飞请求。缺省时后端自取一个：只发一个请求的场景不必关心它。
    #[serde(default)]
    pub attempt_id: Option<String>,
}

/// `strict_variables` 的缺省值：严格。
fn default_strict_variables() -> bool {
    true
}

impl SendRequestInput {
    pub fn saved(id: impl Into<String>) -> Self {
        Self {
            saved_id: Some(id.into()),
            inline: None,
            environment_id: None,
            local: BTreeMap::new(),
            local_secret_names: Vec::new(),
            data: BTreeMap::new(),
            strict_variables: true,
            attempt_id: None,
        }
    }

    pub fn inline(request: SavedRequest) -> Self {
        Self {
            saved_id: None,
            inline: Some(request),
            environment_id: None,
            local: BTreeMap::new(),
            local_secret_names: Vec::new(),
            data: BTreeMap::new(),
            strict_variables: true,
            attempt_id: None,
        }
    }
}

/// 返回给前端的响应。
#[derive(Debug, Clone, Serialize)]
pub struct ResponsePayload {
    /// 用于后续分段取回与全文保存的句柄。
    pub id: String,
    pub status: u16,
    pub status_text: String,
    pub elapsed_ms: u128,
    /// 实际收到的正文总字节数。
    pub size_bytes: u64,
    /// 响应头里声明的长度（可能缺失）。
    pub declared_size_bytes: Option<u64>,
    /// 正文是否因超出上限被截断。
    pub truncated: bool,
    pub headers: Vec<(String, String)>,
    pub content_type: Option<String>,
    /// 正文前缀的文本形态（合法 UTF-8 时）。
    pub body_text: Option<String>,
    /// 正文前缀的 base64（非文本时）。
    pub body_base64: Option<String>,
    /// 是否仍提供结构化格式化视图。
    pub pretty_available: bool,
    pub pretty_print_threshold: u64,
    /// 本次实际生效的正文上限（字节）。界面据此说明「手里有多少」——上限现在是可配的，
    /// 界面不能再用缺省值当常数。
    pub size_limit_bytes: u64,
    /// 证书校验被关闭时的显著警示。
    pub insecure_warning: bool,
    pub final_url: String,
    /// 后端**实际用于发送**的请求目标（含认证落在查询串上的部分）。
    ///
    /// 与 `final_url` 不同：后者是重定向之后的地址。脚本的后置阶段要以本字段确定
    /// `pm.cookies` 的当前请求——前置脚本改写过目标变量时，两者并不是一回事
    /// （spec: pm-script-runtime「pm.cookies 的当前请求目标」）。
    pub request_url: String,
    /// 本次请求是否经由代理发出。
    pub via_proxy: bool,
    /// 本次发送的**代理决定**：直连还是经代理、由哪一层定、为什么。
    ///
    /// 与失败路径上挂的是同一次求解的产物，且**不含凭据**。
    pub proxy_decision: ProxyDecisionView,
    /// 实际协商到的协议版本。
    pub http_version: String,
    /// 解析时未能解析的变量名。
    pub unresolved: Vec<String>,
}

/// 把协议版本渲染成可读标签。
pub fn version_label(version: reqwest::Version) -> String {
    match version {
        reqwest::Version::HTTP_09 => "HTTP/0.9".into(),
        reqwest::Version::HTTP_10 => "HTTP/1.0".into(),
        reqwest::Version::HTTP_11 => "HTTP/1.1".into(),
        reqwest::Version::HTTP_2 => "HTTP/2".into(),
        reqwest::Version::HTTP_3 => "HTTP/3".into(),
        other => format!("{:?}", other),
    }
}

/// 执行一次请求所需的上下文。
struct SendContext {
    environment: Option<Environment>,
    inherited_auth: AuthConfig,
    layers: ScopeLayers,
}

fn build_context(
    db: &Db,
    key_provider: &dyn KeyProvider,
    request: &SavedRequest,
    environment_id: Option<&str>,
    local: BTreeMap<String, String>,
    // `local` 里哪些名字来自 secret；见 `SendRequestInput::local_secret_names`。
    local_secret_names: &[String],
    data: BTreeMap<String, String>,
) -> AppResult<SendContext> {
    let workspace_id = workspace_of(db, request)?;

    let environment = match environment_id {
        Some(id) => {
            let environment = variables::get_environment(db, id)?;
            if environment.workspace_id != workspace_id {
                return Err(AppError::invalid_input("环境不属于该请求所在的工作区"));
            }
            Some(environment)
        }
        None => variables::active_environment(db, &workspace_id)?,
    };

    let inherited_auth = inherited_auth(db, request)?;

    let mut layers = variables::load_scope_layers(
        db,
        &workspace_id,
        Some(&request.collection_id),
        environment.as_ref().map(|env| env.id.as_str()),
        local,
        data,
        key_provider,
    )?;

    // 本地作用域里的 secret 标记由调用方给出：这些取值来自脚本阶段的内存作用域，
    // 数据库里没有对应的行，`load_scope_layers` 无从得知它们是不是 secret。
    // 漏掉这一步，日志与错误消息的脱敏就会对这条路径失效。
    layers
        .secret_names
        .extend(local_secret_names.iter().cloned());

    Ok(SendContext {
        environment,
        inherited_auth,
        layers,
    })
}

/// 请求所属工作区。内联载荷可能没有归属，此时退回活动工作区。
fn workspace_of(db: &Db, request: &SavedRequest) -> AppResult<String> {
    if !request.collection_id.trim().is_empty() {
        return Ok(workspace::get_collection(db, &request.collection_id)?.workspace_id);
    }
    if let Some(active) = workspace::active(db)? {
        return Ok(active.id);
    }
    workspace::list(db)?
        .into_iter()
        .next()
        .map(|workspace| workspace.id)
        .ok_or_else(|| AppError::not_found("当前没有可用的工作区"))
}

/// 集合 → 祖先文件夹（根到叶）叠加出的生效认证配置。
///
/// **不含**请求自身的认证：请求那一层由解析引擎叠加。
fn inherited_auth(db: &Db, request: &SavedRequest) -> AppResult<AuthConfig> {
    let mut chain = Vec::new();

    if !request.collection_id.trim().is_empty() {
        chain.push(workspace::get_collection(db, &request.collection_id)?.auth);
    }

    let mut ancestors = Vec::new();
    let mut cursor = request.folder_id.clone();
    let mut hops = 0usize;
    while let Some(id) = cursor {
        hops += 1;
        if hops > 512 {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "文件夹层级过深或存在环",
            ));
        }
        let folder = workspace::get_folder(db, &id)?;
        ancestors.push(folder.auth.clone());
        cursor = folder.parent_folder_id.clone();
    }
    ancestors.reverse();
    chain.extend(ancestors);

    Ok(engine::resolve_auth_chain(&chain))
}

/// 解析「这次要执行哪个请求」：已保存请求按 id 取，否则用内联载荷。
///
/// 两条入口除了来源不同，其余流程完全一致（design D9）。
pub fn resolve_request_source(db: &Db, input: &SendRequestInput) -> AppResult<SavedRequest> {
    match (&input.saved_id, &input.inline) {
        (Some(id), _) => crate::storage::requests::get_request(db, id),
        (None, Some(inline)) => Ok(inline.clone()),
        (None, None) => Err(AppError::invalid_input(
            "必须给出已保存请求 id 或内联请求载荷",
        )),
    }
}

/// 预览请求（只解析，不发送）。与真实发送共用同一解析实现与同一上下文构造。
///
/// `reveal` 决定 secret 取值以哪种形态呈现：`false` 给出掩码（界面浮层用，spec:
/// variable-engine「Secret 变量掩码」），`true` 给出真实取值（脚本据此构造 `pm.request`，
/// spec: pm-script-runtime「pm.request 的填充」）。两者是**同一次解析的两种呈现**——
/// 做成两条命令就会有两份真相，判定范围只要有一处分叉，界面与脚本看到的东西就会不同。
pub fn preview(
    db: &Db,
    key_provider: &dyn KeyProvider,
    jar: Option<&cookies::CookieJar>,
    input: &SendRequestInput,
    reveal: bool,
) -> AppResult<RequestPreview> {
    let request = resolve_request_source(db, input)?;
    let context = build_context(
        db,
        key_provider,
        &request,
        input.environment_id.as_deref(),
        input.local.clone(),
        &input.local_secret_names,
        input.data.clone(),
    )?;
    let mut payload = engine::preview_request(
        &request,
        &context.inherited_auth,
        &context.layers,
        reveal,
    );

    // 请求调试信息里的 Cookie 可见性（spec: Cookie 在请求中的自动附带）：
    // 与真实发送共用同一个 jar，因此这里列出的就是实际会带上的。
    if let Some(jar) = jar {
        payload.cookies = jar.matches_for_url(&payload.url);
    }

    Ok(payload)
}

/// 只解析、不发送：取回请求与其解析后的形态。
///
/// curl 导出需要与发送完全一致的解析结果（同一套作用域与继承认证），
/// 因此复用同一上下文构造，而不是另起一条解析路径。
pub fn resolve_for_export(
    db: &Db,
    key_provider: &dyn KeyProvider,
    input: &SendRequestInput,
) -> AppResult<(SavedRequest, engine::ResolvedRequest)> {
    let request = resolve_request_source(db, input)?;
    let context = build_context(
        db,
        key_provider,
        &request,
        input.environment_id.as_deref(),
        input.local.clone(),
        &input.local_secret_names,
        input.data.clone(),
    )?;
    let resolved = engine::resolve_request(&request, &context.inherited_auth, &context.layers);
    Ok((request, resolved))
}

/// 发送请求并返回响应。
pub async fn send_request(
    db: &Db,
    key_provider: &dyn KeyProvider,
    uploads: &UploadRegistry,
    store: &ResponseStore,
    jar: &cookies::CookieJar,
    sends: &Arc<cancel::SendRegistry>,
    pac_store: &pac::PacStore,
    input: &SendRequestInput,
) -> AppResult<ResponsePayload> {
    let request = resolve_request_source(db, input)?;

    // 本次发送的会话：取消按它撤销包括脚本内请求在内的全部在飞请求。
    // 句柄在函数返回时自动摘除，正常结束与取消走同一条收尾路径。
    let attempt_id = input
        .attempt_id
        .clone()
        .unwrap_or_else(crate::storage::new_id);
    let send = sends.open(&attempt_id);
    // 令牌副本要先落成变量：`send.token()` 是临时值，直接在 select! 里取会被提前释放
    let cancel_token = send.token();

    // Cookie：装载持久 Cookie（幂等）→ 发送（reqwest 自动附带并处理每一跳的
    // set-cookie）→ 同步回库。顺序是硬性的：同步必须发生在响应处理完之后。
    jar.ensure_loaded(db, key_provider)?;

    let context = build_context(
        db,
        key_provider,
        &request,
        input.environment_id.as_deref(),
        input.local.clone(),
        &input.local_secret_names,
        input.data.clone(),
    )?;

    let resolved = engine::resolve_request(&request, &context.inherited_auth, &context.layers);

    // 变量未能解析时不发出请求（spec: variable-engine「未解析变量提示」）。
    //
    // 位置是刻意的：解析已经完成、连接尚未建立。放在**这里**而不是前端，是为了让
    // 「判定用的那一份」与「真正要发出去的那一份」是同一个 resolved——前置脚本在
    // 此之前刚跑完，它写入的变量因此按已定义处理，不会再被拦下。
    if input.strict_variables && !resolved.unresolved.is_empty() {
        return Err(AppError::new(
            ErrorCode::UnresolvedVariables,
            format!(
                "以下变量未能解析，请求没有发出：{}",
                resolved.unresolved.join("、")
            ),
        ));
    }

    // 代理：请求 > 环境 > 全局，再结合系统设置与白名单
    //
    // 系统设置读的是**操作系统当前的代理配置**（Windows 上含静态代理与自动代理配置
    // 脚本），不只是环境变量——见 `SystemProxyEnv::from_platform`。读的是"此刻"，不是
    // 启动时固化。
    let system_proxy = proxy::SystemProxyEnv::from_platform();
    let proxy_config = proxy::resolve_proxy_for_request(
        db,
        &resolved.settings,
        context.environment.as_ref().map(|env| env.id.as_str()),
        key_provider,
    )?;

    // 代理决定在这里求解**一次**，然后同时挂到成功与失败两条路径上（design D6）。
    // 求解两次就是两份真相——PAC 会随时间变，失败之后重算未必等于当时那一个。
    let outcome = proxy::decide_with_pac(
        proxy_config.as_ref().map(|resolved| &resolved.config),
        &resolved.url,
        &system_proxy,
        pac_store,
    )
    .await;
    let decision_view = outcome.view(proxy_config.as_ref());

    // 失败路径上的错误由 `?` 直接抛出，所以先把决定备成一条可复用的包装。
    //
    // 它按**哪一跳**给视图：首选不通而落到后继项时，决定要说的是实际走的那一跳。
    logging::global().log_proxy_decision(&decision_view);
    let failure_with_hop = |index: usize, err: AppError| {
        err.with_proxy_decision(outcome.hopping(index).view(proxy_config.as_ref()))
    };

    // 超时：请求 > 应用级（spec: http-engine「请求级网络设置」）
    let timeout = limits::effective_timeout(db, &resolved.settings)?;

    // 认证可能落在查询串上
    let auth_application = auth::apply(&resolved.auth)?;
    let url = if auth_application.query.is_empty() {
        resolved.url.clone()
    } else {
        upsert_query(&resolved.url, &auth_application.query)?
    };

    // 逐跳尝试（design D11）。
    //
    // `reqwest` 的客户端没有"按顺序尝试"这个能力，所以 PAC 的降级链只能在这里走。
    // 只尝试一次是常态：非 PAC 的来源只有一跳，正文不可重放时也只给一次机会。
    let attempts = if resolved.body.is_replayable() {
        outcome.plan().len().min(MAX_PROXY_HOPS)
    } else {
        1
    };

    let started = Instant::now();
    logging::global().log_request_start(&resolved.method, &url, &resolved.header_names());

    let mut response = None;
    let mut last_failure: Option<(usize, AppError)> = None;
    let mut succeeded_index = 0usize;

    for (index, hop) in outcome.plan().iter().take(attempts).enumerate() {
        if send.is_cancelled() {
            return Err(send.cancelled_error());
        }

        let via_hop = hop.uses_proxy();
        let builder = build_attempt(
            &resolved,
            hop,
            timeout,
            Some(jar.provider()),
            uploads,
            &url,
            &auth_application.headers,
        )
        .await
        .map_err(|err| failure_with_hop(index, err))?;

        let sent = tokio::select! {
            result = builder.send() => result,
            _ = cancel_token.cancelled() => return Err(send.cancelled_error()),
        };

        match sent {
            Ok(value) => {
                succeeded_index = index;
                response = Some(value);
                break;
            }
            Err(err) => {
                let failure = map_net_error(err, via_hop);
                let can_retry = index + 1 < attempts && hop_unavailable(failure.code);
                last_failure = Some((index, failure));
                if !can_retry {
                    break;
                }
            }
        }
    }

    let mut response = match response {
        Some(response) => response,
        None => {
            let (index, failure) =
                last_failure.unwrap_or_else(|| (0, AppError::internal("没有可尝试的代理跳")));
            return Err(failure_with_hop(index, failure));
        }
    };

    // 实际走的是第几跳，决定就按第几跳呈现——否则决定会与实走的路径对不上
    // （spec: 代理决定的可见性）。
    let decision_view = if succeeded_index == 0 {
        decision_view
    } else {
        let effective = outcome.hopping(succeeded_index).view(proxy_config.as_ref());
        logging::global().log_proxy_decision(&effective);
        effective
    };
    let via_proxy = outcome.hopping(succeeded_index).primary().uses_proxy();
    let with_decision = |err: AppError| err.with_proxy_decision(decision_view.clone());
    let status = response.status();
    let negotiated_version = version_label(response.version());
    let final_url = response.url().to_string();
    let declared_size = response.content_length();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let response_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("<非文本值>").to_string(),
            )
        })
        .collect();

    let id = crate::storage::new_id();
    let limit = limits::response_size_limit(db)?;
    let spill_path = store.spill_path(&id);
    // 落盘副本在登记进仓库之前由守卫负责清理：取消或中途失败都不留残余
    let mut spill = response::SpillGuard::new(spill_path.clone());
    let captured = tokio::select! {
        result = response::read_body(&mut response, limit, &spill_path) => {
            result.map_err(|err| with_decision(err))?
        }
        _ = cancel_token.cancelled() => return Err(send.cancelled_error()),
    };

    let elapsed = started.elapsed();
    let total = captured.total_bytes;
    let truncated = captured.truncated;

    // 只把前缀交给前端；更多内容经 response_body_span 取回
    let preview_len = captured.bytes.len().min(INLINE_PREVIEW_LIMIT);
    let preview_bytes = &captured.bytes[..preview_len];
    let body_text = String::from_utf8(preview_bytes.to_vec()).ok();
    let body_base64 = if body_text.is_none() {
        Some(B64.encode(preview_bytes))
    } else {
        None
    };

    let pretty_threshold = limits::pretty_print_threshold(db)?;
    let payload = ResponsePayload {
        id: id.clone(),
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        elapsed_ms: elapsed.as_millis(),
        size_bytes: total,
        declared_size_bytes: declared_size,
        truncated,
        headers: response_headers,
        content_type,
        body_text,
        body_base64,
        pretty_available: total <= pretty_threshold,
        pretty_print_threshold: pretty_threshold,
        size_limit_bytes: limit,
        insecure_warning: resolved.settings.needs_insecure_warning(),
        final_url,
        // 实际用于发送的目标（认证落在查询串上的部分已经并入），与 final_url 不同：
        // 后者可能已被重定向改写
        request_url: url.clone(),
        via_proxy,
        http_version: negotiated_version,
        // 与失败路径上挂的是**同一份**决定（design D6）
        proxy_decision: decision_view.clone(),
        unresolved: resolved.unresolved.clone(),
    };

    logging::global().log_response_summary(status.as_u16(), elapsed.as_millis(), total);
    store
        .store(&id, captured)
        .map_err(|err| with_decision(err))?;
    // 落盘文件的所有权已交给仓库，守卫不再负责清理
    spill.disarm();

    // 响应可能带来了 set-cookie（含过期删除指令）；此刻 jar 已是最新，落库
    jar.sync_to_db(db, key_provider)
        .map_err(|err| with_decision(err))?;

    Ok(payload)
}

fn upsert_query(url: &str, pairs: &[(String, String)]) -> AppResult<String> {
    let (base, mut params) = url_util::split_url_query(url);
    for (key, value) in pairs {
        match params.iter_mut().find(|param| param.key == *key) {
            Some(existing) => existing.value = value.clone(),
            None => params.push(KeyValue::new(key.clone(), value.clone())),
        }
    }
    url_util::compose_url(&base, &params)
}

/// PAC 降级链最多尝试的跳数（design D11）。
///
/// 有界是必需的：一条长链逐跳串行尝试会把一次发送拖成多个连接超时相加，比直接失败更难用。
const MAX_PROXY_HOPS: usize = 3;

/// 这一跳"不可用"的判据：失败发生在**连接建立或解析**阶段。
///
/// 只在这一类失败上换跳。拿到响应就不再换——后端的 5xx 是服务的回答而不是代理不通，
/// 换个代理重发同一个请求会改变语义。两条特别排除：`TlsError` 多半是对端的问题，换跳法
/// 不会变好；`Timeout` 是应用级预算到期，预算本来就是**整次发送**的，已经花掉了。
fn hop_unavailable(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::ConnectionFailed
            | ErrorCode::ConnectionRefused
            | ErrorCode::ConnectionTimedOut
            | ErrorCode::ProxyError
            | ErrorCode::DnsFailure
    )
}

/// 组装**一次尝试**：客户端、请求头与正文。
///
/// 每跳一份——代理是挂在客户端上的，换一跳就得换一个客户端。正文也重新构造：可重放的
/// 载体不碰一次性句柄，重建没有副作用；不可重放的载体根本走不到第二跳（见调用处）。
#[allow(clippy::too_many_arguments)]
async fn build_attempt<C: reqwest::cookie::CookieStore + 'static>(
    resolved: &ResolvedRequest,
    decision: &ProxyDecision,
    timeout: Option<Duration>,
    cookie_provider: Option<Arc<C>>,
    uploads: &UploadRegistry,
    url: &str,
    auth_headers: &[(String, String)],
) -> AppResult<reqwest::RequestBuilder> {
    let client = build_client(resolved, decision, timeout, cookie_provider)?;

    let method = reqwest::Method::from_bytes(resolved.method.as_bytes()).map_err(|_| {
        AppError::new(
            ErrorCode::RequestBuild,
            format!("请求方法无法使用：{}", resolved.method),
        )
    })?;

    let mut builder = client.request(method, url);

    for (name, value) in &resolved.headers {
        headers::validate_header(name, value)?;
        builder = builder.header(name.as_str(), value.as_str());
    }
    for (name, value) in auth_headers {
        headers::validate_header(name, value)?;
        builder = builder.header(name.as_str(), value.as_str());
    }

    let content_type_configured = resolved
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));

    let built = body::build(&resolved.body, uploads, content_type_configured).await?;

    Ok(match built {
        body::BuiltBody::None => builder,
        body::BuiltBody::Bytes { data, content_type } => {
            if let Some(content_type) = content_type {
                builder = builder.header("Content-Type", content_type);
            }
            builder.body(data)
        }
        body::BuiltBody::Form(pairs) => builder.form(&pairs),
        body::BuiltBody::Multipart(form) => builder.multipart(*form),
        body::BuiltBody::Stream { body, content_type } => {
            if let Some(content_type) = content_type {
                builder = builder.header("Content-Type", content_type);
            }
            builder.body(body)
        }
    })
}

/// 组装请求客户端。
///
/// 代理决定与超时都由调用方 resolve 好后传入（两者同形），因此这里不读任何应用设置；
/// `timeout` 为 `None` 表示不设超时。
fn build_client<C: reqwest::cookie::CookieStore + 'static>(
    resolved: &ResolvedRequest,
    decision: &ProxyDecision,
    timeout: Option<Duration>,
    cookie_provider: Option<Arc<C>>,
) -> AppResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(!resolved.settings.verify_tls)
        .redirect(if resolved.settings.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        });

    //「不限制」时不调用 `.timeout()`：reqwest 的默认正是不设超时，显式塞一个超大值
    // 只会把意图藏起来。
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }

    if let Some(provider) = cookie_provider {
        // 每一跳都按新目标重新计算 Cookie（reqwest 内建行为，spec: 重定向后按新目标重新匹配）
        builder = builder.cookie_provider(provider);
    }

    match resolved.settings.http_version {
        HttpVersion::Auto => {}
        HttpVersion::Http1 => builder = builder.http1_only(),
        HttpVersion::Http2 => {
            // 强制 HTTP/2（prior knowledge）需要 reqwest 的 `http2` 特性，而它要求
            // 的 `h2` 版本在当前依赖镜像中不存在，因此本构建无法强制 HTTP/2。
            // 这里显式降级并留下记录，而不是静默忽略用户的设置。
            logging::global().warn(
                "请求设置为 HTTP/2，但当前构建不支持强制 HTTP/2，已退回默认协议协商",
            );
        }
    }

    match decision {
        // 直连必须在客户端上**显式**落地。
        //
        // reqwest 的 `auto_sys_proxy` 默认是 `true`，只有挂过显式代理才会被关掉；不显式
        // 关掉的话，「不使用代理」的实际含义就变成"环境变量里有代理则走它"，与 spec
        // 「三级代理」要求的"直接发出请求"不是一回事。这个偏差在本次把系统代理接进来
        // 之后更危险：直连会被隐式系统代理二次接管。
        ProxyDecision::Direct => {
            builder = builder.no_proxy();
        }
        ProxyDecision::Use {
            url,
            username,
            password,
        } => {
            let mut proxy = reqwest::Proxy::all(url.as_str()).map_err(|err| {
                AppError::new(
                    ErrorCode::ProxyError,
                    format!("代理配置无效：{}", err),
                )
            })?;
            if let Some(username) = username {
                proxy = proxy.basic_auth(username, password.as_deref().unwrap_or(""));
            }
            builder = builder.proxy(proxy);
        }
    }

    builder.build().map_err(|err| {
        AppError::new(
            ErrorCode::RequestBuild,
            format!("无法初始化网络客户端：{}", err),
        )
    })
}

/// 把网络错误映射为稳定分类，并在消息上过一遍脱敏出口。
///
/// 配置了代理时，连接阶段的失败连的是代理而不是目标，因此归为代理错误（连接建立超时
/// 同属这一类）；DNS 与 TLS 失败仍按各自类别报告——它们与是否使用代理无关。
pub(crate) fn map_net_error(err: reqwest::Error, via_proxy: bool) -> AppError {
    let mut code = classify_reqwest_error(&err);
    if via_proxy
        && matches!(
            code,
            ErrorCode::ConnectionRefused
                | ErrorCode::ConnectionFailed
                | ErrorCode::ConnectionTimedOut
        )
    {
        code = ErrorCode::ProxyError;
    }

    // 先补上「本次未经代理」这一事实，再过脱敏出口——顺序保证兜底清洗是最后一道。
    let described = describe_failure(code, via_proxy, &describe_net_error(&err));
    AppError::new(code, logging::global().redact_text(&described))
}

/// 供命令层判断「哪些取值是 secret」，用于界面掩码。
pub fn is_secret_name(layers: &ScopeLayers, name: &str) -> bool {
    layers.is_secret(name)
}

/// 未使用占位，保持 `ResolvedBody`/`ResolvedAuth` 的公开性对命令层可见。
#[allow(dead_code)]
fn _type_anchors(_: ResolvedBody, _: ResolvedAuth) {}
