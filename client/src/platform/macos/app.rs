//! The main-thread side of the macOS client.
//!
//! AppKit objects may only be touched on the process main thread, and
//! `NSRunningApplication` values only refresh while the main run loop turns.
//! `run_main_thread` starts the tokio client on its own thread and turns the
//! main thread into a small event loop: wait up to LOOP_WAIT for an event,
//! dispatch it, run queued jobs (quit an app, show a warning, lock), refresh
//! the foreground app, expire the warning window. The client thread never
//! touches AppKit; it posts jobs and reads the cached foreground app. The
//! main thread never waits on the client thread, so neither can deadlock the
//! other. When the client returns or panics, the process exits and launchd
//! starts it again.
#![allow(unused_unsafe)]

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tracing::{error, warn};

use objc2::rc::{autoreleasepool, Retained};
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSColor, NSEventMask, NSFont,
    NSRunningApplication, NSScreen, NSTextField, NSWindow, NSWindowCollectionBehavior,
    NSWindowStyleMask, NSWorkspace,
};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPoint, NSRect, NSSize, NSString};

use crate::platform::ForegroundApp;
use crate::types::{truncate_utf16, MAX_CURRENT_APP_LEN};

/// Longest the main loop sleeps waiting for an event before running jobs.
const LOOP_WAIT_SECS: f64 = 0.2;
/// How long a warning stays on screen.
const WARNING_DURATION: Duration = Duration::from_secs(8);
/// How long `quit_app` waits for the main thread.
const QUIT_TIMEOUT: Duration = Duration::from_secs(3);
/// kCGStatusWindowLevel: above normal and floating windows.
const STATUS_WINDOW_LEVEL: isize = 25;

/// App identifiers the client never terminates, whatever the server says.
const PROTECTED_APP_IDS: [&str; 2] = ["com.apple.finder", "com.apple.loginwindow"];

const CLIENT_RUNNING: u8 = 0;
const CLIENT_RETURNED: u8 = 1;
const CLIENT_PANICKED: u8 = 2;
static CLIENT_STATE: AtomicU8 = AtomicU8::new(CLIENT_RUNNING);

enum Job {
    Quit { app_id: String, reply: mpsc::Sender<bool> },
    Warn { title: String, message: String },
    Call(unsafe extern "C" fn()),
}

static JOBS: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

/// The foreground app as last read on the main thread.
static FOREGROUND: Mutex<Option<ForegroundApp>> = Mutex::new(None);

/// Queue a job for the main thread. False if the main loop is not running.
fn send_job(job: Job) -> bool {
    match JOBS.get() {
        Some(tx) => match tx.lock() {
            Ok(tx) => tx.send(job).is_ok(),
            Err(_) => false,
        },
        None => false,
    }
}

pub fn run_main_thread<F: FnOnce() + Send + 'static>(client: F) {
    let Some(mtm) = MainThreadMarker::new() else {
        // Only reachable if main() stops calling this from the main thread.
        error!("run_main_thread called off the main thread; running without AppKit");
        client();
        return;
    };

    let (tx, rx) = mpsc::channel::<Job>();
    let _ = JOBS.set(Mutex::new(tx));

    std::thread::Builder::new()
        .name("watchtower-client".to_string())
        .spawn(move || {
            // With panic = "abort" in release builds a panic ends the process
            // directly; this covers debug builds.
            let state = match std::panic::catch_unwind(AssertUnwindSafe(client)) {
                Ok(()) => CLIENT_RETURNED,
                Err(_) => CLIENT_PANICKED,
            };
            CLIENT_STATE.store(state, Ordering::SeqCst);
        })
        .expect("failed to start the client thread");

    let app = NSApplication::sharedApplication(mtm);
    // Accessory: no Dock icon and no menu bar, but the app may show windows.
    unsafe {
        let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        app.finishLaunching();
    }

    let mut warning: Option<(Retained<NSWindow>, Instant)> = None;
    loop {
        match CLIENT_STATE.load(Ordering::SeqCst) {
            CLIENT_RETURNED => std::process::exit(0),
            CLIENT_PANICKED => std::process::exit(1),
            _ => {}
        }

        autoreleasepool(|_| {
            unsafe {
                let until = NSDate::dateWithTimeIntervalSinceNow(LOOP_WAIT_SECS);
                let event = app.nextEventMatchingMask_untilDate_inMode_dequeue(
                    NSEventMask::Any,
                    Some(&until),
                    NSDefaultRunLoopMode,
                    true,
                );
                if let Some(event) = event {
                    app.sendEvent(&event);
                }
            }

            while let Ok(job) = rx.try_recv() {
                run_job(mtm, job, &mut warning);
            }

            refresh_foreground();

            let expired = warning
                .as_ref()
                .map(|(_, shown)| shown.elapsed() >= WARNING_DURATION)
                .unwrap_or(false);
            if expired {
                if let Some((window, _)) = warning.take() {
                    window.close();
                }
            }
        });
    }
}

fn run_job(mtm: MainThreadMarker, job: Job, warning: &mut Option<(Retained<NSWindow>, Instant)>) {
    match job {
        Job::Quit { app_id, reply } => {
            let _ = reply.send(quit_matching(&app_id));
        }
        Job::Warn { title, message } => {
            // A newer warning replaces the one on screen.
            if let Some((old, _)) = warning.take() {
                old.close();
            }
            *warning = Some((show_warning_window(mtm, &title, &message), Instant::now()));
        }
        Job::Call(f) => unsafe { f() },
    }
}

/// Run a C function on the main thread, or right here if the main loop is
/// not running.
pub(super) fn call_on_main_thread(f: unsafe extern "C" fn()) {
    if MainThreadMarker::new().is_some() || !send_job(Job::Call(f)) {
        unsafe { f() }
    }
}

// ---- Foreground app ----

/// The app identifier: bundle identifier, or the executable's file name for
/// an unbundled process.
fn app_identifier(app: &NSRunningApplication) -> Option<String> {
    unsafe {
        if let Some(id) = app.bundleIdentifier() {
            let id = id.to_string();
            if !id.is_empty() {
                return Some(id);
            }
        }
        let url = app.executableURL()?;
        let name = url.lastPathComponent()?.to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

fn refresh_foreground() {
    let fg = unsafe {
        NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| ForegroundApp {
            app_id: truncate_utf16(&app_identifier(&app).unwrap_or_default(), MAX_CURRENT_APP_LEN),
            display_name: app.localizedName().map(|n| n.to_string()),
            window_title: String::new(),
        })
    };
    if let Ok(mut current) = FOREGROUND.lock() {
        *current = fg;
    }
}

/// The app in front, as last seen by the main loop. None while nothing is in
/// front (login, wake) or before the main loop first runs.
pub fn foreground_app() -> Option<ForegroundApp> {
    FOREGROUND.lock().ok().and_then(|g| g.clone())
}

// ---- Quitting apps ----

fn is_protected(app_id: &str) -> bool {
    app_id.trim().is_empty() || PROTECTED_APP_IDS.iter().any(|p| p.eq_ignore_ascii_case(app_id.trim()))
}

/// Force-terminate every app whose identifier matches `app_id`, ignoring case
/// (the server may send it lowercased). Main thread only.
fn quit_matching(app_id: &str) -> bool {
    if is_protected(app_id) {
        return false;
    }
    let own_pid = std::process::id() as libc::pid_t;
    let mut terminated = false;
    unsafe {
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        for app in apps.iter() {
            if app.processIdentifier() == own_pid {
                continue;
            }
            let Some(id) = app_identifier(&app) else { continue };
            if id.eq_ignore_ascii_case(app_id.trim()) && !is_protected(&id) {
                if app.forceTerminate() {
                    terminated = true;
                } else {
                    warn!("[quit] forceTerminate refused for {}", id);
                }
            }
        }
    }
    terminated
}

/// Force-quit an app by app identifier. Runs on the main thread; waits up to
/// QUIT_TIMEOUT for it.
pub fn quit_app(app_id: &str) -> bool {
    if is_protected(app_id) {
        return false;
    }
    if MainThreadMarker::new().is_some() {
        return quit_matching(app_id);
    }
    let (reply, result) = mpsc::channel();
    if !send_job(Job::Quit { app_id: app_id.to_string(), reply }) {
        warn!("[quit] main loop not running; cannot quit {}", app_id);
        return false;
    }
    result.recv_timeout(QUIT_TIMEOUT).unwrap_or(false)
}

// ---- Warning window ----

/// Show a warning in the client's own window (no Notification Center, which
/// drops notifications from an unbundled binary).
pub fn show_warning(title: &str, message: &str) {
    let _ = send_job(Job::Warn {
        title: title.to_string(),
        message: message.to_string(),
    });
}

/// A small borderless window in the top-right corner of the main screen, above
/// other windows and on every Space, shown without activating the client.
fn show_warning_window(mtm: MainThreadMarker, title: &str, message: &str) -> Retained<NSWindow> {
    const WIDTH: f64 = 380.0;
    const HEIGHT: f64 = 120.0;
    const MARGIN: f64 = 16.0;

    unsafe {
        let (x, y) = match NSScreen::mainScreen(mtm) {
            Some(screen) => {
                let f = screen.visibleFrame();
                (
                    f.origin.x + f.size.width - WIDTH - MARGIN,
                    f.origin.y + f.size.height - HEIGHT - MARGIN,
                )
            }
            None => (100.0, 100.0),
        };
        let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(WIDTH, HEIGHT));

        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        );
        // The Retained owns the window; AppKit must not also release it on close.
        window.setReleasedWhenClosed(false);
        window.setLevel(STATUS_WINDOW_LEVEL);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        window.setHidesOnDeactivate(false);
        window.setBackgroundColor(Some(&NSColor::windowBackgroundColor()));
        window.setHasShadow(true);

        let title_label = NSTextField::labelWithString(&NSString::from_str(title), mtm);
        title_label.setFont(Some(&NSFont::boldSystemFontOfSize(15.0)));
        title_label.setFrame(NSRect::new(
            NSPoint::new(MARGIN, HEIGHT - MARGIN - 22.0),
            NSSize::new(WIDTH - 2.0 * MARGIN, 22.0),
        ));

        let body = NSTextField::wrappingLabelWithString(&NSString::from_str(message), mtm);
        body.setFont(Some(&NSFont::systemFontOfSize(13.0)));
        body.setFrame(NSRect::new(
            NSPoint::new(MARGIN, MARGIN),
            NSSize::new(WIDTH - 2.0 * MARGIN, HEIGHT - 2.0 * MARGIN - 28.0),
        ));

        if let Some(view) = window.contentView() {
            view.addSubview(&title_label);
            view.addSubview(&body);
        }

        // Shows the window without making the client the active app, so the
        // child's focus stays where it was.
        window.orderFrontRegardless();
        window
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_apps_are_never_quit() {
        assert!(is_protected(""));
        assert!(is_protected("   "));
        assert!(is_protected("com.apple.finder"));
        assert!(is_protected("COM.APPLE.FINDER"));
        assert!(is_protected("com.apple.loginwindow"));
        assert!(!is_protected("com.google.chrome"));
        assert!(!quit_app(""));
        assert!(!quit_app("com.apple.Finder"));
    }

    #[test]
    fn foreground_is_none_before_the_main_loop_runs() {
        // Tests do not run the main loop, so nothing has been cached.
        assert!(foreground_app().is_none());
    }
}
