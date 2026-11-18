//! One client per user: an exclusive, non-blocking `flock` on a lock file the
//! child's user can write. The kernel drops the lock when the process exits,
//! however it exits.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use tracing::warn;

/// Holds the lock until dropped (closing the file releases it).
pub struct SingleInstanceGuard {
    _file: Option<File>,
}

/// Candidate lock files, in order: the user's Application Support directory,
/// then a per-uid file in the temp directory.
fn lock_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        paths.push(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Watchtower")
                .join("client.lock"),
        );
    }
    let uid = unsafe { libc::getuid() };
    paths.push(std::env::temp_dir().join(format!("watchtower-{}.lock", uid)));
    paths
}

pub fn acquire_single_instance() -> Option<SingleInstanceGuard> {
    for path in lock_paths() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&path)
        {
            Ok(f) => f,
            Err(e) => {
                warn!("[single-instance] cannot open {}: {}", path.display(), e);
                continue;
            }
        };
        // SAFETY: flock on a file descriptor we own.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Some(SingleInstanceGuard { _file: Some(file) });
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            // Another client holds it.
            return None;
        }
        warn!("[single-instance] flock on {} failed: {}", path.display(), err);
    }
    // No lock file could be used. Running unguarded is better than leaving
    // the device unmonitored.
    warn!("[single-instance] no usable lock file; running without the single-instance guard");
    Some(SingleInstanceGuard { _file: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_paths_end_with_a_per_uid_temp_file() {
        let paths = lock_paths();
        let last = paths.last().unwrap();
        assert!(last.starts_with(std::env::temp_dir()));
        assert!(last.file_name().unwrap().to_string_lossy().starts_with("watchtower-"));
    }

    #[test]
    fn a_second_guard_is_refused_while_the_first_is_held() {
        // flock locks belong to the open file description, so a second open
        // in the same process conflicts like a second process would.
        let first = acquire_single_instance().expect("first guard");
        if first._file.is_some() {
            assert!(acquire_single_instance().is_none());
        }
        drop(first);
        assert!(acquire_single_instance().is_some());
    }
}
