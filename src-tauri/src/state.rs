//! 应用运行态：数据库、密钥来源、上传句柄与响应仓库。

use crate::error::AppResult;
use crate::net::cancel::SendRegistry;
use crate::net::cookies::CookieJar;
use crate::net::limits::MAX_STORED_RESPONSES;
use crate::net::pac::PacStore;
use crate::net::response::ResponseStore;
use crate::net::uploads::UploadRegistry;
use crate::secrets::{KeyProvider, KeyringKeyProvider};
use crate::storage::Db;
use std::path::{Path, PathBuf};
use std::sync::Arc;


pub struct AppState {
    pub db: Arc<Db>,
    pub key_provider: Arc<dyn KeyProvider>,
    pub uploads: Arc<UploadRegistry>,
    pub responses: Arc<ResponseStore>,
    /// 应用级 Cookie Jar（按域共享，不随工作区分区；design D12）。
    pub cookies: Arc<CookieJar>,
    /// 在飞请求的会话注册表（spec: http-engine「请求取消」）。
    pub sends: Arc<SendRegistry>,
    /// PAC 的取用与缓存（design D4）。
    ///
    /// 放在运行态而不是每次新开：缓存与 TTL 只有在跨请求存活时才有意义。
    pub pac: Arc<PacStore>,
}

impl AppState {
    /// 在给定的数据目录下初始化运行态。
    pub fn initialize(data_dir: impl AsRef<Path>) -> AppResult<Self> {
        let data_dir = data_dir.as_ref();
        std::fs::create_dir_all(data_dir)?;

        let db = Db::open(data_dir.join("reqman.db"))?;

        Ok(Self {
            db,
            key_provider: Arc::new(KeyringKeyProvider::default()),
            uploads: Arc::new(UploadRegistry::new()),
            responses: Arc::new(ResponseStore::new(
                MAX_STORED_RESPONSES,
                data_dir.join("responses"),
            )),
            cookies: Arc::new(CookieJar::new()),
            sends: Arc::new(SendRegistry::new()),
            pac: Arc::new(PacStore::new()),
        })
    }

    /// 测试用：围绕一个既有数据库构造运行态，密钥来自内存。
    pub fn with_db(db: Arc<Db>, key_provider: Arc<dyn KeyProvider>, temp_root: PathBuf) -> Self {
        Self {
            db,
            key_provider,
            uploads: Arc::new(UploadRegistry::new()),
            responses: Arc::new(ResponseStore::new(
                MAX_STORED_RESPONSES,
                temp_root.join("responses"),
            )),
            cookies: Arc::new(CookieJar::new()),
            sends: Arc::new(SendRegistry::new()),
            pac: Arc::new(PacStore::new()),
        }
    }
}


