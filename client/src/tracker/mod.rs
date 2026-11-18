/// Seconds without keyboard or mouse input after which the user counts as idle.
pub const IDLE_THRESHOLD_SECS: u64 = 120;

/// Whether this heartbeat should be reported as idle, which stops screen time
/// from accumulating. A locked desktop is idle immediately; otherwise the user
/// is idle after IDLE_THRESHOLD_SECS without input.
pub fn counts_as_idle(idle_secs: u64, session_locked: bool) -> bool {
    session_locked || idle_secs > IDLE_THRESHOLD_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_session_is_idle_even_with_recent_input() {
        assert!(counts_as_idle(0, true));
        assert!(counts_as_idle(IDLE_THRESHOLD_SECS, true));
    }

    #[test]
    fn unlocked_session_is_idle_only_past_the_threshold() {
        assert!(!counts_as_idle(0, false));
        assert!(!counts_as_idle(IDLE_THRESHOLD_SECS, false));
        assert!(counts_as_idle(IDLE_THRESHOLD_SECS + 1, false));
    }
}
