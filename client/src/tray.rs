use std::thread;
use tracing::{info, warn};

#[cfg(windows)]
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::Shell::{
            Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
            NOTIFYICONDATAW,
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, LoadIconW,
            PostQuitMessage, RegisterClassW, TranslateMessage, CW_USEDEFAULT, HICON,
            IDI_APPLICATION, IDI_SHIELD, MSG, WINDOW_EX_STYLE, WM_DESTROY, WM_USER, WNDCLASSW,
            WS_OVERLAPPEDWINDOW,
        },
    },
};

const WM_TRAY_CALLBACK: u32 = WM_USER + 101;

pub fn init_system_tray(device_id: String) {
    #[cfg(windows)]
    {
        thread::spawn(move || {
            run_windows_tray(device_id);
        });
    }

    #[cfg(not(windows))]
    {
        let _ = device_id;
    }
}

#[cfg(windows)]
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TRAY_CALLBACK => LRESULT(0),
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(windows)]
fn run_windows_tray(device_id: String) {
    unsafe {
        let hinstance = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => HINSTANCE(h.0),
            Err(e) => {
                warn!("Failed to get module handle for tray icon: {:?}", e);
                return;
            }
        };

        let class_name = w!("WatchtowerTrayWindowClass");

        let wnd_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };

        let _ = RegisterClassW(&wnd_class);

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!("Watchtower Tray Monitor"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            HWND(std::ptr::null_mut()),
            None,
            hinstance,
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                warn!("Failed to create message window for tray icon: {:?}", e);
                return;
            }
        };

        let mut icon: Result<HICON, _> = LoadIconW(None, IDI_SHIELD);
        if icon.is_err() {
            icon = LoadIconW(None, IDI_APPLICATION);
        }
        let hicon = icon.unwrap_or_default();

        let tip_text = format!("Watchtower - Monitoring Active ({})", device_id);
        let mut sz_tip = [0u16; 128];
        let tip_u16: Vec<u16> = tip_text.encode_utf16().collect();
        let copy_len = tip_u16.len().min(127);
        sz_tip[..copy_len].copy_from_slice(&tip_u16[..copy_len]);

        let mut nid = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: 1001,
            uFlags: NIF_ICON | NIF_TIP | NIF_MESSAGE,
            uCallbackMessage: WM_TRAY_CALLBACK,
            hIcon: hicon,
            szTip: sz_tip,
            ..Default::default()
        };

        let res = Shell_NotifyIconW(NIM_ADD, &nid);
        if !res.as_bool() {
            warn!("Shell_NotifyIconW(NIM_ADD) returned false");
        } else {
            info!("System Tray icon registered successfully: '{}'", tip_text);
        }

        // Message pump
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).into() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // Cleanup on exit
        let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
    }
}
