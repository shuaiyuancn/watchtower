use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info, warn};

use crate::config::ClientConfig;
use crate::enforcer::{execute_forced_logoff, execute_lock_workstation, kill_target_process};
use crate::notifier::show_warning_toast;
use crate::telemetry::{inspect_im_activity, inspect_youtube_activity};
use crate::tracker::{get_foreground_info, get_idle_time_seconds, ForegroundInfo};
use crate::types::{ClientHeartbeat, ServerMessage};

pub async fn run_sync_loop(config: ClientConfig) {
    let ws_endpoint = format!("{}/{}", config.server_url.trim_end_matches('/'), config.device_id);
    let mut last_app = String::new();
    let mut last_active_ts = std::time::Instant::now();

    loop {
        info!("Connecting to Watchtower Server at: {}", ws_endpoint);

        match connect_async(&ws_endpoint).await {
            Ok((ws_stream, _)) => {
                info!("Connected successfully to server!");
                let (mut write, mut read) = ws_stream.split();

                let mut interval = tokio::time::interval(Duration::from_secs(config.heartbeat_interval_secs));

                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            let fg_info = get_foreground_info().unwrap_or(ForegroundInfo {
                                executable_name: "unknown.exe".to_string(),
                                window_title: String::new(),
                                pid: 0,
                            });
                            let idle_secs = get_idle_time_seconds();
                            let is_idle = idle_secs > 120; // considered idle after 2 minutes of no input

                            let now = std::time::Instant::now();
                            let elapsed_delta = if !is_idle {
                                now.duration_since(last_active_ts).as_secs()
                            } else {
                                0
                            };
                            last_active_ts = now;
                            last_app = fg_info.executable_name.clone();

                            // 1. Send Heartbeat
                            let heartbeat = ClientHeartbeat {
                                msg_type: "HEARTBEAT".to_string(),
                                device_id: config.device_id.clone(),
                                hostname: config.device_id.clone(),
                                current_app: fg_info.executable_name.clone(),
                                window_title: fg_info.window_title.clone(),
                                is_idle,
                                idle_seconds: idle_secs,
                                elapsed_active_delta_seconds: elapsed_delta,
                            };

                            if let Ok(json_str) = serde_json::to_string(&heartbeat) {
                                if let Err(e) = write.send(Message::Text(json_str)).await {
                                    error!("Failed to send heartbeat: {}", e);
                                    break;
                                }
                            }

                            // 2. Telemetry Inspection (YouTube)
                            if let Some(yt_event) = inspect_youtube_activity(&config.device_id, &fg_info.executable_name, &fg_info.window_title) {
                                if let Ok(json_str) = serde_json::to_string(&yt_event) {
                                    let _ = write.send(Message::Text(json_str)).await;
                                }
                            }

                            // 3. Telemetry Inspection (IM)
                            if let Some(im_event) = inspect_im_activity(&config.device_id, &fg_info.executable_name, &fg_info.window_title) {
                                if let Ok(json_str) = serde_json::to_string(&im_event) {
                                    let _ = write.send(Message::Text(json_str)).await;
                                }
                            }
                        }

                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    handle_server_message(&text, &last_app).await;
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

async fn handle_server_message(raw_text: &str, current_app: &str) {
    if let Ok(server_msg) = serde_json::from_str::<ServerMessage>(raw_text) {
        // 1. Check Heartbeat Ack / Decision
        if let Some(decision) = server_msg.decision {
            if decision.should_warn {
                if let Some(ref msg) = decision.warning_message {
                    show_warning_toast("Watchtower Alert", msg);
                }
            }

            if decision.should_kill_app {
                let target = current_app;
                if !target.is_empty() {
                    warn!("Enforcement: Killing {}", target);
                    kill_target_process(None, target);
                }
            }

            if decision.should_logoff_user {
                warn!("Enforcement: Daily limit or curfew reached. Locking workstation!");
                execute_lock_workstation();
            }
        }

        // 2. Check Remote Command
        if let Some(cmd) = server_msg.command {
            match cmd.action.as_str() {
                "LOCK_NOW" => {
                    show_warning_toast("Watchtower", "PC locked by parent.");
                    execute_lock_workstation();
                }
                "KILL_APP" => {
                    if let Some(app) = cmd.target_app {
                        kill_target_process(None, &app);
                    }
                }
                "GRANT_TIME" => {
                    if let Some(msg) = cmd.message {
                        show_warning_toast("Time Granted!", &msg);
                    }
                }
                "SHOW_WARNING" => {
                    if let Some(msg) = cmd.message {
                        show_warning_toast("Watchtower Warning", &msg);
                    }
                }
                _ => {}
            }
        }
    }
}
