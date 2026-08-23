use std::sync::Mutex;
use crate::types::TelemetryPayload;

static LAST_IM_SNIPPET: Mutex<Option<String>> = Mutex::new(None);

pub fn inspect_im_activity(
    device_id: &str,
    executable_name: &str,
    window_title: &str,
) -> Option<TelemetryPayload> {
    let norm_exe = executable_name.to_lowercase();
    let is_im = norm_exe == "discord.exe"
        || norm_exe == "telegram.exe"
        || norm_exe == "wechat.exe"
        || norm_exe == "whatsapp.exe"
        || norm_exe == "qq.exe";

    if !is_im {
        return None;
    }

    let trimmed_title = window_title.trim();
    if trimmed_title.is_empty() || trimmed_title.eq_ignore_ascii_case("Discord") || trimmed_title.eq_ignore_ascii_case("Telegram") || trimmed_title.eq_ignore_ascii_case("WeChat") {
        return None;
    }

    let mut last = LAST_IM_SNIPPET.lock().unwrap();
    if let Some(ref prev) = *last {
        if prev == trimmed_title {
            return None;
        }
    }
    *last = Some(trimmed_title.to_string());

    Some(TelemetryPayload {
        msg_type: "TELEMETRY".to_string(),
        device_id: device_id.to_string(),
        telemetry_type: "IM_MESSAGE".to_string(),
        app: executable_name.to_string(),
        title_or_text: trimmed_title.to_string(),
    })
}
