use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::platform;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub server_url: String, // e.g. "ws://127.0.0.1:4000/ws/client" or "wss://your-railway.up.railway.app/ws/client"
    pub device_id: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Device-bound token issued at enrollment. Sent to the server so it can
    /// verify this device when REQUIRE_DEVICE_AUTH is enabled (C1).
    #[serde(default)]
    pub auth_token: Option<String>,
    /// Allow an insecure ws:// connection to a non-loopback host. Off by
    /// default: remote hosts are upgraded to wss:// (M5).
    #[serde(default)]
    pub allow_insecure: bool,
    /// Periodically self-update from the published GitHub release.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// How often to check for a new release binary (seconds). Default 30m.
    #[serde(default = "default_update_interval")]
    pub update_check_interval_secs: u64,
    pub heartbeat_interval_secs: u64,
}

fn default_true() -> bool {
    true
}

fn default_update_interval() -> u64 {
    1_800 // 30 minutes
}

impl Default for ClientConfig {
    fn default() -> Self {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| platform::FALLBACK_DEVICE_ID.to_string());

        Self {
            server_url: "ws://127.0.0.1:4000/ws/client".to_string(),
            device_id: hostname,
            api_key: None,
            auth_token: None,
            allow_insecure: false,
            auto_update: true,
            update_check_interval_secs: 1_800,
            heartbeat_interval_secs: 3,
        }
    }
}

pub fn load_or_create_config(explicit_path: Option<&str>) -> ClientConfig {
    // 1. Check explicit path if provided
    if let Some(p) = explicit_path {
        let path = Path::new(p);
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                    return config;
                }
            }
        }
    }

    // 2. Check directory of running executable
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            let exe_cfg = parent.join("config.json");
            if exe_cfg.exists() {
                if let Ok(content) = fs::read_to_string(&exe_cfg) {
                    if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                        return config;
                    }
                }
            }
        }
    }

    // 3. Check the platform's config locations (on Windows
    //    %LOCALAPPDATA%\Watchtower\config.json, then
    //    C:\ProgramData\Watchtower\config.json)
    for p in platform::config_search_paths() {
        if p.exists() {
            if let Ok(content) = fs::read_to_string(&p) {
                if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                    return config;
                }
            }
        }
    }

    // 4. Fallback: create default in working dir or target path
    let default_config = ClientConfig::default();
    let target_path = explicit_path.unwrap_or("config.json");
    if let Ok(serialized) = serde_json::to_string_pretty(&default_config) {
        let _ = fs::write(target_path, serialized);
    }
    default_config
}
