//! Postman 文档与内部模型之间的双向映射（openspec/changes/add-postman-io）。
//!
//! 映射层刻意独立于 `storage` / `net` / `variables`（design D1）：文档的解析与
//! 序列化是纯数据结构转换，不碰数据库、网络或系统对话框；写入存储由调用方在
//! **单个**事务里完成。
//!
//! 解析侧只做映射，不做落盘；落盘与加密由 `storage` 承担。

pub mod curl;
pub mod document;
pub mod export;
pub mod import;
pub mod parse;

pub use import::{import_document, read_source, ImportOutcome, ImportSource};

use serde::{Deserialize, Serialize};

/// 条目所在的层级。
///
/// 降级报告要能指出「哪一层的哪个条目」，否则压平到请求层的错误无法被观察到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryLevel {
    Collection,
    Folder,
    Request,
}

/// 因内部不支持映射而被降级的认证配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthDowngrade {
    pub level: EntryLevel,
    pub entry_name: String,
    /// 源文档中声明的认证类型（如 `digest`）。
    pub auth_type: String,
}

/// 被跳过、未导入的内容（禁用的变量、无法映射的请求体类型等）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedItem {
    pub name: String,
    pub reason: String,
}

/// 因源文档以本地路径描述而被降级为「未选择文件」的字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFieldDowngrade {
    pub entry_name: String,
    pub field_name: String,
}

/// 导入报告：导入不静默消化差异（spec: 导入报告）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportReport {
    pub auth_downgrades: Vec<AuthDowngrade>,
    pub skipped_items: Vec<SkippedItem>,
    pub file_field_downgrades: Vec<FileFieldDowngrade>,
    /// 因本轮不持久化示例而丢弃的数量（在嵌套条目上递归统计）。
    pub dropped_examples: usize,
}

/// 导出 secret 变量值时所用占位符的前缀与后缀。
///
/// 让占位符可被自己识别，往返才不会把 secret 变成明文或垃圾值（design D8）。
pub const SECRET_PLACEHOLDER_PREFIX: &str = "<<reqman-secret:";
pub const SECRET_PLACEHOLDER_SUFFIX: &str = ">>";

/// 生成 secret 占位符。
pub fn secret_placeholder(name: &str) -> String {
    format!(
        "{}{}{}",
        SECRET_PLACEHOLDER_PREFIX, name, SECRET_PLACEHOLDER_SUFFIX
    )
}

/// 识别 secret 占位符，返回其中记录的变量名。
pub fn secret_placeholder_name(value: &str) -> Option<&str> {
    value
        .trim()
        .strip_prefix(SECRET_PLACEHOLDER_PREFIX)?
        .strip_suffix(SECRET_PLACEHOLDER_SUFFIX)
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

impl ImportReport {
    /// 是否完全无损映射。为假时说明导入存在用户可感知的差异。
    pub fn is_clean(&self) -> bool {
        self.auth_downgrades.is_empty()
            && self.skipped_items.is_empty()
            && self.file_field_downgrades.is_empty()
            && self.dropped_examples == 0
    }
}
