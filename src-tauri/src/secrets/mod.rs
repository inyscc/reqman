//! 密钥提供者与 secret 值的静态加密（design.md D5 / D17）。
//!
//! 操作系统凭据库只保管一把设备级数据密钥；secret 变量值用该密钥以 AEAD
//! 方式加密后存入 SQLite。凭据库不可用时进入降级态：拒绝持久化 secret 值，
//! **绝不**退化为明文写入。
//!
//! 密钥来源是可替换接口（D17）：生产走凭据库，测试走内存实现，因此加密、
//! 解密与脱敏在没有图形会话的 Linux 与 CI 上都能被完整验证。

use crate::error::{AppError, AppResult};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// 数据密钥长度（AES-256）。
pub const KEY_LEN: usize = 32;

/// AES-GCM nonce 长度。
const NONCE_LEN: usize = 12;

/// 生产环境使用的凭据库服务名。
pub const KEYRING_SERVICE: &str = "cc.inys.reqman";
/// 生产环境使用的凭据条目名。
pub const KEYRING_ACCOUNT: &str = "data-encryption-key";

/// 设备级数据密钥的来源。
pub trait KeyProvider: Send + Sync + 'static {
    /// 取出（必要时首次生成）设备级数据密钥。
    fn data_key(&self) -> AppResult<[u8; KEY_LEN]>;
}

/// 测试实现：一次性内存密钥，进程结束即消失。
pub struct MemoryKeyProvider {
    key: [u8; KEY_LEN],
}

impl MemoryKeyProvider {
    pub fn new() -> Self {
        Self { key: random_key() }
    }

    pub fn from_bytes(key: [u8; KEY_LEN]) -> Self {
        Self { key }
    }
}

impl Default for MemoryKeyProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyProvider for MemoryKeyProvider {
    fn data_key(&self) -> AppResult<[u8; KEY_LEN]> {
        Ok(self.key)
    }
}

/// 模拟「系统凭据库不可用」，用于验证降级路径。
pub struct UnavailableKeyProvider;

impl KeyProvider for UnavailableKeyProvider {
    fn data_key(&self) -> AppResult<[u8; KEY_LEN]> {
        Err(AppError::secret_store_unavailable(
            "系统凭据库不可用，secret 值将不被持久化",
        ))
    }
}

/// 生产实现：操作系统凭据库（Windows 凭据管理器 / macOS Keychain / Secret Service）。
pub struct KeyringKeyProvider {
    service: String,
    account: String,
}

impl KeyringKeyProvider {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
        }
    }
}

impl Default for KeyringKeyProvider {
    fn default() -> Self {
        Self::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
    }
}

impl KeyProvider for KeyringKeyProvider {
    fn data_key(&self) -> AppResult<[u8; KEY_LEN]> {
        let entry = keyring::Entry::new(&self.service, &self.account).map_err(|err| {
            AppError::secret_store_unavailable(format!("无法访问系统凭据库：{}", err))
        })?;

        match entry.get_password() {
            Ok(encoded) => decode_key(&encoded),
            Err(keyring::Error::NoEntry) => {
                let key = random_key();
                entry.set_password(&B64.encode(key)).map_err(|err| {
                    AppError::secret_store_unavailable(format!("无法写入系统凭据库：{}", err))
                })?;
                Ok(key)
            }
            Err(err) => Err(AppError::secret_store_unavailable(format!(
                "系统凭据库不可用：{}（无图形会话或缺少 DBus 会话总线时会出现这种情况；受影响的只有 secret 值与 Cookie 的**持久化**——绝不落明文。请求发送、变量解析、脚本执行都不受影响，Cookie 在本次运行内仍然有效）",
                err
            ))),
        }
    }
}

fn random_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

fn decode_key(encoded: &str) -> AppResult<[u8; KEY_LEN]> {
    let raw = B64
        .decode(encoded.trim())
        .map_err(|_| AppError::secret_unreadable("凭据库中的数据密钥格式无效"))?;
    if raw.len() != KEY_LEN {
        return Err(AppError::secret_unreadable(
            "凭据库中的数据密钥长度不正确",
        ));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&raw);
    Ok(key)
}

/// 加密 secret 明文，输出 `base64(nonce || ciphertext)`。
pub fn encrypt_value(key: &[u8; KEY_LEN], plaintext: &str) -> AppResult<String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| AppError::internal("secret 值加密失败"))?;

    let mut buf = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ciphertext);
    Ok(B64.encode(buf))
}

/// 解密 secret 密文。任何失败都返回 [`ErrorCode::SecretUnreadable`]，
/// 绝不返回空值或静默清空。
///
/// [`ErrorCode::SecretUnreadable`]: crate::error::ErrorCode::SecretUnreadable
pub fn decrypt_value(key: &[u8; KEY_LEN], encoded: &str) -> AppResult<String> {
    let raw = B64
        .decode(encoded.trim())
        .map_err(|_| AppError::secret_unreadable("密文格式无效"))?;

    if raw.len() <= NONCE_LEN {
        return Err(AppError::secret_unreadable("密文长度不足，无法解密"));
    }

    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|_| AppError::secret_unreadable("无法解密：设备密钥不匹配或数据已损坏"))?;

    String::from_utf8(plaintext).map_err(|_| AppError::secret_unreadable("解密结果不是合法文本"))
}

/// 变量值的读取状态。
///
/// 加密值存在但已不可解密时用 [`StoredValue::Unreadable`] 表达，而不是给出空值；
/// 降级态下被拒绝持久化的值用 [`StoredValue::NotPersisted`] 表达。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StoredValue {
    Value { value: String },
    Unreadable,
    NotPersisted,
}

impl StoredValue {
    pub fn value(value: impl Into<String>) -> Self {
        Self::Value {
            value: value.into(),
        }
    }

    /// 明文可用时返回值。不可读与未持久化都返回 `None`。
    pub fn plaintext(&self) -> Option<&str> {
        match self {
            StoredValue::Value { value } => Some(value.as_str()),
            _ => None,
        }
    }

    pub fn is_unreadable(&self) -> bool {
        matches!(self, StoredValue::Unreadable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const KEY: [u8; KEY_LEN] = [7u8; KEY_LEN];

    #[test]
    fn roundtrip_recovers_plaintext() {
        let encoded = encrypt_value(&KEY, "hunter2-秘密").expect("加密成功");
        let back = decrypt_value(&KEY, &encoded).expect("解密成功");
        assert_eq!(back, "hunter2-秘密");
    }

    #[test]
    fn ciphertext_does_not_contain_plaintext() {
        let plaintext = "PLAINTEXT_SENTINEL_98765";
        let encoded = encrypt_value(&KEY, plaintext).expect("加密成功");
        assert!(!encoded.contains(plaintext));
        let raw = B64.decode(&encoded).expect("是合法 base64");
        // 原始字节里也不应出现明文
        assert!(!raw
            .windows(plaintext.len())
            .any(|w| w == plaintext.as_bytes()));
    }

    #[test]
    fn same_plaintext_yields_different_ciphertext() {
        let a = encrypt_value(&KEY, "same").expect("加密成功");
        let b = encrypt_value(&KEY, "same").expect("加密成功");
        assert_ne!(a, b, "nonce 应随机，密文不应相同");
    }

    #[test]
    fn wrong_key_reports_unreadable_not_empty() {
        let encoded = encrypt_value(&KEY, "value").expect("加密成功");
        let other = [9u8; KEY_LEN];
        let err = decrypt_value(&other, &encoded).expect_err("应失败");
        assert_eq!(err.code, ErrorCode::SecretUnreadable);
        assert!(!err.message.is_empty());
    }

    #[test]
    fn corrupted_ciphertext_reports_unreadable() {
        let err = decrypt_value(&KEY, "not-base64!!").expect_err("应失败");
        assert_eq!(err.code, ErrorCode::SecretUnreadable);
        let short = B64.encode([0u8; 4]);
        let err = decrypt_value(&KEY, &short).expect_err("应失败");
        assert_eq!(err.code, ErrorCode::SecretUnreadable);
    }

    #[test]
    fn unavailable_provider_reports_degraded_state() {
        let provider = UnavailableKeyProvider;
        let err = provider.data_key().expect_err("应进入降级态");
        assert_eq!(err.code, ErrorCode::SecretStoreUnavailable);
    }

    #[test]
    fn memory_provider_is_stable_across_calls() {
        let provider = MemoryKeyProvider::from_bytes(KEY);
        assert_eq!(provider.data_key().unwrap(), KEY);
        assert_eq!(provider.data_key().unwrap(), KEY);
    }

    #[test]
    fn memory_provider_generates_distinct_keys() {
        let a = MemoryKeyProvider::new().data_key().unwrap();
        let b = MemoryKeyProvider::new().data_key().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn keyring_provider_never_panics_and_never_leaks() {
        // 有凭据库会话时返回密钥，无会话时返回降级错误；两种都不应 panic，
        // 也不应在错误文本里带上密钥材料。
        //
        // 注意别把这条写成「文案里不许出现某个词」——那测的是措辞，不是泄漏。
        // 降级提示**应当**说清影响范围（会用到 secret、Cookie 这类词），
        // 要挡的是密钥材料本身：32 字节数据密钥的 base64 形态是 43–44 个连续字符。
        let provider = KeyringKeyProvider::default();
        match provider.data_key() {
            Ok(key) => assert_eq!(key.len(), KEY_LEN),
            Err(err) => {
                assert_eq!(err.code, ErrorCode::SecretStoreUnavailable);
                assert!(
                    !err
                        .message
                        .split(|c: char| !c.is_ascii_alphanumeric())
                        .any(|token| token.len() >= 40),
                    "错误文本疑似包含密钥材料：{}",
                    err.message
                );
                // 降级提示要能被用户看懂：说明是凭据库的问题，而不是一句内部报错
                assert!(err.message.contains("凭据库"), "降级提示不可读：{}", err.message);
            }
        }
    }
}
