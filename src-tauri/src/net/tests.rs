//! 网络层的集成测试：全部对本地测试服务器进行，不需要外部网络。

use super::*;
use crate::secrets::MemoryKeyProvider;
use crate::storage::model::{
    setting_keys, ApiKeyLocation, FormField, FormFieldKind, ProxyConfig, ProxyLayer, ProxyMode,
    ProxyReason, RawLanguage, RequestBody, Scope, TimeoutSetting,
};
use crate::storage::{requests, variables, workspace, Db};
use crate::testutil::{closed_port_addr, HttpsTestServer, Reply, TempDir, TestServer};
use std::sync::Arc;
use std::time::Duration;

/// 一份"不论目标是什么都返回这个结果"的 PAC。
fn pac_returning(result: &str) -> String {
    format!("function FindProxyForURL(url, host) {{ return '{result}'; }}")
}

struct Harness {
    db: Arc<Db>,
    key: Arc<MemoryKeyProvider>,
    uploads: UploadRegistry,
    responses: ResponseStore,
    cookies: cookies::CookieJar,
    sends: Arc<cancel::SendRegistry>,
    /// PAC 的取用与缓存。测试里也可以预先塞一份，避免真的去取。
    pac: pac::PacStore,
    workspace_id: String,
    collection_id: String,
    dir: TempDir,
}

impl Harness {
    fn new(tag: &str) -> Self {
        let dir = TempDir::new(tag);
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        let workspace_id = workspace::list(&db).unwrap().remove(0).id;
        let collection_id = workspace::create_collection(&db, &workspace_id, "集合")
            .unwrap()
            .id;
        let responses = ResponseStore::new(8, dir.join("responses"));

        Self {
            key: Arc::new(MemoryKeyProvider::from_bytes([42u8; 32])),
            db,
            uploads: UploadRegistry::new(),
            responses,
            cookies: cookies::CookieJar::new(),
            sends: Arc::new(cancel::SendRegistry::new()),
            pac: pac::PacStore::new(),
            workspace_id,
            collection_id,
            dir,
        }
    }

    fn request(&self, name: &str, method: &str, url: &str) -> SavedRequest {
        requests::create_request(&self.db, &self.collection_id, None, name, method, url)
            .expect("创建请求")
    }

    fn save(&self, request: &SavedRequest) -> SavedRequest {
        requests::save_request(&self.db, request).expect("保存请求")
    }

    fn set_collection_auth(&self, auth: AuthConfig) {
        let encoded = serde_json::to_string(&auth).expect("序列化认证");
        self.db
            .write(|conn| {
                conn.execute(
                    "UPDATE collections SET auth = ?2 WHERE id = ?1",
                    rusqlite::params![self.collection_id, encoded],
                )?;
                Ok(())
            })
            .expect("写入集合认证");
    }

    fn global(&self, name: &str, value: &str) {
        variables::set_global(
            &self.db,
            &self.workspace_id,
            name,
            value,
            false,
            self.key.as_ref(),
        )
        .expect("写入全局变量");
    }

    async fn send(&self, input: &SendRequestInput) -> AppResult<ResponsePayload> {
        send_request(
            &self.db,
            self.key.as_ref(),
            &self.uploads,
            &self.responses,
            &self.cookies,
            &self.sends,
            &self.pac,
            input,
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// 5.1 两条执行入口共用一个实现
// ---------------------------------------------------------------------------

#[tokio::test]
async fn saved_and_inline_entry_points_share_one_execution_path() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-entry");

    let mut request = harness.request("R", "POST", &server.url("/echo"));
    request.headers = vec![KeyValue::new("X-Trace", "abc")];
    request.body = RequestBody::raw("{\"a\":1}", RawLanguage::Json);
    let saved = harness.save(&request);

    let by_id = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("按 id 发送");
    let by_inline = harness
        .send(&SendRequestInput::inline(saved.clone()))
        .await
        .expect("按内联载荷发送");

    assert_eq!(by_id.status, by_inline.status);

    let recorded = server.requests();
    assert_eq!(recorded.len(), 2);
    assert_eq!(recorded[0].method, recorded[1].method);
    assert_eq!(recorded[0].path, recorded[1].path);
    assert_eq!(recorded[0].header("x-trace"), recorded[1].header("x-trace"));
    assert_eq!(recorded[0].body, recorded[1].body);
    assert_eq!(recorded[0].header("content-type"), recorded[1].header("content-type"));
}

// ---------------------------------------------------------------------------
// 5.2 请求体类型
// ---------------------------------------------------------------------------

#[tokio::test]
async fn raw_languages_send_the_expected_content_types() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-raw");
    let mut request = harness.request("R", "POST", &server.url("/b"));

    for (language, expected) in [
        (RawLanguage::Json, "application/json"),
        (RawLanguage::Xml, "application/xml"),
        (RawLanguage::Html, "text/html"),
        (RawLanguage::Text, "text/plain"),
        (RawLanguage::Javascript, "application/javascript"),
    ] {
        request.body = RequestBody::raw("payload", language);
        let saved = harness.save(&request);
        harness
            .send(&SendRequestInput::saved(&saved.id))
            .await
            .expect("发送");

        let last = server.last_request();
        assert_eq!(last.body_text(), "payload");
        assert!(
            last.content_type().unwrap_or_default().starts_with(expected),
            "内容类型应为 {}，实际 {:?}",
            expected,
            last.content_type()
        );
    }
}

#[tokio::test]
async fn urlencoded_body_is_sent_as_a_form() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-urlencoded");
    let mut request = harness.request("R", "POST", &server.url("/f"));
    request.body = RequestBody::urlencoded(vec![
        KeyValue::new("a", "1"),
        KeyValue::new("b", "2 3"),
    ]);
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    let last = server.last_request();
    assert!(last
        .content_type()
        .unwrap_or_default()
        .starts_with("application/x-www-form-urlencoded"));
    assert!(last.body_text().contains("a=1"));
    assert!(last.body_text().contains("b=2+3"), "空格应被正确编码：{}", last.body_text());
}

#[tokio::test]
async fn multipart_form_carries_text_and_file_parts() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-multipart");

    let file = harness.dir.join("upload.txt");
    std::fs::write(&file, b"file-payload").expect("写入上传文件");
    let handle = harness.uploads.register(&file).expect("登记文件");

    let mut request = harness.request("R", "POST", &server.url("/m"));
    request.body = RequestBody::form(vec![
        FormField::text("note", "hi"),
        FormField {
            key: "file".into(),
            value: None,
            file_handle: Some(handle),
            description: Some("upload.txt".into()),
            kind: FormFieldKind::File,
            enabled: true,
        },
    ]);
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    let last = server.last_request();
    assert!(last
        .content_type()
        .unwrap_or_default()
        .starts_with("multipart/form-data"));
    let text = last.body_text();
    assert!(text.contains("note"), "应包含文本字段名");
    assert!(text.contains("hi"), "应包含文本字段值");
    assert!(text.contains("file-payload"), "应包含文件内容");
    assert!(text.contains("upload.txt"), "应包含文件名");
}

#[tokio::test]
async fn switching_to_no_body_carries_no_residue() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-nobody");
    let mut request = harness.request("R", "POST", &server.url("/n"));
    request.body = RequestBody::raw("{\"a\":1}", RawLanguage::Json);
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    request.body = RequestBody::none();
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    let last = server.last_request();
    assert!(last.body.is_empty(), "切换到无正文后不应携带原正文");
    assert!(last.header("content-type").is_none());
}

#[tokio::test]
async fn disabled_headers_and_params_are_not_sent() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-disabled");
    let mut request = harness.request("R", "GET", &server.url("/d"));
    request.params = vec![
        KeyValue::new("keep", "1"),
        KeyValue {
            key: "drop".into(),
            value: "2".into(),
            enabled: false,
            description: None,
        },
    ];
    request.headers = vec![KeyValue {
        key: "X-Off".into(),
        value: "1".into(),
        enabled: false,
        description: None,
    }];
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    let last = server.last_request();
    assert!(last.query_has("keep", "1"));
    assert!(!last.query.contains("drop"));
    assert!(last.header("x-off").is_none());
}

// ---------------------------------------------------------------------------
// 5.3 上传句柄
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_path_string_cannot_be_used_as_a_file_handle() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-handle-path");

    let mut request = harness.request("R", "POST", &server.url("/u"));
    request.body = RequestBody::form(vec![FormField {
        key: "file".into(),
        value: None,
        file_handle: Some("/etc/passwd".into()),
        description: None,
        kind: FormFieldKind::File,
        enabled: true,
    }]);
    let saved = harness.save(&request);

    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("路径字符串不应被接受");
    assert_eq!(err.code, ErrorCode::UploadHandleInvalid);
    assert_eq!(server.request_count(), 0, "不应发出任何请求");
}

#[tokio::test]
async fn a_file_handle_cannot_be_reused() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-handle-reuse");

    let file = harness.dir.join("once.txt");
    std::fs::write(&file, b"x").expect("写入文件");
    let handle = harness.uploads.register(&file).expect("登记文件");

    let mut request = harness.request("R", "POST", &server.url("/u"));
    request.body = RequestBody::form(vec![FormField {
        key: "file".into(),
        value: None,
        file_handle: Some(handle),
        description: None,
        kind: FormFieldKind::File,
        enabled: true,
    }]);
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首次发送成功");
    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("同一句柄不应能重复使用");
    assert_eq!(err.code, ErrorCode::UploadHandleConsumed);
}

// ---------------------------------------------------------------------------
// 5.4 代理
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_configured_proxy_is_actually_used() {
    let proxy = TestServer::start(Reply::ok("{\"from\":\"proxy\"}"));
    let harness = Harness::new("net-proxy-used");

    let mut request = harness.request("R", "GET", "http://nonexistent.invalid/thing");
    request.settings.proxy = Some(ProxyConfig::manual(proxy.base_url()));
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("经代理发送");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy, "应标记为经由代理");

    let recorded = proxy.last_request();
    assert!(
        recorded
            .raw_first_line
            .contains("http://nonexistent.invalid/thing"),
        "代理应收到绝对形态的请求行：{}",
        recorded.raw_first_line
    );
}

/// 凭据读不出来时不阻止请求发出，只是这一次不带代理认证
/// （spec: http-engine「三级代理」）。
#[tokio::test]
async fn an_unreadable_proxy_credential_does_not_block_the_request() {
    let proxy = TestServer::start(Reply::ok("{\"from\":\"proxy\"}"));
    let harness = Harness::new("net-proxy-credential-unreadable");

    let mut request = harness.request("R", "GET", "http://nonexistent.invalid/thing");
    let mut config = ProxyConfig::manual(proxy.base_url());
    config.username = Some("u".into());
    // 密文在、可读标记为真，但内容解不开
    config.password_enc = Some("bm90LWEtY2lwaGVydGV4dA==".into());
    config.password_readable = true;
    request.settings.proxy = Some(config);
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("凭据不可读不应让请求失败");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy, "仍应经代理发出");

    let recorded = proxy.last_request();
    assert!(
        recorded.header("proxy-authorization").is_none(),
        "读不出来的凭据不应退化成一次空密码认证"
    );
}

#[tokio::test]
async fn no_proxy_whitelist_sends_directly() {
    let proxy = TestServer::start(Reply::ok("{}"));
    let target = TestServer::start(Reply::ok("{\"from\":\"target\"}"));
    let harness = Harness::new("net-noproxy");

    let mut request = harness.request("R", "GET", &target.url("/direct"));
    let mut config = ProxyConfig::manual(proxy.base_url());
    config.no_proxy = vec!["127.0.0.1".into()];
    request.settings.proxy = Some(config);
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert!(!payload.via_proxy);
    assert_eq!(target.request_count(), 1, "目标服务器应收到请求");
    assert_eq!(proxy.request_count(), 0, "命中白名单时不应经过代理");
}

#[tokio::test]
async fn request_level_proxy_overrides_the_global_one() {
    let request_proxy = TestServer::start(Reply::ok("{}"));
    let global_proxy = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-proxy-precedence");

    variables::set_global_proxy(&harness.db, Some(ProxyConfig::manual(global_proxy.base_url())))
        .expect("设置全局代理");

    let mut request = harness.request("R", "GET", "http://nonexistent.invalid/x");
    request.settings.proxy = Some(ProxyConfig::manual(request_proxy.base_url()));
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(request_proxy.request_count(), 1);
    assert_eq!(global_proxy.request_count(), 0, "请求级应覆盖全局");
}

// ---------------------------------------------------------------------------
// 5.5 认证
// ---------------------------------------------------------------------------

#[tokio::test]
async fn auth_modes_land_on_the_wire() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-auth-modes");
    let mut request = harness.request("R", "GET", &server.url("/a"));

    request.auth = AuthConfig::basic("user", "pass");
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();
    let last = server.last_request();
    assert_eq!(last.header("authorization"), Some("Basic dXNlcjpwYXNz"));

    request.auth = AuthConfig::bearer("tok-123");
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();
    let last = server.last_request();
    assert_eq!(last.header("authorization"), Some("Bearer tok-123"));

    request.auth = AuthConfig::api_key("X-Api-Key", "k-1", ApiKeyLocation::Header);
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();
    let last = server.last_request();
    assert_eq!(last.header("x-api-key"), Some("k-1"));

    request.auth = AuthConfig::api_key("apiKey", "k-2", ApiKeyLocation::Query);
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();
    let last = server.last_request();
    assert!(last.query_has("apiKey", "k-2"), "API Key 应进入查询串");
    assert!(last.header("x-api-key").is_none(), "放入查询时不应再进请求头");
}

#[tokio::test]
async fn request_inherits_collection_auth() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-auth-inherit");
    harness.set_collection_auth(AuthConfig::basic("col-user", "col-pass"));

    let mut request = harness.request("R", "GET", &server.url("/i"));
    request.auth = AuthConfig::default(); // inherit
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();

    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode("col-user:col-pass")
    );
    let last = server.last_request();
    assert_eq!(last.header("authorization"), Some(expected.as_str()));
}

#[tokio::test]
async fn auth_fields_accept_variable_references() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-auth-vars");
    harness.global("token", "resolved-token");

    let mut request = harness.request("R", "GET", &server.url("/v"));
    request.auth = AuthConfig::bearer("{{token}}");
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .unwrap();
    let last = server.last_request();
    assert_eq!(last.header("authorization"), Some("Bearer resolved-token"));
}

// ---------------------------------------------------------------------------
// 5.6 TLS
// ---------------------------------------------------------------------------

#[tokio::test]
async fn certificate_validation_is_on_by_default_and_can_be_disabled_per_request() {
    let server =
        HttpsTestServer::start("{\"tls\":true}").expect("启动自签 HTTPS 测试服务器");
    let harness = Harness::new("net-tls");

    let mut request = harness.request("R", "GET", &server.url("/s"));
    let saved = harness.save(&request);

    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("默认应拒绝自签证书");
    assert_eq!(err.code, ErrorCode::TlsError);

    request.settings.verify_tls = false;
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("关闭校验后应可连接");

    assert_eq!(payload.status, 200);
    assert!(
        payload.insecure_warning,
        "关闭证书校验的请求必须带显著警示"
    );
    assert!(payload.body_text.unwrap_or_default().contains("tls"));
}

// ---------------------------------------------------------------------------
// 5.7 响应元数据与视图
// ---------------------------------------------------------------------------

#[tokio::test]
async fn response_metadata_and_body_are_reported() {
    let body = "{\n  \"a\": 1\n}";
    let server = TestServer::start(Reply::with_content_type(body, "application/json"));
    let harness = Harness::new("net-meta");

    let request = harness.request("R", "GET", &server.url("/m?x=1"));
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(payload.status, 200);
    assert_eq!(payload.status_text, "OK");
    assert_eq!(payload.content_type.as_deref(), Some("application/json"));
    assert_eq!(payload.size_bytes, body.len() as u64);
    assert_eq!(payload.declared_size_bytes, Some(body.len() as u64));
    assert!(!payload.truncated);
    assert!(payload.pretty_available, "小响应应提供格式化视图");
    assert!(payload.unresolved.is_empty());
    assert_eq!(
        payload.body_text.as_deref(),
        Some(body),
        "原始视图应保持原样"
    );
    let last = server.last_request();
    assert!(last.query_has("x", "1"));
}

#[tokio::test]
async fn protocol_version_setting_is_applied_and_reported() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-version");
    let mut request = harness.request("R", "GET", &server.url("/v"));

    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");
    assert_eq!(payload.http_version, "HTTP/1.1");

    // 强制 HTTP/1
    request.settings.http_version = HttpVersion::Http1;
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");
    assert_eq!(payload.http_version, "HTTP/1.1");

    // HTTP/2 在当前依赖条件下被显式降级，但请求本身仍应成功
    request.settings.http_version = HttpVersion::Http2;
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("降级后仍可发送");
    assert_eq!(payload.http_version, "HTTP/1.1");
}

#[tokio::test]
async fn non_utf8_bodies_are_reported_as_base64() {
    let server = TestServer::start(Reply::with_content_type(
        vec![0xff, 0xfe, 0x00, 0x01],
        "application/octet-stream",
    ));
    let harness = Harness::new("net-binary-resp");

    let request = harness.request("R", "GET", &server.url("/bin"));
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert!(payload.body_text.is_none());
    assert!(payload.body_base64.is_some(), "非文本正文应给出 base64");
}

// ---------------------------------------------------------------------------
// 5.8 体积上限
// ---------------------------------------------------------------------------

#[tokio::test]
async fn oversized_response_is_truncated_but_full_text_survives() {
    const LIMIT: usize = 64 * 1024;
    let total = 300 * 1024;
    let server = TestServer::start(Reply::Sized { bytes: total });
    let harness = Harness::new("net-oversize");

    variables::set_setting(
        &harness.db,
        "global",
        setting_keys::RESPONSE_SIZE_LIMIT,
        &LIMIT.to_string(),
    )
    .expect("设置上限");
    variables::set_setting(
        &harness.db,
        "global",
        setting_keys::PRETTY_PRINT_THRESHOLD,
        &(32 * 1024).to_string(),
    )
    .expect("设置格式化阈值");

    let request = harness.request("R", "GET", &server.url("/big"));
    let saved = harness.save(&request);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(payload.size_bytes, total as u64, "元数据应完整");
    assert_eq!(payload.declared_size_bytes, Some(total as u64));
    assert!(payload.truncated, "应被标记为已截断");
    assert!(
        !payload.pretty_available,
        "超出格式化阈值时不应提供结构化视图"
    );
    assert_eq!(payload.body_text.as_ref().unwrap().len(), LIMIT);

    // 分段取回：内存前缀之外的字节来自落地文件
    let span = harness
        .responses
        .span(&payload.id, LIMIT as u64, 1024)
        .expect("分段取回");
    assert_eq!(span.length, 1024);
    assert!(span.truncated);

    // 全文保存
    let out = harness.dir.join("full.bin");
    let written = harness
        .responses
        .save_full(&payload.id, &out)
        .expect("保存全文");
    assert_eq!(written, total as u64);
    assert_eq!(std::fs::metadata(&out).unwrap().len(), total as u64);
}

// ---------------------------------------------------------------------------
// 超时的两层解析（spec: http-engine「请求级网络设置」）
// ---------------------------------------------------------------------------

/// 应用级超时确实到达了客户端，且能表达「不限制」。
#[tokio::test]
async fn the_app_level_timeout_applies_and_can_be_disabled() {
    let harness = Harness::new("net-app-timeout");
    let slow = TestServer::start(Reply::Delay {
        millis: 600,
        body: b"{}".to_vec(),
    });
    let saved = harness.save(&harness.request("R", "GET", &slow.url("/slow")));
    let input = SendRequestInput::saved(&saved.id);

    // 应用级 200 毫秒：「跟随全局」的请求被中止
    variables::set_setting(&harness.db, "global", setting_keys::REQUEST_TIMEOUT, "200").unwrap();
    let err = harness.send(&input).await.expect_err("应超时");
    assert_eq!(err.code, ErrorCode::Timeout, "错误信息：{}", err.message);

    // 应用级改为「不限制」：同一个请求不再因时长被中止
    variables::set_setting(
        &harness.db,
        "global",
        setting_keys::REQUEST_TIMEOUT,
        limits::UNLIMITED_TIMEOUT,
    )
    .unwrap();
    let payload = harness.send(&input).await.expect("不限制时应拿到响应");
    assert_eq!(payload.status, 200);
}

// ---------------------------------------------------------------------------
// 请求取消（spec: http-engine「请求取消」）
// ---------------------------------------------------------------------------

/// 取消以可区分的结果结束（不是超时、也不是笼统的网络失败），会话登记随之清除。
#[tokio::test]
async fn a_cancelled_send_is_distinguishable_from_a_timeout() {
    let harness = Harness::new("net-cancel");
    let slow = TestServer::start(Reply::Delay {
        millis: 1_500,
        body: b"{}".to_vec(),
    });
    let saved = harness.save(&harness.request("R", "GET", &slow.url("/slow")));

    let mut input = SendRequestInput::saved(&saved.id);
    input.attempt_id = Some("attempt-cancel".into());

    let sends = harness.sends.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        sends.cancel("attempt-cancel");
    });

    let err = harness.send(&input).await.expect_err("应被取消");
    assert_eq!(err.code, ErrorCode::Cancelled, "错误信息：{}", err.message);
    assert_ne!(
        err.code,
        ErrorCode::Timeout,
        "取消必须与超时可区分"
    );
    assert_eq!(
        harness.sends.in_flight("attempt-cancel"),
        0,
        "会话登记应随请求结束而清除"
    );
}

/// 读正文途中取消：已落盘的正文副本必须被收尾，不留残余。
#[tokio::test]
async fn cancelling_mid_body_read_leaves_no_spilled_copy() {
    let harness = Harness::new("net-cancel-spill");
    // 上限调小，使正文必然落到磁盘
    variables::set_setting(
        &harness.db,
        "global",
        setting_keys::RESPONSE_SIZE_LIMIT,
        "1024",
    )
    .unwrap();

    // 声明 512 KiB 但只发 4 KiB：客户端会停在「等剩下的字节」上
    let server = TestServer::start(Reply::Truncated {
        declared: 512 * 1024,
        sent: vec![b'x'; 4096],
        hold_millis: 1_500,
    });
    let saved = harness.save(&harness.request("R", "GET", &server.url("/big")));

    let mut input = SendRequestInput::saved(&saved.id);
    input.attempt_id = Some("attempt-spill".into());

    let sends = harness.sends.clone();
    tokio::spawn(async move {
        // 等已发的字节落盘之后再取消
        tokio::time::sleep(Duration::from_millis(200)).await;
        sends.cancel("attempt-spill");
    });

    let err = harness.send(&input).await.expect_err("应被取消");
    assert_eq!(err.code, ErrorCode::Cancelled, "错误信息：{}", err.message);

    let leftovers: Vec<String> = std::fs::read_dir(harness.responses.temp_root())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();

    assert!(
        leftovers.is_empty(),
        "取消后不应残留未被采用的正文副本：{:?}",
        leftovers
    );
}

// ---------------------------------------------------------------------------
// 5.9 失败分类
// ---------------------------------------------------------------------------

#[tokio::test]
async fn failure_classes_are_distinguishable() {
    let harness = Harness::new("net-failures");

    // 超时
    let slow = TestServer::start(Reply::Delay {
        millis: 1_500,
        body: b"{}".to_vec(),
    });
    let mut request = harness.request("R", "GET", &slow.url("/slow"));
    request.settings.timeout = TimeoutSetting::Custom { ms: 300 };
    let saved = harness.save(&request);
    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("应超时");
    assert_eq!(err.code, ErrorCode::Timeout, "错误信息：{}", err.message);

    // 域名解析失败**不在这里**断言。"某个名字一定解析不出来"是与机器环境绑定的假设：
    // 跑着 TUN + fake-IP 的机器（Mihomo 一类）会把任意域名解析成保留段里的假地址，
    // NXDOMAIN 根本不会发生，这条断言在那类机器上必然失败。它守的东西并没有少测——
    // 见 `dns_failure_is_reported_as_a_dns_failure`：注入一个必定失败的解析器，
    // 让"解析失败"这件事由测试自己制造，而不是向环境借。

    // 连接被拒
    let addr = closed_port_addr();
    let saved = harness.save(&harness.request("R", "GET", &format!("http://{}/x", addr)));
    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("应被拒绝");
    assert_eq!(
        err.code,
        ErrorCode::ConnectionRefused,
        "错误信息：{}",
        err.message
    );
}

/// 域名解析失败被归为 `DnsFailure`。
///
/// **为什么注入解析器，而不是找一个"解析不出来"的名字**：后者是本机环境的假设。
/// 跑着 TUN + fake-IP 的机器会把任意域名解析成 `198.18.0.0/15` 的假地址，NXDOMAIN
/// 不会发生，于是把断言建立在一个真实域名能不能解析上，测试就会随机器而红。这里
/// 注入一个一律失败的解析器，"解析失败"由测试自己制造，与机器环境无关。
///
/// 覆盖的是「真实的 `reqwest::Error` → 分类」这一跳：解析失败在 reqwest 里**同时**
/// 是 connect 类错误，仍必须被识别成 `DnsFailure`，而不是被降级成笼统的连接失败
/// （见 `error.rs` 的 `classify_net_failure`）。
#[tokio::test]
async fn dns_failure_is_reported_as_a_dns_failure() {
    struct AlwaysFailsDns;

    impl reqwest::dns::Resolve for AlwaysFailsDns {
        fn resolve(&self, _name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            Box::pin(async {
                // 与 getaddrinfo 失败同形的错误：带一个不随界面语言变化的解析失败错误码
                Err(Box::new(std::io::Error::from_raw_os_error(11001))
                    as Box<dyn std::error::Error + Send + Sync>)
            })
        }
    }

    // `.no_proxy()`：这条用例管的是「解析失败怎么归类」，不该受进程环境变量里有没有
    // 代理影响——同一个进程里另有用例会临时设置 `HTTP_PROXY`。
    let client = reqwest::Client::builder()
        .dns_resolver(Arc::new(AlwaysFailsDns))
        .no_proxy()
        .build()
        .expect("构造客户端");

    let err = client
        .get("http://lookup-must-fail.test/x")
        .send()
        .await
        .expect_err("解析失败应使请求失败");

    assert_eq!(
        crate::error::classify_reqwest_error(&err),
        ErrorCode::DnsFailure,
        "错误信息：{}",
        crate::error::describe_net_error(&err)
    );
}

#[tokio::test]
async fn an_unreachable_proxy_is_reported_as_a_proxy_error() {
    let harness = Harness::new("net-proxy-fail");
    let dead_proxy = closed_port_addr();

    // 目标本身可解析，失败发生在连接代理这一段
    let mut request = harness.request("R", "GET", "http://127.0.0.1:1/x");
    request.settings.proxy = Some(ProxyConfig::manual(format!("http://{}", dead_proxy)));
    let saved = harness.save(&request);

    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("应失败");
    assert_eq!(err.code, ErrorCode::ProxyError, "错误信息：{}", err.message);
}

/// 进程级环境变量的锁。改环境变量的用例必须自己排队（当前只有两条会改：直连不理
/// 环境变量代理那条，与跟随系统读操作系统配置那条）。
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取锁，并从毒化中恢复。
///
/// 从毒化中恢复而不是连带失败：一条用例断言失败不该让另一条跟着报"锁中毒"——那样
/// 真正的失败原因会被埋在第二条的 panic 里，排查时看到的是一堆同源噪音。
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 「不使用代理」必须**真的**直连：进程环境变量里配了代理也不算。
///
/// reqwest 的 `auto_sys_proxy` 默认开着（只有挂过显式代理才会被关掉），所以不显式禁用
/// 的话，「不使用代理」的实际含义就变成"环境变量里有代理则走它"——用户在界面上选了
/// 直连，请求却从代理出去了。
///
/// 判别方式：让「目标服务器」与「环境变量里那个代理」是两台不同的本地服务器，请求
/// 落在哪一台，就说明了它到底是怎么出去的。
#[tokio::test]
async fn an_explicit_direct_decision_ignores_an_environment_proxy() {
    let _guard = env_lock();

    let proxy = TestServer::start(Reply::ok("{\"via\":\"proxy\"}"));
    let target = TestServer::start(Reply::ok("{\"via\":\"direct\"}"));
    let target_url = target.url("/x");

    let previous = std::env::var("HTTP_PROXY").ok();
    std::env::set_var("HTTP_PROXY", proxy.base_url());

    let harness = Harness::new("net-direct-ignores-env-proxy");
    let saved = harness.save(&harness.request("R", "GET", &target_url));
    let sent = harness.send(&SendRequestInput::saved(&saved.id)).await;

    // 先恢复环境变量再断言：断言失败也不能把这个进程级状态留下
    match previous {
        Some(value) => std::env::set_var("HTTP_PROXY", value),
        None => std::env::remove_var("HTTP_PROXY"),
    }

    let payload = sent.expect("直连应成功");
    assert_eq!(payload.status, 200);
    assert_eq!(target.request_count(), 1, "请求应当直接落在目标上");
    assert!(
        !target.last_request().raw_first_line.contains("http://"),
        "请求行应是直连形态，而不是代理形态：{}",
        target.last_request().raw_first_line
    );

    // 按「有没有为**本目标**转发的请求」判定，而不是数这台代理收到的请求总数：
    // 环境变量是进程级的，同一进程里别的用例的请求也可能被它送到这台代理上，
    // 用总数会在并行执行时误报。
    let forwarded = proxy
        .requests()
        .into_iter()
        .filter(|request| request.raw_first_line.contains(&target_url))
        .count();
    assert_eq!(forwarded, 0, "环境变量里的代理不该收到本目标的请求");
}

/// 把进程里可能存在的代理环境变量清空，析构时还原。
///
/// 要断言的是"环境变量为空时仍能读到系统配置"，因此不能假设开发机的 shell 里没有
/// `HTTP_PROXY`——在这类机器上它恰恰常常有。
struct ProxyEnvCleared {
    saved: Vec<(&'static str, Option<String>)>,
}

impl ProxyEnvCleared {
    fn take() -> Self {
        const NAMES: [&str; 4] = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"];
        let saved = NAMES
            .iter()
            .map(|name| {
                let previous = std::env::var(name).ok();
                std::env::remove_var(name);
                (*name, previous)
            })
            .collect();
        Self { saved }
    }
}

impl Drop for ProxyEnvCleared {
    fn drop(&mut self) {
        for (name, value) in &self.saved {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// 「跟随系统」读的是**操作系统配置**，不只是环境变量（spec: 三级代理）。
///
/// 注入一份"从注册表读到的"设置（静态代理指向第二个本地服务器），同时把进程里的
/// 代理环境变量清空——「环境变量为空、系统配置有代理」正是内网那台机器的形状。
/// 断言请求真的经那个代理发出：代理服务器看到的请求行是代理形态。
#[tokio::test]
async fn system_mode_uses_the_operating_system_proxy_not_only_the_environment() {
    let _env_guard = env_lock();
    let _cleared = ProxyEnvCleared::take();

    let proxy_server = TestServer::start(Reply::ok("{\"via\":\"system-proxy\"}"));
    let _platform = proxy::use_test_platform_proxy(proxy::PlatformProxySettings::from_raw(
        Some(proxy_server.base_url()),
        None,
        None,
    ));

    let harness = Harness::new("net-system-proxy");
    let mut request = harness.request("R", "GET", "http://example.test/x");
    request.settings.proxy = Some(ProxyConfig::system());
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("经系统代理应成功");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy, "响应元数据应标明经由代理");
    assert_eq!(proxy_server.request_count(), 1, "请求应当经系统代理发出");
    assert!(
        proxy_server
            .last_request()
            .raw_first_line
            .contains("http://example.test/x"),
        "代理看到的应是代理形态的请求行：{}",
        proxy_server.last_request().raw_first_line
    );
}

/// 响应里的代理决定必须**与实走的路径一致**（spec: 代理决定的可见性）。
#[tokio::test]
async fn the_response_reports_the_decision_that_was_actually_used() {
    let proxy = TestServer::start(Reply::ok("{\"via\":\"proxy\"}"));
    let target = TestServer::start(Reply::ok("{\"via\":\"direct\"}"));
    let proxy_url = proxy.base_url();
    let harness = Harness::new("net-decision-visible");

    // 经代理：层级、原因与地址都要对得上实走的那一份
    let mut by_proxy = harness.request("R1", "GET", "http://example.test/x");
    by_proxy.settings.proxy = Some(ProxyConfig::manual(proxy_url.clone()));
    let saved = harness.save(&by_proxy);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("应经代理成功");

    assert!(payload.via_proxy);
    assert_eq!(payload.proxy_decision.layer, Some(ProxyLayer::Request));
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Manual);
    assert_eq!(
        payload.proxy_decision.proxy_url.as_deref(),
        Some(proxy_url.as_str())
    );
    assert_eq!(proxy.request_count(), 1, "决定说的与实际走的必须是同一件事");

    // 命中白名单：结果是直连，原因是白名单——而不是"没配代理"
    let mut by_direct = harness.request("R2", "GET", &target.url("/x"));
    by_direct.settings.proxy = Some(ProxyConfig {
        mode: ProxyMode::Manual,
        url: Some(proxy_url.clone()),
        no_proxy: vec!["127.*".into()],
        ..ProxyConfig::default()
    });
    let saved = harness.save(&by_direct);
    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("应直连成功");

    assert!(!payload.via_proxy);
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Whitelisted);
    assert_eq!(payload.proxy_decision.proxy_url, None);
    assert_eq!(target.request_count(), 1, "白名单命中时应直接落在目标上");
}

/// 失败时同样要能看到这一次的代理决定，且**既有的错误形状不变**
/// （spec: 代理决定的可见性）。
#[tokio::test]
async fn a_failed_send_still_reports_the_decision() {
    let dead_proxy = format!("http://{}", closed_port_addr());
    let harness = Harness::new("net-decision-on-failure");

    let mut request = harness.request("R", "GET", "http://example.test/x");
    request.settings.proxy = Some(ProxyConfig::manual(dead_proxy.clone()));
    let saved = harness.save(&request);

    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("代理不可达应失败");
    assert_eq!(err.code, ErrorCode::ProxyError, "错误信息：{}", err.message);

    let value = serde_json::to_value(&err).expect("可序列化");
    assert_eq!(value["code"], "proxy_error", "code 的位置与含义不变");
    assert!(value["message"].is_string(), "message 照旧是字符串");

    let view = &value["proxy_decision"];
    assert_eq!(
        view["layer"], "request",
        "失败时也要说清是哪一层定的：{value}"
    );
    assert_eq!(view["reason"], "manual");
    assert_eq!(view["proxy_url"], dead_proxy.as_str());
}

// ---------------------------------------------------------------------------
// PAC 接入（5.6 / 5.7 / 5.3）
// ---------------------------------------------------------------------------

/// PAC 给了降级链时，发送路径**逐跳**走：首选不通就换下一跳，且决定呈现的是实际走的
/// 那一跳（design D11 / spec「降级链依序尝试」）。
#[tokio::test]
async fn a_pac_chain_is_walked_hop_by_hop() {
    let harness = Harness::new("net-pac-chain");
    let dead = closed_port_addr();
    let good = TestServer::start(Reply::ok("{\"via\":\"second\"}"));

    let good_authority = good.base_url().trim_start_matches("http://").to_string();
    let pac_server = TestServer::start(Reply::with_content_type(
        pac_returning(&format!("PROXY {dead}; PROXY {good_authority}")),
        "application/x-ns-proxy-autoconfig",
    ));
    let pac_url = pac_server.url("/proxy.pac");
    let expected_proxy = format!("http://{good_authority}");

    let mut request = harness.request("R", "GET", "http://example.test/x");
    request.settings.proxy = Some(ProxyConfig::pac(pac_url.clone()));
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首选不通应换下一跳，而不是直接失败");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy, "第二跳是代理，应标记为经由代理");
    assert_eq!(good.request_count(), 1, "请求应当经第二跳发出");
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Pac);
    assert_eq!(
        payload.proxy_decision.proxy_url.as_deref(),
        Some(expected_proxy.as_str()),
        "决定要说的是**实际走的那一跳**"
    );
    assert_eq!(
        payload.proxy_decision.pac_url.as_deref(),
        Some(pac_url.as_str())
    );
}

/// 显式填写的 PAC 覆盖系统配置里的自动代理（design D10）。
#[tokio::test]
async fn an_explicit_pac_overrides_the_system_one() {
    let _env_guard = env_lock();
    let _cleared = ProxyEnvCleared::take();
    let harness = Harness::new("net-pac-explicit");

    let target = TestServer::start(Reply::ok("{}"));
    let system_pac = TestServer::start(Reply::with_content_type(
        pac_returning("PROXY 127.0.0.1:1"),
        "application/x-ns-proxy-autoconfig",
    ));
    let explicit_pac = TestServer::start(Reply::with_content_type(
        pac_returning("DIRECT"),
        "application/x-ns-proxy-autoconfig",
    ));
    let _platform = proxy::use_test_platform_proxy(proxy::PlatformProxySettings::from_raw(
        None,
        Some(system_pac.url("/p.pac")),
        None,
    ));

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::pac(explicit_pac.url("/p.pac")));
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(explicit_pac.request_count(), 1, "显式 PAC 应被取用");
    assert_eq!(
        system_pac.request_count(),
        0,
        "系统配置里的 PAC 不该被取用"
    );
    assert!(!payload.via_proxy, "显式 PAC 说了 DIRECT");
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Pac);
}

/// 系统配置里是 PAC 时，「跟随系统」按它求值（spec「系统配置为 PAC 时按其求值」）。
#[tokio::test]
async fn the_system_pac_is_used_when_the_request_follows_the_system() {
    let _env_guard = env_lock();
    let _cleared = ProxyEnvCleared::take();
    let harness = Harness::new("net-pac-system");

    let target = TestServer::start(Reply::ok("{}"));
    let pac_server = TestServer::start(Reply::with_content_type(
        pac_returning("DIRECT"),
        "application/x-ns-proxy-autoconfig",
    ));
    let _platform = proxy::use_test_platform_proxy(proxy::PlatformProxySettings::from_raw(
        None,
        Some(pac_server.url("/p.pac")),
        None,
    ));

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::system());
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(pac_server.request_count(), 1, "应当取用系统配置里的 PAC");
    assert_eq!(payload.proxy_decision.layer, Some(ProxyLayer::System));
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Pac);
    assert_eq!(target.request_count(), 1);
}

/// TTL 之内不重复取 PAC（design D4）。
#[tokio::test]
async fn the_pac_is_fetched_once_within_its_ttl() {
    let harness = Harness::new("net-pac-cache");
    let target = TestServer::start(Reply::ok("{}"));
    let pac_server = TestServer::start(Reply::with_content_type(
        pac_returning("DIRECT"),
        "application/x-ns-proxy-autoconfig",
    ));

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::pac(pac_server.url("/p.pac")));
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首次发送");
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("再次发送");

    assert_eq!(pac_server.request_count(), 1, "TTL 之内不该重复取 PAC");
    assert_eq!(target.request_count(), 2);
}

/// PAC 取不到时按直连继续，且这个降级写进决定里（spec「PAC 拉取失败按直连继续」）。
#[tokio::test]
async fn an_unreachable_pac_continues_directly_and_says_so() {
    let harness = Harness::new("net-pac-unreachable");
    let target = TestServer::start(Reply::ok("{}"));
    let pac_url = format!("http://{}/p.pac", closed_port_addr());

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::pac(pac_url.clone()));
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("PAC 取不到不该让请求失败");

    assert_eq!(payload.status, 200);
    assert!(!payload.via_proxy, "取不到 PAC 就直连");
    assert_eq!(payload.proxy_decision.reason, ProxyReason::PacUnavailable);
    assert_eq!(payload.proxy_decision.proxy_url, None);
    assert_eq!(
        payload.proxy_decision.pac_url.as_deref(),
        Some(pac_url.as_str()),
        "降级不静默：来源仍要写出来"
    );
    assert_eq!(target.request_count(), 1);
}

/// 取新失败时沿用上一次成功取回的副本，且这个事实写进决定（design D4）。
#[tokio::test]
async fn a_failed_refresh_keeps_using_the_last_good_copy() {
    let mut harness = Harness::new("net-pac-stale");
    // 零 TTL：每次发送都重取——正常 TTL 是五分钟，等不起，而"回落"这条路只有重取失败
    // 才走得到。
    harness.pac = pac::PacStore::with_ttl(Duration::ZERO);

    let target = TestServer::start(Reply::ok("{}"));
    let pac_server = TestServer::start(Reply::with_content_type(
        pac_returning("DIRECT"),
        "application/x-ns-proxy-autoconfig",
    ));

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::pac(pac_server.url("/p.pac")));
    let saved = harness.save(&request);

    let first = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首次发送");
    assert_eq!(first.proxy_decision.reason, ProxyReason::Pac);
    assert!(!first.proxy_decision.pac_stale, "首次是新鲜取到的");

    // 让 PAC 服务器消失：这次取不到，应回落到上一次成功的那一份
    drop(pac_server);

    let second = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("回落到旧副本仍应发出");

    assert_eq!(second.status, 200);
    assert_eq!(second.proxy_decision.reason, ProxyReason::Pac);
    assert!(
        second.proxy_decision.pac_stale,
        "用的是旧副本，这个事实要说出来"
    );
}

/// 端到端：**系统配置注入的** PAC 指定了一个代理，请求就经它发出，决定也这么说（7.1）。
///
/// 与前面的两条例用分头覆盖了一半：`a_pac_chain_is_walked_hop_by_hop` 用显式 PAC 走多跳，
/// `the_system_pac_is_used_when_the_request_follows_the_system` 用系统 PAC 但只说 DIRECT。
/// 这一条把两端合起来——「跟随系统」读到的是 PAC，而 PAC 说走代理。
#[tokio::test]
async fn the_system_pac_can_send_the_request_through_a_proxy() {
    let _env_guard = env_lock();
    let _cleared = ProxyEnvCleared::take();
    let harness = Harness::new("net-pac-system-proxy");

    let proxy_server = TestServer::start(Reply::ok("{\"via\":\"pac-proxy\"}"));
    let proxy_authority = proxy_server
        .base_url()
        .trim_start_matches("http://")
        .to_string();
    let expected_proxy = format!("http://{proxy_authority}");
    let pac_server = TestServer::start(Reply::with_content_type(
        pac_returning(&format!("PROXY {proxy_authority}")),
        "application/x-ns-proxy-autoconfig",
    ));
    let pac_url = pac_server.url("/p.pac");
    let _platform = proxy::use_test_platform_proxy(proxy::PlatformProxySettings::from_raw(
        None,
        Some(pac_url.clone()),
        None,
    ));

    let mut request = harness.request("R", "GET", "http://example.test/x");
    request.settings.proxy = Some(ProxyConfig::system());
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("应经 PAC 指定的代理发出");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy);
    assert_eq!(payload.proxy_decision.layer, Some(ProxyLayer::System));
    assert_eq!(payload.proxy_decision.reason, ProxyReason::Pac);
    assert_eq!(
        payload.proxy_decision.proxy_url.as_deref(),
        Some(expected_proxy.as_str()),
        "决定给出的地址应当是实际走的那个"
    );
    assert_eq!(
        payload.proxy_decision.pac_url.as_deref(),
        Some(pac_url.as_str())
    );

    assert_eq!(proxy_server.request_count(), 1, "请求应当经该代理发出");
    assert!(
        proxy_server
            .last_request()
            .raw_first_line
            .contains("http://example.test/x"),
        "代理看到的应是代理形态的请求行：{}",
        proxy_server.last_request().raw_first_line
    );
}

/// PAC 的正文**不进日志**（spec: PAC 求值的边界）。
///
/// 把全局日志出口的下游换成内存捕获，跑一次完整的发送（取 PAC → 求值 → 发出），再看有没有
/// 任何一行提到 PAC 的正文。模块里本就没有记录正文的入口，这条用例把那件事钉住：日后有人
/// 顺手把正文打进日志，它会红。
#[tokio::test]
async fn the_pac_body_never_reaches_the_log() {
    /// 正文里的哨兵：任何一行日志提到它，就说明正文漏出去了。
    const SENTINEL: &str = "PAC_SENTINEL_9f3a";

    let sink = logging::MemorySink::new();
    logging::global().set_sink(sink.clone());

    let harness = Harness::new("net-pac-no-log");
    let target = TestServer::start(Reply::ok("{}"));
    let pac_server = TestServer::start(Reply::with_content_type(
        format!("// {SENTINEL}\n{}", pac_returning("DIRECT")),
        "application/x-ns-proxy-autoconfig",
    ));

    let mut request = harness.request("R", "GET", &target.url("/x"));
    request.settings.proxy = Some(ProxyConfig::pac(pac_server.url("/p.pac")));
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    // 还原全局出口，别把其它用例的日志也收进来
    logging::global().set_sink(Arc::new(logging::TracingSink));

    let text = sink.joined();
    assert!(
        text.contains("proxy decision"),
        "决定本身应当被记下，否则这条用例什么都没测到：{text}"
    );
    assert!(!text.contains(SENTINEL), "PAC 的正文不该进日志：{text}");
}

// ---------------------------------------------------------------------------
// 7.1 端到端串联
// ---------------------------------------------------------------------------

#[tokio::test]
async fn end_to_end_variables_proxy_and_metadata() {
    let proxy = TestServer::start(Reply::ok("{\"ok\":true}"));
    let harness = Harness::new("net-e2e");

    harness.global("host", "internal.example");
    harness.global("token", "abc-123");
    harness.global("id", "42");
    variables::set_global_proxy(&harness.db, Some(ProxyConfig::manual(proxy.base_url())))
        .expect("设置全局代理");

    let mut request = harness.request("R", "POST", "http://{{host}}/users/:id");
    request.params = vec![KeyValue::new("q", "{{token}}")];
    request.headers = vec![KeyValue::new("X-Token", "{{token}}")];
    request.body = RequestBody::raw("{\"n\":\"{{id}}\"}", RawLanguage::Json);
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("端到端发送");

    assert_eq!(payload.status, 200);
    assert!(payload.via_proxy);
    assert!(
        payload.unresolved.is_empty(),
        "不应有未解析变量：{:?}",
        payload.unresolved
    );
    assert!(payload.size_bytes > 0);
    assert_eq!(payload.content_type.as_deref(), Some("application/json"));

    let recorded = proxy.last_request();
    assert!(
        recorded
            .raw_first_line
            .contains("http://internal.example/users/42"),
        "占位符与路径变量都应替换：{}",
        recorded.raw_first_line
    );
    assert!(recorded.query_has("q", "abc-123"));
    assert_eq!(recorded.header("x-token"), Some("abc-123"));
    assert_eq!(recorded.body_text(), "{\"n\":\"42\"}");
}

#[tokio::test]
async fn secrets_are_masked_in_the_preview_but_used_for_real() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-secret-preview");

    variables::set_global(
        &harness.db,
        &harness.workspace_id,
        "apiKey",
        "SUPER_SECRET_1234",
        true,
        harness.key.as_ref(),
    )
    .expect("写入 secret 变量");

    let mut request = harness.request("R", "GET", &server.url("/s"));
    request.headers = vec![KeyValue::new("X-Api-Key", "{{apiKey}}")];
    let saved = harness.save(&request);

    let preview = preview(
        &harness.db,
        harness.key.as_ref(),
        None,
        &SendRequestInput::saved(&saved.id),
        false,
    )
    .expect("预览");
    assert!(preview.masked, "预览应标记存在被掩码的取值");
    assert_eq!(preview.headers[0].1, crate::logging::MASK);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");
    let last = server.last_request();
    assert_eq!(
        last.header("x-api-key"),
        Some("SUPER_SECRET_1234"),
        "实际请求应使用真实值"
    );
}

#[tokio::test]
async fn unresolved_variables_do_not_break_the_preview() {
    let harness = Harness::new("net-unresolved");
    let mut request = harness.request("R", "GET", "http://example.invalid/{{missing}}");
    request.params = vec![KeyValue::new("p", "{{alsoMissing}}")];
    let saved = harness.save(&request);

    let preview = preview(
        &harness.db,
        harness.key.as_ref(),
        None,
        &SendRequestInput::saved(&saved.id),
        false,
    )
    .expect("预览");
    assert!(preview.unresolved.contains(&"missing".to_string()));
    assert!(preview.unresolved.contains(&"alsoMissing".to_string()));
    assert!(preview.url.contains("{{missing}}"), "未解析变量应保留原文");
}

#[tokio::test]
async fn unresolved_variables_block_the_send_before_any_round_trip() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-strict-unresolved");
    let request = harness.request("R", "GET", &format!("{}/{{{{missing}}}}", server.base_url()));
    let saved = harness.save(&request);

    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("未解析变量应拦住本次发送");

    // 可辨识的错误码：界面据此把响应区留着，同时把变量名报出来
    assert_eq!(err.code, ErrorCode::UnresolvedVariables);
    assert!(err.message.contains("missing"), "错误里应点名未解析的变量");
    assert_eq!(server.request_count(), 0, "不应产生任何网络往返");
}

#[tokio::test]
async fn a_non_strict_send_goes_out_with_the_placeholder_kept() {
    // 脚本内 `pm.sendRequest` 走这条路：与 Postman 一致，脚本自己的请求照发
    // （spec: variable-engine「脚本发起的请求的变量解析」）
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-non-strict");
    let request = harness.request("R", "GET", &format!("{}/{{{{missing}}}}", server.base_url()));
    let saved = harness.save(&request);

    let mut input = SendRequestInput::saved(&saved.id);
    input.strict_variables = false;

    harness.send(&input).await.expect("非严格模式照发");
    assert_eq!(server.request_count(), 1, "占位符照原样发出去");
}

#[tokio::test]
async fn local_secret_names_keep_masking_for_values_that_never_reached_the_database() {
    let harness = Harness::new("net-local-secret");
    let mut request = harness.request("R", "GET", "http://api.test/x");
    request.headers = vec![KeyValue::new("X-Token", "{{token}}")];
    let saved = harness.save(&request);

    // 脚本阶段的内存作用域：取值不在数据库里，脱敏只能靠调用方给出的名字
    let mut input = SendRequestInput::saved(&saved.id);
    input.local.insert("token".into(), "SCRIPT_SECRET_9876".into());
    input.local_secret_names = vec!["token".into()];

    let masked = preview(&harness.db, harness.key.as_ref(), None, &input, false).expect("预览");
    assert!(masked.masked, "本地 secret 也应参与掩码判定");
    assert_eq!(
        masked.headers[0].1,
        crate::logging::MASK,
        "取值不应以明文出现在可观测输出里"
    );

    // 揭示模式给出真实取值：脚本据此构造 `pm.request`
    let revealed = preview(&harness.db, harness.key.as_ref(), None, &input, true).expect("预览");
    assert_eq!(revealed.headers[0].1, "SCRIPT_SECRET_9876");
}

#[tokio::test]
async fn request_url_reports_the_target_that_was_actually_sent() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-request-url");
    let target = format!("{}/path", server.base_url());
    let request = harness.request("R", "GET", &target);
    let saved = harness.save(&request);

    let payload = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    // 脚本后置阶段据它确定 `pm.cookies` 的当前请求：这里给的是**实际发送的目标**，
    // 与重定向之后的 `final_url` 不是一回事
    assert_eq!(payload.request_url, target);
    assert_eq!(server.request_count(), 1);
}

#[tokio::test]
async fn request_without_any_entry_point_is_rejected() {
    let harness = Harness::new("net-no-entry");
    let input = SendRequestInput {
        saved_id: None,
        inline: None,
        environment_id: None,
        local: Default::default(),
        local_secret_names: Default::default(),
        data: Default::default(),
        strict_variables: true,
        attempt_id: None,
    };
    let err = harness.send(&input).await.expect_err("应拒绝");
    assert_eq!(err.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn local_variables_shadow_persisted_scopes_for_one_execution() {
    let server = TestServer::start(Reply::ok("{}"));
    let harness = Harness::new("net-local");
    harness.global("host", "global.invalid");

    // 请求引用全局变量，但本次执行用本地变量把主机名换成测试服务器
    let request = harness.request(
        "R",
        "GET",
        &format!("http://{{{{host}}}}:{}/x", server.addr().port()),
    );
    let saved = harness.save(&request);

    let mut input = SendRequestInput::saved(&saved.id);
    input.local.insert("host".into(), "127.0.0.1".into());

    harness.send(&input).await.expect("发送");
    assert_eq!(server.request_count(), 1, "本地变量应覆盖全局变量");
}

#[tokio::test]
async fn environment_selection_affects_resolution() {
    let harness = Harness::new("net-env");
    let dev = variables::create_environment(&harness.db, &harness.workspace_id, "开发")
        .expect("创建环境");
    variables::upsert_variable(
        &harness.db,
        Scope::Environment,
        &dev.id,
        "host",
        false,
        Some("dev.example"),
        Some("dev.example"),
        harness.key.as_ref(),
    )
    .expect("写入环境变量");

    let request = harness.request("R", "GET", "http://{{host}}/x");
    let saved = harness.save(&request);

    let mut with_env_input = SendRequestInput::saved(&saved.id);
    with_env_input.environment_id = Some(dev.id.clone());
    let with_env =
        preview(&harness.db, harness.key.as_ref(), None, &with_env_input, false).expect("预览");
    assert_eq!(with_env.url, "http://dev.example/x");

    // 未选环境时该变量未定义
    let without_env = preview(
        &harness.db,
        harness.key.as_ref(),
        None,
        &SendRequestInput::saved(&saved.id),
        false,
    )
    .expect("预览");
    assert!(without_env.unresolved.contains(&"host".to_string()));
}

// ---------------------------------------------------------------------------
// 8.2 / 8.3 Cookie：接收、自动附带与持久化（对本地测试服务器）
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cookies_received_from_response_are_carried_by_later_requests() {
    let harness = Harness::new("net-cookie-carry");
    let server = TestServer::start(Reply::WithHeaders {
        status: 200,
        headers: vec![(
            "Set-Cookie".into(),
            "sid=abc123; Path=/; Max-Age=3600".into(),
        )],
        body: b"ok".to_vec(),
    });

    let request = harness.request("带Cookie", "GET", &server.url("/first"));
    let saved = harness.save(&request);

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首次发送");
    let first = &server.requests()[0];
    assert!(first.header("cookie").is_none(), "首次请求不应携带 Cookie");

    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("再次发送");
    let second = server.last_request();
    assert_eq!(
        second.header("cookie"),
        Some("sid=abc123"),
        "响应写入的 Cookie 应被后续请求自动携带"
    );

    // 持久 Cookie（带 Max-Age）已在发送后同步落库
    assert_eq!(
        crate::storage::cookies::count_rows(&harness.db).expect("计数"),
        1
    );
}

#[tokio::test]
async fn persisted_cookies_survive_restart_and_still_match() {
    let harness = Harness::new("net-cookie-restart");
    let server = TestServer::start(Reply::WithHeaders {
        status: 200,
        headers: vec![(
            "Set-Cookie".into(),
            "sid=keep; Path=/; Max-Age=3600".into(),
        )],
        body: b"ok".to_vec(),
    });

    let request = harness.request("重启", "GET", &server.url("/first"));
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("首次发送");

    // 模拟应用重启：全新 jar，仅从数据库装载
    let reborn = cookies::CookieJar::new();
    reborn
        .load_from_db(&harness.db, harness.key.as_ref())
        .expect("装载");

    send_request(
        &harness.db,
        harness.key.as_ref(),
        &harness.uploads,
        &harness.responses,
        &reborn,
        &harness.sends,
        &harness.pac,
        &SendRequestInput::saved(&saved.id),
    )
    .await
    .expect("重启后发送");

    assert_eq!(
        server.last_request().header("cookie"),
        Some("sid=keep"),
        "持久 Cookie 应跨重启仍然生效"
    );
}

#[tokio::test]
async fn cookies_set_during_redirect_apply_to_the_next_hop() {
    let harness = Harness::new("net-cookie-redirect");
    let final_server = TestServer::start(Reply::ok(b"done".to_vec()));
    let redirect_server = TestServer::start(Reply::WithHeaders {
        status: 302,
        headers: vec![
            ("Location".into(), final_server.url("/final")),
            ("Set-Cookie".into(), "hop=1; Path=/".into()),
        ],
        body: Vec::new(),
    });

    let request = harness.request("重定向", "GET", &redirect_server.url("/jump"));
    let saved = harness.save(&request);
    harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect("发送");

    assert_eq!(
        final_server.last_request().header("cookie"),
        Some("hop=1"),
        "重定向中间跳收到的 Cookie 应按新目标重新计算并携带"
    );
}

#[tokio::test]
async fn unavailable_key_store_does_not_break_sending() {
    let harness = Harness::new("net-cookie-degraded-send");
    let server = TestServer::start(Reply::WithHeaders {
        status: 200,
        headers: vec![(
            "Set-Cookie".into(),
            "sid=abc123; Path=/; Max-Age=3600".into(),
        )],
        body: b"ok".to_vec(),
    });

    let request = harness.request("降级发送", "GET", &server.url("/first"));
    let saved = harness.save(&request);

    // 没有 DBus 会话时的真实形态：凭据库不可用。发送必须照常成功——
    // Cookie 只是附带能力，不能连坐整条请求路径（这正是实机报错的成因）。
    let payload = send_request(
        &harness.db,
        &crate::secrets::UnavailableKeyProvider,
        &harness.uploads,
        &harness.responses,
        &harness.cookies,
        &harness.sends,
        &harness.pac,
        &SendRequestInput::saved(&saved.id),
    )
    .await
    .expect("凭据库不可用不应让发送失败");
    assert_eq!(payload.status, 200);

    // 没有密钥就绝不落库
    assert_eq!(
        crate::storage::cookies::count_rows(&harness.db).expect("计数"),
        0,
        "降级态下不应写入任何 Cookie 行"
    );

    // 但它在**本次运行内**仍然可用：同一个 jar 的下一次发送会带上
    send_request(
        &harness.db,
        &crate::secrets::UnavailableKeyProvider,
        &harness.uploads,
        &harness.responses,
        &harness.cookies,
        &harness.sends,
        &harness.pac,
        &SendRequestInput::saved(&saved.id),
    )
    .await
    .expect("再次发送");
    assert_eq!(
        server.last_request().header("cookie"),
        Some("sid=abc123"),
        "降级态下会话内 Cookie 仍应自动携带"
    );
}
