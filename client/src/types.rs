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
    /// This machine's current offset from UTC in minutes (e.g. +480 for UTC+8),
    /// so the server evaluates bedtime, daily reset, and hour buckets in the
    /// device's local time regardless of the server's timezone.
    #[serde(rename = "utcOffsetMinutes")]
    pub utc_offset_minutes: i32,
    /// Whether this client has self-update enabled, so the server can alert if
    /// it is disabled (a tamper signal).
    #[serde(rename = "autoUpdate")]
    pub auto_update: bool,
    /// This client's build version (Cargo package version), reported so the
    /// server and Slack can show which version each device is running.
    #[serde(rename = "version")]
    pub version: String,
    /// SHA-256 of this running executable. The server compares it to the latest
    /// published release checksum to tell whether the device is up to date.
    #[serde(rename = "binaryHash")]
    pub binary_hash: String,
    /// The device's platform, `"windows"` or `"macos"`. Omitted by builds for
    /// any other target, which the server would not recognise.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub platform: Option<String>,
    /// Display name of `currentApp` (macOS only), at most
    /// MAX_APP_DISPLAY_NAME_LEN UTF-16 units. Shown to the parent, never
    /// matched by rules.
    #[serde(rename = "appDisplayName", skip_serializing_if = "Option::is_none", default)]
    pub app_display_name: Option<String>,
}

/// Server-side length caps (the server rejects a whole message whose string
/// fields are longer). Lengths are JavaScript string lengths: UTF-16 units.
pub const MAX_APP_DISPLAY_NAME_LEN: usize = 128;
#[allow(dead_code)] // only the macOS platform builds app identifiers that could reach it
pub const MAX_CURRENT_APP_LEN: usize = 260;
pub const MAX_LOCK_FAILED_REASON_LEN: usize = 256;

/// Sent when the client asked the device to lock and it stayed unlocked.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockFailed {
    #[serde(rename = "type")]
    pub msg_type: String, // "LOCK_FAILED"
    pub reason: String,
}

/// The longest prefix of `s` (on a char boundary) that is at most `max`
/// UTF-16 units long, which is how the server measures string length.
pub fn truncate_utf16(s: &str, max: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        end = i + c.len_utf8();
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_utf16_keeps_short_strings() {
        assert_eq!(truncate_utf16("Safari", 128), "Safari");
        assert_eq!(truncate_utf16("", 128), "");
    }

    #[test]
    fn truncate_utf16_cuts_at_the_limit() {
        let long = "a".repeat(300);
        assert_eq!(truncate_utf16(&long, 128).len(), 128);
    }

    #[test]
    fn truncate_utf16_counts_surrogate_pairs_and_keeps_char_boundaries() {
        // Each emoji is 2 UTF-16 units and 4 UTF-8 bytes.
        let s = "\u{1F600}".repeat(100);
        let t = truncate_utf16(&s, 129);
        assert_eq!(t.encode_utf16().count(), 128);
        assert_eq!(t.chars().count(), 64);
        // Multi-byte but single-unit chars count once.
        assert_eq!(truncate_utf16("\u{00e9}\u{00e9}\u{00e9}", 2), "\u{00e9}\u{00e9}");
    }

    #[test]
    fn heartbeat_omits_absent_optional_fields() {
        let hb = ClientHeartbeat {
            msg_type: "HEARTBEAT".into(),
            device_id: "d".into(),
            hostname: "d".into(),
            current_app: "chrome.exe".into(),
            window_title: String::new(),
            is_idle: false,
            idle_seconds: 0,
            elapsed_active_delta_seconds: 3,
            utc_offset_minutes: 0,
            auto_update: true,
            version: "0.1.0".into(),
            binary_hash: String::new(),
            platform: None,
            app_display_name: None,
        };
        let v: serde_json::Value = serde_json::to_value(&hb).unwrap();
        assert!(v.get("platform").is_none());
        assert!(v.get("appDisplayName").is_none());

        let hb = ClientHeartbeat {
            platform: Some("macos".into()),
            app_display_name: Some("Safari".into()),
            ..hb
        };
        let v: serde_json::Value = serde_json::to_value(&hb).unwrap();
        assert_eq!(v["platform"], "macos");
        assert_eq!(v["appDisplayName"], "Safari");
    }

    #[test]
    fn lock_failed_serializes_with_type_tag() {
        let m = LockFailed { msg_type: "LOCK_FAILED".into(), reason: "x".into() };
        let v: serde_json::Value = serde_json::to_value(&m).unwrap();
        assert_eq!(v["type"], "LOCK_FAILED");
        assert_eq!(v["reason"], "x");
    }
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
