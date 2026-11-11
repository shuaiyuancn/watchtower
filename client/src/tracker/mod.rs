pub mod win32;

pub use win32::{
    counts_as_idle, get_foreground_info, get_idle_time_seconds, is_session_locked, ForegroundInfo,
};
