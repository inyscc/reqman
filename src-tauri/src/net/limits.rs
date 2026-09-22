//! 数值默认值（design.md D16 / D1）。
//!
//! 响应体积硬上限、格式化阈值与超时集中定义，既作为默认值，也可被应用设置覆盖，
//! 便于按真实使用手感调整。

use crate::error::AppResult;
use crate::storage::model::{setting_keys, RequestSettings, TimeoutSetting};
use crate::storage::{variables, Db};
use std::time::Duration;

/// 响应正文的硬上限：超过即截断，但保留元数据。
pub const DEFAULT_RESPONSE_SIZE_LIMIT: u64 = 50 * 1024 * 1024;

/// 超过该体积不再提供结构化解析视图。
pub const DEFAULT_PRETTY_PRINT_THRESHOLD: u64 = 5 * 1024 * 1024;

/// 应用级超时的缺省值（毫秒）。
///
/// 它不再是「未显式设置超时时的兜底」，而是应用级超时这一设置的**缺省取值**——
/// 缺省值与设置值走同一条解析路径，两者的区别只在于用户有没有改过。
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// 「不限制」在这个设置里的写法：0。
///
/// 请求这一节统一用它：超时与响应体积上限都是「0 代表不限制」，界面上的提示也只有这一句。
pub const UNLIMITED: &str = "0";

/// 「不限制」的旧写法。
///
/// 这一改动早期用词写过它，开发库（以及实机冒烟留下的库）里可能还留着；认它只是不让
/// 那些值退化成「回落缺省」，对外只有一个写法。
pub const UNLIMITED_TIMEOUT: &str = "unlimited";



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

/// 响应正文的硬上限。
///
/// 这一项**没有**「不限制」：`大响应保护` 要求上限存在，0 会让整份正文进内存，
/// 正是那条要求要挡的事。0 与负数因此同属坏值。
pub fn response_size_limit(db: &Db) -> AppResult<u64> {
    Ok(read_override(db, setting_keys::RESPONSE_SIZE_LIMIT)?
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_RESPONSE_SIZE_LIMIT))
}

/// 超过该体积不再提供结构化解析视图。
///
/// 这里 0 **不是**「不限制」：它表达的是「超过多大不再结构化」，0 会让每一份响应都失去
/// 结构化视图，而界面上的这一项是档位下拉，也表达不出 0。0 与负数因此同属坏值。
pub fn pretty_print_threshold(db: &Db) -> AppResult<u64> {
    Ok(read_override(db, setting_keys::PRETTY_PRINT_THRESHOLD)?
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PRETTY_PRINT_THRESHOLD))
}

/// 应用级超时（毫秒）；`None` 表示不限制。
///
/// 缺失、负数与读不懂的值一律回落 [`DEFAULT_TIMEOUT_MS`]——一条网络设置不该因为一个坏值
/// 把每个请求都拖进「立刻超时」。
pub fn app_timeout_ms(db: &Db) -> AppResult<Option<u64>> {
    let raw = variables::get_setting(db, "global", setting_keys::REQUEST_TIMEOUT)?;
    let Some(text) = raw.as_deref().map(str::trim).filter(|text| !text.is_empty()) else {
        return Ok(Some(DEFAULT_TIMEOUT_MS));
    };

    if text == UNLIMITED || text == UNLIMITED_TIMEOUT {
        return Ok(None);
    }

    Ok(Some(
        text.parse::<u64>()
            .ok()
            .filter(|millis| *millis > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS),
    ))
}

/// 解析本次请求生效的超时（spec: http-engine「请求级网络设置」）。
///
/// 与三级代理同形：先在这里 resolve 出唯一值，再由调用方交给客户端组装，因此
/// `build_client` 不必知道应用设置的存在。`None` 表示不设超时。
pub fn effective_timeout(db: &Db, settings: &RequestSettings) -> AppResult<Option<Duration>> {
    let millis = match settings.timeout {
        // 0 在任何一层都表示不限制，绝不表示「立刻超时」——老行里可能留着裸 `0`
        TimeoutSetting::Custom { ms: 0 } => None,
        TimeoutSetting::Custom { ms } => Some(ms),
        TimeoutSetting::Unlimited => None,
        TimeoutSetting::Inherit => app_timeout_ms(db)?,
    };

    Ok(millis.map(Duration::from_millis))
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
    fn malformed_or_zero_size_limit_falls_back_to_the_default() {
        let db = Db::open_in_memory().expect("打开数据库");

        // 这一项没有「不限制」：0 与负数、读不懂的值一样是坏值（`大响应保护`）
        for raw in ["not-a-number", "-1", UNLIMITED] {
            variables::set_setting(&db, "global", setting_keys::RESPONSE_SIZE_LIMIT, raw).unwrap();
            assert_eq!(
                response_size_limit(&db).unwrap(),
                DEFAULT_RESPONSE_SIZE_LIMIT,
                "坏值 {raw:?} 应回落缺省"
            );
        }
    }

    // ---- 超时的两层解析（spec: http-engine「请求级网络设置」）----

    #[test]
    fn inherited_timeout_takes_the_app_setting_and_defaults_to_30s() {
        let db = Db::open_in_memory().expect("打开数据库");
        let settings = RequestSettings::default(); // 缺省即「跟随全局」

        assert_eq!(
            effective_timeout(&db, &settings).unwrap(),
            Some(Duration::from_millis(30_000)),
            "从未配置过时应取缺省 30 秒"
        );

        variables::set_setting(&db, "global", setting_keys::REQUEST_TIMEOUT, "60000").unwrap();
        assert_eq!(
            effective_timeout(&db, &settings).unwrap(),
            Some(Duration::from_millis(60_000)),
            "跟随全局应取到应用级设置"
        );
    }

    #[test]
    fn request_level_timeout_overrides_the_app_setting() {
        let db = Db::open_in_memory().expect("打开数据库");
        variables::set_setting(&db, "global", setting_keys::REQUEST_TIMEOUT, "60000").unwrap();

        let custom = RequestSettings {
            timeout: TimeoutSetting::Custom { ms: 1_500 },
            ..RequestSettings::default()
        };
        assert_eq!(
            effective_timeout(&db, &custom).unwrap(),
            Some(Duration::from_millis(1_500)),
            "请求级自定义优先于应用级"
        );

        let unlimited = RequestSettings {
            timeout: TimeoutSetting::Unlimited,
            ..RequestSettings::default()
        };
        assert_eq!(
            effective_timeout(&db, &unlimited).unwrap(),
            None,
            "「不限制」不产生任何超时上限"
        );
    }

    #[test]
    fn a_zero_custom_timeout_never_becomes_an_instant_failure() {
        let db = Db::open_in_memory().expect("打开数据库");
        let zero = RequestSettings {
            timeout: TimeoutSetting::Custom { ms: 0 },
            ..RequestSettings::default()
        };

        assert_eq!(
            effective_timeout(&db, &zero).unwrap(),
            None,
            "0 表示不限制，不是一个必然失败的 0 毫秒"
        );
    }

    #[test]
    fn zero_timeout_is_expressed_by_a_number() {
        let db = Db::open_in_memory().expect("打开数据库");
        let settings = RequestSettings::default();

        for raw in [UNLIMITED, UNLIMITED_TIMEOUT] {
            variables::set_setting(&db, "global", setting_keys::REQUEST_TIMEOUT, raw).unwrap();
            assert_eq!(
                effective_timeout(&db, &settings).unwrap(),
                None,
                "{raw:?} 表示不限制"
            );
        }
    }

    #[test]
    fn malformed_timeout_settings_fall_back_to_the_default() {
        let db = Db::open_in_memory().expect("打开数据库");
        let settings = RequestSettings::default();

        for raw in ["", "-5", "not-a-number"] {
            variables::set_setting(&db, "global", setting_keys::REQUEST_TIMEOUT, raw).unwrap();
            assert_eq!(
                effective_timeout(&db, &settings).unwrap(),
                Some(Duration::from_millis(DEFAULT_TIMEOUT_MS)),
                "坏值 {raw:?} 应回落缺省"
            );
        }
    }
}
