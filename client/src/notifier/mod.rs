use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

static LAST_NOTIFICATION_TIME: AtomicI64 = AtomicI64::new(0);

pub fn show_warning_toast(title: &str, message: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let last = LAST_NOTIFICATION_TIME.load(Ordering::Relaxed);
    // Debounce: don't show more than one toast every 30 seconds
    if now - last < 30 {
        return;
    }
    LAST_NOTIFICATION_TIME.store(now, Ordering::Relaxed);

    info!("[Notification] {}: {}", title, message);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Execute PowerShell Windows Toast Notification
        let script = format!(
            r#"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
            [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;
            $xml = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>{title}</text>
            <text>{message}</text>
        </binding>
    </visual>
</toast>
"@;
            $doc = New-Object Windows.Data.Xml.Dom.XmlDocument;
            $doc.LoadXml($xml);
            $toast = [Windows.UI.Notifications.ToastNotification]::new($doc);
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Watchtower").Show($toast);
            "#,
            title = title.replace('"', "`\""),
            message = message.replace('"', "`\"")
        );

        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
        cmd.creation_flags(0x08000000);
        let _ = cmd.spawn();
    }
}
