//! Single-instance guard backed by a named Win32 mutex.

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;

const INSTANCE_MUTEX_NAME: &str = "WatchtowerClientDaemonMutex";

pub struct SingleInstanceGuard {
    handle: HANDLE,
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Returns Some(SingleInstanceGuard) if this is the only running instance of
/// the client, or None if another instance already holds the mutex.
pub fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    acquire_named_mutex(INSTANCE_MUTEX_NAME)
}

/// Attempts to acquire a single-instance named mutex on Windows.
fn acquire_named_mutex(app_id: &str) -> Option<SingleInstanceGuard> {
    unsafe {
        // Try global mutex first (handles cross-session if elevated), fallback to Local (user session)
        let global_name = HSTRING::from(format!("Global\\{app_id}"));
        let handle_res = CreateMutexW(None, true, windows::core::PCWSTR(global_name.as_ptr()));

        let handle = match handle_res {
            Ok(h) => Ok(h),
            Err(_) => {
                let local_name = HSTRING::from(format!("Local\\{app_id}"));
                CreateMutexW(None, true, windows::core::PCWSTR(local_name.as_ptr()))
            }
        };

        if let Ok(h) = handle {
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(h);
                return None;
            }
            return Some(SingleInstanceGuard { handle: h });
        }

        None
    }
}
