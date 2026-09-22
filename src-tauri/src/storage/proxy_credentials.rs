//! 代理凭据的静态加密（spec: storage-foundation「敏感值不以明文落盘」）。
//!
//! 与 secret 变量、Cookie 同一取向：明文只在内存里存在，落库前必须加密；密钥不可用时
//! **拒绝写入**而不是退化为明文。三处落库边界（应用设置、环境、请求）都经这里。
//!
//! 为什么单独成模块：凭据的规范只有两条（写入要加密、发送要解密），收在一处才能被逐条
//! 审计；散进三个存储函数里，每一处都得重新论证一遍，而漏掉的那一处不会有任何症状——
//! 它只是把密码写成了明文。

use super::model::{ProxyConfig, RequestSettings};
use crate::error::{AppError, AppResult};
use crate::logging;
use crate::secrets::{self, KeyProvider};

fn to_value<T: serde::Serialize>(value: &T) -> AppResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|err| AppError::internal(format!("序列化失败：{}", err)))
}

/// 代理配置的**落库形态**：在对外形状（见 `ProxyConfig` 的 `Serialize`）之上补回凭据两字段。
///
/// 一个类型同时承担两种形态是刻意的：对外形状由 `Serialize` 定死（不给凭据），落库形态
/// 则必须带上密文，否则凭据根本写不进去。这里从对外形状**派生**而不是另写一个结构——
/// 新增字段时不可能出现「对外有、落库没有」的静默丢失；反过来只多出这两个字段，一眼可审。
pub fn storage_value(proxy: &ProxyConfig) -> AppResult<serde_json::Value> {
    let mut value = to_value(proxy)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| AppError::internal("代理配置的序列化结果不是对象"))?;

    object.insert("password_enc".to_string(), to_value(&proxy.password_enc)?);
    object.insert(
        "password_readable".to_string(),
        to_value(&proxy.password_readable)?,
    );

    Ok(value)
}

/// 单个代理配置的落库 JSON。
pub fn storage_json(proxy: &ProxyConfig) -> AppResult<String> {
    Ok(storage_value(proxy)?.to_string())
}

/// 请求设置的落库 JSON：其中的代理换成含凭据的落库形态。
pub fn storage_settings_json(settings: &RequestSettings) -> AppResult<String> {
    let mut value = to_value(settings)?;

    if let Some(proxy) = settings.proxy.as_ref() {
        value["proxy"] = storage_value(proxy)?;
    }

    Ok(value.to_string())
}

/// 落库前把提交的明文凭据换成密文。
///
/// `password` 是提交语义的三态：**缺字段** = 不改写既有凭据（沿用 `existing` 的密文与
/// 可读标记）；`Some("")` = 清除；`Some(明文)` = 换新值。
///
/// `existing` 只在这一步被读到：界面回传的形状里没有密文，所以「不改写」必须由后端自己
/// 把既有值补回来。把它实现成「清除」的话，用户每改一次代理地址就会静默丢掉密码。
pub fn seal(
    submitted: Option<ProxyConfig>,
    existing: Option<&ProxyConfig>,
    key_provider: &dyn KeyProvider,
) -> AppResult<Option<ProxyConfig>> {
    let Some(mut proxy) = submitted else {
        return Ok(None);
    };

    match proxy.password.take() {
        None => {
            // 界面回传的形状里没有密文，因此「不改写」要靠既有值补回来；而副本这类
            // 「输入本身就是落库形态」的场景已经带着密文，原样保留即可。
            if proxy.password_enc.is_none() {
                let (encoded, readable) = existing
                    .map(|old| (old.password_enc.clone(), old.password_readable))
                    .unwrap_or((None, false));
                proxy.password_enc = encoded;
                proxy.password_readable = readable;
            }
        }
        Some(text) if text.is_empty() => {
            proxy.password_enc = None;
            proxy.password_readable = false;
        }
        Some(text) => {
            // 没有设备密钥就绝不落明文：宁可让这次保存失败。
            let key = key_provider.data_key()?;
            proxy.password_enc = Some(secrets::encrypt_value(&key, &text)?);
            proxy.password_readable = true;
            logging::global().register_secret_value(&text);
        }
    }

    Ok(Some(proxy))
}

/// 取出可发送的明文凭据。
///
/// 已经带着明文的（未保存的编辑态）原样返回；否则解密落库的密文。读不出来时返回**不带
/// 凭据**的配置——spec 要求凭据不可读不阻止请求发出，只是这一次没有代理认证。
pub fn unseal(mut proxy: ProxyConfig, key_provider: &dyn KeyProvider) -> ProxyConfig {
    if proxy.password.is_some() {
        return proxy;
    }

    let Some(encoded) = proxy.password_enc.clone() else {
        return proxy;
    };

    // 凭据存在却读不出来时按**不带代理认证**发出，而不是退化成一次空密码认证：
    // 用户名与密码是一对，读不出密码时只剩用户名没有意义（spec: 三级代理）。
    let plaintext = if proxy.password_readable {
        key_provider
            .data_key()
            .and_then(|key| secrets::decrypt_value(&key, &encoded))
            .ok()
    } else {
        None
    };

    match plaintext {
        Some(text) => {
            logging::global().register_secret_value(&text);
            proxy.password = Some(text);
        }
        None => proxy.username = None,
    }

    proxy
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::secrets::{MemoryKeyProvider, UnavailableKeyProvider};

    fn with_password(mut proxy: ProxyConfig, password: &str) -> ProxyConfig {
        proxy.password = Some(password.to_string());
        proxy
    }

    fn stored(key: &dyn KeyProvider, password: &str) -> ProxyConfig {
        seal(Some(with_password(ProxyConfig::manual("http://p:1"), password)), None, key)
            .expect("落库")
            .expect("有代理")
    }

    #[test]
    fn a_submitted_password_is_stored_as_ciphertext_and_can_be_read_back() {
        let key = MemoryKeyProvider::default();
        let sealed = stored(&key, "s3cret");

        let encoded = sealed.password_enc.clone().expect("应有密文");
        assert!(!encoded.contains("s3cret"), "密文里不该出现明文");
        assert!(sealed.password_readable);
        assert_eq!(sealed.password, None, "落库形态里不保留明文");

        assert_eq!(unseal(sealed, &key).password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn an_absent_password_keeps_the_saved_credential() {
        let key = MemoryKeyProvider::default();
        let existing = stored(&key, "s3cret");

        // 只改地址，不带 password 字段
        let updated = seal(Some(ProxyConfig::manual("http://other:2")), Some(&existing), &key)
            .expect("落库")
            .expect("有代理");

        assert_eq!(updated.password_enc, existing.password_enc, "既有密文应被保留");
        assert!(updated.password_readable);
        assert_eq!(unseal(updated, &key).password.as_deref(), Some("s3cret"));
    }

    #[test]
    fn an_empty_password_clears_the_saved_credential() {
        let key = MemoryKeyProvider::default();
        let existing = stored(&key, "s3cret");

        let cleared = seal(
            Some(with_password(ProxyConfig::manual("http://p:1"), "")),
            Some(&existing),
            &key,
        )
        .expect("落库")
        .expect("有代理");

        assert_eq!(cleared.password_enc, None);
        assert!(!cleared.password_readable);
        assert_eq!(unseal(cleared, &key).password, None);
    }

    #[test]
    fn without_a_device_key_the_credential_is_never_stored_in_plaintext() {
        let err = seal(
            Some(with_password(ProxyConfig::manual("http://p:1"), "s3cret")),
            None,
            &UnavailableKeyProvider,
        )
        .expect_err("密钥不可用时应拒绝落库");

        assert_eq!(err.code, ErrorCode::SecretStoreUnavailable);
    }

    #[test]
    fn an_unreadable_credential_yields_no_authentication_but_keeps_the_proxy() {
        let key = MemoryKeyProvider::default();
        let mut saved = stored(&key, "s3cret");
        saved.username = Some("u".into());

        let unsealed = unseal(saved, &UnavailableKeyProvider);

        assert_eq!(unsealed.password, None, "读不出来时不带凭据");
        assert_eq!(
            unsealed.username, None,
            "用户名与密码是一对：只剩用户名会变成一次空密码认证"
        );
        assert_eq!(
            unsealed.url.as_deref(),
            Some("http://p:1"),
            "代理本身照常生效"
        );
        assert!(unsealed.password_enc.is_some(), "密文仍在");
    }

    #[test]
    fn a_corrupted_ciphertext_also_yields_no_authentication() {
        let key = MemoryKeyProvider::default();
        let mut saved = stored(&key, "s3cret");
        saved.username = Some("u".into());
        // 可读标记为真但内容解不开：换过设备密钥、数据损坏都会长这样
        saved.password_enc = Some("bm90LWEtY2lwaGVydGV4dA==".into());

        let unsealed = unseal(saved, &key);

        assert_eq!(unsealed.password, None);
        assert_eq!(unsealed.username, None);
    }
}
