//! Concurrent HLS segment/key lookahead prefetch into the local media cache.
//!
//! hls.js downloads one media fragment at a time, leaving fast links idle between
//! segments and after seeks. When Rust rewrites a media playlist or serves a
//! segment, this module schedules a bounded lookahead window into `KEY_CACHE` /
//! `SEG_CACHE` via `media::load_segment_raw`, sharing single-flight coalescing
//! and cancelling queued work as soon as the playback window, cache epoch, or
//! network scope advances.

use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;

const MAX_TRACKED_PLAYLISTS: usize = 16;
const MAX_SEGMENTS_PER_PLAYLIST: usize = 2048;
const INITIAL_SEGMENTS: usize = 2;
const LOOKAHEAD_SEGMENTS: usize = 2;
const MAX_CONCURRENT_PREFETCH: usize = 3;

struct PlaylistEntry {
    id: u64,
    segments: Arc<Vec<String>>,
}

#[derive(Default)]
struct PlaylistIndex {
    next_id: u64,
    order: VecDeque<PlaylistEntry>,
    by_segment: HashMap<String, (u64, usize)>,
}

static INDEX: Lazy<Mutex<PlaylistIndex>> = Lazy::new(|| Mutex::new(PlaylistIndex::default()));
static EPOCH: AtomicU64 = AtomicU64::new(0);
static SEM: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(MAX_CONCURRENT_PREFETCH)));

fn absolutize(base: &str, target: &str) -> Option<String> {
    let resolved = if target.starts_with("http://") || target.starts_with("https://") {
        url::Url::parse(target).ok()?
    } else {
        url::Url::parse(base).ok()?.join(target).ok()?
    };
    matches!(resolved.scheme(), "http" | "https").then(|| resolved.into())
}

fn extract_quoted_uri(line: &str) -> Option<&str> {
    let upper = line.to_ascii_uppercase();
    let pos = upper.find("URI=\"")?;
    let rest = &line[pos + 5..];
    let end = rest.find('"')?;
    let uri = rest[..end].trim();
    (!uri.is_empty()).then_some(uri)
}

fn parse_media_playlist(base_url: &str, text: &str) -> (Vec<String>, Vec<String>) {
    let mut init_urls = Vec::new();
    let mut segments = Vec::new();
    let mut got_key = false;
    let mut got_map = false;
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-STREAM-INF:") {
            return (Vec::new(), Vec::new());
        }
        if line.starts_with("#EXT-X-KEY:") {
            if !got_key && !line.to_ascii_uppercase().contains("METHOD=NONE") {
                if let Some(uri) = extract_quoted_uri(line).and_then(|u| absolutize(base_url, u)) {
                    if !init_urls.contains(&uri) {
                        init_urls.push(uri);
                    }
                    got_key = true;
                }
            }
            continue;
        }
        if line.starts_with("#EXT-X-MAP:") {
            if !got_map {
                if let Some(uri) = extract_quoted_uri(line).and_then(|u| absolutize(base_url, u)) {
                    if !init_urls.contains(&uri) {
                        init_urls.push(uri);
                    }
                    got_map = true;
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if segments.len() >= MAX_SEGMENTS_PER_PLAYLIST {
            break;
        }
        if let Some(url) = absolutize(base_url, line) {
            segments.push(url);
        }
    }
    (init_urls, segments)
}

fn register_playlist(segments: Vec<String>) {
    let Ok(mut idx) = INDEX.lock() else {
        return;
    };
    idx.next_id = idx.next_id.wrapping_add(1);
    let id = idx.next_id;
    for (pos, seg) in segments.iter().enumerate() {
        idx.by_segment.insert(seg.clone(), (id, pos));
    }
    idx.order.push_back(PlaylistEntry {
        id,
        segments: Arc::new(segments),
    });
    while idx.order.len() > MAX_TRACKED_PLAYLISTS {
        if let Some(old) = idx.order.pop_front() {
            idx.by_segment.retain(|_, (entry_id, _)| *entry_id != old.id);
        }
    }
}

fn schedule_urls(urls: Vec<String>, epoch: u64) {
    if urls.is_empty() || crate::cache::max_segment_item_bytes() == 0 {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let scope = crate::net::request_scope();
    for url in urls {
        if crate::media::is_cached_segment(&url) {
            continue;
        }
        let sem = Arc::clone(&SEM);
        handle.spawn(async move {
            let Ok(_permit) = sem.acquire_owned().await else {
                return;
            };
            if EPOCH.load(Ordering::Acquire) != epoch || crate::net::request_scope() != scope {
                return;
            }
            if crate::media::is_cached_segment(&url) {
                return;
            }
            let _ = crate::media::load_segment_raw(&url).await;
        });
    }
}

/// Index a media playlist's segments and immediately warm its key/map + first segments.
pub(crate) fn on_playlist(base_url: &str, text: &str) {
    let (mut warm, segments) = parse_media_playlist(base_url, text);
    if segments.is_empty() {
        return;
    }
    for seg in segments.iter().take(INITIAL_SEGMENTS) {
        if !warm.contains(seg) {
            warm.push(seg.clone());
        }
    }
    register_playlist(segments);
    let epoch = EPOCH.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    schedule_urls(warm, epoch);
}

/// When the player requests segment N, prefetch segments N+1..=N+2 concurrently.
pub(crate) fn on_segment_access(url: &str) {
    let next_urls = {
        let Ok(idx) = INDEX.lock() else {
            return;
        };
        let Some(&(playlist_id, pos)) = idx.by_segment.get(url) else {
            return;
        };
        let Some(entry) = idx.order.iter().find(|e| e.id == playlist_id) else {
            return;
        };
        entry
            .segments
            .get(pos + 1..)
            .map(|tail| tail.iter().take(LOOKAHEAD_SEGMENTS).cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    if next_urls.is_empty() {
        return;
    }
    let epoch = EPOCH.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
    schedule_urls(next_urls, epoch);
}

/// Discard tracked playlists and cancel queued background prefetches on cache clear.
pub(crate) fn clear() {
    EPOCH.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut idx) = INDEX.lock() {
        idx.order.clear();
        idx.by_segment.clear();
    }
}
