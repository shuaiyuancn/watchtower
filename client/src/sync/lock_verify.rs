//! Lock verification for platforms whose lock call can silently do nothing
//! (`platform::VERIFIES_LOCK`). The server re-requests the lock on every
//! heartbeat ACK, about every 3 seconds, while a limit, curfew or emergency
//! lock holds. If those requests keep coming for LOCK_GRACE and the device is
//! still unlocked, the client reports LOCK_FAILED, at most once per
//! REPORT_INTERVAL.

use std::time::{Duration, Instant};

/// How long the lock may be requested without effect before it counts as failed.
pub const LOCK_GRACE: Duration = Duration::from_secs(10);

/// Minimum time between two LOCK_FAILED reports.
pub const REPORT_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// A pause in lock requests longer than this ends the current run of requests.
/// Several heartbeats long, so one dropped ACK does not reset the run.
pub const REQUEST_GAP: Duration = Duration::from_secs(15);

#[derive(Debug, Default)]
pub struct LockVerifier {
    /// First request of the current run of requests that found the device unlocked.
    unlocked_since: Option<Instant>,
    last_request: Option<Instant>,
    last_report: Option<Instant>,
}

impl LockVerifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a lock request made at `now`; `locked` is whether the device was
    /// locked when the request arrived. Returns true when a LOCK_FAILED report
    /// is due.
    pub fn on_lock_request(&mut self, now: Instant, locked: bool) -> bool {
        let continuous = self
            .last_request
            .map(|last| now.saturating_duration_since(last) <= REQUEST_GAP)
            .unwrap_or(false);
        self.last_request = Some(now);

        if locked || !continuous {
            self.unlocked_since = None;
        }
        if locked {
            return false;
        }

        let since = *self.unlocked_since.get_or_insert(now);
        if now.saturating_duration_since(since) < LOCK_GRACE {
            return false;
        }

        let report_due = self
            .last_report
            .map(|last| now.saturating_duration_since(last) >= REPORT_INTERVAL)
            .unwrap_or(true);
        if report_due {
            self.last_report = Some(now);
        }
        report_due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// Feed requests every 3 s from `start` for `count` requests; return the
    /// offsets (seconds from `start`) at which a report was due.
    fn run(v: &mut LockVerifier, start: Instant, from: u64, count: u64, locked: bool) -> Vec<u64> {
        (0..count)
            .map(|i| from + i * 3)
            .filter(|&t| v.on_lock_request(start + secs(t), locked))
            .collect()
    }

    #[test]
    fn reports_after_ten_seconds_of_unlocked_requests() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        // Requests at 0, 3, 6, 9, 12: the one at 12 s is past the grace period.
        assert_eq!(run(&mut v, t0, 0, 5, false), vec![12]);
    }

    #[test]
    fn never_reports_when_the_lock_works() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        assert!(!v.on_lock_request(t0, false));
        assert!(run(&mut v, t0, 3, 100, true).is_empty());
    }

    #[test]
    fn reports_at_most_once_per_interval() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        // 15 minutes of failed requests every 3 s.
        let reports = run(&mut v, t0, 0, 300, false);
        assert_eq!(reports, vec![12, 612]);
    }

    #[test]
    fn a_successful_lock_restarts_the_grace_period() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        assert!(run(&mut v, t0, 0, 3, false).is_empty()); // 0, 3, 6
        assert!(!v.on_lock_request(t0 + secs(9), true)); // locked
        // Unlocked again from 12 s: the run restarts, so the first report is at 24 s.
        assert_eq!(run(&mut v, t0, 12, 5, false), vec![24]);
    }

    #[test]
    fn a_pause_in_requests_restarts_the_grace_period() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        assert!(run(&mut v, t0, 0, 3, false).is_empty()); // 0, 3, 6
        // Lock no longer requested for a while (limit lifted), then requested again.
        assert!(run(&mut v, t0, 60, 3, false).is_empty()); // 60, 63, 66
        assert_eq!(run(&mut v, t0, 69, 2, false), vec![72]);
    }

    #[test]
    fn tolerates_one_missed_heartbeat() {
        let t0 = Instant::now();
        let mut v = LockVerifier::new();
        assert!(!v.on_lock_request(t0, false));
        assert!(!v.on_lock_request(t0 + secs(6), false)); // 3 s ACK missed
        assert!(v.on_lock_request(t0 + secs(12), false));
    }
}
