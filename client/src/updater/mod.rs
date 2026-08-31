use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::process::Command;
use tracing::info;

pub async fn perform_self_update(download_url: &str, expected_sha256: &str) -> Result<(), String> {
    info!("Starting self-update from: {}", download_url);

    let current_exe = env::current_exe().map_err(|e| format!("Failed to get current exe path: {}", e))?;
    let new_exe = current_exe.with_extension("exe.new");
    let old_exe = current_exe.with_extension("exe.old");

    // 1. Download new binary bytes
    let response = reqwest::get(download_url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed reading response bytes: {}", e))?;

    // 2. Verify SHA256
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash_result = format!("{:x}", hasher.finalize());

    if !expected_sha256.is_empty() && !hash_result.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "Checksum mismatch! Expected: {}, Computed: {}",
            expected_sha256, hash_result
        ));
    }

    // 3. Write new binary to .exe.new
    fs::write(&new_exe, &bytes).map_err(|e| format!("Failed to write new binary: {}", e))?;

    // 4. Rename running binary to .exe.old (Allowed by Windows!)
    if old_exe.exists() {
        let _ = fs::remove_file(&old_exe);
    }
    fs::rename(&current_exe, &old_exe)
        .map_err(|e| format!("Failed to rename running executable: {}", e))?;

    // 5. Move .exe.new to .exe
    fs::rename(&new_exe, &current_exe)
        .map_err(|e| format!("Failed to place new executable: {}", e))?;

    info!("Update successfully applied! Spawning new version...");

    // 6. Spawn new executable
    let mut cmd = Command::new(&current_exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let _ = cmd.spawn();

    // 7. Terminate old process
    std::process::exit(0);
}
