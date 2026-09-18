//! 测试辅助（仅在 `cfg(test)` 下编译）。
//!
//! 环境里没有 `tempfile` / `wiremock` 这类 crate，因此这里自带最小的临时目录
//! 持有者、一个可控的本地 HTTP 测试服务器，以及一个用 openssl 现场签发自签
//! 证书的 HTTPS 测试服务器——后者让证书校验的两条路径都能被断言。

#![allow(dead_code)]

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 进程退出或离开作用域时自动清理的临时目录。
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let mut path = std::env::temp_dir();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        path.push(format!("reqman-test-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&path).expect("创建临时目录");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 一个被测试服务器记录下来的请求。
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// 原始请求行，用于判断请求是直连形态还是代理形态。
    pub raw_first_line: String,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        let wanted = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| key.to_ascii_lowercase() == wanted)
            .map(|(_, value)| value.as_str())
    }

    pub fn content_type(&self) -> Option<&str> {
        self.header("content-type")
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn query_has(&self, key: &str, value: &str) -> bool {
        self.query
            .split('&')
            .any(|pair| pair == format!("{}={}", key, value))
    }

    /// 查询串里是否含有某个键（不论值）。
    pub fn query_contains_key(&self, key: &str) -> bool {
        self.query
            .split('&')
            .any(|pair| pair.split('=').next() == Some(key))
    }
}

/// 测试服务器的应答行为。
#[derive(Debug, Clone)]
pub enum Reply {
    Fixed {
        status: u16,
        content_type: String,
        body: Vec<u8>,
    },
    /// 先等待一段时间再应答，用于验证超时。
    Delay {
        millis: u64,
        body: Vec<u8>,
    },
    /// 返回指定大小的正文，用于验证体积上限与截断。
    Sized {
        bytes: usize,
    },
    /// 带自定义响应头的应答（Set-Cookie、Location 等），供 Cookie 会话与重定向验证。
    WithHeaders {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Reply::Fixed {
            status: 200,
            content_type: "application/json".into(),
            body: body.into(),
        }
    }

    pub fn with_content_type(body: impl Into<Vec<u8>>, content_type: &str) -> Self {
        Reply::Fixed {
            status: 200,
            content_type: content_type.into(),
            body: body.into(),
        }
    }
}

/// 本地 HTTP 测试服务器。
pub struct TestServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    pub fn start(reply: Reply) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定测试端口");
        listener.set_nonblocking(true).expect("设置非阻塞");
        let addr = listener.local_addr().expect("取本地地址");

        let requests = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicBool::new(true));

        let thread = {
            let requests = requests.clone();
            let running = running.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("测试服务器运行时");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).expect("转换监听器");
                    while running.load(Ordering::SeqCst) {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let reply = reply.clone();
                                let requests = requests.clone();
                                tokio::spawn(async move {
                                    let _ = handle_connection(stream, reply, requests).await;
                                });
                            }
                            Err(_) => break,
                        }
                    }
                });
            })
        };

        Self {
            addr,
            requests,
            running,
            thread: Some(thread),
        }
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("请求记录锁未中毒").clone()
    }

    pub fn last_request(&self) -> RecordedRequest {
        self.requests()
            .pop()
            .expect("测试服务器应至少收到一个请求")
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().map(|r| r.len()).unwrap_or(0)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        // 主动连接一次，唤醒阻塞在 accept 上的线程
        let _ = std::net::TcpStream::connect(self.addr);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 一个必定连接失败的本地地址（绑定后立刻释放端口）。
pub fn closed_port_addr() -> SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定端口");
    let addr = listener.local_addr().expect("取本地地址");
    drop(listener);
    addr
}

async fn handle_connection(
    stream: tokio::net::TcpStream,
    reply: Reply,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut first_line = String::new();
    if reader.read_line(&mut first_line).await? == 0 {
        return Ok(());
    }
    let first_line = first_line.trim_end().to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let header_value = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };

    let body = if let Some(length) = header_value("content-length") {
        let length: usize = length.trim().parse().unwrap_or(0);
        let mut buffer = vec![0u8; length];
        if length > 0 {
            reader.read_exact(&mut buffer).await?;
        }
        buffer
    } else if header_value("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        read_chunked(&mut reader).await?
    } else {
        Vec::new()
    };

    let mut parts = first_line.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.clone(), String::new()),
    };

    if let Ok(mut recorded) = requests.lock() {
        recorded.push(RecordedRequest {
            method,
            path,
            query,
            headers,
            body,
            raw_first_line: first_line,
        });
    }

    let (status, content_type, body, extra_headers) = match reply {
        Reply::Fixed {
            status,
            content_type,
            body,
        } => (status, Some(content_type), body, Vec::new()),
        Reply::Delay { millis, body } => {
            tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
            (200, Some("application/json".to_string()), body, Vec::new())
        }
        Reply::Sized { bytes } => (
            200,
            Some("application/octet-stream".to_string()),
            vec![b'x'; bytes],
            Vec::new(),
        ),
        Reply::WithHeaders {
            status,
            headers,
            body,
        } => (status, None, body, headers),
    };

    let reason = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    };

    let mut response = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        status,
        reason,
        body.len()
    );
    if let Some(content_type) = content_type {
        response.push_str(&format!("Content-Type: {}\r\n", content_type));
    }
    for (name, value) in extra_headers {
        response.push_str(&format!("{}: {}\r\n", name, value));
    }
    response.push_str("\r\n");

    write_half.write_all(response.as_bytes()).await?;
    write_half.write_all(&body).await?;
    write_half.flush().await?;
    Ok(())
}

async fn read_chunked(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> std::io::Result<Vec<u8>> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        if reader.read_line(&mut size_line).await? == 0 {
            break;
        }
        let size_text = size_line.trim();
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("0").trim(), 16)
            .unwrap_or(0);
        if size == 0 {
            // 读到空行为止（忽略 trailer）
            let mut trailer = String::new();
            let _ = reader.read_line(&mut trailer).await;
            break;
        }
        let mut buffer = vec![0u8; size];
        reader.read_exact(&mut buffer).await?;
        body.extend_from_slice(&buffer);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).await?;
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// HTTPS 测试服务器（自签证书，由 openssl 现场签发）
// ---------------------------------------------------------------------------

/// 现场签发一张自签证书，返回 (证书 DER, 私钥 DER/PKCS#8)。
fn generate_self_signed(dir: &TempDir) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    let cert_pem = dir.join("cert.pem");
    let key_pem = dir.join("key.pem");
    let cert_der = dir.join("cert.der");
    let key_der = dir.join("key.der");

    let status = std::process::Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ])
        .arg("-keyout")
        .arg(&key_pem)
        .arg("-out")
        .arg(&cert_pem)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "openssl 签发证书失败",
        ));
    }

    fn to_der(args: &[&str], input: &Path, output: &Path) -> std::io::Result<()> {
        let status = std::process::Command::new("openssl")
            .args(args)
            .arg(input)
            .args(["-outform", "DER", "-out"])
            .arg(output)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if !status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "openssl 转换 DER 失败",
            ));
        }
        Ok(())
    }

    to_der(&["x509", "-in"], &cert_pem, &cert_der)?;
    // `pkey -outform DER` 输出的是 PKCS#1，rustls 需要 PKCS#8，因此显式转换
    to_der(&["pkcs8", "-topk8", "-nocrypt", "-in"], &key_pem, &key_der)?;

    Ok((std::fs::read(cert_der)?, std::fs::read(key_der)?))
}

/// 使用自签证书的 HTTPS 测试服务器。
pub struct HttpsTestServer {
    addr: SocketAddr,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl HttpsTestServer {
    pub fn start(dir: &TempDir, body: impl Into<Vec<u8>>) -> std::io::Result<Self> {
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

        let (cert_der, key_der) = generate_self_signed(dir)?;

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert_der)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
            )
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err.to_string()))?;

        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));

        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;

        let running = Arc::new(AtomicBool::new(true));
        let body: Vec<u8> = body.into();

        let thread = {
            let running = running.clone();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("HTTPS 测试服务器运行时");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).expect("转换监听器");
                    while running.load(Ordering::SeqCst) {
                        let Ok((stream, _)) = listener.accept().await else {
                            break;
                        };
                        let acceptor = acceptor.clone();
                        let body = body.clone();
                        tokio::spawn(async move {
                            if let Ok(mut tls) = acceptor.accept(stream).await {
                                let mut buffer = [0u8; 4096];
                                let _ = tls.read(&mut buffer).await;
                                let mut response = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                                    body.len()
                                )
                                .into_bytes();
                                response.extend_from_slice(&body);
                                let _ = tls.write_all(&response).await;
                                let _ = tls.flush().await;
                            }
                        });
                    }
                });
            })
        };

        Ok(Self {
            addr,
            running,
            thread: Some(thread),
        })
    }

    pub fn url(&self, path: &str) -> String {
        format!("https://{}{}", self.addr, path)
    }
}

impl Drop for HttpsTestServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.addr);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 字节序列中是否包含给定片段。
pub fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}

/// 供调试：把字节写入文件。
pub fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.flush()
}
