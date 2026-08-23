use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientHeartbeat {
    #[serde(rename = "type")]
    pub msg_type: String, // "HEARTBEAT"
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub hostname: String,
    #[serde(rename = "currentApp")]
    pub current_app: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "isIdle")]
    pub is_idle: bool,
    #[serde(rename = "idleSeconds")]
    pub idle_seconds: u64,
    #[serde(rename = "elapsedActiveDeltaSeconds")]
    pub elapsed_active_delta_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    #[serde(rename = "type")]
    pub msg_type: String, // "TELEMETRY"
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "telemetryType")]
    pub telemetry_type: String, // "YOUTUBE" | "IM_MESSAGE"
    pub app: String,
    #[serde(rename = "titleOrText")]
    pub title_or_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnforcementDecision {
    #[serde(rename = "shouldKillApp")]
    pub should_kill_app: bool,
    #[serde(rename = "shouldLogoffUser")]
    pub should_logoff_user: bool,
    #[serde(rename = "shouldWarn")]
    pub should_warn: bool,
    #[serde(rename = "warningMessage")]
    pub warning_message: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "remainingAppSeconds")]
    pub remaining_app_seconds: Option<u64>,
    #[serde(rename = "remainingGlobalSeconds")]
    pub remaining_global_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatAck {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub decision: EnforcementDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerCommand {
    pub action: String, // "GRANT_TIME" | "LOCK_NOW" | "UNLOCK" | "KILL_APP" | "SHOW_WARNING" | "SYNC_POLICY"
    #[serde(rename = "targetApp")]
    pub target_app: Option<String>,
    #[serde(rename = "extraSeconds")]
    pub extra_seconds: Option<u64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub decision: Option<EnforcementDecision>,
    pub command: Option<ServerCommand>,
}
