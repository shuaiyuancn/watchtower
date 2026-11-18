//! The Platform layer: everything the client needs from the operating system.
//!
//! Each platform module exposes the same items with the same signatures, and
//! `cfg` picks one at compile time. The rest of the client calls `platform::*`
//! and keeps the platform-neutral logic (warning debounce, idle threshold,
//! update hash checks and file swap, heartbeat loop) to itself.
//!
//! Surface every platform module provides:
//!
//! - `PLATFORM_NAME: &str`
//! - `UNKNOWN_APP_ID: &str`: app identifier used when the foreground app is unreadable
//! - `TELEMETRY_SUPPORTED: bool`: whether window-title telemetry (YouTube, IM) runs
//! - `RELEASE_ASSET_URL`, `RELEASE_CHECKSUM_URL: &str`: self-update downloads
//! - `UPDATE_NEW_EXTENSION`, `UPDATE_OLD_EXTENSION: &str`: self-update temp and backup files
//! - `FALLBACK_DEVICE_ID: &str`: device ID when the hostname is unreadable
//! - `fn run_main_thread<F: FnOnce() + Send + 'static>(client: F)`: owns the
//!   process main thread and runs `client` (the tokio runtime) on it or beside it
//! - `fn hide_console()`
//! - `fn acquire_single_instance() -> Option<SingleInstanceGuard>`: None if
//!   another client is running; the guard holds the lock until dropped
//! - `fn start_tray(device_id: String)`: the client's tray or menu-bar presence
//! - `fn foreground_app() -> Option<ForegroundApp>`
//! - `fn idle_seconds() -> u64`: seconds since the last keyboard or mouse input
//! - `fn is_locked() -> bool`: whether the device's desktop is locked
//! - `fn quit_app(app_id: &str) -> bool`: force-quit an app by app identifier
//! - `fn lock_device() -> bool`: lock the device; true if the request was made
//! - `fn show_warning(title: &str, message: &str)`: show a warning to the child, undebounced
//! - `fn config_search_paths() -> Vec<PathBuf>`: config files to try, in order
//! - `fn relaunch(exe: &Path, args: &[String]) -> std::io::Result<()>`: start
//!   the updated client before this process exits

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use self::stub::*;

/// The app in front of the child right now.
#[derive(Debug, Clone)]
pub struct ForegroundApp {
    /// Platform-specific app identifier (on Windows the executable name, e.g.
    /// `chrome.exe`). Sent to the server as `currentApp`.
    pub app_id: String,
    /// Human-readable app name, where the platform has one separate from the
    /// app identifier. Windows does not; it is not sent to the server.
    #[allow(dead_code)]
    pub display_name: Option<String>,
    /// Title of the foreground window, or empty if unavailable.
    pub window_title: String,
}

impl ForegroundApp {
    /// Placeholder used when the foreground app cannot be read.
    pub fn unknown() -> Self {
        Self {
            app_id: UNKNOWN_APP_ID.to_string(),
            display_name: None,
            window_title: String::new(),
        }
    }
}
