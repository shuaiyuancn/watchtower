//! Showing a warning to the child as a Windows toast notification.

use std::os::windows::process::CommandExt;
use std::process::Command;

pub fn show_warning(title: &str, message: &str) {
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
