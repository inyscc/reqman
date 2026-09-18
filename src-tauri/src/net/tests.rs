//! 网络层的集成测试：全部对本地测试服务器进行，不需要外部网络。

use super::*;
use crate::secrets::MemoryKeyProvider;
use crate::storage::model::{
    setting_keys, ApiKeyLocation, FormField, FormFieldKind, ProxyConfig, RawLanguage, RequestBody,
    Scope,
};
use crate::storage::{requests, variables, workspace, Db};
use crate::testutil::{closed_port_addr, HttpsTestServer, Reply, TempDir, TestServer};
use std::sync::Arc;

struct Harness {
    db: Arc<Db>,
    key: Arc<MemoryKeyProvider>,
    uploads: UploadRegistry,
    responses: ResponseStore,
    cookies: cookies::CookieJar,
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
    let cert_dir = TempDir::new("net-tls-cert");
    let server = HttpsTestServer::start(&cert_dir, "{\"tls\":true}")
        .expect("启动自签 HTTPS 测试服务器");
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
    request.settings.timeout_ms = Some(300);
    let saved = harness.save(&request);
    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("应超时");
    assert_eq!(err.code, ErrorCode::Timeout, "错误信息：{}", err.message);

    // 域名解析失败
    let saved = harness.save(&harness.request("R", "GET", "http://does-not-exist.invalid/x"));
    let err = harness
        .send(&SendRequestInput::saved(&saved.id))
        .await
        .expect_err("应解析失败");
    assert_eq!(err.code, ErrorCode::DnsFailure, "错误信息：{}", err.message);

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

    let preview = preview(&harness.db, harness.key.as_ref(), None, &SendRequestInput::saved(&saved.id))
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

    let preview = preview(&harness.db, harness.key.as_ref(), None, &SendRequestInput::saved(&saved.id))
        .expect("预览");
    assert!(preview.unresolved.contains(&"missing".to_string()));
    assert!(preview.unresolved.contains(&"alsoMissing".to_string()));
    assert!(preview.url.contains("{{missing}}"), "未解析变量应保留原文");
}

#[tokio::test]
async fn request_without_any_entry_point_is_rejected() {
    let harness = Harness::new("net-no-entry");
    let input = SendRequestInput {
        saved_id: None,
        inline: None,
        environment_id: None,
        local: Default::default(),
        data: Default::default(),
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
    let with_env = preview(&harness.db, harness.key.as_ref(), None, &with_env_input).expect("预览");
    assert_eq!(with_env.url, "http://dev.example/x");

    // 未选环境时该变量未定义
    let without_env =
        preview(&harness.db, harness.key.as_ref(), None, &SendRequestInput::saved(&saved.id))
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
