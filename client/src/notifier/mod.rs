use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

use crate::platform;

static LAST_NOTIFICATION_TIME: AtomicI64 = AtomicI64::new(0);

/// Show a warning to the child, at most once every 30 seconds.
pub fn show_warning(title: &str, message: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let last = LAST_NOTIFICATION_TIME.load(Ordering::Relaxed);
    // Debounce: don't show more than one toast every 30 seconds
    if now - last < 30 {
        return;
    }
    LAST_NOTIFICATION_TIME.store(now, Ordering::Relaxed);

    info!("[Notification] {}: {}", title, message);

    platform::show_warning(title, message);
}
