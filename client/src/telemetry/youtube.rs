use regex::Regex;
use std::sync::Mutex;
use crate::types::TelemetryPayload;

static LAST_YOUTUBE_TITLE: Mutex<Option<String>> = Mutex::new(None);

pub fn inspect_youtube_activity(
    device_id: &str,
    executable_name: &str,
    window_title: &str,
) -> Option<TelemetryPayload> {
    let norm_exe = executable_name.to_lowercase();
    let is_browser = norm_exe == "chrome.exe"
        || norm_exe == "msedge.exe"
        || norm_exe == "firefox.exe"
        || norm_exe == "brave.exe"
        || norm_exe == "opera.exe";

    if !is_browser {
        return None;
    }

    // Pattern 1: "{Title} - YouTube - Google Chrome" or "{Title} - YouTube"
    if let Ok(re) = Regex::new(r"^(.*?)\s*-\s*YouTube(?:\s*-\s*.*)?$") {
        if let Some(caps) = re.captures(window_title) {
            let raw_title = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            
            // Filter out empty or home page
            if raw_title.is_empty() || raw_title.eq_ignore_ascii_case("YouTube") {
                return None;
            }

            // Deduplicate
            let mut last = LAST_YOUTUBE_TITLE.lock().unwrap();
            if let Some(ref prev) = *last {
                if prev == raw_title {
                    return None; // already emitted
                }
            }
            *last = Some(raw_title.to_string());

            return Some(TelemetryPayload {
                msg_type: "TELEMETRY".to_string(),
                device_id: device_id.to_string(),
                telemetry_type: "YOUTUBE".to_string(),
                app: executable_name.to_string(),
                title_or_text: raw_title.to_string(),
            });
        }
    }

    None
}
