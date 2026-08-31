#[cfg(windows)]
mod win_enforce {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use tracing::{error, info};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Shutdown::{
        ExitWindowsEx, EWX_FORCE, EWX_LOGOFF, EXIT_WINDOWS_FLAGS, SHUTDOWN_REASON,
    };
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    pub fn kill_process_pid(pid: u32, exe_name: &str) -> bool {
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let success = TerminateProcess(handle, 1).is_ok();
                let _ = CloseHandle(handle);
                if success {
                    info!("Successfully terminated process {} (PID: {})", exe_name, pid);
                    return true;
                }
            }
        }

        // Fallback to taskkill /F /PID
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/PID", &pid.to_string()]);
        cmd.creation_flags(0x08000000);
        let status = cmd.output();

        match status {
            Ok(output) if output.status.success() => {
                info!("Terminated PID {} via taskkill fallback", pid);
                true
            }
            _ => {
                error!("Failed to terminate PID {}", pid);
                false
            }
        }
    }

    pub fn kill_process_by_name(exe_name: &str) -> bool {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/IM", exe_name]);
        cmd.creation_flags(0x08000000);
        let status = cmd.output();

        match status {
            Ok(output) if output.status.success() => {
                info!("Terminated {} via taskkill /IM", exe_name);
                true
            }
            _ => {
                error!("Failed to terminate process by name {}", exe_name);
                false
            }
        }
    }

    pub fn lock_workstation() {
        info!("Executing immediate Windows workstation lock (preserving open apps/windows)...");
        unsafe {
            let _ = windows::Win32::System::Shutdown::LockWorkStation();
        }

        // Secondary fallback
        let _ = Command::new("rundll32.exe")
            .args(["user32.dll,LockWorkStation"])
            .spawn();
    }

    pub fn force_logoff() {
        info!("Executing immediate Windows session logoff...");
        unsafe {
            let _ = ExitWindowsEx(
                EXIT_WINDOWS_FLAGS(EWX_LOGOFF.0 | EWX_FORCE.0),
                SHUTDOWN_REASON(0),
            );
        }

        // Secondary fallback to shutdown /l
        let _ = Command::new("shutdown")
            .args(["/l"])
            .spawn();
    }
}

#[cfg(not(windows))]
mod win_enforce {
    use tracing::info;

    pub fn kill_process_pid(pid: u32, exe_name: &str) -> bool {
        info!("[Mock] Terminating process {} (PID: {})", exe_name, pid);
        true
    }

    pub fn kill_process_by_name(exe_name: &str) -> bool {
        info!("[Mock] Terminating process by name {}", exe_name);
        true
    }

    pub fn lock_workstation() {
        info!("[Mock] Locking workstation");
    }

    pub fn force_logoff() {
        info!("[Mock] Forcing user logoff");
    }
}

pub fn kill_target_process(pid: Option<u32>, exe_name: &str) -> bool {
    if let Some(p) = pid {
        if win_enforce::kill_process_pid(p, exe_name) {
            return true;
        }
    }
    win_enforce::kill_process_by_name(exe_name)
}

pub fn execute_lock_workstation() {
    win_enforce::lock_workstation();
}

pub fn execute_forced_logoff() {
    win_enforce::force_logoff();
}
