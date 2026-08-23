use std::env;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod enforcer;
mod notifier;
mod sync;
mod telemetry;
mod tracker;
mod types;
mod updater;

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,watchtower_client=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("🛡️ Starting Project Watchtower Windows 11 Client Daemon v0.1.0");

    let args: Vec<String> = env::args().collect();
    let config_path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|idx| args.get(idx + 1))
        .map(|s| s.as_str())
        .unwrap_or("config.json");

    let client_config = config::load_or_create_config(config_path);
    info!("Loaded config: Device ID='{}', Server='{}'", client_config.device_id, client_config.server_url);

    // Run sync loop
    sync::run_sync_loop(client_config).await;
}
