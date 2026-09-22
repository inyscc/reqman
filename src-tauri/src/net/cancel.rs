//! 在飞请求的撤销（spec: http-engine「请求取消」）。
//!
//! 一次发送是一个**会话**：前置脚本、主请求、后置脚本，以及脚本内经 `pm.sendRequest`
//! 发出的请求都属于它。用户按下取消时要撤销的是该会话下**全部**在飞请求——脚本可以
//! 并发发出多个请求（宿主的事件处理是游离的异步任务，不阻塞脚本），所以注册表按会话收
//! 一组令牌，而不是只留一个「当前请求」的槽位；也不能是「取消全部在飞」，那会把本次发送
//! 之外的请求一起卷进来。
//!
//! 收尾用 RAII：令牌从注册表里摘除发生在 `SendToken` 的 drop 里，正常结束与取消两条路径
//! 走的是同一段代码，不会出现「取消路径忘了清理」这种只在出错时才暴露的漏洞。

use crate::error::{AppError, ErrorCode};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// 按发送会话登记在飞请求。
#[derive(Default)]
pub struct SendRegistry {
    entries: Mutex<HashMap<String, HashMap<u64, CancellationToken>>>,
    next: AtomicU64,
}

impl SendRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 为某个会话登记一个在飞请求；返回的句柄 drop 时自动把自己摘除。
    pub fn open(self: &Arc<Self>, attempt_id: &str) -> SendToken {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let token = CancellationToken::new();

        if let Ok(mut entries) = self.entries.lock() {
            entries
                .entry(attempt_id.to_string())
                .or_default()
                .insert(id, token.clone());
        }

        SendToken {
            attempt_id: attempt_id.to_string(),
            id,
            token,
            registry: Arc::clone(self),
        }
    }

    /// 撤销某个会话下的全部在飞请求，返回撤销的数量。
    ///
    /// 返回值只作诊断用：**结果归属由被撤销的请求自己表达**（它以取消错误结束），前端不该
    /// 据此判定本次发送的结果——否则会出现「界面说已取消、响应其实已经到了」。
    pub fn cancel(&self, attempt_id: &str) -> usize {
        let Ok(entries) = self.entries.lock() else {
            return 0;
        };

        let Some(tokens) = entries.get(attempt_id) else {
            return 0;
        };

        let count = tokens.len();
        for token in tokens.values() {
            token.cancel();
        }
        count
    }

    /// 该会话当前的在飞数量（诊断与测试用）。
    pub fn in_flight(&self, attempt_id: &str) -> usize {
        self.entries
            .lock()
            .map(|entries| entries.get(attempt_id).map(HashMap::len).unwrap_or(0))
            .unwrap_or(0)
    }

    fn close(&self, attempt_id: &str, id: u64) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };

        if let Some(tokens) = entries.get_mut(attempt_id) {
            tokens.remove(&id);
            if tokens.is_empty() {
                entries.remove(attempt_id);
            }
        }
    }
}

/// 一次在飞请求的句柄：持有它的撤销令牌，并在 drop 时从注册表摘除。
pub struct SendToken {
    attempt_id: String,
    id: u64,
    token: CancellationToken,
    registry: Arc<SendRegistry>,
}

impl SendToken {
    /// 该请求是否已被取消。
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// 撤销信号的副本，供 `select!` 使用。
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// 取消时统一产出的结果：它与超时等失败可区分，但不是「错误」。
    pub fn cancelled_error(&self) -> AppError {
        AppError::new(ErrorCode::Cancelled, "请求已被取消")
    }
}

impl Drop for SendToken {
    fn drop(&mut self) {
        self.registry.close(&self.attempt_id, self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_can_hold_several_in_flight_requests() {
        let registry = Arc::new(SendRegistry::new());
        let first = registry.open("attempt-1");
        let second = registry.open("attempt-1");
        let other = registry.open("attempt-2");

        assert_eq!(registry.in_flight("attempt-1"), 2, "同一会话下可以并发多个请求");
        assert_eq!(
            registry.cancel("attempt-1"),
            2,
            "撤销会话下的全部在飞请求"
        );

        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(!other.is_cancelled(), "别的会话不该被卷进来");
    }

    #[test]
    fn finishing_a_request_removes_its_registration() {
        let registry = Arc::new(SendRegistry::new());
        {
            let _token = registry.open("attempt-1");
            assert_eq!(registry.in_flight("attempt-1"), 1);
        }

        assert_eq!(
            registry.in_flight("attempt-1"),
            0,
            "正常结束与取消都走同一条摘除路径"
        );
        assert_eq!(registry.cancel("attempt-1"), 0, "空会话撤销不产生结果");
    }

    #[test]
    fn cancelling_an_unknown_session_is_a_no_op() {
        let registry = Arc::new(SendRegistry::new());
        assert_eq!(registry.cancel("never-started"), 0);
    }
}
