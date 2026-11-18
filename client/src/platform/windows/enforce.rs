//! Quitting an app and locking the device on Windows.

use std::os::windows::process::CommandExt;
use std::process::Command;
use tracing::{error, info};

/// Force-quit every process whose executable name is `app_id`.
pub fn quit_app(app_id: &str) -> bool {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/IM", app_id]);
    cmd.creation_flags(0x08000000);
    let status = cmd.output();

    match status {
        Ok(output) if output.status.success() => {
            info!("Terminated {} via taskkill /IM", app_id);
            true
        }
        _ => {
            error!("Failed to terminate process by name {}", app_id);
            false
        }
    }
}

/// Lock the workstation (open apps and windows stay as they are). Returns
/// true if LockWorkStation succeeded or the rundll32 fallback was started.
pub fn lock_device() -> bool {
    info!("Executing immediate Windows workstation lock (preserving open apps/windows)...");
    let api_ok = unsafe { windows::Win32::System::Shutdown::LockWorkStation().is_ok() };

    // Secondary fallback
    let fallback_ok = Command::new("rundll32.exe")
        .args(["user32.dll,LockWorkStation"])
        .spawn()
        .is_ok();

    api_ok || fallback_ok
}
