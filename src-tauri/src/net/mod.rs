//! 网络层：由 Rust 侧发起请求（design.md D9 / D11 / D12 / D13）。
//!
//! 前端没有任何发起网络请求的能力，所有出站流量都经 [`send_request`] 进入这里，
//! 并且必然经过变量解析、代理求解与脱敏日志出口。

pub mod auth;
pub mod body;
pub mod cookies;
pub mod headers;
pub mod limits;
pub mod proxy;
pub mod response;
pub mod uploads;

#[cfg(test)]
mod tests;

use crate::error::{classify_reqwest_error, describe_net_error, AppError, AppResult, ErrorCode};
use crate::logging;
use crate::secrets::KeyProvider;
use crate::storage::model::{AuthConfig, Environment, HttpVersion, KeyValue, SavedRequest};
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
    /// 迭代数据。
    #[serde(default)]
    pub data: BTreeMap<String, String>,
}

impl SendRequestInput {
    pub fn saved(id: impl Into<String>) -> Self {
        Self {
            saved_id: Some(id.into()),
            inline: None,
            environment_id: None,
            local: BTreeMap::new(),
            data: BTreeMap::new(),
        }
    }

    pub fn inline(request: SavedRequest) -> Self {
        Self {
            saved_id: None,
            inline: Some(request),
            environment_id: None,
            local: BTreeMap::new(),
            data: BTreeMap::new(),
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
    /// 证书校验被关闭时的显著警示。
    pub insecure_warning: bool,
    pub final_url: String,
    /// 本次请求是否经由代理发出。
    pub via_proxy: bool,
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

    let layers = variables::load_scope_layers(
        db,
        &workspace_id,
        Some(&request.collection_id),
        environment.as_ref().map(|env| env.id.as_str()),
        local,
        data,
        key_provider,
    )?;

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
pub fn preview(
    db: &Db,
    key_provider: &dyn KeyProvider,
    jar: Option<&cookies::CookieJar>,
    input: &SendRequestInput,
) -> AppResult<RequestPreview> {
    let request = resolve_request_source(db, input)?;
    let context = build_context(
        db,
        key_provider,
        &request,
        input.environment_id.as_deref(),
        input.local.clone(),
        input.data.clone(),
    )?;
    let mut payload = engine::preview_request(
        &request,
        &context.inherited_auth,
        &context.layers,
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
    input: &SendRequestInput,
) -> AppResult<ResponsePayload> {
    let request = resolve_request_source(db, input)?;

    // Cookie：装载持久 Cookie（幂等）→ 发送（reqwest 自动附带并处理每一跳的
    // set-cookie）→ 同步回库。顺序是硬性的：同步必须发生在响应处理完之后。
    jar.ensure_loaded(db, key_provider)?;

    let context = build_context(
        db,
        key_provider,
        &request,
        input.environment_id.as_deref(),
        input.local.clone(),
        input.data.clone(),
    )?;

    let resolved = engine::resolve_request(&request, &context.inherited_auth, &context.layers);

    // 代理：请求 > 环境 > 全局，再结合系统设置与白名单
    let system_proxy = proxy::SystemProxyEnv::from_env();
    let proxy_config = proxy::resolve_proxy_for_request(
        db,
        &resolved.settings,
        context.environment.as_ref().map(|env| env.id.as_str()),
    )?;
    let decision = proxy::decide(proxy_config.as_ref(), &resolved.url, &system_proxy);

    let client = build_client(&resolved, &decision, Some(jar.provider()))?;

    // 认证可能落在查询串上
    let auth_application = auth::apply(&resolved.auth)?;
    let url = if auth_application.query.is_empty() {
        resolved.url.clone()
    } else {
        upsert_query(&resolved.url, &auth_application.query)?
    };

    let method = reqwest::Method::from_bytes(resolved.method.as_bytes()).map_err(|_| {
        AppError::new(
            ErrorCode::RequestBuild,
            format!("请求方法无法使用：{}", resolved.method),
        )
    })?;

    let mut builder = client.request(method, &url);

    let content_type_configured = resolved
        .headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));

    for (name, value) in &resolved.headers {
        headers::validate_header(name, value)?;
        builder = builder.header(name.as_str(), value.as_str());
    }
    for (name, value) in &auth_application.headers {
        headers::validate_header(name, value)?;
        builder = builder.header(name.as_str(), value.as_str());
    }

    let built = body::build(&resolved.body, uploads, content_type_configured).await?;
    builder = match built {
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
    };

    let started = Instant::now();
    logging::global().log_request_start(
        &resolved.method,
        &url,
        &resolved.header_names(),
    );

    let via_proxy = matches!(decision, ProxyDecision::Use { .. });
    let mut response = builder.send().await.map_err(|err| map_net_error(err, via_proxy))?;
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
    let captured = response::read_body(&mut response, limit, &store.spill_path(&id)).await?;

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
        insecure_warning: resolved.settings.needs_insecure_warning(),
        final_url,
        via_proxy: matches!(decision, ProxyDecision::Use { .. }),
        http_version: negotiated_version,
        unresolved: resolved.unresolved.clone(),
    };

    logging::global().log_response_summary(status.as_u16(), elapsed.as_millis(), total);
    store.store(&id, captured)?;

    // 响应可能带来了 set-cookie（含过期删除指令）；此刻 jar 已是最新，落库
    jar.sync_to_db(db, key_provider)?;

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

fn build_client<C: reqwest::cookie::CookieStore + 'static>(
    resolved: &ResolvedRequest,
    decision: &ProxyDecision,
    cookie_provider: Option<Arc<C>>,
) -> AppResult<reqwest::Client> {
    let timeout = Duration::from_millis(
        resolved
            .settings
            .timeout_ms
            .unwrap_or(limits::DEFAULT_TIMEOUT_MS),
    );

    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(!resolved.settings.verify_tls)
        .timeout(timeout)
        .redirect(if resolved.settings.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        });

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

    if let ProxyDecision::Use {
        url,
        username,
        password,
    } = decision
    {
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

    builder.build().map_err(|err| {
        AppError::new(
            ErrorCode::RequestBuild,
            format!("无法初始化网络客户端：{}", err),
        )
    })
}

/// 把网络错误映射为稳定分类，并在消息上过一遍脱敏出口。
///
/// 配置了代理时，连接阶段的失败连的是代理而不是目标，因此归为代理错误；
/// DNS 与 TLS 失败仍按各自类别报告——它们与是否使用代理无关。
pub(crate) fn map_net_error(err: reqwest::Error, via_proxy: bool) -> AppError {
    let mut code = classify_reqwest_error(&err);
    if via_proxy && matches!(code, ErrorCode::ConnectionRefused | ErrorCode::ConnectionFailed) {
        code = ErrorCode::ProxyError;
    }
    let message = logging::global().redact_text(&describe_net_error(&err));
    AppError::new(code, message)
}

/// 供命令层判断「哪些取值是 secret」，用于界面掩码。
pub fn is_secret_name(layers: &ScopeLayers, name: &str) -> bool {
    layers.is_secret(name)
}

/// 未使用占位，保持 `ResolvedBody`/`ResolvedAuth` 的公开性对命令层可见。
#[allow(dead_code)]
fn _type_anchors(_: ResolvedBody, _: ResolvedAuth) {}
