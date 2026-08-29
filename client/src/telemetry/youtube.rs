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
        || norm_exe == "opera.exe"
        || norm_exe == "zen.exe"
        || norm_exe == "vivaldi.exe"
        || norm_exe == "arc.exe";

    if !is_browser {
        return None;
    }

    // Pattern: "{Title} - YouTube - BrowserName" or "{Title} — YouTube — Zen Browser" or "{Title} - YouTube"
    if let Ok(re) = Regex::new(r"^(.*?)\s*[-—–]\s*YouTube(?:\s*[-—–]\s*.*)?$") {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inspect_youtube_activity_zen_browser() {
        let payload = inspect_youtube_activity(
            "test-device",
            "zen.exe",
            "Rust in 100 Seconds - YouTube — Zen Browser",
        );
        assert!(payload.is_some());
        let p = payload.unwrap();
        assert_eq!(p.app, "zen.exe");
        assert_eq!(p.title_or_text, "Rust in 100 Seconds");
        assert_eq!(p.telemetry_type, "YOUTUBE");
    }

    #[test]
    fn test_inspect_youtube_activity_chrome() {
        let payload = inspect_youtube_activity(
            "test-device",
            "chrome.exe",
            "Learning React 19 - YouTube - Google Chrome",
        );
        assert!(payload.is_some());
        let p = payload.unwrap();
        assert_eq!(p.app, "chrome.exe");
        assert_eq!(p.title_or_text, "Learning React 19");
    }

    #[test]
    fn test_non_browser_ignored() {
        let payload = inspect_youtube_activity(
            "test-device",
            "notepad.exe",
            "My Notes - YouTube",
        );
        assert!(payload.is_none());
    }
}
