//! Lock-free media download byte counter for live playback speed display.
use std::sync::atomic::{AtomicU64, Ordering};

static MEDIA_RX_BYTES: AtomicU64 = AtomicU64::new(0);

#[inline]
pub fn record_rx(bytes: u64) {
    if bytes > 0 {
        MEDIA_RX_BYTES.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// Returns cumulative bytes received by the Rust media proxy since app launch.
/// The frontend samples deltas only while buffering to display live download speed.
#[tauri::command]
pub fn media_rx_bytes() -> u64 {
    MEDIA_RX_BYTES.load(Ordering::Relaxed)
}
