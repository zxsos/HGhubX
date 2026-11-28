//! Selective WebView & media cache maintenance with configurable limits.
//!
//! `clear_all_browsing_data` is intentionally not used: it also removes cookies,
//! local/session storage and other account state. Each platform purges only HTTP
//! or media disk/memory caches without touching login, favorites, history, or preferences.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const DEFAULT_LIMIT_MB: u64 = 128;
const MIN_FINITE_LIMIT_MB: u64 = 32;
const MAX_FINITE_LIMIT_MB: u64 = 65536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CacheBucketLimits {
    pub img_items: Option<usize>,
    pub img_bytes: Option<usize>,
    pub seg_items: Option<usize>,
    pub seg_bytes: Option<usize>,
    pub key_items: Option<usize>,
    pub key_bytes: Option<usize>,
    pub pl_items: Option<usize>,
    pub pl_bytes: Option<usize>,
}

static CACHE_LIMIT_MB: AtomicU64 = AtomicU64::new(DEFAULT_LIMIT_MB);
static CACHE_CONFIG_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheConfigFile {
    limit_mb: u64,
}

pub fn current_limit_mb() -> u64 {
    CACHE_LIMIT_MB.load(Ordering::Acquire)
}

fn normalize_limit_mb(limit_mb: u64) -> Option<u64> {
    if limit_mb == 0 || (MIN_FINITE_LIMIT_MB..=MAX_FINITE_LIMIT_MB).contains(&limit_mb) {
        Some(limit_mb)
    } else {
        None
    }
}

pub fn bucket_limits(limit_mb: u64) -> CacheBucketLimits {
    if limit_mb == 0 {
        return CacheBucketLimits {
            img_items: None,
            img_bytes: None,
            seg_items: None,
            seg_bytes: None,
            key_items: None,
            key_bytes: None,
            pl_items: None,
            pl_bytes: None,
        };
    }
    let total = usize::try_from(limit_mb)
        .unwrap_or(MAX_FINITE_LIMIT_MB as usize)
        .saturating_mul(1024 * 1024);
    let img_bytes = (total * 40 / 100).max(4 * 1024 * 1024);
    let seg_bytes = (total * 53 / 100).max(8 * 1024 * 1024);
    let key_bytes = (total * 35 / 1000).max((512 * 1024).max(total.min(4 * 1024 * 1024) / 2));
    let pl_bytes = total
        .saturating_sub(img_bytes.saturating_add(seg_bytes).saturating_add(key_bytes))
        .max(512 * 1024);
    CacheBucketLimits {
        img_items: Some((img_bytes / (200 * 1024)).max(120)),
        img_bytes: Some(img_bytes),
        seg_items: Some((seg_bytes / (1024 * 1024)).max(24)),
        seg_bytes: Some(seg_bytes),
        key_items: Some((key_bytes / 16384).max(120)),
        key_bytes: Some(key_bytes),
        pl_items: Some((pl_bytes / 16384).max(60)),
        pl_bytes: Some(pl_bytes),
    }
}

pub fn max_segment_item_bytes() -> usize {
    match current_limit_mb() {
        0 => 64 * 1024 * 1024,
        512.. => 16 * 1024 * 1024,
        256.. => 8 * 1024 * 1024,
        _ => 4 * 1024 * 1024,
    }
}

pub fn bind(data_dir: &Path) {
    let path = data_dir.join("cache.json");
    let loaded = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CacheConfigFile>(&bytes).ok())
        .and_then(|cfg| normalize_limit_mb(cfg.limit_mb))
        .unwrap_or(DEFAULT_LIMIT_MB);
    if let Ok(mut guard) = CACHE_CONFIG_PATH.lock() {
        *guard = Some(path);
    }
    CACHE_LIMIT_MB.store(loaded, Ordering::Release);
    crate::media::apply_cache_limits(&bucket_limits(loaded));
}

fn persist_limit_mb(limit_mb: u64) -> Result<(), String> {
    let path = CACHE_CONFIG_PATH
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    let Some(path) = path else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let bytes = serde_json::to_vec_pretty(&CacheConfigFile { limit_mb })
        .map_err(|e| format!("序列化缓存设置失败：{e}"))?;
    let tmp = path.with_extension("json.tmp");
    if let Err(err) = std::fs::write(&tmp, &bytes) {
        return Err(format!("写入缓存设置失败：{err}"));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("保存缓存设置失败：{e}")
    })
}

pub fn set_limit_mb(app: &tauri::AppHandle, limit_mb: u64) -> Result<CacheStatsReport, String> {
    let valid = normalize_limit_mb(limit_mb)
        .ok_or_else(|| "缓存上限须为 0（无上限）或 32–65536 MB".to_string())?;
    persist_limit_mb(valid)?;
    CACHE_LIMIT_MB.store(valid, Ordering::Release);
    crate::media::apply_cache_limits(&bucket_limits(valid));
    Ok(cache_stats(app))
}

/// Bounded or unlimited in-memory cache with automatic LRU eviction when capped.
pub struct LruCache<V> {
    entries: HashMap<String, (V, usize, u64)>,
    total_bytes: usize,
    max_items: Option<usize>,
    max_bytes: Option<usize>,
    clock: u64,
}

impl<V> LruCache<V> {
    pub fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            total_bytes: 0,
            max_items: Some(max_items),
            max_bytes: Some(max_bytes),
            clock: 0,
        }
    }

    fn tick(&mut self) -> u64 {
        self.clock = self.clock.wrapping_add(1);
        self.clock
    }

    pub fn set_limits(&mut self, max_items: Option<usize>, max_bytes: Option<usize>) {
        self.max_items = max_items;
        self.max_bytes = max_bytes;
        self.evict_excess(false, 0);
    }

    fn evict_excess(&mut self, reserve_slot: bool, incoming_bytes: usize) {
        let slot = usize::from(reserve_slot);
        while !self.entries.is_empty()
            && (self
                .max_items
                .is_some_and(|m| self.entries.len().saturating_add(slot) > m)
                || self
                    .max_bytes
                    .is_some_and(|m| self.total_bytes.saturating_add(incoming_bytes) > m))
        {
            let Some(victim) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, _, ts))| *ts)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((_, evicted_bytes, _)) = self.entries.remove(&victim) {
                self.total_bytes = self.total_bytes.saturating_sub(evicted_bytes);
            }
        }
    }

    pub fn get(&mut self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        let next = self.tick();
        let entry = self.entries.get_mut(key)?;
        entry.2 = next;
        Some(entry.0.clone())
    }

    pub fn insert(&mut self, key: String, value: V, bytes: usize) {
        if self.max_items == Some(0) || self.max_bytes.is_some_and(|m| bytes > m) {
            return;
        }
        if let Some((_, old_bytes, _)) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old_bytes);
        }
        self.evict_excess(true, bytes);
        let ts = self.tick();
        self.entries.insert(key, (value, bytes, ts));
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }

    #[cfg(test)]
    pub fn remove(&mut self, key: &str) {
        if let Some((_, bytes, _)) = self.entries.remove(key) {
            self.total_bytes = self.total_bytes.saturating_sub(bytes);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }

    pub fn stats(&self) -> (usize, usize, usize) {
        (
            self.entries.len(),
            self.total_bytes,
            self.max_bytes.unwrap_or(0),
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsReport {
    pub used_bytes: u64,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
    pub limit_bytes: u64,
    pub limit_mb: u64,
    pub unlimited: bool,
    pub image_count: usize,
    pub segment_count: usize,
    pub playlist_count: usize,
}

fn dir_bytes_recursive(dir: &Path, depth: usize) -> u64 {
    if depth > 8 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            total = total.saturating_add(meta.len());
        } else if meta.is_dir() {
            total = total.saturating_add(dir_bytes_recursive(&entry.path(), depth + 1));
        }
    }
    total
}

fn remove_dir_contents_best_effort(dir: &Path, skip_top_names: &[&str]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if skip_top_names
                .iter()
                .any(|skip| name.eq_ignore_ascii_case(skip) || name.to_ascii_lowercase().starts_with(skip))
            {
                continue;
            }
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            let _ = std::fs::remove_file(&path);
        } else if meta.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn disk_cache_bytes(app: &tauri::AppHandle) -> u64 {
    use tauri::Manager;
    let Ok(cache_dir) = app.path().app_cache_dir() else {
        return 0;
    };
    #[cfg(target_os = "windows")]
    {
        // On Windows, app_cache_dir() equals %LOCALAPPDATA%\<id>, which also contains
        // EBWebView/Default/Local Storage & Cookies. Measure only pure cache subdirectories.
        let targets = [
            cache_dir.join("updates"),
            cache_dir.join("EBWebView/Default/Cache/Cache_Data"),
            cache_dir.join("EBWebView/Default/Code Cache"),
            cache_dir.join("EBWebView/Default/GPUCache"),
        ];
        targets
            .into_iter()
            .map(|p| dir_bytes_recursive(&p, 0))
            .sum()
    }
    #[cfg(not(target_os = "windows"))]
    {
        dir_bytes_recursive(&cache_dir, 0)
    }
}

pub fn cache_stats(app: &tauri::AppHandle) -> CacheStatsReport {
    let (image_count, segment_count, playlist_count, mem_used, _mem_limit) =
        crate::media::cache_stats();
    let disk_used = disk_cache_bytes(app);
    let limit_mb = current_limit_mb();
    let unlimited = limit_mb == 0;
    let limit_bytes = if unlimited {
        0
    } else {
        limit_mb.saturating_mul(1024 * 1024)
    };
    CacheStatsReport {
        used_bytes: mem_used.saturating_add(disk_used),
        memory_bytes: mem_used,
        disk_bytes: disk_used,
        limit_bytes,
        limit_mb,
        unlimited,
        image_count,
        segment_count,
        playlist_count,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearReport {
    /// Whether a platform WebView HTTP/media cache was selectively cleared.
    pub web_cache: bool,
    pub platform: &'static str,
    pub freed_bytes: u64,
    pub remaining_bytes: u64,
}

pub async fn clear_all(webview: &tauri::Webview) -> Result<CacheClearReport, String> {
    use tauri::Manager;
    let app = webview.app_handle();
    let before = cache_stats(app).used_bytes;
    crate::media::clear_caches();
    if let Ok(cache_dir) = app.path().app_cache_dir() {
        crate::updater::cleanup_tv_updates(&cache_dir);
    }

    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    let web_cache = {
        linux::clear(webview).await?;
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            remove_dir_contents_best_effort(&cache_dir, &["webkit"]);
        }
        true
    };

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let web_cache = {
        apple::clear();
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            remove_dir_contents_best_effort(&cache_dir, &[]);
        }
        true
    };

    #[cfg(target_os = "windows")]
    let web_cache = {
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            // Only remove WebView2 disk/code/GPU cache folders; never touch Local Storage or Cookies.
            for sub in [
                "EBWebView/Default/Cache/Cache_Data",
                "EBWebView/Default/Code Cache",
                "EBWebView/Default/GPUCache",
            ] {
                remove_dir_contents_best_effort(&cache_dir.join(sub), &[]);
            }
        }
        true
    };

    #[cfg(target_os = "android")]
    let web_cache = {
        if let Ok(cache_dir) = app.path().app_cache_dir() {
            // Live Chromium WebView HTTP cache is cleared via MainActivity's WebView.clearCache(true).
            remove_dir_contents_best_effort(&cache_dir, &["webview"]);
        }
        false
    };

    #[cfg(not(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        target_os = "ios",
        target_os = "windows",
        target_os = "android"
    )))]
    let web_cache = false;

    let after = cache_stats(app).used_bytes;
    Ok(CacheClearReport {
        web_cache,
        platform: std::env::consts::OS,
        freed_bytes: before.saturating_sub(after),
        remaining_bytes: after,
    })
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};

    pub(super) fn clear() {
        if let Some(cls) = AnyClass::get(c"NSURLCache") {
            let shared: Option<Retained<AnyObject>> = unsafe { msg_send![cls, sharedURLCache] };
            if let Some(cache) = shared {
                let _: () = unsafe { msg_send![&*cache, removeAllCachedResponses] };
            }
        }
    }
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
mod linux {
    use std::time::Duration;
    use webkit2gtk::{WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};

    fn safe_cache_types() -> WebsiteDataTypes {
        // Deliberately excludes COOKIES, LOCAL_STORAGE, SESSION_STORAGE,
        // INDEXEDDB_DATABASES, SERVICE_WORKER_REGISTRATIONS and HSTS.
        WebsiteDataTypes::MEMORY_CACHE
            | WebsiteDataTypes::DISK_CACHE
            | WebsiteDataTypes::OFFLINE_APPLICATION_CACHE
    }

    pub(super) async fn clear(webview: &tauri::Webview) -> Result<(), String> {
        let (done, result) = tokio::sync::oneshot::channel();
        webview
            .with_webview(move |platform| {
                let Some(manager) = platform.inner().website_data_manager() else {
                    let _ = done.send(Err("WebKit 数据管理器不可用".to_string()));
                    return;
                };
                manager.clear(
                    safe_cache_types(),
                    webkit2gtk::glib::TimeSpan::from_seconds(0),
                    None::<&webkit2gtk::gio::Cancellable>,
                    move |outcome| {
                        let _ = done.send(outcome.map_err(|error| error.to_string()));
                    },
                );
            })
            .map_err(|error| format!("无法访问 WebView：{error}"))?;

        match tokio::time::timeout(Duration::from_secs(20), result).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(error))) => Err(format!("WebKit 缓存清理失败：{error}")),
            Ok(Err(_)) => Err("WebKit 缓存清理未返回结果".to_string()),
            Err(_) => Err("WebKit 缓存清理超时".to_string()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::safe_cache_types;
        use webkit2gtk::WebsiteDataTypes;

        #[test]
        fn selective_clear_never_includes_account_or_preference_storage() {
            let types = safe_cache_types();
            assert!(types.contains(WebsiteDataTypes::MEMORY_CACHE));
            assert!(types.contains(WebsiteDataTypes::DISK_CACHE));
            assert!(!types.intersects(
                WebsiteDataTypes::COOKIES
                    | WebsiteDataTypes::LOCAL_STORAGE
                    | WebsiteDataTypes::SESSION_STORAGE
                    | WebsiteDataTypes::INDEXEDDB_DATABASES
                    | WebsiteDataTypes::SERVICE_WORKER_REGISTRATIONS
                    | WebsiteDataTypes::HSTS_CACHE
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CacheClearReport;

    #[test]
    fn report_matches_frontend_camel_case_contract() {
        let value = serde_json::to_value(CacheClearReport {
            web_cache: true,
            platform: "linux",
            freed_bytes: 2048,
            remaining_bytes: 0,
        })
        .unwrap();
        assert_eq!(value["webCache"], true);
        assert_eq!(value["platform"], "linux");
        assert_eq!(value["freedBytes"], 2048);
        assert_eq!(value["remainingBytes"], 0);
    }
}
