#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod notifier;
mod platform;
mod sync;
mod telemetry;
mod tracker;
mod types;
mod updater;

fn main() {
    // The platform owns the main thread; the client itself runs on a tokio
    // runtime built the same way #[tokio::main] builds one.
    platform::run_main_thread(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed building the Runtime")
            .block_on(run_client());
    });
}

async fn run_client() {
    let args: Vec<String> = env::args().collect();
    let is_foreground = args.iter().any(|a| a == "--foreground" || a == "--debug");

    if !is_foreground {
        platform::hide_console();
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

    let _single_instance_guard = {
        let attempts = if post_update { 20 } else { 1 };
        let mut guard = None;
        for i in 0..attempts {
            if let Some(g) = platform::acquire_single_instance() {
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

    if platform::PLATFORM_NAME == "macos" {
        info!("🛡️ Starting Project Watchtower macOS Client v{}", env!("CARGO_PKG_VERSION"));
    } else {
        info!("🛡️ Starting Project Watchtower Windows 11 Client Daemon v0.1.0");
    }

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
    platform::start_tray(client_config.device_id.clone());

    // Periodic self-update from the published GitHub release. Where the
    // platform cannot replace its own binary (macOS: the install directory is
    // root-owned and a root helper updates it), the loop does not run; the
    // heartbeat still reports `autoUpdate` from config.
    if !platform::SELF_UPDATE_SUPPORTED {
        info!("[update] self-update is handled outside the client on this platform.");
    } else if client_config.auto_update {
        let update_cfg = client_config.clone();
        tokio::spawn(async move {
            updater::run_update_loop(update_cfg).await;
        });
    }

    // Run sync loop
    sync::run_sync_loop(client_config).await;
}
