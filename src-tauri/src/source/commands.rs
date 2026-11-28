//! Tauri commands and active-source dispatch helpers.

use super::manifest::{
    decode_package_input, encode_share_code, validate_package, MAX_PACKAGE_JSON_BYTES,
};
use super::runtime::{host_http_request, invoke_source};
use super::store::{InstalledSourceSummary, SourceStateSnapshot};
use super::subscription::{
    build_maccms_package, parse_subscription, probe_maccms_channels, probe_maccms_site,
    SubscriptionPreview, SubscriptionProbeResult, SubscriptionSiteInput, MAX_SUBSCRIPTION_ITEMS,
};
use super::verify::verify_package;
use super::store_arc;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

static PENDING_DEEP_LINK: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub(crate) fn set_pending_deep_link(url: String) {
    if let Ok(mut guard) = PENDING_DEEP_LINK.lock() {
        *guard = Some(url);
    }
}

#[tauri::command]
pub fn source_take_deep_link() -> Option<String> {
    PENDING_DEEP_LINK
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUpdateOutcome {
    pub updated: bool,
    pub from_version: String,
    pub to_version: String,
    pub summary: InstalledSourceSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTestOutcome {
    pub ok: bool,
    pub ms: u64,
    pub method: String,
    pub item_count: usize,
    pub sample_title: Option<String>,
    pub error: Option<String>,
}

fn parse_deep_link_target(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw).ok()?;
    if !parsed.scheme().eq_ignore_ascii_case("hghubx") {
        return None;
    }
    let host = parsed.host_str().unwrap_or("");
    let path = parsed.path().trim_matches('/');
    if !host.eq_ignore_ascii_case("import") && !path.eq_ignore_ascii_case("import") {
        return None;
    }
    for (k, v) in parsed.query_pairs() {
        if matches!(k.as_ref(), "url" | "src" | "code") && !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn expand_import_urls(trimmed: &str) -> Option<Vec<String>> {
    if let Some(inner) = parse_deep_link_target(trimmed) {
        return expand_import_urls(&inner);
    }
    if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        return Some(vec![trimmed.to_string()]);
    }
    // Bare host/path shorthand (e.g. `example.com/source.json`)
    if !trimmed.starts_with('{')
        && !trimmed.starts_with("hghubx-src://")
        && !trimmed.chars().any(char::is_whitespace)
    {
        if let Some((host, path)) = trimmed.split_once('/') {
            if host.contains('.') && !host.contains(':') && !path.is_empty() {
                return Some(vec![format!("https://{trimmed}")]);
            }
        }
    }
    None
}

async fn resolve_raw_input(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if let Some(inner) = parse_deep_link_target(trimmed) {
        if !inner.starts_with("http://")
            && !inner.starts_with("https://")
            && expand_import_urls(&inner).is_none()
        {
            return Ok(inner);
        }
    }
    if let Some(urls) = expand_import_urls(trimmed) {
        let mut last_err = String::from("拉取远程视频源失败");
        for url in urls {
            match host_http_request(
                "GET",
                &url,
                &HashMap::new(),
                None,
                None,
                MAX_PACKAGE_JSON_BYTES,
                15,
            )
            .await
            {
                Ok(resp) => {
                    let status = resp.get("status").and_then(Value::as_u64).unwrap_or(0);
                    if (200..300).contains(&status) {
                        return Ok(resp
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string());
                    }
                    last_err = format!("拉取远程视频源失败（HTTP {status}）");
                }
                Err(e) => last_err = e,
            }
        }
        return Err(last_err);
    }
    Ok(trimmed.to_string())
}

pub(crate) async fn import_source_raw(
    input: &str,
    activate: bool,
) -> Result<InstalledSourceSummary, String> {
    let raw = resolve_raw_input(input).await?;
    if parse_subscription(&raw, &HashSet::new())?.is_some() {
        return Err("这是订阅清单，暂不支持在此直接导入；请在手机/电脑端「视频源管理」中导入订阅后，再推送或同步到电视".into());
    }
    let pkg = decode_package_input(&raw)?;
    validate_package(&pkg)?;
    let store = store_arc();
    let sig_info = verify_package(&pkg, store.allow_untrusted())?;
    // Smoke-test loading & optional init() inside QuickJS before installing!
    invoke_source(store.clone(), pkg.clone(), "init", json!({}), Some(6)).await?;
    let summary = store.install(pkg, sig_info, activate)?;
    if activate {
        let _ = store.activate(Some(summary.id.clone()));
        sync_active_source_side_effects();
        return Ok(InstalledSourceSummary { active: true, ..summary });
    }
    sync_active_source_side_effects();
    Ok(summary)
}

#[tauri::command]
pub async fn source_state() -> Result<SourceStateSnapshot, String> {
    Ok(store_arc().snapshot())
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceResolveResult {
    Imported { summary: InstalledSourceSummary },
    Subscription { preview: SubscriptionPreview },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionImportFailure {
    pub name: String,
    pub api: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionImportOutcome {
    pub imported: Vec<InstalledSourceSummary>,
    pub failed: Vec<SubscriptionImportFailure>,
    pub active_source_id: Option<String>,
}

#[tauri::command]
pub async fn source_import(input: String, activate: Option<bool>) -> Result<InstalledSourceSummary, String> {
    import_source_raw(&input, activate.unwrap_or(false)).await
}

#[tauri::command]
pub async fn source_resolve_import(
    input: String,
    activate: Option<bool>,
) -> Result<SourceResolveResult, String> {
    let raw = resolve_raw_input(&input).await?;
    let installed_ids: HashSet<String> = store_arc()
        .snapshot()
        .sources
        .into_iter()
        .map(|s| s.id)
        .collect();
    if let Some(preview) = parse_subscription(&raw, &installed_ids)? {
        return Ok(SourceResolveResult::Subscription { preview });
    }
    let pkg = decode_package_input(&raw)?;
    validate_package(&pkg)?;
    let store = store_arc();
    let sig_info = verify_package(&pkg, store.allow_untrusted())?;
    invoke_source(store.clone(), pkg.clone(), "init", json!({}), Some(6)).await?;
    let should_activate = activate.unwrap_or(false);
    let summary = store.install(pkg, sig_info, should_activate)?;
    if should_activate {
        let _ = store.activate(Some(summary.id.clone()));
        sync_active_source_side_effects();
        return Ok(SourceResolveResult::Imported {
            summary: InstalledSourceSummary { active: true, ..summary },
        });
    }
    sync_active_source_side_effects();
    Ok(SourceResolveResult::Imported { summary })
}

#[tauri::command]
pub async fn source_probe_subscription(
    items: Vec<SubscriptionSiteInput>,
) -> Result<Vec<SubscriptionProbeResult>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    if items.len() > MAX_SUBSCRIPTION_ITEMS {
        return Err(format!("单次最多检测 {MAX_SUBSCRIPTION_ITEMS} 个站点"));
    }
    let sem = Arc::new(Semaphore::new(6));
    let mut join_set = JoinSet::new();
    for (idx, site) in items.into_iter().enumerate() {
        let permit_sem = Arc::clone(&sem);
        let id = site.id.unwrap_or_else(|| site.api.clone());
        let api = site.api;
        join_set.spawn(async move {
            let _permit = permit_sem.acquire_owned().await.ok();
            (idx, probe_maccms_site(id, &api).await)
        });
    }
    let mut out = Vec::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(entry) = res {
            out.push(entry);
        }
    }
    out.sort_by_key(|(idx, _)| *idx);
    Ok(out.into_iter().map(|(_, r)| r).collect())
}

#[tauri::command]
pub async fn source_import_subscription(
    items: Vec<SubscriptionSiteInput>,
    activate_first: Option<bool>,
) -> Result<SubscriptionImportOutcome, String> {
    if items.is_empty() {
        return Err("请至少选择一个站点".into());
    }
    if items.len() > MAX_SUBSCRIPTION_ITEMS {
        return Err(format!("单次最多导入 {MAX_SUBSCRIPTION_ITEMS} 个站点"));
    }

    // Probe each selected site's MacCMS categories concurrently (bounded) so category shelves
    // appear immediately; timeouts fall back cleanly to `catalog: None`.
    let sem = Arc::new(Semaphore::new(4));
    let mut join_set = JoinSet::new();
    for (idx, site) in items.into_iter().enumerate() {
        let permit_sem = Arc::clone(&sem);
        join_set.spawn(async move {
            let _permit = permit_sem.acquire_owned().await.ok();
            let catalog = match crate::network_policy::parse_target(site.api.trim()) {
                Ok(parsed) if parsed.scheme() == "https" => {
                    let origin = parsed.origin().ascii_serialization();
                    probe_maccms_channels(site.api.trim(), &origin).await
                }
                _ => None,
            };
            (idx, site, catalog)
        });
    }

    let mut probed = Vec::new();
    while let Some(res) = join_set.join_next().await {
        if let Ok(entry) = res {
            probed.push(entry);
        }
    }
    probed.sort_by_key(|(idx, _, _)| *idx);

    let store = store_arc();
    let allow_untrusted = store.allow_untrusted();
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    let should_activate_first = activate_first.unwrap_or(true);
    let mut activated_id: Option<String> = None;

    for (_, site, catalog) in probed {
        let pkg = match build_maccms_package(&site, catalog) {
            Ok(p) => p,
            Err(error) => {
                failed.push(SubscriptionImportFailure {
                    name: site.name,
                    api: site.api,
                    error,
                });
                continue;
            }
        };
        let sig_info = match verify_package(&pkg, allow_untrusted) {
            Ok(s) => s,
            Err(error) => {
                failed.push(SubscriptionImportFailure {
                    name: site.name,
                    api: site.api,
                    error,
                });
                continue;
            }
        };
        if let Err(error) = invoke_source(store.clone(), pkg.clone(), "init", json!({}), Some(6)).await {
            failed.push(SubscriptionImportFailure {
                name: site.name,
                api: site.api,
                error,
            });
            continue;
        }
        let activate_this = should_activate_first && activated_id.is_none();
        match store.install(pkg, sig_info, activate_this) {
            Ok(mut summary) => {
                if activate_this {
                    let _ = store.activate(Some(summary.id.clone()));
                    summary.active = true;
                    activated_id = Some(summary.id.clone());
                }
                imported.push(summary);
            }
            Err(error) => {
                failed.push(SubscriptionImportFailure {
                    name: site.name,
                    api: site.api,
                    error,
                });
            }
        }
    }

    if imported.is_empty() {
        let first_err = failed
            .first()
            .map(|f| f.error.clone())
            .unwrap_or_else(|| "导入失败".into());
        return Err(first_err);
    }

    sync_active_source_side_effects();
    let active_source_id = store.snapshot().active_source_id;
    Ok(SubscriptionImportOutcome {
        imported,
        failed,
        active_source_id,
    })
}

fn sync_active_source_side_effects() {
    crate::media::clear_caches();
    let origin = active_default_origin();
    crate::net::sync_base_for_source(&origin);
}

#[tauri::command]
pub async fn source_activate(id: Option<String>) -> Result<SourceStateSnapshot, String> {
    let snap = store_arc().activate(id)?;
    sync_active_source_side_effects();
    Ok(snap)
}

#[tauri::command]
pub async fn source_rollback(id: String) -> Result<InstalledSourceSummary, String> {
    let res = store_arc().rollback(&id)?;
    sync_active_source_side_effects();
    Ok(res)
}

#[tauri::command]
pub async fn source_remove(id: String) -> Result<SourceStateSnapshot, String> {
    let snap = store_arc().remove(&id)?;
    sync_active_source_side_effects();
    Ok(snap)
}

#[tauri::command]
pub async fn source_remove_many(ids: Vec<String>) -> Result<SourceStateSnapshot, String> {
    let (snap, _) = store_arc().remove_many(&ids)?;
    sync_active_source_side_effects();
    Ok(snap)
}

#[tauri::command]
pub async fn source_set_allow_untrusted(allow: bool) -> Result<SourceStateSnapshot, String> {
    store_arc().set_allow_untrusted(allow)
}

#[tauri::command]
pub async fn source_export_share_code(id: String) -> Result<String, String> {
    let pkg = store_arc()
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    encode_share_code(&pkg)
}

#[tauri::command]
pub async fn source_check_update(id: String) -> Result<SourceUpdateOutcome, String> {
    let store = store_arc();
    let current = store
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    if current.update_urls.is_empty() {
        return Err("该视频源未配置更新链接（updateUrls）；请直接复制新口令覆盖导入".into());
    }
    let from_version = current.manifest.version.clone();
    let mut last_err = String::from("所有更新链接均不可用");
    for url in &current.update_urls {
        match resolve_raw_input(url).await {
            Ok(raw) => {
                let candidate = match decode_package_input(&raw) {
                    Ok(p) => p,
                    Err(e) => { last_err = e; continue; }
                };
                if candidate.manifest.id != id {
                    last_err = "远程视频源 id 与当前源不一致，已拒绝覆盖".into();
                    continue;
                }
                if let Err(e) = validate_package(&candidate) {
                    last_err = e;
                    continue;
                }
                let sig_info = match verify_package(&candidate, store.allow_untrusted()) {
                    Ok(s) => s,
                    Err(e) => { last_err = e; continue; }
                };
                if !store.is_newer_than_installed(&id, &candidate.manifest.version) {
                    let snap = store.snapshot();
                    let summary = snap
                        .sources
                        .into_iter()
                        .find(|s| s.id == id)
                        .ok_or_else(|| "视频源不存在".to_string())?;
                    return Ok(SourceUpdateOutcome {
                        updated: false,
                        from_version: from_version.clone(),
                        to_version: from_version,
                        summary,
                    });
                }
                if let Err(e) = invoke_source(store.clone(), candidate.clone(), "init", json!({}), Some(6)).await {
                    last_err = format!("新版视频源初始化失败，已保留旧版：{e}");
                    continue;
                }
                let origins_changed = current.manifest.network.origins != candidate.manifest.network.origins;
                let to_version = candidate.manifest.version.clone();
                let summary = store.install(candidate, sig_info, false)?;
                if summary.active {
                    crate::media::clear_caches();
                    if origins_changed || crate::net::base().is_empty() {
                        crate::net::sync_base_for_source(&active_default_origin());
                    }
                }
                return Ok(SourceUpdateOutcome {
                    updated: true,
                    from_version,
                    to_version,
                    summary,
                });
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn source_test(id: String, query: Option<String>) -> Result<SourceTestOutcome, String> {
    let store = store_arc();
    let pkg = store
        .get_package(&id)
        .ok_or_else(|| "视频源不存在".to_string())?;
    let started = Instant::now();
    let q = query.unwrap_or_default().trim().to_string();
    let (method, input) = if !q.is_empty() {
        ("search", json!({ "q": q, "page": 1, "size": 5, "kind": "video" }))
    } else if pkg.manifest.capabilities.home {
        ("home", json!({ "page": 1, "size": 5 }))
    } else if pkg.manifest.capabilities.posts {
        ("posts", json!({ "page": 1, "size": 5 }))
    } else if pkg.manifest.capabilities.catalog.tags {
        ("hotTags", json!({}))
    } else if pkg.manifest.capabilities.catalog.rankings {
        ("rank", json!({ "kind": "hot" }))
    } else {
        ("search", json!({ "q": "", "page": 1, "size": 5, "kind": "video" }))
    };
    match invoke_source(store, pkg, method, input, Some(12)).await {
        Ok(val) => {
            let items = val.get("items").and_then(Value::as_array);
            let item_count = items.map_or(0, Vec::len);
            let sample_title = items
                .and_then(|arr| arr.first())
                .and_then(|v| v.get("title").or_else(|| v.get("name")))
                .and_then(Value::as_str)
                .map(str::to_string);
            Ok(SourceTestOutcome {
                ok: true,
                ms: started.elapsed().as_millis() as u64,
                method: method.into(),
                item_count,
                sample_title,
                error: None,
            })
        }
        Err(e) => Ok(SourceTestOutcome {
            ok: false,
            ms: started.elapsed().as_millis() as u64,
            method: method.into(),
            item_count: 0,
            sample_title: None,
            error: Some(e),
        }),
    }
}

/* ───────────────────── Pure-shell active-source dispatch ───────────────────── */

pub(crate) fn active_origins() -> Vec<String> {
    store_arc()
        .active_package()
        .map(|p| p.manifest.network.origins)
        .unwrap_or_default()
}

pub(crate) fn active_default_origin() -> String {
    active_origins().into_iter().next().unwrap_or_default()
}

pub(crate) fn active_source_id() -> String {
    store_arc()
        .active_package()
        .map(|p| p.manifest.id)
        .unwrap_or_default()
}

pub(crate) fn active_image_decrypt() -> Option<([u8; 16], [u8; 16])> {
    let pkg = store_arc().active_package()?;
    let cfg = pkg.manifest.media?.image_decrypt?;
    super::manifest::parse_image_decrypt_bytes(&cfg).ok()
}

pub(crate) async fn invoke_active(
    method: &str,
    input: Value,
    auth_token: Option<String>,
    base_override: Option<String>,
) -> Result<Value, String> {
    let store = store_arc();
    let pkg = store
        .active_package()
        .ok_or_else(|| "尚未导入视频源，请先在「视频源」中导入口令或链接".to_string())?;
    super::runtime::invoke_source_with_ctx(store, pkg, method, input, auth_token, base_override, None).await
}

fn non_empty_str(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null() && x.as_str().is_some_and(|s| !s.trim().is_empty()))
}

/// Shared play-info normalizer used by plugin `playback`.
pub(crate) fn normalize_play_info(info: &mut Value) {
    let Some(obj) = info.as_object_mut() else { return };
    for (field, key) in [("video_url", "main"), ("video_url_hevc", "hevc")] {
        let url = obj
            .get("streams")
            .and_then(|st| st.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned);
        if let Some(url) = url {
            if non_empty_str(obj.get(field)).is_none() {
                obj.insert(field.into(), json!(url));
            }
        }
    }
    if non_empty_str(obj.get("video_url")).is_none() {
        if let Some(hevc) = non_empty_str(obj.get("video_url_hevc")).cloned() {
            obj.insert("video_url".into(), hevc);
        }
    }
}

pub(crate) fn has_play_url(info: &Value) -> bool {
    non_empty_str(info.get("video_url")).is_some() || non_empty_str(info.get("video_url_hevc")).is_some()
}
