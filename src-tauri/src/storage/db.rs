//! 数据库句柄：单写者 + 读连接池（design.md D3）。

use super::migrations;
use crate::error::{AppError, AppResult, ErrorCode};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

pub struct Db {
    path: Option<PathBuf>,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    in_memory: bool,
}

impl Db {
    /// 打开（必要时创建）文件型数据库，并在打开时完成迁移与初始化。
    pub fn open(path: impl AsRef<Path>) -> AppResult<Arc<Self>> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut writer = Self::new_connection(&path, false)?;
        let version = migrations::migrate(&mut writer, Some(&path), migrations::MIGRATIONS)?;
        crate::logging::global().info(&format!("storage ready schema_version={}", version));

        let db = Arc::new(Self {
            path: Some(path),
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
            in_memory: false,
        });
        db.bootstrap()?;
        Ok(db)
    }

    /// 内存数据库，供测试使用。
    pub fn open_in_memory() -> AppResult<Arc<Self>> {
        let writer = Connection::open_in_memory()?;
        Self::configure(&writer)?;
        let db = Arc::new(Self {
            path: None,
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
            in_memory: true,
        });
        db.write_tx(|conn| {
            migrations::migrate(conn, None, migrations::MIGRATIONS)?;
            Ok(())
        })?;
        db.bootstrap()?;
        Ok(db)
    }

    fn new_connection(path: &Path, read_only: bool) -> AppResult<Connection> {
        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
        };
        let conn = Connection::open_with_flags(path, flags)?;
        Self::configure(&conn)?;
        Ok(conn)
    }

    fn configure(conn: &Connection) -> AppResult<()> {
        // journal_mode 会返回一行结果，不能用 pragma_update
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(())
    }

    /// 写操作：经单写者串行化。
    pub fn write<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.writer()?;
        f(&conn)
    }

    /// 需要事务的写操作。
    pub fn write_tx<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.writer()?;
        f(&mut conn)
    }

    /// 读操作：优先复用池中的只读连接。
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        if self.in_memory {
            let conn = self.writer()?;
            return f(&conn);
        }

        let pooled = self
            .readers
            .lock()
            .map_err(|_| AppError::internal("读连接池锁中毒"))?
            .pop();

        let conn = match pooled {
            Some(conn) => conn,
            None => {
                let path = self
                    .path
                    .as_ref()
                    .ok_or_else(|| AppError::new(ErrorCode::StorageUnavailable, "数据库路径缺失"))?;
                Self::new_connection(path, true)?
            }
        };

        let result = f(&conn);
        // 无论成功与否都归还连接
        if let Ok(mut pool) = self.readers.lock() {
            pool.push(conn);
        }
        result
    }

    fn writer(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.writer
            .lock()
            .map_err(|_| AppError::internal("存储锁中毒"))
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> AppResult<i64> {
        self.read(migrations::current_version)
    }

    /// 用备份文件的内容替换当前数据库（design D4 / 任务 2.7）。
    ///
    /// 走 SQLite 的在线备份 API 直接灌入当前连接，不做文件替换，因此不需要
    /// 关闭或重开连接；完成后丢弃读连接池，避免旧快照继续被使用。
    pub fn replace_contents_with(&self, source_path: &Path) -> AppResult<()> {
        if !source_path.exists() {
            return Err(AppError::invalid_input(format!(
                "备份文件不存在：{}",
                source_path.display()
            )));
        }

        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let source_version = migrations::current_version(&source)?;
        if source_version > migrations::LATEST_VERSION {
            return Err(AppError::invalid_input(format!(
                "备份文件的 schema 版本（{}）高于当前应用支持的版本（{}），无法恢复",
                source_version, migrations::LATEST_VERSION
            )));
        }

        let mut writer = self.writer()?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut writer)?;
            backup.run_to_completion(64, Duration::from_millis(0), None)?;
        }

        // 备份可能是旧版本，恢复后补齐迁移
        migrations::migrate(&mut writer, self.path.as_deref(), migrations::MIGRATIONS)?;
        drop(writer);

        // 读者连接持有旧快照，全部丢弃
        if let Ok(mut pool) = self.readers.lock() {
            pool.clear();
        }
        Ok(())
    }

    fn bootstrap(&self) -> AppResult<()> {
        super::workspace::ensure_default_workspace(self)?;
        Ok(())
    }

    /// 测试中使用：直接拿到写连接以执行原始 SQL 断言。
    #[cfg(test)]
    pub fn writer_for_test(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().expect("存储锁未中毒")
    }
}
