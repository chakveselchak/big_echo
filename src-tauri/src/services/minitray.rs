//! Floating minitray overlay (NSPanel on macOS; no-op elsewhere).
//!
//! Public API:
//!   - `install_production_sinks()` — wire the FFI sinks at boot (no-op on non-macOS).
//!   - `show_if_enabled(settings, levels)` — show panel iff setting is on and not visible; starts level poller.
//!   - `hide()` — hide panel if visible; stops level poller.
//!   - `update_level(level)` — push current level to panel (throttled to ~30 Hz).
//!   - `is_visible()` — current state.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;

use crate::audio::capture::SharedLevels;
use crate::settings::public_settings::PublicSettings;

type ShowSink = Box<dyn Fn() + Send + Sync>;
type HideSink = Box<dyn Fn() + Send + Sync>;
type LevelSink = Box<dyn Fn(f32) + Send + Sync>;

static VISIBLE: AtomicBool = AtomicBool::new(false);
/// `u64::MAX` is the "never pushed" sentinel: guarantees the first call always goes through.
static LAST_PUSH_NANOS: AtomicU64 = AtomicU64::new(u64::MAX);
static EPOCH: OnceLock<Instant> = OnceLock::new();
static POLLER: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

static SHOW_SINK: OnceLock<ShowSink> = OnceLock::new();
static HIDE_SINK: OnceLock<HideSink> = OnceLock::new();
static LEVEL_SINK: OnceLock<LevelSink> = OnceLock::new();

const MIN_PUSH_INTERVAL_NS: u64 = 33_000_000; // ~30 Hz

fn now_nanos() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

/// Wire the production sinks. Call once at app boot.
/// On macOS the sinks invoke `bigecho_minitray_*` FFI; on other platforms
/// they're no-ops. Test code calls `install_*_sink_for_test` instead.
pub fn install_production_sinks() {
    #[cfg(target_os = "macos")]
    {
        let _ = SHOW_SINK.set(Box::new(|| unsafe { bigecho_minitray_show() }));
        let _ = HIDE_SINK.set(Box::new(|| unsafe { bigecho_minitray_hide() }));
        let _ = LEVEL_SINK.set(Box::new(|level| unsafe {
            bigecho_minitray_update_level(level)
        }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = SHOW_SINK.set(Box::new(|| {}));
        let _ = HIDE_SINK.set(Box::new(|| {}));
        let _ = LEVEL_SINK.set(Box::new(|_| {}));
    }
}

pub fn show_if_enabled(settings: &PublicSettings, levels: &SharedLevels) {
    if !settings.show_minitray_overlay {
        return;
    }
    if VISIBLE.swap(true, Ordering::SeqCst) {
        // Already visible; nothing to do.
        return;
    }
    call_show_sink();

    // Only spawn the poller if we're inside a tokio runtime.
    // In production (Tauri command handlers) a runtime is always present.
    // Some synchronous unit tests have no runtime — skip the poller there.
    if let Ok(handle_rt) = tokio::runtime::Handle::try_current() {
        let levels = levels.clone();
        let handle = handle_rt.spawn(async move {
            loop {
                if !VISIBLE.load(Ordering::SeqCst) {
                    break;
                }
                let snap = levels.snapshot();
                let combined = snap.mic.max(snap.system);
                update_level(combined);
                tokio::time::sleep(std::time::Duration::from_millis(33)).await;
            }
        });
        if let Ok(mut guard) = POLLER.lock() {
            *guard = Some(handle);
        }
    }
}

pub fn hide() {
    if !VISIBLE.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut guard) = POLLER.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
    call_hide_sink();
}

pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::SeqCst)
}

pub fn update_level(level: f32) {
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    let now = now_nanos();
    let last = LAST_PUSH_NANOS.load(Ordering::SeqCst);
    // `u64::MAX` means "never pushed" — always let the first call through.
    if last != u64::MAX && now.saturating_sub(last) < MIN_PUSH_INTERVAL_NS {
        return;
    }
    if LAST_PUSH_NANOS
        .compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // Another thread won the race.
    }
    call_level_sink(level);
}

fn call_show_sink() {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_SHOW.lock().unwrap().as_ref() {
            sink();
            return;
        }
    }
    if let Some(sink) = SHOW_SINK.get() {
        sink();
    }
}

fn call_hide_sink() {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_HIDE.lock().unwrap().as_ref() {
            sink();
            return;
        }
    }
    if let Some(sink) = HIDE_SINK.get() {
        sink();
    }
}

fn call_level_sink(level: f32) {
    #[cfg(test)]
    {
        if let Some(sink) = test_sinks::TEST_LEVEL.lock().unwrap().as_ref() {
            sink(level);
            return;
        }
    }
    if let Some(sink) = LEVEL_SINK.get() {
        sink(level);
    }
}

#[cfg(target_os = "macos")]
#[link(name = "MinitrayBridge", kind = "static")]
extern "C" {
    fn bigecho_minitray_show();
    fn bigecho_minitray_hide();
    fn bigecho_minitray_update_level(level: f32);
    fn bigecho_minitray_set_callbacks(
        on_stop: extern "C" fn(),
        on_icon: extern "C" fn(),
    );
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C" fn on_stop_clicked() {
    if let Some(app) = APP_HANDLE.get() {
        // Reuse the existing channel that the recording controller already
        // listens to. This stops the recording, which in turn calls hide().
        let _ = app.emit("tray:stop", ());
    }
}

extern "C" fn on_icon_clicked() {
    if let Some(app) = APP_HANDLE.get() {
        // Emit an event; main.rs listens and opens the tray window.
        // (window_manager is only in the binary crate, not the lib crate.)
        let _ = app.emit("minitray:open_tray", ());
    }
}

pub fn install_callbacks(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
    #[cfg(target_os = "macos")]
    unsafe {
        bigecho_minitray_set_callbacks(on_stop_clicked, on_icon_clicked);
    }
}

#[cfg(test)]
mod test_sinks {
    use super::{HideSink, LevelSink, ShowSink};
    use std::sync::Mutex;

    pub static TEST_SHOW: Mutex<Option<ShowSink>> = Mutex::new(None);
    pub static TEST_HIDE: Mutex<Option<HideSink>> = Mutex::new(None);
    pub static TEST_LEVEL: Mutex<Option<LevelSink>> = Mutex::new(None);
}

#[cfg(test)]
pub(crate) fn install_show_sink_for_test(sink: ShowSink) {
    *test_sinks::TEST_SHOW.lock().unwrap() = Some(sink);
}

#[cfg(test)]
pub(crate) fn install_hide_sink_for_test(sink: HideSink) {
    *test_sinks::TEST_HIDE.lock().unwrap() = Some(sink);
}

#[cfg(test)]
pub(crate) fn install_level_sink_for_test(sink: LevelSink) {
    *test_sinks::TEST_LEVEL.lock().unwrap() = Some(sink);
}

// Shared serialization lock for all tests that touch the minitray global state
// (VISIBLE, LAST_PUSH_NANOS, test sinks). Exposed as pub(crate) so tests in
// other modules (e.g. commands::recording) can acquire the same lock and avoid
// parallel-run interference.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn reset_state_for_test() {
        // Clear any running poller handle; ignore mutex poison from a previous failed test.
        let poller_handle = POLLER.lock().ok().and_then(|mut g| g.take());
        // Also recover from a poisoned mutex by re-initializing it.
        if POLLER.is_poisoned() {
            // Safety: we're in a single-threaded test context under TEST_LOCK.
            // Clearing the poison is the cleanest option here.
            drop(POLLER.lock().unwrap_or_else(|e| e.into_inner()));
        }
        if let Some(handle) = poller_handle {
            handle.abort();
        }
        VISIBLE.store(false, Ordering::SeqCst);
        LAST_PUSH_NANOS.store(u64::MAX, Ordering::SeqCst);
        *test_sinks::TEST_SHOW.lock().unwrap() = None;
        *test_sinks::TEST_HIDE.lock().unwrap() = None;
        *test_sinks::TEST_LEVEL.lock().unwrap() = None;
    }

    #[test]
    fn show_if_enabled_is_noop_when_setting_is_off() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = false;
        show_if_enabled(&settings, &SharedLevels::new());

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!is_visible());
    }

    #[test]
    fn show_if_enabled_calls_sink_when_setting_is_on() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings, &SharedLevels::new());

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(is_visible());
    }

    #[test]
    fn show_if_enabled_is_idempotent() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_sink = Arc::clone(&calls);
        install_show_sink_for_test(Box::new(move || {
            calls_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings, &SharedLevels::new());
        show_if_enabled(&settings, &SharedLevels::new());
        show_if_enabled(&settings, &SharedLevels::new());

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hide_resets_visibility_and_calls_sink_once() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let show_calls = Arc::new(AtomicUsize::new(0));
        let show_for_sink = Arc::clone(&show_calls);
        install_show_sink_for_test(Box::new(move || {
            show_for_sink.fetch_add(1, Ordering::SeqCst);
        }));
        let hide_calls = Arc::new(AtomicUsize::new(0));
        let hide_for_sink = Arc::clone(&hide_calls);
        install_hide_sink_for_test(Box::new(move || {
            hide_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings, &SharedLevels::new());
        assert!(is_visible());

        hide();
        assert!(!is_visible());
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);

        // Subsequent hide while not visible: no extra FFI call.
        hide();
        assert_eq!(hide_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn update_level_throttles_high_frequency_pushes() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let pushes = Arc::new(AtomicUsize::new(0));
        let pushes_for_sink = Arc::clone(&pushes);
        install_show_sink_for_test(Box::new(|| {}));
        install_level_sink_for_test(Box::new(move |_| {
            pushes_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings, &SharedLevels::new());

        // Drive 1000 quick updates back-to-back.
        for _ in 0..1000 {
            update_level(0.5);
        }

        let n = pushes.load(Ordering::SeqCst);
        // First call always passes; subsequent calls within 33ms are throttled.
        // Loose upper bound — we expect 1 if the loop runs faster than 33ms,
        // but allow up to 5 in case the test runs slowly.
        assert!(n >= 1 && n <= 5, "pushes was {}", n);
    }

    #[test]
    fn update_level_is_noop_when_not_visible() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();
        let pushes = Arc::new(AtomicUsize::new(0));
        let pushes_for_sink = Arc::clone(&pushes);
        install_level_sink_for_test(Box::new(move |_| {
            pushes_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        update_level(0.5);
        assert_eq!(pushes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn show_pumps_levels_until_hide() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_state_for_test();

        let pushes = Arc::new(AtomicUsize::new(0));
        let pushes_for_sink = Arc::clone(&pushes);
        install_show_sink_for_test(Box::new(|| {}));
        install_hide_sink_for_test(Box::new(|| {}));
        install_level_sink_for_test(Box::new(move |_| {
            pushes_for_sink.fetch_add(1, Ordering::SeqCst);
        }));

        let levels = SharedLevels::new();
        levels.set_mic(0.4);
        levels.set_system(0.7);

        let mut settings = PublicSettings::default();
        settings.show_minitray_overlay = true;
        show_if_enabled(&settings, &levels);

        tokio::time::sleep(std::time::Duration::from_millis(120)).await;

        let n = pushes.load(Ordering::SeqCst);
        assert!(n >= 2, "expected at least 2 level pushes within 120ms, got {}", n);

        hide();
        let after_hide = pushes.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let final_count = pushes.load(Ordering::SeqCst);
        assert_eq!(final_count, after_hide, "poller should stop after hide()");
    }
}
