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
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::System::ProcessStatus::GetProcessImageFileNameW;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetLastInputInfo, GetWindowTextW, GetWindowThreadProcessId,
        LASTINPUTINFO,
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
}

pub fn get_foreground_info() -> Option<ForegroundInfo> {
    imp::get_foreground_window_info()
}

pub fn get_idle_time_seconds() -> u64 {
    imp::get_idle_seconds()
}
