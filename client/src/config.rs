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

pub fn load_or_create_config(path_str: &str) -> ClientConfig {
    let path = Path::new(path_str);
    if path.exists() {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(config) = serde_json::from_str::<ClientConfig>(&content) {
                return config;
            }
        }
    }

    let default_config = ClientConfig::default();
    if let Ok(serialized) = serde_json::to_string_pretty(&default_config) {
        let _ = fs::write(path, serialized);
    }
    default_config
}
