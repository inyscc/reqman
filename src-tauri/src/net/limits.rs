//! 数值默认值（design.md D16）。
//!
//! 响应体积硬上限与格式化阈值集中定义，既作为默认值，也可被应用设置覆盖，
//! 便于按真实使用手感调整。

use crate::error::AppResult;
use crate::storage::model::setting_keys;
use crate::storage::{variables, Db};

/// 响应正文的硬上限：超过即截断，但保留元数据。
pub const DEFAULT_RESPONSE_SIZE_LIMIT: u64 = 50 * 1024 * 1024;

/// 超过该体积不再提供结构化解析视图。
pub const DEFAULT_PRETTY_PRINT_THRESHOLD: u64 = 5 * 1024 * 1024;

/// 未显式设置超时时的默认值。
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 单次读取正文的分段大小上限。
pub const MAX_SPAN_LENGTH: usize = 4 * 1024 * 1024;

/// 响应正文在内存中保留的数量上限，超出后淘汰最早的一条。
pub const MAX_STORED_RESPONSES: usize = 32;

fn read_override(db: &Db, key: &str) -> AppResult<Option<u64>> {
    match variables::get_setting(db, "global", key)? {
        Some(raw) => Ok(raw.trim().parse::<u64>().ok()),
        None => Ok(None),
    }
}

pub fn response_size_limit(db: &Db) -> AppResult<u64> {
    Ok(read_override(db, setting_keys::RESPONSE_SIZE_LIMIT)?
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RESPONSE_SIZE_LIMIT))
}

pub fn pretty_print_threshold(db: &Db) -> AppResult<u64> {
    Ok(read_override(db, setting_keys::PRETTY_PRINT_THRESHOLD)?
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PRETTY_PRINT_THRESHOLD))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_used_when_no_setting_exists() {
        let db = Db::open_in_memory().expect("打开数据库");
        assert_eq!(
            response_size_limit(&db).unwrap(),
            DEFAULT_RESPONSE_SIZE_LIMIT
        );
        assert_eq!(
            pretty_print_threshold(&db).unwrap(),
            DEFAULT_PRETTY_PRINT_THRESHOLD
        );
    }

    #[test]
    fn settings_override_the_defaults() {
        let db = Db::open_in_memory().expect("打开数据库");
        variables::set_setting(&db, "global", setting_keys::RESPONSE_SIZE_LIMIT, "1024").unwrap();
        variables::set_setting(&db, "global", setting_keys::PRETTY_PRINT_THRESHOLD, "512").unwrap();

        assert_eq!(response_size_limit(&db).unwrap(), 1024);
        assert_eq!(pretty_print_threshold(&db).unwrap(), 512);
    }

    #[test]
    fn malformed_or_zero_settings_fall_back_to_defaults() {
        let db = Db::open_in_memory().expect("打开数据库");
        variables::set_setting(&db, "global", setting_keys::RESPONSE_SIZE_LIMIT, "not-a-number")
            .unwrap();
        assert_eq!(
            response_size_limit(&db).unwrap(),
            DEFAULT_RESPONSE_SIZE_LIMIT
        );

        variables::set_setting(&db, "global", setting_keys::RESPONSE_SIZE_LIMIT, "0").unwrap();
        assert_eq!(
            response_size_limit(&db).unwrap(),
            DEFAULT_RESPONSE_SIZE_LIMIT
        );
    }
}
