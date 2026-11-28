//! Optional, bounded playback diagnostics. Never write media URLs, credentials or response bodies.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::Manager;

const MAX_FILE: u64 = 2 * 1024 * 1024;
// 导出上限：安卓 ClipboardManager.setPrimaryClip 走 Binder，单次事务约 1 MiB，
// 两份 2 MiB 日志拼起来可达 4 MiB+，整份复制会 TransactionTooLargeException（issue #142）。
// 这里把剪贴板导出裁到安全尺寸，保留环境头 + 最近的事件，并插一行 truncation 说明（仍是 JSONL）。
const MAX_EXPORT: usize = 256 * 1024;
const MAX_CLIPBOARD_DEBUG: usize = 64 * 1024;
// 文件分享/导出通道不走剪贴板 Binder，保留完整 playback.previous.log + playback.log，
// 并对未轮转的 debug.log 放宽到 4 MiB 尾部保护，既给足全量上下文又防止异常超大文件撑爆内存。
const MAX_FULL_DEBUG: usize = 4 * 1024 * 1024;
static ENABLED: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU64 = AtomicU64::new(0);
static LOG: Lazy<Mutex<Journal>> = Lazy::new(|| Mutex::new(Journal::default()));

#[derive(Default)]
struct Journal {
    dir: Option<PathBuf>,
    enabled: bool,
    error: Option<String>,
    last_export: Option<PathBuf>,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    path: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullExport {
    filename: String,
    path: Option<String>,
    content: String,
    bytes: usize,
    line_count: usize,
    truncated: bool,
    native_opened: bool,
    native_outcome: Option<String>,
    native_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeExportResult {
    opened: bool,
    outcome: String,
    detail: Option<String>,
}

#[derive(Deserialize)]
pub struct Entry {
    event: String,
    data: Value,
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn resource_id(raw: &str) -> String {
    let hash = raw
        .as_bytes()
        .iter()
        .fold(2166136261u32, |h, b| (h ^ *b as u32).wrapping_mul(16777619));
    format!("r{hash:08x}")
}

pub fn error_kind(error: &str) -> &'static str {
    if error.contains("禁止") || error.contains("只允许") || error.contains("控制字符") {
        if error.contains("降级") {
            "https_downgrade_denied"
        } else if error.contains("内网") || error.contains("保留地址") {
            "private_address_denied"
        } else {
            "target_policy_denied"
        }
    } else if error.contains("DNS") {
        "dns_error"
    } else if error.contains("超时")
        || error.to_ascii_lowercase().contains("timeout")
        || error.to_ascii_lowercase().contains("timed out")
    {
        "timeout"
    } else if error.starts_with("HTTP ") {
        "http_error"
    } else if error.contains("重定向") {
        "redirect_error"
    } else {
        "transport_error"
    }
}

// Defense in depth for frontend entries: no arbitrary URL/message/header fields reach disk.
fn scrub(value: &Value, depth: usize) -> Value {
    if depth > 5 {
        return Value::Null;
    }
    match value {
        Value::String(s) => {
            if s.contains("://") || s.to_ascii_lowercase().contains("%3a") {
                json!("[redacted]")
            } else {
                json!(s.chars().take(160).collect::<String>())
            }
        }
        Value::Array(items) => {
            Value::Array(items.iter().take(24).map(|v| scrub(v, depth + 1)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .take(64)
                .filter_map(|(key, v)| {
                    let k = key.to_ascii_lowercase();
                    if [
                        "url",
                        "src",
                        "token",
                        "password",
                        "cookie",
                        "authorization",
                        "body",
                        "message",
                        "reason",
                    ]
                    .iter()
                    .any(|s| k.contains(s))
                    {
                        None
                    } else {
                        Some((key.chars().take(64).collect(), scrub(v, depth + 1)))
                    }
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

impl Journal {
    fn status(&self) -> Status {
        Status {
            enabled: self.enabled,
            path: self
                .dir
                .as_ref()
                .map(|d| d.join("playback.log").display().to_string()),
            error: self.error.clone(),
        }
    }

    fn append(&mut self, event: &str, data: Value, limit: u64) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("日志目录尚未初始化")?;
        let path = dir.join("playback.log");
        let ts = crate::logging::utc_timestamp()?;
        let line = json!({ "ts": ts, "pid": std::process::id(), "seq": SEQ.fetch_add(1, Ordering::Relaxed), "event": event, "strict": crate::network_policy::strict_security(), "data": scrub(&data, 0) }).to_string() + "\n";
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > limit {
            let previous = dir.join("playback.previous.log");
            if previous.exists() {
                fs::remove_file(&previous).map_err(|_| "无法轮转诊断日志")?;
            }
            if path.exists() {
                fs::rename(&path, previous).map_err(|_| "无法轮转诊断日志")?;
            }
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(line.as_bytes()))
            .map_err(|_| "无法写入诊断日志".to_string())
    }

    fn set(&mut self, on: bool) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("日志目录尚未初始化")?;
        if on {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("playback.log"))
                .map_err(|_| "无法创建诊断日志")?;
        }
        let temp = dir.join("playback-diagnostics.json.tmp");
        fs::write(&temp, json!({"enabled": on}).to_string())
            .and_then(|_| fs::rename(&temp, dir.join("playback-diagnostics.json")))
            .map_err(|_| "无法保存日志开关")?;
        self.enabled = on;
        self.error = None;
        if let Err(e) = self.append("diagnostics.toggle", json!({"enabled": on, "version": app_version(), "os": std::env::consts::OS}), MAX_FILE) { self.error = Some(e); }
        Ok(())
    }
}

fn app_version() -> &'static str {
    option_env!("HGHUBX_APP_VERSION")
        .filter(|v| !v.is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

pub fn bind(dir: &Path) {
    if let Ok(mut log) = LOG.lock() {
        log.dir = Some(dir.to_path_buf());
        log.enabled = fs::read_to_string(dir.join("playback-diagnostics.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["enabled"].as_bool())
            .unwrap_or(false);
        ENABLED.store(log.enabled, Ordering::Relaxed);
        if log.enabled {
            if let Err(e) = log.append(
                "process.start",
                json!({"version": app_version(), "os": std::env::consts::OS}),
                MAX_FILE,
            ) {
                log.error = Some(e);
            }
        }
    }
}

pub fn record(event: &str, data: Value) {
    if !enabled() {
        return;
    }
    if let Ok(mut log) = LOG.lock() {
        if log.enabled {
            if let Err(e) = log.append(event, data, MAX_FILE) {
                log.error = Some(e);
            }
        }
    }
}

#[tauri::command]
pub fn playback_log_status() -> Result<Status, String> {
    Ok(LOG.lock().map_err(|_| "日志锁失败")?.status())
}

#[tauri::command]
pub fn playback_log_set(enabled: bool) -> Result<Status, String> {
    let mut log = LOG.lock().map_err(|_| "日志锁失败")?;
    let result = log.set(enabled);
    ENABLED.store(log.enabled, Ordering::Relaxed);
    result?;
    Ok(log.status())
}

#[tauri::command]
pub fn playback_log_write(entries: Vec<Entry>) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    if entries.len() > 128 {
        return Err("日志批次过大".into());
    }
    let mut log = LOG.lock().map_err(|_| "日志锁失败")?;
    if !log.enabled {
        return Ok(());
    }
    for entry in entries {
        if entry.event.len() > 80
            || !entry
                .event
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || entry.data.to_string().len() > 8192
        {
            return Err("日志条目无效".into());
        }
        log.append(&format!("web.{}", entry.event), entry.data, MAX_FILE)?;
    }
    Ok(())
}

#[tauri::command]
pub fn playback_log_read() -> Result<String, String> {
    let log = LOG.lock().map_err(|_| "日志锁失败")?;
    let dir = log.dir.as_ref().ok_or("日志目录尚未初始化")?;
    export(dir)
}

#[tauri::command]
pub async fn playback_log_export_full(
    app: tauri::AppHandle,
    reveal: Option<bool>,
    title: Option<String>,
) -> Result<FullExport, String> {
    let dir = {
        let log = LOG.lock().map_err(|_| "日志锁失败")?;
        log.dir.clone().ok_or("日志目录尚未初始化")?
    };
    let (content, line_count, truncated) = export_full(&dir)?;
    let bytes = content.len();
    let filename = export_filename();
    let saved = write_export_file(&app, &dir, &filename, &content);
    if let Some(ref saved_path) = saved {
        if let Ok(mut log) = LOG.lock() {
            log.last_export = Some(saved_path.clone());
        }
    }
    let (native_opened, native_outcome, native_error) = if reveal.unwrap_or(false) {
        match saved.as_deref() {
            Some(p) => {
                let res = reveal_or_open_export(
                    &app,
                    p,
                    &filename,
                    title.as_deref().unwrap_or("HGhubX Full Diagnostic Log"),
                )
                .await;
                let err = if !res.opened && res.outcome == "failed" {
                    res.detail.clone()
                } else {
                    None
                };
                (res.opened, Some(res.outcome), err)
            }
            None => (false, Some("failed".into()), Some("无法写入临时导出文件".into())),
        }
    } else {
        (false, None, None)
    };
    Ok(FullExport {
        filename,
        path: saved.map(|p| p.to_string_lossy().into_owned()),
        content,
        bytes,
        line_count,
        truncated,
        native_opened,
        native_outcome,
        native_error,
    })
}

#[tauri::command]
pub async fn playback_log_reveal_export(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<NativeExportResult, String> {
    let path = {
        let log = LOG.lock().map_err(|_| "日志锁失败")?;
        log.last_export.clone()
    };
    let Some(path) = path else {
        return Ok(NativeExportResult {
            opened: false,
            outcome: "failed".into(),
            detail: Some("没有可分享的导出文件".into()),
        });
    };
    if !path.is_file() {
        return Ok(NativeExportResult {
            opened: false,
            outcome: "failed".into(),
            detail: Some("导出文件不存在".into()),
        });
    }
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("hghubx-logs.jsonl.txt")
        .to_string();
    Ok(reveal_or_open_export(
        &app,
        &path,
        &filename,
        title.as_deref().unwrap_or("HGhubX Full Diagnostic Log"),
    )
    .await)
}

#[cfg(target_env = "ohos")]
mod ohos_share {
    use napi_derive_ohos::napi;
    use openharmony_ability::{
        impl_bridge_napi_type, AsyncBridge, BridgeCallOptions, BridgeContextRequirement,
        BridgePlugin,
    };

    pub struct ShareBridgePlugin;

    impl BridgePlugin for ShareBridgePlugin {
        type Mode = AsyncBridge;

        const ID: &'static str = "hghubx.share";
        const REQUIRED_CONTEXTS: &'static [BridgeContextRequirement] =
            &[BridgeContextRequirement::Ability];
    }

    #[napi(object)]
    #[derive(Clone, Debug)]
    pub struct ShareFileRequest {
        pub path: String,
        pub filename: String,
        pub title: String,
    }

    impl_bridge_napi_type!(ShareFileRequest, "hghubx.share.FileRequest");

    #[napi(object)]
    #[derive(Clone, Debug)]
    pub struct ShareFileResponse {
        pub outcome: String,
        pub detail: String,
    }

    impl_bridge_napi_type!(ShareFileResponse, "hghubx.share.FileResponse");

    pub async fn share_file(
        path: String,
        filename: String,
        title: String,
    ) -> Result<ShareFileResponse, String> {
        let ohos_app = tauri::ohos::APP
            .lock()
            .map_err(|_| "ohos app lock failed".to_string())?
            .clone()
            .ok_or_else(|| "ohos app not initialized".to_string())?;
        let bridge = ohos_app.bridge().map_err(|e| e.to_string())?;
        bridge
            .call_async::<ShareBridgePlugin, ShareFileRequest, ShareFileResponse>(
                "share-file",
                ShareFileRequest {
                    path,
                    filename,
                    title,
                },
                BridgeCallOptions::default(),
            )
            .await
            .map_err(|e| e.to_string())
    }
}

fn export_filename() -> String {
    let stamp = crate::logging::utc_timestamp().unwrap_or_default();
    let digits: String = stamp.bytes().filter(u8::is_ascii_digit).map(char::from).collect();
    if digits.len() >= 14 {
        format!("hghubx-logs-{}-{}.jsonl.txt", &digits[..8], &digits[8..14])
    } else {
        "hghubx-logs.jsonl.txt".into()
    }
}

fn write_export_file(
    app: &tauri::AppHandle,
    dir: &Path,
    filename: &str,
    content: &str,
) -> Option<PathBuf> {
    #[cfg(all(desktop, not(target_env = "ohos")))]
    let (export_dir, prune_old) = match app.path().download_dir() {
        Ok(d) => (d, false),
        Err(_) => (dir.join("exports"), true),
    };
    #[cfg(not(all(desktop, not(target_env = "ohos"))))]
    let (export_dir, prune_old) = match app.path().app_cache_dir() {
        Ok(c) => (c.join("exports"), true),
        Err(_) => (dir.join("exports"), true),
    };
    if fs::create_dir_all(&export_dir).is_err() {
        return None;
    }
    let dest = export_dir.join(filename);
    if fs::write(&dest, content.as_bytes()).is_err() {
        return None;
    }
    if prune_old {
        prune_old_exports(&export_dir, &dest, 3);
    }
    Some(dest)
}

fn prune_old_exports(dir: &Path, keep: &Path, max_files: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_file()
                && name.starts_with("hghubx-logs-")
                && name.ends_with(".jsonl.txt")
            {
                Some((name, path))
            } else {
                None
            }
        })
        .collect();
    if files.len() <= max_files {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(max_files) {
        if path != keep {
            let _ = fs::remove_file(path);
        }
    }
}

async fn reveal_or_open_export(
    app: &tauri::AppHandle,
    path: &Path,
    filename: &str,
    title: &str,
) -> NativeExportResult {
    #[cfg(all(desktop, not(target_env = "ohos")))]
    {
        let _ = (filename, title);
        use tauri_plugin_opener::OpenerExt;
        match app.opener().reveal_item_in_dir(path) {
            Ok(()) => NativeExportResult {
                opened: true,
                outcome: "reveal".into(),
                detail: None,
            },
            Err(e) => NativeExportResult {
                opened: false,
                outcome: "failed".into(),
                detail: Some(crate::net::redact_error_proxy_auth(&e.to_string())),
            },
        }
    }
    #[cfg(target_env = "ohos")]
    {
        let _ = app;
        let path_str = path.to_string_lossy().into_owned();
        match ohos_share::share_file(path_str, filename.to_string(), title.to_string()).await {
            Ok(resp) => {
                let opened = resp.outcome == "shared" || resp.outcome == "saved";
                let detail = if resp.detail.is_empty() {
                    None
                } else {
                    Some(resp.detail)
                };
                NativeExportResult {
                    opened,
                    outcome: resp.outcome,
                    detail,
                }
            }
            Err(e) => NativeExportResult {
                opened: false,
                outcome: "failed".into(),
                detail: Some(crate::net::redact_error_proxy_auth(&e)),
            },
        }
    }
    #[cfg(target_os = "ios")]
    {
        let _ = (filename, title);
        match crate::ios_layout::present_share_sheet(app, path) {
            Ok(()) => NativeExportResult {
                opened: true,
                outcome: "shared".into(),
                detail: None,
            },
            Err(e) => NativeExportResult {
                opened: false,
                outcome: "failed".into(),
                detail: Some(crate::net::redact_error_proxy_auth(&e)),
            },
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, path, filename, title);
        NativeExportResult {
            opened: false,
            outcome: "unsupported".into(),
            detail: None,
        }
    }
}

fn read_playback_lines(dir: &Path) -> Result<Vec<String>, String> {
    let mut body: Vec<String> = Vec::new();
    for name in ["playback.previous.log", "playback.log"] {
        let path = dir.join(name);
        if path.exists() {
            if fs::metadata(&path).map_err(|_| "无法读取日志")?.len() > MAX_FILE + 16384 {
                return Err("日志文件超出大小限制".into());
            }
            let raw = fs::read_to_string(path).map_err(|_| "无法读取日志")?;
            for line in raw.lines() {
                if !line.is_empty() {
                    body.push(line.to_string());
                }
            }
        }
    }
    Ok(body)
}

fn current_line_host() -> String {
    let base = crate::net::base();
    let host = base.split("://").nth(1).unwrap_or(&base);
    host.split('/').next().unwrap_or(host).to_string()
}

// 纯函数：从目录组装并裁剪导出。不依赖全局 LOG，便于并行单测直接验证尺寸上限。
fn export(dir: &Path) -> Result<String, String> {
    let host = current_line_host();
    let header = env_line(&host)?;
    let mut body = read_playback_lines(dir)?;
    body.extend(debug_lines(dir)?);

    let mut text = header;
    let total: usize = body.iter().map(|l| l.len() + 1).sum();
    if total > MAX_EXPORT {
        let note = json!({
            "event": "log.truncated",
            "data": { "total_bytes": total, "kept_bytes": MAX_EXPORT }
        })
        .to_string();
        let mut used = note.len() + 1;
        let mut start = body.len();
        while start > 0 && used + body[start - 1].len() + 1 <= MAX_EXPORT {
            used += body[start - 1].len() + 1;
            start -= 1;
        }
        text.push_str(&note);
        text.push('\n');
        for line in &body[start..] {
            text.push_str(line);
            text.push('\n');
        }
    } else {
        for line in &body {
            text.push_str(line);
            text.push('\n');
        }
    }
    Ok(text)
}

/// 纯函数：组装全量脱敏 JSONL（不受 256 KiB 剪贴板裁剪上限限制），供直接分享/文件导出使用。
fn export_full(dir: &Path) -> Result<(String, usize, bool), String> {
    let host = current_line_host();
    let header = env_line(&host)?;
    let mut body = read_playback_lines(dir)?;
    let (debug, debug_trunc) = debug_lines_bounded(dir, MAX_FULL_DEBUG, 4000)?;
    let truncated = debug_trunc.is_some();
    if let Some((total_bytes, kept_bytes)) = debug_trunc {
        body.push(
            json!({
                "event": "log.truncated",
                "data": { "source": "debug.log", "total_bytes": total_bytes, "kept_bytes": kept_bytes }
            })
            .to_string(),
        );
    }
    body.extend(debug);

    let line_count = 1 + body.len();
    let cap = header.len() + body.iter().map(|l| l.len() + 1).sum::<usize>();
    let mut text = String::with_capacity(cap);
    text.push_str(&header);
    for line in &body {
        text.push_str(line);
        text.push('\n');
    }
    Ok((text, line_count, truncated))
}

/// 始终在写的 debug.log 尾部，也转成同构记录（`debug.line`）。
/// 好处：忘了先开诊断，复制出来也不是空的；而且整份导出依旧是一个 JSON 对象一行，
/// 能直接 grep / jq，不会出现纯文本块。
fn debug_lines(dir: &Path) -> Result<Vec<String>, String> {
    let (lines, _) = debug_lines_bounded(dir, MAX_CLIPBOARD_DEBUG, 2000)?;
    Ok(lines)
}

fn debug_lines_bounded(
    dir: &Path,
    max_bytes: usize,
    max_line_chars: usize,
) -> Result<(Vec<String>, Option<(usize, usize)>), String> {
    let path = dir.join("debug.log");
    if !path.exists() {
        return Ok((Vec::new(), None));
    }
    let bytes = fs::read(&path).map_err(|_| "无法读取日志")?;
    let mut start = bytes.len().saturating_sub(max_bytes);
    let truncated = if start > 0 {
        if let Some(nl) = bytes[start..].iter().position(|&b| b == b'\n') {
            start += nl + 1;
        }
        Some((bytes.len(), bytes.len().saturating_sub(start)))
    } else {
        None
    };
    let tail = String::from_utf8_lossy(&bytes[start..]);
    let pid = std::process::id();
    let stamp = crate::logging::utc_timestamp()?;
    let strict = crate::network_policy::strict_security();
    let mut out = Vec::new();
    for line in tail.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        // 削掉 append_debug 加的前缀 "[ts] [pid=N] "，把时间单独放字段里
        let (source_ts, rest) = match line.strip_prefix('[').and_then(|r| r.split_once("] ")) {
            Some((ts, rest)) => (Some(ts), rest),
            None => (None, line),
        };
        let rest = rest.strip_prefix(&format!("[pid={pid}] ")).unwrap_or(rest);
        let safe_text = crate::net::redact_error_proxy_auth(rest);
        out.push(
            json!({
                "ts": stamp,
                "pid": pid,
                "seq": SEQ.load(Ordering::Relaxed),
                "event": "debug.line",
                "strict": strict,
                "data": { "source_ts": source_ts, "text": safe_text.chars().take(max_line_chars).collect::<String>() },
            })
            .to_string(),
        );
    }
    Ok((out, truncated))
}

/// 与落盘行完全同构的环境记录：版本 / 平台 / 线路 host / 严格模式。
/// 线路只留 host，不带路径与查询串（签名参数一个都不落盘）。
fn env_line(host: &str) -> Result<String, String> {
    let entry = json!({
        "ts": crate::logging::utc_timestamp()?,
        "pid": std::process::id(),
        "seq": SEQ.load(Ordering::Relaxed),
        "event": "diagnostics.env",
        "strict": crate::network_policy::strict_security(),
        "data": {
            "version": app_version(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "line": host,
        },
    });
    Ok(entry.to_string() + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_timeout_and_policy_errors_keep_their_categories() {
        assert_eq!(error_kind("client error (Connect) ← operation timed out"), "timeout");
        assert_eq!(error_kind("request timeout"), "timeout");
        assert_eq!(error_kind("DNS 解析超时"), "dns_error");
        assert_eq!(error_kind("禁止访问普通内网"), "private_address_denied");
        assert_eq!(error_kind("HTTP 403 Forbidden"), "http_error");
    }

    #[test]
    fn commands_stop_writes_when_disabled_and_read_retained_logs() {
        let dir = std::env::temp_dir().join(format!(
            "hghubx-playback-commands-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        bind(&dir);
        assert!(!playback_log_status().unwrap().enabled);
        record("test.off", json!({"n": 1}));
        assert!(!dir.join("playback.log").exists());
        playback_log_set(true).unwrap();
        playback_log_write(vec![Entry {
            event: "seek.request".into(),
            data: json!({"player": "p1", "seek": 1, "target": 30}),
        }])
        .unwrap();
        playback_log_set(false).unwrap();
        let size = fs::metadata(dir.join("playback.log")).unwrap().len();
        playback_log_write(vec![Entry {
            event: "seek.request".into(),
            data: json!({"seek": 2}),
        }])
        .unwrap();
        record("test.off", json!({"n": 2}));
        assert_eq!(fs::metadata(dir.join("playback.log")).unwrap().len(), size);
        let text = playback_log_read().unwrap();
        assert!(text.contains("web.seek.request"));
        assert!(!text.contains("test.off"));
        // 导出的就是 JSONL 本体：环境记录 + 每行事件，一行一个对象，不掺纯文本。
        assert!(text.contains("\"diagnostics.env\""));
        for line in text.lines() {
            assert!(line.starts_with('{') && line.ends_with('}'), "不是 JSONL 行: {line}");
            serde_json::from_str::<Value>(line).expect("导出行必须可解析");
        }
        bind(&dir);
        assert!(!enabled());
        let mut log = LOG.lock().unwrap();
        *log = Journal::default();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_redacts_urls_credentials_and_limits_depth() {
        let value = scrub(&json!({"resource": "r123", "url": "https://a/?token=secret", "token": "secret", "nested": {"message": "secret", "detail": "hg://localhost/seg?u=secret"}}), 0).to_string();
        assert!(!value.contains("secret"));
        assert!(value.contains("r123"));
        assert_eq!(resource_id("hello"), "r4f9f2cab");
    }

    #[test]
    fn logging_rotates_and_persists_without_changing_mode_on_save_failure() {
        let dir = std::env::temp_dir().join(format!(
            "hghubx-playback-log-{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut log = Journal {
            dir: Some(dir.clone()),
            ..Default::default()
        };
        log.set(true).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &fs::read_to_string(dir.join("playback-diagnostics.json")).unwrap()
            )
            .unwrap()["enabled"],
            true
        );
        for _ in 0..5 {
            log.append("test", json!({"count": 1}), 400).unwrap();
        }
        assert!(dir.join("playback.previous.log").exists());
        for name in ["playback.log", "playback.previous.log"] {
            let text = fs::read_to_string(dir.join(name)).unwrap();
            assert!(text.len() <= 400);
            for line in text.lines() {
                assert!(serde_json::from_str::<Value>(line).unwrap()["ts"]
                    .as_str()
                    .unwrap()
                    .ends_with('Z'));
            }
        }
        log.dir = Some(dir.join("missing"));
        assert!(log.set(false).is_err());
        assert!(log.enabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_export_is_bounded_for_clipboard() {
        let dir = std::env::temp_dir().join(format!(
            "hghubx-playback-log-{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        // 两份接近上限的日志，拼起来远超安卓 Binder 单次事务的安全尺寸（issue #142）。
        let line = json!({
            "ts": "2026-11-17T00:00:00Z", "pid": 1, "seq": 1,
            "event": "web.seek.request", "data": { "blob": "x".repeat(2000) }
        })
        .to_string();
        let mut big = String::new();
        for _ in 0..900 {
            big.push_str(&line);
            big.push('\n');
        }
        assert!(big.len() as u64 <= MAX_FILE + 16384);
        fs::write(dir.join("playback.previous.log"), &big).unwrap();
        fs::write(dir.join("playback.log"), &big).unwrap();
        let text = export(&dir).unwrap();
        assert!(text.len() <= MAX_EXPORT + 4096, "导出超出剪贴板安全尺寸: {}", text.len());
        assert!(text.contains("\"diagnostics.env\""), "环境头必须保留");
        assert!(text.contains("\"log.truncated\""), "超限必须插裁剪说明");
        for line in text.lines() {
            assert!(line.starts_with('{') && line.ends_with('}'), "不是 JSONL 行: {line}");
            serde_json::from_str::<Value>(line).expect("导出行必须可解析");
        }
        // 小日志不裁剪，原样导出。
        fs::write(dir.join("playback.previous.log"), "").unwrap();
        fs::write(dir.join("playback.log"), format!("{line}\n")).unwrap();
        let small = export(&dir).unwrap();
        assert!(!small.contains("\"log.truncated\""));
        assert!(small.contains("web.seek.request"));
        fs::remove_dir_all(dir).unwrap();
    }
}
