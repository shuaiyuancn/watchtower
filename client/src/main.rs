#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod enforcer;
mod notifier;
mod single_instance;
mod sync;
mod telemetry;
mod tracker;
mod tray;
mod types;
mod updater;

#[cfg(windows)]
fn hide_console_window() {
    unsafe {
        use windows::Win32::System::Console::GetConsoleWindow;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        let hwnd = GetConsoleWindow();
        if hwnd.0 as usize != 0 {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    let is_foreground = args.iter().any(|a| a == "--foreground" || a == "--debug");

    #[cfg(windows)]
    if !is_foreground {
        hide_console_window();
    }

    // Configure clean, human-readable logging without raw ANSI escape codes
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(false)
        .compact();

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,watchtower_client=debug".into()),
        )
        .with(fmt_layer)
        .init();

    // A freshly-updated process (relaunched by the updater) may briefly race the
    // outgoing instance for the single-instance mutex; retry a few times.
    let post_update = args.iter().any(|a| a == updater::UPDATED_ARG);

    #[cfg(windows)]
    let _single_instance_guard = {
        let attempts = if post_update { 20 } else { 1 };
        let mut guard = None;
        for i in 0..attempts {
            if let Some(g) = single_instance::acquire_single_instance("WatchtowerClientDaemonMutex") {
                guard = Some(g);
                break;
            }
            if i + 1 < attempts {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            }
        }
        match guard {
            Some(g) => g,
            None => {
                info!("Another instance of Watchtower is already running. Exiting cleanly.");
                return;
            }
        }
    };

    info!("🛡️ Starting Project Watchtower Windows 11 Client Daemon v0.1.0");

    let explicit_config = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|idx| args.get(idx + 1))
        .map(|s| s.as_str())
        .or_else(|| {
            args.iter()
                .find(|a| a.starts_with("--config="))
                .and_then(|a| a.split_once('=').map(|(_, v)| v))
        });

    let client_config = config::load_or_create_config(explicit_config);
    info!("Loaded config: Device ID='{}', Server='{}'", client_config.device_id, client_config.server_url);

    // Initialize System Tray Icon
    tray::init_system_tray(client_config.device_id.clone());

    // Periodic self-update from the published GitHub release.
    if client_config.auto_update {
        let update_cfg = client_config.clone();
        tokio::spawn(async move {
            updater::run_update_loop(update_cfg).await;
        });
    }

    // Run sync loop
    sync::run_sync_loop(client_config).await;
}
