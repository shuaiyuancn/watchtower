//! Stand-in platform for targets without a real implementation, so the crate
//! still builds and its tests run on non-Windows hosts. It returns fixed mock
//! values and keeps the Windows constants, which is how the client behaved on
//! these hosts before the platform module existed.

use super::ForegroundApp;
use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::info;

/// Not a value the server accepts, so the client sends no platform.
pub const PLATFORM_NAME: &str = "stub";

pub const DEVICE_NOUN: &str = "PC";

pub const UNKNOWN_APP_ID: &str = "unknown.exe";

pub const TELEMETRY_SUPPORTED: bool = true;

pub const SELF_UPDATE_SUPPORTED: bool = true;

pub const VERIFIES_LOCK: bool = false;

pub fn lock_failure_reason() -> String {
    "[Mock] lock did not take effect".to_string()
}

pub const RELEASE_ASSET_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe";
pub const RELEASE_CHECKSUM_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe.sha256";

pub const UPDATE_NEW_EXTENSION: &str = "exe.new";
pub const UPDATE_OLD_EXTENSION: &str = "exe.old";

pub const FALLBACK_DEVICE_ID: &str = "windows-pc";

pub fn run_main_thread<F: FnOnce() + Send + 'static>(client: F) {
    client()
}

pub fn hide_console() {}

pub struct SingleInstanceGuard;

pub fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    Some(SingleInstanceGuard)
}

pub fn start_tray(device_id: String) {
    let _ = device_id;
}

pub fn foreground_app() -> Option<ForegroundApp> {
    Some(ForegroundApp {
        app_id: "test_process.exe".to_string(),
        display_name: None,
        window_title: "Test Window Title".to_string(),
    })
}

pub fn idle_seconds() -> u64 {
    0
}

pub fn is_locked() -> bool {
    false
}

pub fn quit_app(app_id: &str) -> bool {
    info!("[Mock] Terminating process by name {}", app_id);
    true
}

pub fn lock_device() -> bool {
    info!("[Mock] Locking workstation");
    true
}

pub fn show_warning(title: &str, message: &str) {
    let _ = (title, message);
}

pub fn config_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        paths.push(Path::new(&local_app_data).join("Watchtower").join("config.json"));
    }
    paths.push(PathBuf::from("C:\\ProgramData\\Watchtower\\config.json"));
    paths
}

pub fn relaunch(exe: &Path, args: &[String]) -> std::io::Result<()> {
    Command::new(exe).args(args).spawn().map(|_| ())
}
