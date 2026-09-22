//! 三级代理的求解（design.md D12）。
//!
//! 请求 > 环境 > 全局的优先级在**一处**求解，产出唯一生效配置；`no_proxy`
//! 白名单在挂载代理之前判定；系统代理在请求时刻读取，而不是启动时固化。

use crate::error::AppResult;
use crate::secrets::KeyProvider;
use crate::storage::model::{ProxyConfig, ProxyMode, RequestSettings};
use crate::storage::{proxy_credentials, variables, Db};
use crate::url_util;

/// 从操作系统环境读到的代理设置。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemProxyEnv {
    pub http_proxy: Option<String>,
    pub https_proxy: Option<String>,
    pub no_proxy: Vec<String>,
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
        }
    }

    pub fn proxy_for(&self, scheme: &str) -> Option<&str> {
        match scheme {
            "https" => self.https_proxy.as_deref().or(self.http_proxy.as_deref()),
            _ => self.http_proxy.as_deref(),
        }
    }

    pub fn bypasses(&self, host: &str) -> bool {
        let host = host.trim().to_ascii_lowercase();
        let bare = host
            .rsplit_once(':')
            .map(|(h, _)| h.to_string())
            .unwrap_or(host.clone());
        self.no_proxy.iter().any(|entry| {
            let entry = entry.trim().to_ascii_lowercase();
            if entry.is_empty() {
                return false;
            }
            if entry == "*" {
                return true;
            }
            let entry = entry.trim_start_matches('.');
            bare == entry || bare.ends_with(&format!(".{}", entry))
        })
    }
}

/// 最终要交给网络栈的决定。
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

/// 求解唯一生效的代理配置：请求 > 环境 > 全局，取第一个「实际生效」的层。
///
/// 「未配置」的层不生效因而被跳过；「不使用代理」的层生效因而**停下**——它表达的是
/// 直连，不应被更低层级的代理接管（spec: http-engine「三级代理」）。
pub fn resolve_proxy(
    request_proxy: Option<&ProxyConfig>,
    environment_proxy: Option<&ProxyConfig>,
    global_proxy: Option<&ProxyConfig>,
) -> Option<ProxyConfig> {
    [request_proxy, environment_proxy, global_proxy]
        .into_iter()
        .flatten()
        .find(|candidate| candidate.is_effective())
        .cloned()
}

/// 从存储读取三层配置并求解。
///
/// 求解出的那一层在这里解出明文凭据：只有发送路径需要它，读取路径一律不回传凭据。
pub fn resolve_proxy_for_request(
    db: &Db,
    settings: &RequestSettings,
    environment_id: Option<&str>,
    key_provider: &dyn KeyProvider,
) -> AppResult<Option<ProxyConfig>> {
    let global = variables::global_proxy(db)?;
    let environment = match environment_id {
        Some(id) => variables::get_environment(db, id)?.proxy,
        None => None,
    };

    Ok(
        resolve_proxy(
            settings.proxy.as_ref(),
            environment.as_ref(),
            global.as_ref(),
        )
        .map(|proxy| proxy_credentials::unseal(proxy, key_provider)),
    )
}

/// 结合目标 URL 与系统代理设置，得出最终决定。
pub fn decide(
    proxy: Option<&ProxyConfig>,
    url: &str,
    system: &SystemProxyEnv,
) -> ProxyDecision {
    let Some(proxy) = proxy else {
        return ProxyDecision::Direct;
    };
    if !proxy.is_effective() {
        return ProxyDecision::Direct;
    }

    let host = url_util::host_of(url).unwrap_or_default();

    // 白名单在挂载代理之前判定
    if !host.is_empty() && proxy.bypasses(&host) {
        return ProxyDecision::Direct;
    }

    match proxy.mode {
        // 求解过程只产出「生效」的层，因此这两档都以直连收场。
        ProxyMode::Inherit | ProxyMode::None => ProxyDecision::Direct,
        ProxyMode::Manual => match proxy.url.as_deref().map(str::trim) {
            Some(url) if !url.is_empty() => ProxyDecision::Use {
                url: url.to_string(),
                username: proxy.username.clone(),
                password: proxy.password.clone(),
            },
            _ => ProxyDecision::Direct,
        },
        ProxyMode::System => {
            if !host.is_empty() && system.bypasses(&host) {
                return ProxyDecision::Direct;
            }
            let scheme = url_util::host_of(url).is_some().then(|| {
                url.split_once(':').map(|(s, _)| s.to_ascii_lowercase()).unwrap_or_default()
            });
            match system.proxy_for(scheme.as_deref().unwrap_or("http")) {
                Some(url) => ProxyDecision::Use {
                    url: url.to_string(),
                    username: None,
                    password: None,
                },
                None => ProxyDecision::Direct,
            }
        }
    }
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
        assert_eq!(resolved.unwrap().url.as_deref(), Some("http://env:2"));

        // 请求级最高
        let settings = RequestSettings {
            proxy: Some(ProxyConfig::manual("http://request:3")),
            ..RequestSettings::default()
        };
        let resolved = resolve_proxy_for_request(&db, &settings, Some(&env.id), &key).unwrap();
        assert_eq!(resolved.unwrap().url.as_deref(), Some("http://request:3"));

        // 没有活动环境时用全局
        let resolved =
            resolve_proxy_for_request(&db, &RequestSettings::default(), None, &key).unwrap();
        assert_eq!(resolved.unwrap().url.as_deref(), Some("http://global:1"));

        let _ = Scope::Global;
    }
}
