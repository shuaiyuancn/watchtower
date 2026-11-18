use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info, warn};

use crate::config::ClientConfig;
use crate::notifier::show_warning;
use crate::platform::{self, ForegroundApp};
use crate::telemetry::{inspect_im_activity, inspect_youtube_activity};
use crate::tracker::counts_as_idle;
use crate::sync::lock_verify::{LockVerifier, LOCK_GRACE};
use crate::types::{
    truncate_utf16, ClientHeartbeat, LockFailed, ServerMessage, MAX_APP_DISPLAY_NAME_LEN,
    MAX_LOCK_FAILED_REASON_LEN,
};

/// Returns true if the host portion of a ws(s) URL is a loopback address.
fn is_loopback_host(url: &str) -> bool {
    let after_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url);
    let host = after_scheme.split(['/', '?']).next().unwrap_or("");
    host.starts_with("localhost")
        || host.starts_with("127.0.0.1")
        || host.starts_with("[::1]")
}

/// The platform value sent to the server, which accepts only "windows" and
/// "macos". Other builds (the stub) send none.
fn wire_platform(platform_name: &str) -> Option<&'static str> {
    match platform_name {
        "windows" => Some("windows"),
        "macos" => Some("macos"),
        _ => None,
    }
}

/// Build the WebSocket endpoint: enforce wss:// for remote hosts (M5) and
/// append the device auth token (C1) and the platform when present.
fn build_ws_endpoint(config: &ClientConfig, platform: Option<&str>) -> String {
    let mut base = config.server_url.trim_end_matches('/').to_string();

    if base.starts_with("ws://") && !is_loopback_host(&base) && !config.allow_insecure {
        warn!("Upgrading insecure ws:// to wss:// for remote host (set allow_insecure=true to override).");
        base = format!("wss://{}", &base["ws://".len()..]);
    }

    let mut endpoint = format!("{}/{}", base, config.device_id);
    let mut query: Vec<String> = Vec::new();
    if let Some(token) = config.auth_token.as_deref() {
        if !token.is_empty() {
            query.push(format!("token={}", token));
        }
    }
    if let Some(p) = platform {
        query.push(format!("platform={}", p));
    }
    if !query.is_empty() {
        let sep = if endpoint.contains('?') { '&' } else { '?' };
        endpoint = format!("{}{}{}", endpoint, sep, query.join("&"));
    }
    endpoint
}

/// The endpoint with the token value replaced by `***`, for logging.
fn redact_token(endpoint: &str) -> String {
    let start = match endpoint.find("?token=").or_else(|| endpoint.find("&token=")) {
        Some(i) => i + "?token=".len(),
        None => return endpoint.to_string(),
    };
    let end = endpoint[start..]
        .find('&')
        .map(|j| start + j)
        .unwrap_or(endpoint.len());
    format!("{}***{}", &endpoint[..start], &endpoint[end..])
}

/// The display name to report for the foreground app: trimmed, non-empty and
/// within the server's length cap.
fn wire_display_name(display_name: Option<&str>) -> Option<String> {
    display_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| truncate_utf16(s, MAX_APP_DISPLAY_NAME_LEN))
}

pub async fn run_sync_loop(config: ClientConfig) {
    let wire_platform = wire_platform(platform::PLATFORM_NAME);
    let ws_endpoint = build_ws_endpoint(&config, wire_platform);
    let mut last_app = String::new();
    let mut last_active_ts = std::time::Instant::now();
    // Lives across reconnects so the LOCK_FAILED rate limit holds.
    let mut lock_verifier = LockVerifier::new();

    // Reported to the server on every heartbeat. The build version is baked in
    // at compile time; the binary hash is computed once from the running exe.
    let client_version = env!("CARGO_PKG_VERSION").to_string();
    let binary_hash = crate::updater::current_binary_sha256().unwrap_or_default();

    let log_endpoint = redact_token(&ws_endpoint);

    loop {
        info!("Connecting to Watchtower Server at: {}", log_endpoint);

        match connect_async(&ws_endpoint).await {
            Ok((ws_stream, _)) => {
                info!("Connected successfully to server!");
                let (mut write, mut read) = ws_stream.split();

                let mut interval = tokio::time::interval(Duration::from_secs(config.heartbeat_interval_secs));
                let mut last_tick_ts = std::time::Instant::now();
                let mut last_rx_ts = std::time::Instant::now();
                last_active_ts = std::time::Instant::now();

                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let now = std::time::Instant::now();

                            // 1. Detect system sleep / modern standby resume gap
                            let gap = now.duration_since(last_tick_ts);
                            if gap > Duration::from_secs(config.heartbeat_interval_secs * 3) {
                                warn!("System resume/sleep detected (gap: {:?}). Cycling WebSocket connection...", gap);
                                last_active_ts = now;
                                last_tick_ts = now;
                                break;
                            }
                            last_tick_ts = now;

                            // 2. Check connection liveness (dead socket watchdog after sleep/network drop)
                            if now.duration_since(last_rx_ts) > Duration::from_secs(15) {
                                warn!("No server ACK received in 15 seconds. Socket dead, reconnecting...");
                                break;
                            }

                            let fg_info = platform::foreground_app().unwrap_or_else(ForegroundApp::unknown);
                            let idle_secs = platform::idle_seconds();
                            // Idle after 2 minutes of no input, or immediately while the desktop is locked.
                            let is_idle = counts_as_idle(idle_secs, platform::is_locked());

                            // 3. Compute active delta capped to maximum 2x interval to prevent sleep spikes
                            let raw_delta = if !is_idle {
                                now.duration_since(last_active_ts).as_secs()
                            } else {
                                0
                            };
                            let elapsed_delta = raw_delta.min(config.heartbeat_interval_secs * 2);
                            last_active_ts = now;
                            last_app = fg_info.app_id.clone();

                            // 4. Send Heartbeat
                            let utc_offset_minutes = chrono::Local::now().offset().local_minus_utc() / 60;
                            let heartbeat = ClientHeartbeat {
                                msg_type: "HEARTBEAT".to_string(),
                                device_id: config.device_id.clone(),
                                hostname: config.device_id.clone(),
                                current_app: fg_info.app_id.clone(),
                                window_title: fg_info.window_title.clone(),
                                is_idle,
                                idle_seconds: idle_secs,
                                elapsed_active_delta_seconds: elapsed_delta,
                                utc_offset_minutes,
                                auto_update: config.auto_update,
                                version: client_version.clone(),
                                binary_hash: binary_hash.clone(),
                                platform: wire_platform.map(str::to_string),
                                app_display_name: wire_display_name(fg_info.display_name.as_deref()),
                            };

                            if let Ok(json_str) = serde_json::to_string(&heartbeat) {
                                if let Err(e) = write.send(Message::Text(json_str)).await {
                                    error!("Failed to send heartbeat: {}", e);
                                    break;
                                }
                            }

                            if platform::TELEMETRY_SUPPORTED {
                                // 5. Telemetry Inspection (YouTube)
                                if let Some(yt_event) = inspect_youtube_activity(&config.device_id, &fg_info.app_id, &fg_info.window_title) {
                                    if let Ok(json_str) = serde_json::to_string(&yt_event) {
                                        let _ = write.send(Message::Text(json_str)).await;
                                    }
                                }

                                // 6. Telemetry Inspection (IM)
                                if let Some(im_event) = inspect_im_activity(&config.device_id, &fg_info.app_id, &fg_info.window_title) {
                                    if let Ok(json_str) = serde_json::to_string(&im_event) {
                                        let _ = write.send(Message::Text(json_str)).await;
                                    }
                                }
                            }
                        }

                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    last_rx_ts = std::time::Instant::now();
                                    if let Some(reply) = handle_server_message(&text, &last_app, &mut lock_verifier).await {
                                        if let Err(e) = write.send(Message::Text(reply)).await {
                                            error!("Failed to send message: {}", e);
                                            break;
                                        }
                                    }
                                }
                                Some(Ok(Message::Ping(ping_data))) => {
                                    last_rx_ts = std::time::Instant::now();
                                    let _ = write.send(Message::Pong(ping_data)).await;
                                }
                                Some(Ok(Message::Pong(_))) => {
                                    last_rx_ts = std::time::Instant::now();
                                }
                                Some(Ok(Message::Close(_))) => {
                                    warn!("Server closed WebSocket connection.");
                                    break;
                                }
                                Some(Err(e)) => {
                                    error!("WebSocket error: {}", e);
                                    break;
                                }
                                None => {
                                    warn!("WebSocket stream ended.");
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            Err(e) => {
                warn!("Connection failed: {}. Retrying in 5 seconds...", e);
            }
        }

        sleep(Duration::from_secs(5)).await;
    }
}

/// Ask the platform to lock the device. Where the platform verifies locks,
/// also feed the verifier and return a LOCK_FAILED message when one is due.
fn request_lock(verifier: &mut LockVerifier) -> Option<String> {
    if !platform::VERIFIES_LOCK {
        platform::lock_device();
        return None;
    }

    // The server repeats the request every heartbeat while a limit holds. Do
    // not lock again when the device is already locked: `is_locked` is also
    // true while the child's session is in the background, and locking then
    // would lock the session of whoever is at the Mac (a parent in their own
    // account), or blank the display under them with the pmset fallback.
    let was_locked = platform::is_locked();
    if was_locked {
        verifier.on_lock_request(std::time::Instant::now(), true);
        return None;
    }
    let requested = platform::lock_device();
    if !verifier.on_lock_request(std::time::Instant::now(), was_locked) {
        return None;
    }

    let reason = if requested {
        platform::lock_failure_reason()
    } else {
        format!("no lock request could be made: {}", platform::lock_failure_reason())
    };
    warn!("Enforcement: lock requested for over {:?} but the device is still unlocked ({})", LOCK_GRACE, reason);
    let msg = LockFailed {
        msg_type: "LOCK_FAILED".to_string(),
        reason: truncate_utf16(&reason, MAX_LOCK_FAILED_REASON_LEN),
    };
    serde_json::to_string(&msg).ok()
}

/// Act on one server message. Returns a message to send back, if any.
async fn handle_server_message(raw_text: &str, current_app: &str, verifier: &mut LockVerifier) -> Option<String> {
    let mut reply = None;
    if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(raw_text) {
        // 1. Check Heartbeat Ack / Decision
        if let Some(decision) = server_msg.decision {
            if decision.should_warn {
                if let Some(ref msg) = decision.warning_message {
                    show_warning("Watchtower Alert", msg);
                }
            }

            if decision.should_kill_app {
                let target = current_app;
                if !target.is_empty() {
                    warn!("Enforcement: Killing {}", target);
                    platform::quit_app(target);
                }
            }

            if decision.should_logoff_user {
                // Lock the workstation (not sign out). Re-issued every heartbeat
                // while the limit/curfew holds, so if it is unlocked it locks
                // again within seconds.
                warn!("Enforcement: Daily limit or curfew reached. Locking workstation!");
                reply = request_lock(verifier).or(reply);
            }
        }

        // 2. Check Remote Command
        if let Some(cmd) = server_msg.command {
            match cmd.action.as_str() {
                "LOCK_NOW" => {
                    show_warning("Watchtower", &format!("{} locked by parent.", platform::DEVICE_NOUN));
                    reply = request_lock(verifier).or(reply);
                }
                "KILL_APP" => {
                    if let Some(app) = cmd.target_app {
                        platform::quit_app(&app);
                    }
                }
                "GRANT_TIME" => {
                    if let Some(msg) = cmd.message {
                        show_warning("Time Granted!", &msg);
                    }
                }
                "SHOW_WARNING" => {
                    if let Some(msg) = cmd.message {
                        show_warning("Watchtower Warning", &msg);
                    }
                }
                _ => {}
            }
        }
    }
    reply
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(server_url: &str, token: Option<&str>) -> ClientConfig {
        ClientConfig {
            server_url: server_url.to_string(),
            device_id: "kid-pc".to_string(),
            auth_token: token.map(str::to_string),
            ..ClientConfig::default()
        }
    }

    #[test]
    fn wire_platform_sends_only_known_values() {
        assert_eq!(wire_platform("windows"), Some("windows"));
        assert_eq!(wire_platform("macos"), Some("macos"));
        assert_eq!(wire_platform("stub"), None);
    }

    #[test]
    fn endpoint_carries_token_and_platform() {
        let c = config("wss://example.com/ws/client/", Some("abc"));
        assert_eq!(
            build_ws_endpoint(&c, Some("windows")),
            "wss://example.com/ws/client/kid-pc?token=abc&platform=windows"
        );
    }

    #[test]
    fn endpoint_without_token_starts_the_query_with_platform() {
        let c = config("wss://example.com/ws/client", None);
        assert_eq!(
            build_ws_endpoint(&c, Some("macos")),
            "wss://example.com/ws/client/kid-pc?platform=macos"
        );
        let c = config("wss://example.com/ws/client", Some(""));
        assert_eq!(
            build_ws_endpoint(&c, Some("macos")),
            "wss://example.com/ws/client/kid-pc?platform=macos"
        );
    }

    #[test]
    fn endpoint_without_platform_is_unchanged() {
        let c = config("wss://example.com/ws/client", Some("abc"));
        assert_eq!(build_ws_endpoint(&c, None), "wss://example.com/ws/client/kid-pc?token=abc");
        let c = config("ws://127.0.0.1:4000/ws/client", None);
        assert_eq!(build_ws_endpoint(&c, None), "ws://127.0.0.1:4000/ws/client/kid-pc");
    }

    #[test]
    fn endpoint_upgrades_remote_ws_to_wss() {
        let c = config("ws://example.com/ws/client", None);
        assert_eq!(build_ws_endpoint(&c, None), "wss://example.com/ws/client/kid-pc");
    }

    #[test]
    fn redact_token_hides_only_the_token_value() {
        assert_eq!(
            redact_token("wss://h/ws/client/d?token=secret&platform=macos"),
            "wss://h/ws/client/d?token=***&platform=macos"
        );
        assert_eq!(redact_token("wss://h/ws/client/d?token=secret"), "wss://h/ws/client/d?token=***");
        assert_eq!(
            redact_token("wss://h/ws/client/d?platform=macos"),
            "wss://h/ws/client/d?platform=macos"
        );
    }

    #[test]
    fn display_name_is_trimmed_capped_and_dropped_when_empty() {
        assert_eq!(wire_display_name(None), None);
        assert_eq!(wire_display_name(Some("   ")), None);
        assert_eq!(wire_display_name(Some(" Safari ")), Some("Safari".to_string()));
        let long = "x".repeat(500);
        assert_eq!(wire_display_name(Some(&long)).unwrap().len(), MAX_APP_DISPLAY_NAME_LEN);
    }
}
