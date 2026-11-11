#[derive(Debug, Clone)]
pub struct ForegroundInfo {
    pub executable_name: String,
    pub window_title: String,
    pub pid: u32,
}

#[cfg(windows)]
pub mod imp {
    use super::ForegroundInfo;
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
    };
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn get_foreground_window_info() -> Option<ForegroundInfo> {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0 == 0 as _ {
                return None;
            }

            // 1. Get Window Title
            let mut title_buf = [0u16; 512];
            let title_len = GetWindowTextW(hwnd, &mut title_buf);
            let window_title = if title_len > 0 {
                String::from_utf16_lossy(&title_buf[..title_len as usize])
            } else {
                String::new()
            };

            // 2. Get Process ID
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }

            // 3. Query Process Executable Name
            let process_handle: Result<HANDLE, _> =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);

            let executable_name = if let Ok(handle) = process_handle {
                let mut path_buf = [0u16; 1024];
                let mut size = path_buf.len() as u32;

                let success = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(path_buf.as_mut_ptr()),
                    &mut size,
                );

                let _ = CloseHandle(handle);

                if success.is_ok() && size > 0 {
                    let full_path = String::from_utf16_lossy(&path_buf[..size as usize]);
                    Path::new(&full_path)
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("unknown.exe")
                        .to_string()
                } else {
                    "unknown.exe".to_string()
                }
            } else {
                "system.exe".to_string()
            };

            Some(ForegroundInfo {
                executable_name,
                window_title,
                pid,
            })
        }
    }

    pub fn get_idle_seconds() -> u64 {
        unsafe {
            let mut lii = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };

            if GetLastInputInfo(&mut lii).as_bool() {
                let current_tick = GetTickCount();
                if current_tick >= lii.dwTime {
                    let diff_ms = current_tick - lii.dwTime;
                    return (diff_ms / 1000) as u64;
                }
            }
            0
        }
    }

    /// WTSINFOEX_LEVEL1.SessionFlags value for a locked session (WTS_SESSIONSTATE_LOCK).
    const SESSION_FLAG_LOCKED: i64 = 0;

    /// True while this session's desktop is locked (lock screen showing, or the
    /// session is switched out). Any failure reads as "not locked", so a broken
    /// query can never stop screen time from being counted.
    pub fn is_session_locked() -> bool {
        unsafe {
            let mut buf = PWSTR::null();
            let mut bytes = 0u32;
            if WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &mut buf,
                &mut bytes,
            )
            .is_err()
                || buf.is_null()
            {
                return false;
            }

            let mut locked = false;
            if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
                let info = std::ptr::read_unaligned(buf.0 as *const WTSINFOEXW);
                if info.Level == 1 {
                    locked = info.Data.WTSInfoExLevel1.SessionFlags as i64 == SESSION_FLAG_LOCKED;
                }
            }
            WTSFreeMemory(buf.0 as *mut core::ffi::c_void);
            locked
        }
    }
}

#[cfg(not(windows))]
pub mod imp {
    use super::ForegroundInfo;

    pub fn get_foreground_window_info() -> Option<ForegroundInfo> {
        Some(ForegroundInfo {
            executable_name: "test_process.exe".to_string(),
            window_title: "Test Window Title".to_string(),
            pid: 1234,
        })
    }

    pub fn get_idle_seconds() -> u64 {
        0
    }

    pub fn is_session_locked() -> bool {
        false
    }
}

pub fn get_foreground_info() -> Option<ForegroundInfo> {
    imp::get_foreground_window_info()
}

pub fn get_idle_time_seconds() -> u64 {
    imp::get_idle_seconds()
}

pub fn is_session_locked() -> bool {
    imp::is_session_locked()
}

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
