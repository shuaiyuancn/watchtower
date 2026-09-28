use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tracing::{error, info, warn};

use crate::config::ClientConfig;

const RELEASE_BINARY_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe";
const RELEASE_SHA_URL: &str =
    "https://github.com/shuaiyuancn/watchtower/releases/latest/download/watchtower.exe.sha256";

/// Marker arg passed to the freshly-updated process so it knows to wait for the
/// previous instance to release the single-instance mutex.
pub const UPDATED_ARG: &str = "--updated";

// ---- Pure, unit-testable helpers ----

/// Lowercase hex SHA-256 of the given bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Extract the 64-char hex digest from a `.sha256` file. Accepts either a bare
/// digest or the common "`<digest>  <filename>`" format, any case.
pub fn parse_expected_sha256(content: &str) -> Option<String> {
    for line in content.lines() {
        let token = line.split_whitespace().next().unwrap_or("");
        let token = token.trim().trim_start_matches("sha256:");
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(token.to_ascii_lowercase());
        }
    }
    None
}

/// Whether the running binary should be replaced. Both hashes must be valid;
/// comparison is case-insensitive.
pub fn needs_update(current_sha: &str, expected_sha: &str) -> bool {
    let expected = expected_sha.trim();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    !current_sha.eq_ignore_ascii_case(expected)
}

/// Sibling `.exe.new` / `.exe.old` paths for the given executable. Uses PathBuf
/// operations (no string concatenation) so it is correct for Windows 8.3 short
/// paths and paths containing spaces.
pub fn update_target_paths(current_exe: &Path) -> (PathBuf, PathBuf) {
    (
        current_exe.with_extension("exe.new"),
        current_exe.with_extension("exe.old"),
    )
}

/// Build the argument list for relaunching after an update: the original args
/// (minus program name) plus the UPDATED_ARG marker (added once).
pub fn relaunch_args(original: &[String]) -> Vec<String> {
    let mut args: Vec<String> = original.iter().skip(1).cloned().collect();
    if !args.iter().any(|a| a == UPDATED_ARG) {
        args.push(UPDATED_ARG.to_string());
    }
    args
}

// ---- Effectful update flow ----

/// One update check: fetch the published checksum, compare to the running
/// binary, and self-update if they differ. Best-effort; errors are logged.
pub async fn check_and_update() {
    let current_exe = match env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            warn!("[update] cannot resolve current exe: {}", e);
            return;
        }
    };

    let current_bytes = match fs::read(&current_exe) {
        Ok(b) => b,
        Err(e) => {
            warn!("[update] cannot read current exe: {}", e);
            return;
        }
    };
    let current_sha = sha256_hex(&current_bytes);

    let sha_text = match reqwest::get(RELEASE_SHA_URL).await {
        Ok(r) => match r.text().await {
            Ok(t) => t,
            Err(e) => {
                warn!("[update] failed reading checksum body: {}", e);
                return;
            }
        },
        Err(e) => {
            warn!("[update] checksum fetch failed: {}", e);
            return;
        }
    };

    let expected = match parse_expected_sha256(&sha_text) {
        Some(h) => h,
        None => {
            warn!("[update] no valid sha256 in published checksum");
            return;
        }
    };

    if !needs_update(&current_sha, &expected) {
        info!("[update] client is up to date.");
        return;
    }

    info!("[update] new version available; updating...");
    if let Err(e) = perform_self_update(RELEASE_BINARY_URL, &expected).await {
        error!("[update] self-update failed: {}", e);
    }
}

/// Periodic update loop. Runs an initial check shortly after startup, then every
/// `update_check_interval_secs`.
pub async fn run_update_loop(config: ClientConfig) {
    // Small initial delay so we don't fight the startup/connect path.
    tokio::time::sleep(Duration::from_secs(60)).await;
    let interval = Duration::from_secs(config.update_check_interval_secs.max(300));
    loop {
        check_and_update().await;
        tokio::time::sleep(interval).await;
    }
}

pub async fn perform_self_update(download_url: &str, expected_sha256: &str) -> Result<(), String> {
    info!("Starting self-update from: {}", download_url);

    let current_exe = env::current_exe().map_err(|e| format!("Failed to get current exe path: {}", e))?;
    let (new_exe, old_exe) = update_target_paths(&current_exe);

    // 1. Download new binary bytes
    let response = reqwest::get(download_url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed reading response bytes: {}", e))?;

    // 2. Verify SHA256
    let hash_result = sha256_hex(&bytes);
    if !expected_sha256.is_empty() && !hash_result.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "Checksum mismatch! Expected: {}, Computed: {}",
            expected_sha256, hash_result
        ));
    }

    // 3. Write new binary to .exe.new
    fs::write(&new_exe, &bytes).map_err(|e| format!("Failed to write new binary: {}", e))?;

    // 4. Rename running binary to .exe.old (allowed by Windows), then swap in new.
    if old_exe.exists() {
        let _ = fs::remove_file(&old_exe);
    }
    fs::rename(&current_exe, &old_exe)
        .map_err(|e| format!("Failed to rename running executable: {}", e))?;
    if let Err(e) = fs::rename(&new_exe, &current_exe) {
        // Best-effort rollback so we don't leave the service without a binary.
        let _ = fs::rename(&old_exe, &current_exe);
        return Err(format!("Failed to place new executable: {}", e));
    }

    info!("Update applied; relaunching new version...");

    // 5. Spawn new executable, preserving original args (e.g. --config) plus the
    //    UPDATED_ARG marker so it waits out the single-instance mutex.
    let original: Vec<String> = env::args().collect();
    let mut cmd = Command::new(&current_exe);
    cmd.args(relaunch_args(&original));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("Failed to relaunch: {}", e))?;

    // 6. Terminate old process so it releases the mutex and file handle.
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_is_lowercase_hex() {
        let h = sha256_hex(b"hello");
        assert_eq!(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn parses_bare_digest() {
        let d = "a".repeat(64);
        assert_eq!(parse_expected_sha256(&d), Some(d.clone()));
    }

    #[test]
    fn parses_digest_with_filename_and_case() {
        let content = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  watchtower.exe\n";
        assert_eq!(
            parse_expected_sha256(content),
            Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string())
        );
    }

    #[test]
    fn parses_sha256_prefixed_and_skips_junk_lines() {
        let content = "# comment line\nsha256:aa\nsha256:11112222333344445555666677778888aaaabbbbccccddddeeeeffff00001111\n";
        assert_eq!(
            parse_expected_sha256(content),
            Some("11112222333344445555666677778888aaaabbbbccccddddeeeeffff00001111".to_string())
        );
    }

    #[test]
    fn rejects_invalid_checksum_content() {
        assert_eq!(parse_expected_sha256(""), None);
        assert_eq!(parse_expected_sha256("not-a-hash"), None);
        assert_eq!(parse_expected_sha256(&"g".repeat(64)), None); // non-hex
        assert_eq!(parse_expected_sha256(&"a".repeat(63)), None); // wrong length
    }

    #[test]
    fn needs_update_only_when_hashes_differ_and_valid() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        assert!(needs_update(&a, &b));
        assert!(!needs_update(&a, &a));
        // case-insensitive equality => no update
        assert!(!needs_update(&a, &a.to_ascii_uppercase()));
        // invalid expected => never update
        assert!(!needs_update(&a, "short"));
        assert!(!needs_update(&a, &"z".repeat(64)));
    }

    #[test]
    fn update_target_paths_are_siblings_with_correct_suffixes() {
        // Includes a Windows 8.3-style short path and a space to guard path handling.
        let p = Path::new(r"C:\PROGRA~1\Watch Tower\watchtower.exe");
        let (new_exe, old_exe) = update_target_paths(p);
        assert_eq!(new_exe, Path::new(r"C:\PROGRA~1\Watch Tower\watchtower.exe.new"));
        assert_eq!(old_exe, Path::new(r"C:\PROGRA~1\Watch Tower\watchtower.exe.old"));
        assert_eq!(new_exe.parent(), p.parent());
        assert_eq!(old_exe.parent(), p.parent());
    }

    #[test]
    fn relaunch_args_preserve_config_and_add_marker_once() {
        let original = vec![
            "watchtower.exe".to_string(),
            "--config".to_string(),
            r"C:\ProgramData\Watchtower\config.json".to_string(),
        ];
        let args = relaunch_args(&original);
        assert_eq!(
            args,
            vec![
                "--config".to_string(),
                r"C:\ProgramData\Watchtower\config.json".to_string(),
                UPDATED_ARG.to_string(),
            ]
        );
        // Idempotent: does not duplicate the marker.
        let again = relaunch_args(&[
            "watchtower.exe".to_string(),
            UPDATED_ARG.to_string(),
        ]);
        assert_eq!(again, vec![UPDATED_ARG.to_string()]);
    }
}
