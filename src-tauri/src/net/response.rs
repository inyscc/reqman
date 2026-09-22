//! 响应的捕获、体积上限、分段取回与全文保存（design.md D13）。
//!
//! 超出内存上限的正文会落到磁盘，内存里只保留前缀；这样界面既不会因为大响应
//! 卡死，用户又仍然能拿到完整正文。

use crate::error::{describe_net_error, AppError, AppResult, ErrorCode};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

/// 一次响应正文的捕获结果。
#[derive(Debug, Clone)]
pub struct CapturedBody {
    /// 内存中保留的前缀（最多 `limit` 字节）。
    pub bytes: Vec<u8>,
    /// 是否发生了截断。
    pub truncated: bool,
    /// 实际收到的总字节数。
    pub total_bytes: u64,
    /// 被截断的部分是否已落地到磁盘。
    pub spilled: bool,
}

/// 读取响应正文，超过上限的部分落到磁盘，内存中只保留前缀。
pub async fn read_body(
    response: &mut reqwest::Response,
    limit: u64,
    spill_path: &Path,
) -> AppResult<CapturedBody> {
    let memory_limit = limit.min(usize::MAX as u64) as usize;
    let mut memory: Vec<u8> = Vec::with_capacity(memory_limit.min(1 << 20));
    let mut total: u64 = 0;
    let mut spilled = false;
    let mut spill_file: Option<tokio::fs::File> = None;

    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                return Err(AppError::new(
                    crate::error::classify_reqwest_error(&err),
                    describe_net_error(&err),
                ))
            }
        };

        total += chunk.len() as u64;
        let room = memory_limit.saturating_sub(memory.len());
        let take = chunk.len().min(room);
        memory.extend_from_slice(&chunk[..take]);

        let rest = &chunk[take..];
        if !rest.is_empty() {
            if spill_file.is_none() {
                if let Some(parent) = spill_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                spill_file = Some(tokio::fs::File::create(spill_path).await?);
            }
            if let Some(file) = spill_file.as_mut() {
                file.write_all(rest).await?;
            }
            spilled = true;
        }
    }

    if let Some(mut file) = spill_file {
        file.flush().await?;
    }

    Ok(CapturedBody {
        bytes: memory,
        truncated: spilled,
        total_bytes: total,
        spilled,
    })
}

/// 响应正文的落盘副本：在登记进仓库之前，清理由这个守卫负责。
///
/// 落盘文件是**惰性**创建的（只有正文超出内存前缀才写），而清理原本只挂在已登记的条目上
/// ——登记发生在正文读完**之后**。于是取消（或任何中途失败）会让文件无人认领，在会话内
/// 累积（超大响应尤其明显，而那恰好是最可能被取消的一类请求）。
pub struct SpillGuard {
    path: PathBuf,
    armed: bool,
}

impl SpillGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    /// 文件的所有权已交给仓库（或本来就不存在），守卫不再负责清理。
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SpillGuard {
    fn drop(&mut self) {
        if self.armed {
            // 文件可能从未创建过（正文没超限），删除失败是正常情况
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 一段正文。
#[derive(Debug, Clone, Serialize)]
pub struct ResponseSpan {
    pub offset: u64,
    pub length: usize,
    pub total_bytes: u64,
    pub truncated: bool,
    /// 该段是合法 UTF-8 时给出文本。
    pub text: Option<String>,
    pub base64: String,
}

struct StoredResponse {
    id: String,
    bytes: Vec<u8>,
    truncated: bool,
    total_bytes: u64,
    spill: Option<PathBuf>,
}

/// 已捕获响应的内存仓库：容量有限，超出后淘汰最早的条目并清理其落地文件。
pub struct ResponseStore {
    entries: Mutex<VecDeque<StoredResponse>>,
    capacity: usize,
    temp_root: PathBuf,
}

impl ResponseStore {
    pub fn new(capacity: usize, temp_root: impl Into<PathBuf>) -> Self {
        Self {
            entries: Mutex::new(VecDeque::new()),
            capacity: capacity.max(1),
            temp_root: temp_root.into(),
        }
    }

    pub fn temp_root(&self) -> &Path {
        &self.temp_root
    }

    /// 超出内存上限时，某个响应的完整正文落到这里。
    pub fn spill_path(&self, id: &str) -> PathBuf {
        self.temp_root.join(format!("{}.body", id))
    }

    /// 存入一条已捕获的响应，并按容量淘汰最早的条目。
    pub fn store(&self, id: impl Into<String>, captured: CapturedBody) -> AppResult<()> {
        let CapturedBody {
            bytes,
            truncated,
            total_bytes,
            spilled,
        } = captured;
        let id = id.into();

        let entry = StoredResponse {
            spill: spilled.then(|| self.spill_path(&id)),
            id,
            bytes,
            truncated,
            total_bytes,
        };

        let mut entries = self
            .entries
            .lock()
            .map_err(|_| AppError::internal("响应仓库锁中毒"))?;

        while entries.len() >= self.capacity {
            if let Some(evicted) = entries.pop_front() {
                if let Some(path) = evicted.spill {
                    let _ = std::fs::remove_file(path);
                }
            }
        }

        entries.push_back(entry);
        Ok(())
    }

    pub fn total_bytes(&self, id: &str) -> AppResult<u64> {
        self.with(id, |entry| Ok(entry.total_bytes))
    }

    pub fn is_truncated(&self, id: &str) -> AppResult<bool> {
        self.with(id, |entry| Ok(entry.truncated))
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&StoredResponse) -> AppResult<T>) -> AppResult<T> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| AppError::internal("响应仓库锁中毒"))?;
        let entry = entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| AppError::not_found("该响应已不在内存中，请重新发送请求"))?;
        f(entry)
    }

    /// 分段取回：内存前缀命中内存，其余从落地文件读取。
    pub fn span(&self, id: &str, offset: u64, length: usize) -> AppResult<ResponseSpan> {
        self.with(id, |entry| {
            let length = length.min(crate::net::limits::MAX_SPAN_LENGTH);
            let end = offset.saturating_add(length as u64).min(entry.total_bytes);
            let effective = end.saturating_sub(offset) as usize;

            let mut buffer = vec![0u8; effective];
            let memory_len = entry.bytes.len() as u64;

            let from_memory = offset.min(memory_len);
            let memory_part =
                (memory_len.saturating_sub(from_memory)).min(effective as u64) as usize;
            if memory_part > 0 {
                let start = from_memory as usize;
                buffer[..memory_part].copy_from_slice(&entry.bytes[start..start + memory_part]);
            }

            if memory_part < effective {
                let spill = entry.spill.as_ref().ok_or_else(|| {
                    AppError::new(
                        ErrorCode::Internal,
                        "该响应已被截断，但缺少可读取的完整副本",
                    )
                })?;
                // 落地文件只保存「超出内存前缀」的那一段，因此它的第 0 字节
                // 对应绝对偏移 `entry.bytes.len()`。
                let spill_base = memory_len;
                let absolute = from_memory + memory_part as u64;
                let mut file = std::fs::File::open(spill)?;
                file.seek(SeekFrom::Start(absolute.saturating_sub(spill_base)))?;
                let remaining = effective - memory_part;
                let read = file.read(&mut buffer[memory_part..memory_part + remaining])?;
                buffer.truncate(memory_part + read);
            }

            let text = String::from_utf8(buffer.clone()).ok();
            Ok(ResponseSpan {
                offset,
                length: buffer.len(),
                total_bytes: entry.total_bytes,
                truncated: entry.truncated,
                text,
                base64: B64.encode(&buffer),
            })
        })
    }

    /// 把已捕获的正文完整写入目标位置（超出内存上限的部分来自落地文件）。
    pub fn save_full(&self, id: &str, destination: &Path) -> AppResult<u64> {
        self.with(id, |entry| {
            if let Some(parent) = destination.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }

            let mut out = std::fs::File::create(destination)?;
            out.write_all(&entry.bytes)?;

            let mut written = entry.bytes.len() as u64;
            if let Some(spill) = entry.spill.as_ref() {
                let mut source = std::fs::File::open(spill)?;
                written += std::io::copy(&mut source, &mut out)?;
            }
            out.flush()?;
            Ok(written)
        })
    }

    pub fn clear(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            for entry in entries.drain(..) {
                if let Some(path) = entry.spill {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.entries.lock().map(|entries| entries.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for ResponseStore {
    fn drop(&mut self) {
        self.clear();
        let _ = std::fs::remove_dir_all(&self.temp_root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn captured(bytes: &[u8], truncated: bool, total: u64) -> CapturedBody {
        CapturedBody {
            bytes: bytes.to_vec(),
            truncated,
            total_bytes: total,
            spilled: truncated,
        }
    }

    fn store(tag: &str) -> (TempDir, ResponseStore) {
        let dir = TempDir::new(tag);
        let store = ResponseStore::new(4, dir.join("responses"));
        (dir, store)
    }

    #[test]
    fn span_reads_from_memory_when_possible() {
        let (_dir, store) = store("resp-memory");
        store
            .store("r1", captured(b"hello world", false, 11))
            .expect("存入响应");

        let span = store.span("r1", 0, 5).expect("取回片段");
        assert_eq!(span.text.as_deref(), Some("hello"));
        assert_eq!(span.total_bytes, 11);
        assert!(!span.truncated);

        let span = store.span("r1", 6, 5).expect("取回片段");
        assert_eq!(span.text.as_deref(), Some("world"));
        assert_eq!(span.length, 5);
    }

    #[test]
    fn span_beyond_memory_is_read_from_the_spill_file() {
        let dir = TempDir::new("resp-spill");
        let store = ResponseStore::new(4, dir.join("responses"));
        let spill = store.spill_path("r1");
        std::fs::create_dir_all(spill.parent().unwrap()).unwrap();
        std::fs::write(&spill, b"ABCDEF").expect("写入落地文件");

        store
            .store("r1", captured(b"0123456789", true, 16))
            .expect("存入响应");

        let span = store.span("r1", 10, 6).expect("跨内存边界取回");
        assert_eq!(span.text.as_deref(), Some("ABCDEF"));
        assert!(span.truncated);
    }

    #[test]
    fn save_full_writes_memory_plus_spill() {
        let dir = TempDir::new("resp-save");
        let store = ResponseStore::new(4, dir.join("responses"));
        let spill = store.spill_path("r1");
        std::fs::create_dir_all(spill.parent().unwrap()).unwrap();
        std::fs::write(&spill, b"TAIL").expect("写入落地文件");
        let destination = dir.join("saved/out.bin");

        store
            .store("r1", captured(b"HEAD", true, 8))
            .expect("存入响应");

        let written = store.save_full("r1", &destination).expect("保存全文");
        assert_eq!(written, 8);
        assert_eq!(std::fs::read(&destination).unwrap(), b"HEADTAIL");
    }

    #[test]
    fn eviction_removes_the_oldest_entry_and_its_spill_file() {
        let dir = TempDir::new("resp-evict");
        let store = ResponseStore::new(2, dir.join("responses"));
        let spill = store.spill_path("old");
        std::fs::create_dir_all(spill.parent().unwrap()).unwrap();
        std::fs::write(&spill, b"x").expect("写入落地文件");

        store.store("old", captured(b"a", true, 10)).expect("存入响应");
        store.store("mid", captured(b"b", false, 1)).unwrap();
        store.store("new", captured(b"c", false, 1)).unwrap();

        assert_eq!(store.len(), 2);
        assert!(store.span("old", 0, 1).is_err(), "最早的一条应被淘汰");
        assert!(!spill.exists(), "淘汰时应清理落地文件");
        assert!(store.span("new", 0, 1).is_ok());
    }

    #[test]
    fn unknown_response_reports_not_found() {
        let (_dir, store) = store("resp-missing");
        let err = store.span("missing", 0, 1).expect_err("应报不存在");
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn span_length_is_capped() {
        let (_dir, store) = store("resp-cap");
        let big = vec![b'x'; crate::net::limits::MAX_SPAN_LENGTH + 100];
        store
            .store("r1", captured(&big, false, big.len() as u64))
            .unwrap();
        let span = store
            .span("r1", 0, crate::net::limits::MAX_SPAN_LENGTH * 2)
            .unwrap();
        assert!(span.length <= crate::net::limits::MAX_SPAN_LENGTH);
    }

    #[test]
    fn span_past_the_end_returns_what_exists() {
        let (_dir, store) = store("resp-past-end");
        store.store("r1", captured(b"abc", false, 3)).unwrap();
        let span = store.span("r1", 1, 100).unwrap();
        assert_eq!(span.text.as_deref(), Some("bc"));
        assert_eq!(span.length, 2);
    }

    #[test]
    fn drop_cleans_up_spill_files() {
        let dir = TempDir::new("resp-drop");
        let spill_path;
        {
            let response_store = ResponseStore::new(2, dir.join("responses"));
            let spill = response_store.spill_path("r1");
            std::fs::create_dir_all(spill.parent().unwrap()).unwrap();
            std::fs::write(&spill, b"x").unwrap();
            spill_path = spill.clone();
            response_store
                .store("r1", captured(b"a", true, 5))
                .unwrap();
        }
        assert!(!spill_path.exists(), "仓库销毁时应清理落地文件");
    }
}
