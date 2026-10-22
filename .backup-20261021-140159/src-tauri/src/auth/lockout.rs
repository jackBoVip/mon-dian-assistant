//! 失败次数限制与临时锁定。错误提示不得泄露内部 ID 或凭据是否存在。

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockoutStatus {
    pub locked: bool,
    pub failed_count: i64,
    pub seconds_remaining: i64,
    pub attempts_remaining: i64,
}

pub fn evaluate(failed_count: i64, locked_until: Option<&str>, max_attempts: i64, now: i64) -> LockoutStatus {
    let seconds_remaining = match locked_until {
        Some(until) => parse_ts(until).map(|t| (t - now).max(0)).unwrap_or(0),
        None => 0,
    };
    let locked = seconds_remaining > 0;
    LockoutStatus {
        locked,
        failed_count,
        seconds_remaining,
        attempts_remaining: if locked { 0 } else { (max_attempts - failed_count).max(0) },
    }
}

/// 逐步延迟：即使尚未达到锁定阈值，也按失败次数给出建议等待秒数，抬高暴力猜测成本。
pub fn progressive_backoff_seconds(failed_count: i64) -> i64 {
    match failed_count {
        0..=2 => 0,
        3 => 1,
        4 => 3,
        5 => 8,
        n => (2i64.pow(n.min(10) as u32)).min(60),
    }
}

pub fn should_lock(failed_count: i64, max_attempts: i64) -> bool {
    max_attempts > 0 && failed_count >= max_attempts
}

pub fn locked_until_rfc3339(now: i64, lockout_seconds: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(now + lockout_seconds, 0)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

fn parse_ts(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_locked_before_threshold() {
        let st = evaluate(2, None, 5, 1000);
        assert!(!st.locked);
        assert_eq!(st.attempts_remaining, 3);
    }

    #[test]
    fn locked_until_in_future_locks() {
        let until = locked_until_rfc3339(1000, 300);
        let st = evaluate(5, Some(&until), 5, 1100);
        assert!(st.locked);
        assert_eq!(st.seconds_remaining, 200);
        assert_eq!(st.attempts_remaining, 0);
    }

    #[test]
    fn expired_lockout_unlocks() {
        let until = locked_until_rfc3339(1000, 300);
        let st = evaluate(5, Some(&until), 5, 1400);
        assert!(!st.locked);
    }

    #[test]
    fn should_lock_at_threshold_only() {
        assert!(!should_lock(4, 5));
        assert!(should_lock(5, 5));
        assert!(!should_lock(99, 0), "0 表示不启用锁定");
    }

    /// 设置项 `max_failed_login_attempts` = 0 的语义是"不启用锁定"（见上面那条断言），
    /// 所以 `evaluate` 此时**不得**报 `locked`：否则解锁界面会显示"已被临时锁定 / 0 秒后重试"，
    /// 而后端其实照常接受下一次尝试——这是界面骗人，不是策略。
    #[test]
    fn zero_max_means_no_locking_at_all() {
        let st = evaluate(9, None, 0, 1000);
        assert!(!st.locked, "锁定策略关闭时不能报锁定态");
        assert_eq!(st.seconds_remaining, 0);
        assert_eq!(st.attempts_remaining, 0);
    }

    #[test]
    fn backoff_grows_monotonically_and_caps() {
        let mut prev = -1;
        for n in 0..15 {
            let v = progressive_backoff_seconds(n);
            assert!(v >= prev, "延迟必须单调不减");
            assert!(v <= 60);
            prev = v;
        }
    }
}
