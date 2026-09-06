#[cfg(windows)]
use windows::core::HSTRING;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Threading::CreateMutexW;

pub struct SingleInstanceGuard {
    #[cfg(windows)]
    handle: HANDLE,
}

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

/// Attempts to acquire a single-instance named mutex on Windows.
/// Returns Some(SingleInstanceGuard) if this is the only running instance,
/// or None if another instance is already running.
pub fn acquire_single_instance(app_id: &str) -> Option<SingleInstanceGuard> {
    #[cfg(windows)]
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

    #[cfg(not(windows))]
    {
        let _ = app_id;
        Some(SingleInstanceGuard {})
    }
}
