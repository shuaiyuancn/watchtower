//! Idle time and lock state from CoreGraphics. Both calls are safe from any
//! thread and need no permission.

use std::ffi::c_void;

type CFTypeRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFStringRef = *const c_void;
type CFTypeID = usize; // unsigned long
type CFIndex = isize;
type Boolean = u8;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_CF_NUMBER_SINT64_TYPE: CFIndex = 4;

/// kCGEventSourceStateCombinedSessionState
const COMBINED_SESSION_STATE: i32 = 0;
/// kCGAnyInputEventType (~0)
const ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    fn CFBooleanGetTypeID() -> CFTypeID;
    fn CFBooleanGetValue(boolean: CFTypeRef) -> Boolean;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFNumberGetValue(number: CFTypeRef, the_type: CFIndex, value_ptr: *mut c_void) -> Boolean;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFStringCreateWithBytes(
        alloc: *const c_void,
        bytes: *const u8,
        num_bytes: CFIndex,
        encoding: u32,
        is_external_representation: Boolean,
    ) -> CFStringRef;
}

/// Seconds since the last keyboard, mouse or trackpad input in this session.
pub fn idle_seconds() -> u64 {
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT_TYPE) };
    if secs.is_finite() && secs > 0.0 {
        secs as u64
    } else {
        0
    }
}

/// Whether the child's session is locked, or not the one on screen.
pub fn is_locked() -> bool {
    unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return session_counts_as_locked(false, None, None);
        }
        let screen_locked = dict_flag(dict, "CGSSessionScreenIsLocked");
        let on_console = dict_flag(dict, "kCGSSessionOnConsoleKey");
        CFRelease(dict);
        session_counts_as_locked(true, screen_locked, on_console)
    }
}

/// The lock decision. No session dictionary (not in a GUI session) counts as
/// locked; so does a session in the background under fast user switching, so
/// no screen time accrues while another user is at the screen. A missing key
/// means the default: unlocked, on console.
fn session_counts_as_locked(have_dict: bool, screen_locked: Option<bool>, on_console: Option<bool>) -> bool {
    !have_dict || screen_locked == Some(true) || on_console == Some(false)
}

/// Read a boolean-like value (CFBoolean or CFNumber) from a CF dictionary.
/// The value is borrowed from the dictionary (Get rule) and not released.
unsafe fn dict_flag(dict: CFDictionaryRef, key: &str) -> Option<bool> {
    let cf_key = CFStringCreateWithBytes(
        std::ptr::null(),
        key.as_ptr(),
        key.len() as CFIndex,
        K_CF_STRING_ENCODING_UTF8,
        0,
    );
    if cf_key.is_null() {
        return None;
    }
    let value = CFDictionaryGetValue(dict, cf_key);
    CFRelease(cf_key);
    if value.is_null() {
        return None;
    }
    let type_id = CFGetTypeID(value);
    if type_id == CFBooleanGetTypeID() {
        Some(CFBooleanGetValue(value) != 0)
    } else if type_id == CFNumberGetTypeID() {
        let mut n: i64 = 0;
        if CFNumberGetValue(value, K_CF_NUMBER_SINT64_TYPE, &mut n as *mut i64 as *mut c_void) != 0 {
            Some(n != 0)
        } else {
            None
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_session_dictionary_counts_as_locked() {
        assert!(session_counts_as_locked(false, None, None));
    }

    #[test]
    fn screen_lock_flag_counts_as_locked() {
        assert!(session_counts_as_locked(true, Some(true), Some(true)));
        assert!(!session_counts_as_locked(true, Some(false), Some(true)));
    }

    #[test]
    fn background_session_counts_as_locked() {
        assert!(session_counts_as_locked(true, None, Some(false)));
    }

    #[test]
    fn missing_keys_mean_unlocked_on_console() {
        assert!(!session_counts_as_locked(true, None, None));
        assert!(!session_counts_as_locked(true, None, Some(true)));
    }

    #[test]
    fn ffi_calls_do_not_crash_on_the_ci_runner() {
        // The runner may or may not have a GUI session; only check the calls
        // return without crashing.
        let _ = is_locked();
        let _ = idle_seconds();
    }
}
