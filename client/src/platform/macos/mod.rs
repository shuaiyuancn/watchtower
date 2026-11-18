//! The macOS platform (Apple Silicon, macOS 14+).
//!
//! The client runs as the child's Standard user inside their GUI session,
//! started by a launch agent, from a root-owned install directory. It is
//! ad-hoc signed, so nothing here may need a privacy (TCC) permission: no
//! Accessibility, Screen Recording, Automation or Notification Center. See
//! docs/adr/0001-unsigned-macos-client.md.
//!
//! AppKit work happens on the process main thread, which `run_main_thread`
//! turns into a small event loop (`app.rs`). The tokio client runs on its own
//! thread and reaches the main thread through a job queue.

mod app;
mod lock;
mod session;
mod single_instance;

use std::path::{Path, PathBuf};
use std::process::Command;

pub use app::{foreground_app, quit_app, run_main_thread, show_warning};
pub use lock::{lock_device, lock_failure_reason};
pub use session::{idle_seconds, is_locked};
pub use single_instance::{acquire_single_instance, SingleInstanceGuard};

pub const PLATFORM_NAME: &str = "macos";

/// What warnings call the device.
pub const DEVICE_NOUN: &str = "Mac";

/// Empty: the server treats an empty app as a system surface (login window,
/// nothing in front), which no rule matches.
pub const UNKNOWN_APP_ID: &str = "";

/// Window titles need Screen Recording or Accessibility, which an ad-hoc
/// signed binary cannot keep, so there is no YouTube or IM telemetry.
pub const TELEMETRY_SUPPORTED: bool = false;

/// The child cannot write the install directory. A root launchd helper
/// replaces the binary and restarts the agent instead.
pub const SELF_UPDATE_SUPPORTED: bool = false;

/// The private lock call and the pmset fallback can both do nothing, so every
/// lock is checked and failures are reported.
pub const VERIFIES_LOCK: bool = true;

/// Published release binary and its checksum file. Unused while
/// SELF_UPDATE_SUPPORTED is false; kept so the platform surface is complete.
pub const RELEASE_ASSET_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower-macos-arm64";
pub const RELEASE_CHECKSUM_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower-macos-arm64.sha256";

/// The binary has no extension, so `with_extension` gives `watchtower.new`
/// and `watchtower.old`.
pub const UPDATE_NEW_EXTENSION: &str = "new";
pub const UPDATE_OLD_EXTENSION: &str = "old";

/// Device ID used when the hostname cannot be read.
pub const FALLBACK_DEVICE_ID: &str = "mac";

/// No console window to hide: launchd starts the client without a terminal.
pub fn hide_console() {}

/// No menu bar icon.
pub fn start_tray(device_id: String) {
    let _ = device_id;
}

/// Config file locations checked after `--config` and the executable's own
/// directory. The installer puts the binary and config.json in the same
/// root-owned directory, so the executable-directory lookup normally finds it.
pub fn config_search_paths() -> Vec<PathBuf> {
    vec![PathBuf::from("/Library/Application Support/Watchtower/config.json")]
}

/// Start another copy of the client. Unused while SELF_UPDATE_SUPPORTED is false.
pub fn relaunch(exe: &Path, args: &[String]) -> std::io::Result<()> {
    Command::new(exe).args(args).spawn().map(|_| ())
}
