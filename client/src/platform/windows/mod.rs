//! The Windows platform: every Win32 call the client makes lives under here.

mod enforce;
mod foreground;
mod single_instance;
mod tray;
mod warning;

use std::path::{Path, PathBuf};
use std::process::Command;

pub use enforce::{lock_device, quit_app};
pub use foreground::{foreground_app, idle_seconds, is_locked};
pub use single_instance::acquire_single_instance;
pub use tray::start_tray;
pub use warning::show_warning;

pub const PLATFORM_NAME: &str = "windows";

/// What warnings call the device.
pub const DEVICE_NOUN: &str = "PC";

/// App identifier reported when the foreground app cannot be read.
pub const UNKNOWN_APP_ID: &str = "unknown.exe";

/// Windows can read window titles, so YouTube and IM telemetry is collected.
pub const TELEMETRY_SUPPORTED: bool = true;

/// The client replaces its own executable from the published release.
pub const SELF_UPDATE_SUPPORTED: bool = true;

/// LockWorkStation is trusted; lock requests are not verified or reported.
pub const VERIFIES_LOCK: bool = false;

/// Unused while VERIFIES_LOCK is false.
pub fn lock_failure_reason() -> String {
    "LockWorkStation did not lock the session".to_string()
}

/// Published release binary and its checksum file.
pub const RELEASE_ASSET_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe";
pub const RELEASE_CHECKSUM_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe.sha256";

/// Extensions (as passed to `Path::with_extension`) for the downloaded binary
/// and the backup of the running one during a self-update.
pub const UPDATE_NEW_EXTENSION: &str = "exe.new";
pub const UPDATE_OLD_EXTENSION: &str = "exe.old";

/// Device ID used when the hostname cannot be read.
pub const FALLBACK_DEVICE_ID: &str = "windows-pc";

/// Runs the client on the main thread. Windows needs nothing else on the main
/// thread (the tray has its own message-pump thread), so this just calls it.
pub fn run_main_thread<F: FnOnce() + Send + 'static>(client: F) {
    client()
}

pub fn hide_console() {
    unsafe {
        use windows::Win32::System::Console::GetConsoleWindow;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        let hwnd = GetConsoleWindow();
        if hwnd.0 as usize != 0 {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// Config file locations checked after the explicit `--config` path and the
/// executable's own directory, in order.
pub fn config_search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // %LOCALAPPDATA%\Watchtower\config.json
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        paths.push(Path::new(&local_app_data).join("Watchtower").join("config.json"));
    }

    // C:\ProgramData\Watchtower\config.json
    paths.push(PathBuf::from("C:\\ProgramData\\Watchtower\\config.json"));

    paths
}

/// Start the freshly updated executable without a console window.
pub fn relaunch(exe: &Path, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(exe);
    cmd.args(args);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.spawn().map(|_| ())
}
