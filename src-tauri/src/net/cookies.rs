//! Cookie Jar：接收、匹配与持久化的编排（openspec/changes/add-pm-script-runtime）。
//!
//! 匹配、过期与域名/路径语义全部由 [`cookie_store::CookieStore`] 承担（design D14：
//! 采用成熟实现，不自行写匹配逻辑）。本模块负责三件事：
//!
//! 1. **进程级 jar**：会话 Cookie（无有效期）存活于应用运行期——跨请求但不跨重启，
//!    与「仅当前会话有效」的语义一致；
//! 2. **启动装载 / 发送后同步**：持久 Cookie 以加密行落库（[`crate::storage::cookies`]），
//!    重启后从库装载，响应里获得的 Cookie 在发送后同步回库；
//! 3. **桥接 reqwest**：把 jar 的 `Arc` 句柄交给 `cookie_provider`，重定向的每一跳
//!    都按新目标重新计算应携带的 Cookie（reqwest 内建行为）。
//!
//! 作用域是**整个应用、按域共享**（design D12），不随工作区分区。

use cookie_store::{Cookie, CookieDomain, CookieExpiration, CookieStore};
use reqwest_cookie_store::{CookieStoreMutex, RawCookie};
use std::sync::Arc;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::secrets::{self, KeyProvider};
use crate::storage::cookies::{self, CookieRow};
use crate::storage::Db;

/// 应用级 Cookie Jar。
pub struct CookieJar {
    store: Arc<CookieStoreMutex>,
    /// 持久 Cookie 是否已从库装载。装载是**懒**的：不占用应用启动路径
    /// （启动即触密钥库会让无凭据会话的环境连应用都起不来），首次发送前完成。
    loaded: std::sync::atomic::AtomicBool,
}

impl Default for CookieJar {
    fn default() -> Self {
        Self::new()
    }
}

impl CookieJar {
    pub fn new() -> Self {
        Self {
            store: Arc::new(CookieStoreMutex::new(CookieStore::new(None))),
            loaded: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// 交给 reqwest 的提供者句柄；同一 jar 在多次发送之间共享。
    pub fn provider(&self) -> Arc<RfcCookieProvider> {
        Arc::new(RfcCookieProvider {
            store: Arc::clone(&self.store),
        })
    }

    fn now_unix() -> i64 {
        time::OffsetDateTime::now_utc().unix_timestamp()
    }

    /// 确保持久 Cookie 已从库装载（幂等，通常经发送路径触发）。
    ///
    /// **凭据库不可用时降级为「只有会话 Cookie」，而不是报错**：这台机器上没有任何持久
    /// Cookie 能解密，但那不该让请求发不出去——发送路径上的降级态与 secret 变量同一取向
    /// （读不到就是读不到，绝不落明文），区别是它**不能连坐一次发送**。
    pub fn ensure_loaded(&self, db: &Db, key_provider: &dyn KeyProvider) -> AppResult<()> {
        if self.loaded.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }

        match self.load_from_db(db, key_provider) {
            Ok(()) => Ok(()),
            Err(err) if err.code == ErrorCode::SecretStoreUnavailable => {
                crate::logging::global()
                    .warn("凭据库不可用：本次运行不装载持久 Cookie（会话 Cookie 仍然可用）");
                Ok(())
            }
            Err(err) => Err(err),
        }
    }

    /// 从数据库装载持久 Cookie（应用启动时调用一次），并清理已过期的行。
    pub fn load_from_db(&self, db: &Db, key_provider: &dyn KeyProvider) -> AppResult<()> {
        let now_ts = Self::now_unix();
        cookies::delete_expired(db, now_ts)?;

        let rows = cookies::list_rows(db, key_provider)?;
        let mut store = self.store.lock().expect("Cookie jar 锁未中毒");
        for row in rows {
            insert_row(&mut store, &row, now_ts)?;
        }
        Ok(())
    }

    /// 把 jar 中**持久且未过期**的 Cookie 同步回数据库；其余（会话 Cookie、
    /// 已过期的）从库中清除。每次请求发送后调用。
    ///
    /// 密钥不可用时**不落库、也不算失败**：会话 Cookie 仍在 jar 中可用，持久化被拒绝——
    /// 与 secret 变量的降级态同一取向，绝不退化为明文落库。关键在于**不能因此把一次已经
    /// 成功的发送变成错误**：响应已经拿到，用户该看到的是响应，而不是凭据库的毛病。
    pub fn sync_to_db(&self, db: &Db, key_provider: &dyn KeyProvider) -> AppResult<()> {
        let key = match key_provider.data_key() {
            Ok(key) => key,
            Err(err) if err.code == ErrorCode::SecretStoreUnavailable => {
                crate::logging::global().warn(
                    "凭据库不可用：本次运行不持久化 Cookie（响应写入的 Cookie 仅存活于本次运行）",
                );
                return Ok(());
            }
            Err(err) => return Err(err),
        };

        let mut kept = std::collections::HashSet::new();
        let mut rows = Vec::new();
        {
            let store = self.store.lock().expect("Cookie jar 锁未中毒");
            for cookie in store.iter_unexpired() {
                if !cookie.is_persistent() {
                    continue; // 会话 Cookie 不落库
                }
                let Some(row) = cookie_to_row(cookie) else {
                    continue;
                };
                kept.insert(cookies::row_key(&row));
                rows.push(row);
            }
        } // 不在持有 jar 锁的情况下做磁盘 IO

        db.write(move |conn| {
            for row in &rows {
                let encoded = secrets::encrypt_value(&key, &row.value)?;
                cookies::upsert_row(conn, row, &encoded, &crate::storage::now())?;
            }
            cookies::delete_rows_not_in(conn, &kept)?;
            Ok(())
        })
    }

    /// 请求目标的匹配 Cookie（`name=value` 对），供请求预览等调试信息呈现。
    ///
    /// 与实际发送使用**同一套排序**（[`request_cookie_pairs`]）——调试信息里看到
    /// 的顺序就是请求头里的顺序。
    pub fn matches_for_url(&self, url: &str) -> Vec<(String, String)> {
        let Ok(target) = url::Url::parse(url) else {
            return Vec::new();
        };
        let store = self.store.lock().expect("Cookie jar 锁未中毒");
        request_cookie_pairs(&store, &target)
    }

    /// 目标 URL 匹配的全部 Cookie（含完整属性），供脚本经 `pm.cookies` 读取。
    ///
    /// 与自动附带共用同一套匹配（cookie_store 的 `matches`），保证脚本读到的
    /// 集合与实际会携带的集合一致（spec: 读取当前请求可用的 Cookie）。
    pub fn matching_cookies(&self, url: &str) -> Vec<CookieRow> {
        let Ok(target) = url::Url::parse(url) else {
            return Vec::new();
        };
        let store = self.store.lock().expect("Cookie jar 锁未中毒");
        store
            .matches(&target)
            .iter()
            .filter_map(|cookie| cookie_to_row(cookie))
            .collect()
    }

    /// 清空 jar（手动管理界面与测试使用）。
    pub fn clear(&self) {
        self.store.lock().expect("Cookie jar 锁未中毒").clear();
    }

    /// 从 jar 中移除一条 Cookie（手动删除用）。
    ///
    /// 借「写入一个立即过期的同键 Cookie」实现——过期写入会触发
    /// `CookieStore` 的过期删除（`StoreAction::ExpiredExisting`），不需要
    /// 触碰它的内部键格式。显式带上 Path（与 Domain），保证与被删条目同键。
    pub fn expire(&self, row: &CookieRow) {
        let scheme = if row.secure { "https" } else { "http" };
        let Ok(url) = url::Url::parse(&format!("{}://{}/", scheme, row.domain)) else {
            return;
        };

        let mut text = format!("{}=", row.name);
        if !row.host_only {
            text.push_str(&format!("; Domain={}", row.domain));
        }
        text.push_str(&format!("; Path={}", row.path));
        text.push_str("; Max-Age=0");

        let _ = self
            .store
            .lock()
            .expect("Cookie jar 锁未中毒")
            .parse(&text, &url);
    }

    /// 手动/脚本写入一个 Cookie；立即参与后续请求的匹配。
    ///
    /// 持久 Cookie 同时落库；会话 Cookie 只留在内存 jar 中。
    pub fn put(&self, db: &Db, key_provider: &dyn KeyProvider, row: CookieRow) -> AppResult<()> {
        {
            let mut store = self.store.lock().expect("Cookie jar 锁未中毒");
            insert_row(&mut store, &row, Self::now_unix())?;
        }
        if row.expires_at.is_some() {
            cookies::put_row(db, key_provider, &row)?;
        }
        Ok(())
    }
}

/// reqwest 的 Cookie 提供者。
///
/// 匹配语义（域、路径、Secure、HttpOnly、过期）**全部**委托给
/// [`cookie_store::CookieStore`]；唯一自己做的事是按 **RFC 6265 §5.4** 组装
/// Cookie 头：路径长的在前。上游的 `CookieStoreMutex` 不做这个排序（BTreeMap
/// 的字典序会把 `/` 排在 `/deep` 前面），而服务器普遍按出现顺序取同名 Cookie
/// 的第一个——不排序时，更泛路径的值会压过更具体的值。
pub struct RfcCookieProvider {
    store: Arc<CookieStoreMutex>,
}

impl reqwest::cookie::CookieStore for RfcCookieProvider {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>,
        url: &url::Url,
    ) {
        let mut store = self.store.lock().expect("Cookie jar 锁未中毒");
        let cookies = cookie_headers.filter_map(|value| {
            std::str::from_utf8(value.as_bytes())
                .ok()
                .and_then(|text| RawCookie::parse(text).ok())
                .map(|cookie| cookie.into_owned())
        });
        store.store_response_cookies(cookies, url);
    }

    fn cookies(&self, url: &url::Url) -> Option<reqwest::header::HeaderValue> {
        let store = self.store.lock().expect("Cookie jar 锁未中毒");
        let pairs = request_cookie_pairs(&store, url);

        if pairs.is_empty() {
            None
        } else {
            let header = pairs
                .iter()
                .map(|(name, value)| format!("{}={}", name, value))
                .collect::<Vec<_>>()
                .join("; ");
            reqwest::header::HeaderValue::from_str(&header).ok()
        }
    }
}

/// 按请求目标取出匹配的 Cookie 对，并按 **RFC 6265 §5.4** 排序（路径长的在前）。
fn request_cookie_pairs(store: &CookieStore, url: &url::Url) -> Vec<(String, String)> {
    let mut matched = store.matches(url);
    // 稳定排序保持插入序，近似「创建时间早者在前」的次级规则
    matched.sort_by(|a, b| b.path.as_ref().len().cmp(&a.path.as_ref().len()));

    matched
        .iter()
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect()
}

/// 把行装入 store。
///
/// 用 `Max-Age` 表达绝对有效期（换算为剩余秒数），避免日期格式的解析往返；
/// `Domain` 属性只在非 host-only 时给出——省略即按 host-only 解释，与
/// cookie_store 的判定规则一致。已过期的行不入 jar。
fn insert_row(store: &mut CookieStore, row: &CookieRow, now_ts: i64) -> AppResult<()> {
    if let Some(expires_at) = row.expires_at {
        if expires_at <= now_ts {
            return Ok(());
        }
    }
    if row.domain.trim().is_empty() || row.name.trim().is_empty() {
        return Ok(()); // 无法路由的行只能丢弃
    }

    let scheme = if row.secure { "https" } else { "http" };
    let url = url::Url::parse(&format!("{}://{}/", scheme, row.domain))
        .map_err(|_| AppError::invalid_input(format!("无效的 Cookie 域：{}", row.domain)))?;

    let mut text = format!("{}={}", row.name, row.value);
    if !row.host_only {
        text.push_str(&format!("; Domain={}", row.domain));
    }
    text.push_str(&format!("; Path={}", row.path));
    if row.secure {
        text.push_str("; Secure");
    }
    if row.http_only {
        text.push_str("; HttpOnly");
    }
    if let Some(expires_at) = row.expires_at {
        text.push_str(&format!("; Max-Age={}", expires_at - now_ts));
    }

    store
        .parse(&text, &url)
        .map_err(|err| AppError::invalid_input(format!("Cookie 无法装载：{}", err)))?;
    Ok(())
}

/// 把 store 里的 Cookie 抽回行模型。
///
/// 属性保真的关键：path 取**生效值**（含默认路径推导的结果），域按枚举区分
/// host-only 与 suffix——两者参与唯一键，同名同域不同解释不会互相覆盖。
/// 无法确定域的 Cookie（正常流程不会出现）返回 `None` 并跳过。
fn cookie_to_row(cookie: &Cookie<'static>) -> Option<CookieRow> {
    let (domain, host_only) = match &cookie.domain {
        CookieDomain::HostOnly(domain) => (domain.clone(), true),
        CookieDomain::Suffix(domain) => (domain.clone(), false),
        _ => return None,
    };

    let expires_at = match cookie.expires {
        CookieExpiration::AtUtc(at) => Some(at.unix_timestamp()),
        CookieExpiration::SessionEnd => None,
    };

    Some(CookieRow {
        name: cookie.name().to_string(),
        domain,
        path: String::from(&cookie.path),
        host_only,
        value: cookie.value().to_string(),
        secure: cookie.secure().unwrap_or(false),
        http_only: cookie.http_only().unwrap_or(false),
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryKeyProvider;
    use crate::testutil::TempDir;
    use std::sync::Arc;

    fn setup(name: &str) -> (TempDir, Arc<Db>, MemoryKeyProvider, CookieJar) {
        let dir = TempDir::new(name);
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        (dir, db, MemoryKeyProvider::new(), CookieJar::new())
    }

    const FAR_FUTURE: i64 = 4_102_444_800; // 2100-01-01

    fn cookie(name: &str, value: &str, expires_at: Option<i64>) -> CookieRow {
        CookieRow {
            name: name.into(),
            domain: "api.test".into(),
            path: "/".into(),
            host_only: true,
            value: value.into(),
            secure: false,
            http_only: false,
            expires_at,
        }
    }

    // -- 8.2 接收与保存 ------------------------------------------------------

    #[test]
    fn session_cookie_works_within_session_but_not_across_restart() {
        let (_dir, db, keys, jar) = setup("cookie-session");

        jar.put(&db, &keys, cookie("sid", "session", None)).expect("写入");
        assert_eq!(
            jar.matches_for_url("http://api.test/x"),
            vec![("sid".to_string(), "session".to_string())]
        );

        // 会话 Cookie 不落库
        jar.sync_to_db(&db, &keys).expect("同步");
        assert_eq!(cookies::count_rows(&db).expect("计数"), 0);

        // 模拟重启：新 jar 从库装载，会话 Cookie 不应回来
        let reborn = CookieJar::new();
        reborn.load_from_db(&db, &keys).expect("装载");
        assert!(reborn.matches_for_url("http://api.test/x").is_empty());
    }

    #[test]
    fn persistent_cookie_survives_restart() {
        let (_dir, db, keys, jar) = setup("cookie-persistent");

        jar.put(&db, &keys, cookie("sid", "keep-me", Some(FAR_FUTURE))).expect("写入");
        jar.sync_to_db(&db, &keys).expect("同步");

        let reborn = CookieJar::new();
        reborn.load_from_db(&db, &keys).expect("装载");
        assert_eq!(
            reborn.matches_for_url("http://api.test/x"),
            vec![("sid".to_string(), "keep-me".to_string())]
        );
    }

    #[test]
    fn expired_expiry_invalidates_the_cookie() {
        let (_dir, db, keys, jar) = setup("cookie-expired");

        jar.put(&db, &keys, cookie("sid", "old", Some(1_000_000_000))).expect("写入");
        jar.sync_to_db(&db, &keys).expect("同步");

        assert!(jar.matches_for_url("http://api.test/x").is_empty());
        assert_eq!(cookies::count_rows(&db).expect("计数"), 0, "过期行应被清理");
    }

    #[test]
    fn sync_removes_rows_that_vanished_from_the_jar() {
        let (_dir, db, keys, jar) = setup("cookie-vanish");

        jar.put(&db, &keys, cookie("a", "1", Some(FAR_FUTURE))).expect("写入");
        jar.put(&db, &keys, cookie("b", "2", Some(FAR_FUTURE))).expect("写入");
        jar.sync_to_db(&db, &keys).expect("同步");
        assert_eq!(cookies::count_rows(&db).expect("计数"), 2);

        // jar 清空后同步：库里也应当清空
        jar.clear();
        jar.sync_to_db(&db, &keys).expect("同步");
        assert_eq!(cookies::count_rows(&db).expect("计数"), 0);
    }

    // -- 8.3 自动附带与匹配 --------------------------------------------------

    #[test]
    fn domain_mismatch_is_not_attached() {
        let (_dir, db, keys, jar) = setup("cookie-domain-mismatch");

        jar.put(&db, &keys, cookie("sid", "v", Some(FAR_FUTURE))).expect("写入");

        assert!(jar.matches_for_url("http://other.test/x").is_empty());
        assert_eq!(jar.matches_for_url("http://api.test/x").len(), 1);
    }

    #[test]
    fn path_mismatch_is_not_attached() {
        let (_dir, db, keys, jar) = setup("cookie-path");

        let mut scoped = cookie("sid", "v", Some(FAR_FUTURE));
        scoped.path = "/admin".into();
        jar.put(&db, &keys, scoped).expect("写入");

        assert_eq!(jar.matches_for_url("http://api.test/admin/panel").len(), 1);
        assert!(jar.matches_for_url("http://api.test/public").is_empty());
    }

    #[test]
    fn secure_cookie_is_not_attached_over_plain_http() {
        let (_dir, db, keys, jar) = setup("cookie-secure");

        let mut secure = cookie("sid", "v", Some(FAR_FUTURE));
        secure.secure = true;
        jar.put(&db, &keys, secure).expect("写入");

        assert!(jar.matches_for_url("http://api.test/x").is_empty());
        assert_eq!(jar.matches_for_url("https://api.test/x").len(), 1);
    }

    #[test]
    fn host_only_cookie_does_not_cover_subdomains_but_domain_cookie_does() {
        let (_dir, db, keys, jar) = setup("cookie-hostonly-match");

        jar.put(&db, &keys, cookie("sid", "host", Some(FAR_FUTURE))).expect("写入");

        let mut suffix = cookie("sub", "domain", Some(FAR_FUTURE));
        suffix.host_only = false;
        jar.put(&db, &keys, suffix).expect("写入");

        assert_eq!(jar.matches_for_url("http://api.test/x").len(), 2);
        let at_subdomain = jar.matches_for_url("http://sub.api.test/x");
        assert_eq!(at_subdomain.len(), 1);
        assert_eq!(at_subdomain[0].0, "sub");
    }

    // -- 8.4 属性保真 --------------------------------------------------------

    #[test]
    fn same_name_on_different_paths_are_both_kept_and_selected_by_path() {
        let (_dir, db, keys, jar) = setup("cookie-two-paths");

        jar.put(&db, &keys, cookie("sid", "root-value", Some(FAR_FUTURE))).expect("写入");
        let mut deep = cookie("sid", "deep-value", Some(FAR_FUTURE));
        deep.path = "/deep".into();
        jar.put(&db, &keys, deep).expect("写入");

        let at_root = jar.matches_for_url("http://api.test/other");
        assert_eq!(at_root, vec![("sid".to_string(), "root-value".to_string())]);

        // RFC 6265：路径前缀重叠时两条都匹配，按路径长度排序呈现
        let at_deep = jar.matches_for_url("http://api.test/deep/inside");
        assert_eq!(at_deep.len(), 2);
        assert_eq!(at_deep[0], ("sid".to_string(), "deep-value".to_string()));
    }

    #[test]
    fn attributes_survive_save_and_reload() {
        let (_dir, db, keys, jar) = setup("cookie-fidelity");

        let original = CookieRow {
            name: "sid".into(),
            domain: "api.test".into(),
            path: "/deep".into(),
            host_only: false,
            value: "secret-value-1".into(),
            secure: true,
            http_only: true,
            expires_at: Some(FAR_FUTURE),
        };
        jar.put(&db, &keys, original).expect("写入");
        jar.sync_to_db(&db, &keys).expect("同步");

        let reborn = CookieJar::new();
        reborn.load_from_db(&db, &keys).expect("装载");

        // 域、路径、安全标记逐一验证
        assert_eq!(reborn.matches_for_url("https://api.test/deep/x").len(), 1);
        assert!(
            reborn.matches_for_url("https://sub.api.test/deep/x").len() == 1,
            "域后缀应覆盖子域"
        );
        assert!(reborn.matches_for_url("https://api.test/other").is_empty(), "路径应保持原样");
        assert!(
            reborn.matches_for_url("http://api.test/deep/x").is_empty(),
            "Secure 标记应保持原样"
        );

        let rows = cookies::list_rows(&db, &keys).expect("读取");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/deep");
        assert_eq!(rows[0].value, "secret-value-1");
        assert!(!rows[0].host_only);
        assert!(rows[0].secure && rows[0].http_only);
        assert_eq!(rows[0].expires_at, Some(FAR_FUTURE));
    }

    #[test]
    fn degraded_key_provider_keeps_session_usable_and_refuses_persistence() {
        let dir = TempDir::new("cookie-degraded-jar");
        let db = Db::open(dir.join("reqman.db")).expect("打开数据库");
        let jar = CookieJar::new();

        // 会话 Cookie 不需要密钥，照常可用
        jar.put(&db, &crate::secrets::UnavailableKeyProvider, cookie("sid", "v", None))
            .expect("会话 Cookie 不落库，无需密钥");
        assert_eq!(jar.matches_for_url("http://api.test/x").len(), 1);

        // 持久 Cookie 在降级态下被拒绝落库
        let err = jar
            .put(&db, &crate::secrets::UnavailableKeyProvider, cookie("sid", "v", Some(FAR_FUTURE)))
            .expect_err("应进入降级态");
        assert_eq!(err.code, crate::error::ErrorCode::SecretStoreUnavailable);
        // jar 里仍可用（内存），但库文件里没有
        assert_eq!(jar.matches_for_url("http://api.test/x").len(), 1);
    }

    #[test]
    fn degraded_key_provider_does_not_fail_load_or_sync() {
        let (_dir, db, keys, jar) = setup("cookie-degraded-paths");
        jar.put(&db, &keys, cookie("sid", "v", Some(FAR_FUTURE)))
            .expect("正常密钥下写入持久 Cookie");
        jar.sync_to_db(&db, &keys).expect("正常密钥下同步");
        assert_eq!(cookies::count_rows(&db).unwrap(), 1);

        // 换成不可用的凭据库——这台机器上没有 DBus 会话时的真实形态。
        // 装载与同步都跑在**发送路径**上，报错等于让所有请求发不出去，因此必须降级为成功。
        let fresh = CookieJar::new();
        fresh
            .ensure_loaded(&db, &crate::secrets::UnavailableKeyProvider)
            .expect("装载必须降级而不是报错");
        fresh
            .sync_to_db(&db, &crate::secrets::UnavailableKeyProvider)
            .expect("同步必须降级而不是报错");

        // 降级态既不写也不删：库里那条持久 Cookie 原样保留
        assert_eq!(cookies::count_rows(&db).unwrap(), 1);
        // 读不出来的 Cookie 不会凭空出现在 jar 里
        assert!(fresh.matches_for_url("http://api.test/x").is_empty());
    }
}
