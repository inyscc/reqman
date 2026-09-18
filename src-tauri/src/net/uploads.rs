//! 上传文件的一次性句柄（design.md D10）。
//!
//! 系统文件选择对话框由用户发起，后端登记所选路径并返回一次性句柄；发送请求
//! 只接受句柄，不接受路径字符串。这样即使前端被注入，也无法让后端去读取一个
//! 它自己选定的文件。

use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct UploadRegistry {
    pending: Mutex<HashMap<String, PathBuf>>,
    consumed: Mutex<HashSet<String>>,
}

impl UploadRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个用户在对话框中选择的文件，返回一次性句柄。
    pub fn register(&self, path: impl AsRef<Path>) -> AppResult<String> {
        let path = path.as_ref();
        if !path.is_file() {
            return Err(AppError::invalid_input(format!(
                "所选文件不存在或不是普通文件：{}",
                path.display()
            )));
        }
        let handle = uuid::Uuid::new_v4().to_string();
        self.pending
            .lock()
            .map_err(|_| AppError::internal("上传登记表锁中毒"))?
            .insert(handle.clone(), path.to_path_buf());
        Ok(handle)
    }

    /// 取出并**消费**句柄。同一句柄只能使用一次。
    pub fn take(&self, handle: &str) -> AppResult<PathBuf> {
        if let Some(path) = self
            .pending
            .lock()
            .map_err(|_| AppError::internal("上传登记表锁中毒"))?
            .remove(handle)
        {
            if let Ok(mut consumed) = self.consumed.lock() {
                consumed.insert(handle.to_string());
            }
            return Ok(path);
        }

        if self
            .consumed
            .lock()
            .map_err(|_| AppError::internal("上传登记表锁中毒"))?
            .contains(handle)
        {
            return Err(AppError::new(
                ErrorCode::UploadHandleConsumed,
                "该文件句柄已被使用，请重新选择文件",
            ));
        }

        Err(AppError::new(
            ErrorCode::UploadHandleInvalid,
            "文件句柄无效或已过期，请重新选择文件",
        ))
    }

    /// 只查看，不消费。
    pub fn peek(&self, handle: &str) -> Option<PathBuf> {
        self.pending.lock().ok()?.get(handle).cloned()
    }

    pub fn revoke(&self, handle: &str) -> bool {
        self.pending
            .lock()
            .map(|mut map| map.remove(handle).is_some())
            .unwrap_or(false)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|map| map.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn temp_file(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"payload").expect("写入临时文件");
        path
    }

    #[test]
    fn handle_is_one_time_use() {
        let dir = TempDir::new("upload-once");
        let file = temp_file(&dir, "a.txt");
        let registry = UploadRegistry::new();

        let handle = registry.register(&file).expect("登记文件");
        let taken = registry.take(&handle).expect("首次使用");
        assert_eq!(taken, file);

        let err = registry.take(&handle).expect_err("第二次应失败");
        assert_eq!(err.code, ErrorCode::UploadHandleConsumed);
    }

    #[test]
    fn unknown_handle_is_invalid_not_consumed() {
        let registry = UploadRegistry::new();
        let err = registry.take("nope").expect_err("应失败");
        assert_eq!(err.code, ErrorCode::UploadHandleInvalid);
    }

    #[test]
    fn registering_a_missing_file_is_rejected() {
        let registry = UploadRegistry::new();
        let err = registry
            .register("/definitely/not/here/payload.bin")
            .expect_err("应拒绝");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn directory_is_not_accepted() {
        let dir = TempDir::new("upload-dir");
        let registry = UploadRegistry::new();
        let err = registry.register(dir.path()).expect_err("应拒绝目录");
        assert_eq!(err.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn peek_does_not_consume_and_revoke_removes() {
        let dir = TempDir::new("upload-peek");
        let file = temp_file(&dir, "b.bin");
        let registry = UploadRegistry::new();

        let handle = registry.register(&file).unwrap();
        assert!(registry.peek(&handle).is_some());
        assert_eq!(registry.pending_count(), 1);
        assert!(registry.revoke(&handle));
        assert!(registry.peek(&handle).is_none());
        assert_eq!(registry.pending_count(), 0);
    }

    #[test]
    fn handles_are_unique() {
        let dir = TempDir::new("upload-unique");
        let registry = UploadRegistry::new();
        let a = registry.register(temp_file(&dir, "x")).unwrap();
        let b = registry.register(temp_file(&dir, "y")).unwrap();
        assert_ne!(a, b);
    }
}
