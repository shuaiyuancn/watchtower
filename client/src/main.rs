#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod enforcer;
mod notifier;
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

    info!("🛡️ Starting Project Watchtower Windows 11 Client Daemon v0.1.0");

    let config_path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|idx| args.get(idx + 1))
        .map(|s| s.as_str())
        .unwrap_or("config.json");

    let client_config = config::load_or_create_config(config_path);
    info!("Loaded config: Device ID='{}', Server='{}'", client_config.device_id, client_config.server_url);

    // Initialize System Tray Icon
    tray::init_system_tray(client_config.device_id.clone());

    // Run sync loop
    sync::run_sync_loop(client_config).await;
}
