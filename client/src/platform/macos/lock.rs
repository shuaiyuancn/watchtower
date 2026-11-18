//! Screen lock. The supported way to lock a Mac needs Accessibility or
//! Automation, so the client calls the private `SACLockScreenImmediate` from
//! login.framework (loaded at runtime, never linked), as Hammerspoon does.
//! If that is missing it puts the display to sleep with pmset, which locks
//! only when "require password after sleep" is set to immediately. The sync
//! loop verifies the result (VERIFIES_LOCK).

use std::ffi::CString;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use tracing::{info, warn};

type SacLockScreenImmediate = unsafe extern "C" fn();

const LOGIN_FRAMEWORK_PATHS: [&str; 2] = [
    "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login",
    "/System/Library/PrivateFrameworks/login.framework/login",
];

const MECHANISM_NONE: u8 = 0;
const MECHANISM_SAC: u8 = 1;
const MECHANISM_PMSET: u8 = 2;
const MECHANISM_PMSET_FAILED: u8 = 3;

static LAST_MECHANISM: AtomicU8 = AtomicU8::new(MECHANISM_NONE);

/// `SACLockScreenImmediate`, resolved once. The library handle is kept open
/// for the life of the process, so the pointer stays valid.
fn sac_lock_screen() -> Option<SacLockScreenImmediate> {
    static CELL: OnceLock<Option<SacLockScreenImmediate>> = OnceLock::new();
    *CELL.get_or_init(|| {
        let symbol = CString::new("SACLockScreenImmediate").ok()?;
        for path in LOGIN_FRAMEWORK_PATHS {
            let Ok(c_path) = CString::new(path) else { continue };
            // SAFETY: dlopen/dlsym with valid NUL-terminated strings. The
            // handle is never closed.
            unsafe {
                let handle = libc::dlopen(c_path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
                if handle.is_null() {
                    continue;
                }
                let sym = libc::dlsym(handle, symbol.as_ptr());
                if sym.is_null() {
                    continue;
                }
                info!("[lock] using SACLockScreenImmediate from {}", path);
                // SAFETY: the symbol is a `void SACLockScreenImmediate(void)`.
                return Some(std::mem::transmute::<*mut libc::c_void, SacLockScreenImmediate>(sym));
            }
        }
        warn!("[lock] SACLockScreenImmediate not found; falling back to pmset displaysleepnow");
        None
    })
}

/// Lock the screen. Returns whether a lock request was made.
pub fn lock_device() -> bool {
    if let Some(lock_fn) = sac_lock_screen() {
        LAST_MECHANISM.store(MECHANISM_SAC, Ordering::Relaxed);
        super::app::call_on_main_thread(lock_fn);
        return true;
    }

    match Command::new("/usr/bin/pmset")
        .arg("displaysleepnow")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            LAST_MECHANISM.store(MECHANISM_PMSET, Ordering::Relaxed);
            // Reap it off the async thread so it does not linger as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(e) => {
            LAST_MECHANISM.store(MECHANISM_PMSET_FAILED, Ordering::Relaxed);
            warn!("[lock] could not start pmset: {}", e);
            false
        }
    }
}

/// Which mechanism the last lock request used, for LOCK_FAILED.
pub fn lock_failure_reason() -> String {
    reason_for(LAST_MECHANISM.load(Ordering::Relaxed)).to_string()
}

fn reason_for(mechanism: u8) -> &'static str {
    match mechanism {
        MECHANISM_SAC => "SACLockScreenImmediate was called but the screen stayed unlocked",
        MECHANISM_PMSET => {
            "SACLockScreenImmediate unavailable; pmset displaysleepnow ran but the screen stayed unlocked (is a password required immediately after sleep?)"
        }
        MECHANISM_PMSET_FAILED => "SACLockScreenImmediate unavailable and pmset displaysleepnow could not start",
        _ => "no lock mechanism has run yet",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::MAX_LOCK_FAILED_REASON_LEN;

    #[test]
    fn reasons_fit_the_server_cap() {
        for m in [MECHANISM_NONE, MECHANISM_SAC, MECHANISM_PMSET, MECHANISM_PMSET_FAILED] {
            let r = reason_for(m);
            assert!(!r.is_empty());
            assert!(r.encode_utf16().count() <= MAX_LOCK_FAILED_REASON_LEN);
        }
    }

    #[test]
    fn resolving_the_lock_symbol_does_not_crash() {
        // Only resolves the symbol; never calls it (that would lock the runner).
        let _ = sac_lock_screen();
    }
}
