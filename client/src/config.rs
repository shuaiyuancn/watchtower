use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub server_url: String, // e.g. "ws://127.0.0.1:4000/ws/client" or "wss://your-railway.up.railway.app/ws/client"
    pub device_id: String,
    pub api_key: Option<String>,
    pub heartbeat_interval_secs: u64,
}

impl Default for ClientConfig {
    fn default() -> Self {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "windows-pc".to_string());

        Self {
            server_url: "ws://127.0.0.1:4000/ws/client".to_string(),
            device_id: hostname,
            api_key: None,
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

    // 3. Check %LOCALAPPDATA%\Watchtower\config.json
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let p = Path::new(&local_app_data).join("Watchtower").join("config.json");
        if p.exists() {
            if let Ok(content) = fs::read_to_string(&p) {
                if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                    return config;
                }
            }
        }
    }

    // 4. Check C:\ProgramData\Watchtower\config.json
    let prog_data = Path::new("C:\\ProgramData\\Watchtower\\config.json");
    if prog_data.exists() {
        if let Ok(content) = fs::read_to_string(prog_data) {
            if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                return config;
            }
        }
    }

    // 5. Fallback: create default in working dir or target path
    let default_config = ClientConfig::default();
    let target_path = explicit_path.unwrap_or("config.json");
    if let Ok(serialized) = serde_json::to_string_pretty(&default_config) {
        let _ = fs::write(target_path, serialized);
    }
    default_config
}
