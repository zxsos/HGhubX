//! Subscription list parser (Base58 / Base64 / JSON) and generic MacCMS v10 QuickJS adapter.
//!
//! Pure-shell boundary: contains zero hardcoded site domains, API keys, or site-specific rules.
//! Every imported endpoint is validated through `network_policy::parse_target`, restricted to
//! HTTPS origins, and runs inside the standard QuickJS sandbox with origin-scoped `host.fetch`.

use super::manifest::{
    is_safe_id, validate_package, CatalogCapabilities, CatalogChannel, DetailCapabilities,
    PlaybackCapabilities, SourceCapabilities, SourceCatalogConfig, SourceManifest, SourceNetwork,
    SourcePackage, SourceRuntime, CURRENT_SCHEMA_VERSION, MAX_PACKAGE_JSON_BYTES,
    SUPPORTED_API_VERSION,
};
use super::runtime::host_http_request;
use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use url::Url;

pub const MAX_SUBSCRIPTION_ITEMS: usize = 200;
const MAX_PROBED_CHANNELS: usize = 24;
const MAX_PROBE_BYTES: usize = 256 * 1024;
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSitePreview {
    pub id: String,
    pub key: String,
    pub name: String,
    pub api: String,
    pub origin: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionPreview {
    pub format: String,
    pub total_count: usize,
    pub skipped_http_count: usize,
    pub skipped_unsupported_count: usize,
    pub items: Vec<SubscriptionSitePreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSiteInput {
    pub id: Option<String>,
    pub name: String,
    pub api: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionProbeResult {
    pub id: String,
    pub ok: bool,
    pub ms: u64,
    pub playable: bool,
    pub reason: Option<String>,
}

fn sha256_short_hex(text: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
    let mut out = String::with_capacity(8);
    for b in &digest.as_ref()[..4] {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub(crate) fn decode_base58(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Base58 输入为空".into());
    }
    if trimmed.len() > MAX_PACKAGE_JSON_BYTES * 2 {
        return Err("订阅内容超出大小上限".into());
    }
    let mut table = [255u8; 128];
    for (idx, &ch) in BASE58_ALPHABET.iter().enumerate() {
        table[ch as usize] = idx as u8;
    }
    let mut leading_zeros = 0usize;
    for b in trimmed.bytes() {
        if b == b'1' {
            leading_zeros += 1;
        } else {
            break;
        }
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(trimmed.len());
    for b in trimmed.bytes() {
        if b.is_ascii_whitespace() {
            continue;
        }
        if b >= 128 {
            return Err("非有效 Base58 字符".into());
        }
        let digit = table[b as usize];
        if digit == 255 {
            return Err("非有效 Base58 字符".into());
        }
        let mut carry = digit as u32;
        for byte in bytes.iter_mut().rev() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            if bytes.len() + leading_zeros > MAX_PACKAGE_JSON_BYTES {
                return Err("订阅解码内容超出上限（最大 512 KB）".into());
            }
            carry >>= 8;
        }
    }
    let mut out = vec![0u8; leading_zeros];
    out.extend_from_slice(&bytes);
    Ok(out)
}

fn is_subscription_json(val: &Value) -> bool {
    let Some(obj) = val.as_object() else {
        return false;
    };
    if obj.contains_key("manifest") && obj.contains_key("code") {
        return false;
    }
    obj.get("api_site").and_then(Value::as_object).is_some()
        || obj.get("sites").and_then(Value::as_array).is_some()
}

fn try_parse_json_bytes(bytes: &[u8]) -> Option<Value> {
    if bytes.len() > MAX_PACKAGE_JSON_BYTES {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let clean = text.trim_start_matches('\u{feff}').trim();
    if !clean.starts_with('{') {
        return None;
    }
    let val: Value = serde_json::from_str(clean).ok()?;
    is_subscription_json(&val).then_some(val)
}

fn decode_subscription_json(raw: &str) -> Option<Value> {
    let trimmed = raw.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() || trimmed.starts_with("hghubx-src://") {
        return None;
    }
    // 1. Plain JSON
    if let Some(val) = try_parse_json_bytes(trimmed.as_bytes()) {
        return Some(val);
    }
    // 2. Base64 / Base64URL
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.len() >= 16 && compact.len() <= MAX_PACKAGE_JSON_BYTES * 2 {
        for decoded in [
            B64_STD.decode(compact.as_bytes()).ok(),
            B64_URL.decode(compact.trim_end_matches('=').as_bytes()).ok(),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(val) = try_parse_json_bytes(&decoded) {
                return Some(val);
            }
        }
        // 3. Base58 (e.g. MoonTV / LunaTV `format=2`)
        if let Ok(decoded) = decode_base58(&compact) {
            if let Some(val) = try_parse_json_bytes(&decoded) {
                return Some(val);
            }
        }
    }
    None
}

fn sanitize_label(raw: &str, fallback: &str, max_chars: usize) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|&c| !matches!(c, '<' | '>' | '\r' | '\n' | '\t'))
        .collect();
    let trimmed = cleaned.trim();
    let chosen = if trimmed.is_empty() { fallback } else { trimmed };
    chosen.chars().take(max_chars).collect()
}

fn make_source_id(host: &str, api: &str, used: &mut HashSet<String>) -> String {
    let mut slug = String::from("maccms.");
    for ch in host.to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '-' | '_') {
            slug.push(ch);
        } else {
            slug.push('-');
        }
    }
    while slug.ends_with('.') || slug.ends_with('-') || slug.ends_with('_') {
        slug.pop();
    }
    if slug.len() > 80 {
        slug.truncate(80);
        while slug.ends_with('.') || slug.ends_with('-') || slug.ends_with('_') {
            slug.pop();
        }
    }
    if slug.len() < 3 || !is_safe_id(&slug) {
        slug = format!("maccms.{}", sha256_short_hex(api));
    }
    if used.contains(&slug) {
        let suffix = sha256_short_hex(api);
        let base = if slug.len() > 86 { &slug[..86] } else { &slug };
        slug = format!("{base}.{suffix}");
    }
    used.insert(slug.clone());
    slug
}

fn canonical_api_url(parsed: &Url) -> String {
    let mut normalized = parsed.clone();
    normalized.set_fragment(None);
    let trimmed_path = normalized.path().trim_end_matches('/').to_string();
    if !trimmed_path.is_empty() {
        normalized.set_path(&trimmed_path);
    }
    normalized.to_string()
}

/// Detect and parse a MacCMS subscription payload (`api_site` or TVBox `sites` with `type: 1`).
/// Returns `Ok(None)` when the input is not a subscription list (e.g. a standard single source).
pub(crate) fn parse_subscription(
    raw: &str,
    installed_ids: &HashSet<String>,
) -> Result<Option<SubscriptionPreview>, String> {
    let Some(val) = decode_subscription_json(raw) else {
        return Ok(None);
    };
    let Some(obj) = val.as_object() else {
        return Ok(None);
    };

    let mut raw_entries: Vec<(String, String, String)> = Vec::new();
    let mut skipped_unsupported = 0usize;
    let format: String;

    if let Some(api_site) = obj.get("api_site").and_then(Value::as_object) {
        format = "api_site".into();
        for (key, entry) in api_site {
            let Some(item) = entry.as_object() else {
                skipped_unsupported += 1;
                continue;
            };
            let api = item
                .get("api")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(key)
                .trim()
                .to_string();
            if api.is_empty() {
                skipped_unsupported += 1;
                continue;
            }
            raw_entries.push((key.clone(), name, api));
        }
    } else if let Some(sites) = obj.get("sites").and_then(Value::as_array) {
        format = "tvbox_maccms".into();
        for entry in sites {
            let Some(item) = entry.as_object() else {
                skipped_unsupported += 1;
                continue;
            };
            let site_type = item.get("type").and_then(Value::as_i64).unwrap_or(-1);
            let api = item
                .get("api")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let key = item
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&key)
                .trim()
                .to_string();
            // Only accept standard MacCMS v10 JSON endpoints (`type: 1` or explicit HTTP(S) `/provide/vod`).
            let is_http = api.starts_with("https://") || api.starts_with("http://");
            let is_maccms = is_http && (site_type == 1 || api.contains("/provide/vod"));
            if !is_maccms {
                skipped_unsupported += 1;
                continue;
            }
            raw_entries.push((if key.is_empty() { name.clone() } else { key }, name, api));
        }
    } else {
        return Ok(None);
    }

    let total_count = raw_entries.len() + skipped_unsupported;
    let mut skipped_http = 0usize;
    let mut seen_apis = HashSet::new();
    let mut used_ids = HashSet::new();
    let mut items = Vec::new();

    for (key, name, api) in raw_entries {
        if items.len() >= MAX_SUBSCRIPTION_ITEMS {
            break;
        }
        let parsed = match crate::network_policy::parse_target(&api) {
            Ok(u) => u,
            Err(_) => {
                skipped_unsupported += 1;
                continue;
            }
        };
        if parsed.scheme() != "https" {
            skipped_http += 1;
            continue;
        }
        let canonical = canonical_api_url(&parsed);
        if !seen_apis.insert(canonical.clone()) {
            continue;
        }
        let host = parsed.host_str().unwrap_or("source");
        let origin = parsed.origin().ascii_serialization();
        let id = make_source_id(host, &canonical, &mut used_ids);
        let safe_name = sanitize_label(&name, host, 80);
        items.push(SubscriptionSitePreview {
            installed: installed_ids.contains(&id),
            id,
            key: sanitize_label(&key, host, 64),
            name: safe_name,
            api: canonical,
            origin,
        });
    }

    if items.is_empty() {
        if format == "tvbox_maccms" && skipped_unsupported > 0 && skipped_http == 0 {
            return Err(
                "该配置仅包含 TVBox JAR/扩展爬虫源（不支持跨平台沙箱），仅支持标准苹果 CMS（MacCMS）JSON 接口"
                    .into(),
            );
        }
        if skipped_http > 0 {
            return Err(format!(
                "订阅清单中没有可用的 HTTPS 站点（已跳过 {skipped_http} 个非 HTTPS 站点）"
            ));
        }
        return Err("订阅清单中没有可导入的苹果 CMS（MacCMS）站点".into());
    }

    Ok(Some(SubscriptionPreview {
        format,
        total_count,
        skipped_http_count: skipped_http,
        skipped_unsupported_count: skipped_unsupported,
        items,
    }))
}

fn append_query(base: &str, suffix: &str) -> String {
    if base.contains('?') {
        format!("{base}&{suffix}")
    } else {
        format!("{base}?{suffix}")
    }
}

/// Extracts MacCMS `ac=list` categories into `catalog.channels`.
///
/// Multi-level MacCMS sites usually attach videos only to leaf categories (`type_pid != 0`),
/// leaving parent nodes (`type_pid == 0`) with 0 items when queried directly. Prefer leaf
/// categories (any `type_id` that is not another entry's `type_pid`), while keeping all valid
/// categories on flat single-level sites.
fn extract_maccms_channels(classes: &[Value]) -> Option<SourceCatalogConfig> {
    let mut entries: Vec<(CatalogChannel, String)> = Vec::new();
    let mut parent_ids: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();

    for entry in classes {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let id = match obj.get("type_id") {
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) => s.trim().to_string(),
            _ => continue,
        };
        let raw_name = obj.get("type_name").and_then(Value::as_str).unwrap_or("");
        let label = sanitize_label(raw_name, "", 64);
        if id.is_empty() || id.len() > 64 || label.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let pid = match obj.get("type_pid") {
            Some(Value::Number(n)) => n.to_string(),
            Some(Value::String(s)) => s.trim().to_string(),
            _ => String::new(),
        };
        if !pid.is_empty() && pid != "0" {
            parent_ids.insert(pid.clone());
        }
        entries.push((
            CatalogChannel {
                id,
                label,
                kind: Some("video".into()),
                icon: None,
                sorts: vec![],
            },
            pid,
        ));
    }

    let leaves: Vec<CatalogChannel> = entries
        .iter()
        .filter(|(ch, _)| !parent_ids.contains(&ch.id))
        .map(|(ch, _)| ch.clone())
        .collect();
    let chosen = if !leaves.is_empty() {
        leaves
    } else {
        entries.into_iter().map(|(ch, _)| ch).collect()
    };
    let channels: Vec<CatalogChannel> = chosen.into_iter().take(MAX_PROBED_CHANNELS).collect();
    if channels.is_empty() {
        None
    } else {
        Some(SourceCatalogConfig {
            shortcuts: vec![],
            channels,
        })
    }
}

/// Best-effort probe of a MacCMS endpoint's `ac=list` categories to populate `manifest.catalog.channels`.
/// Never fails import if the remote endpoint is slow or omits `class`.
pub(crate) async fn probe_maccms_channels(api: &str, origin: &str) -> Option<SourceCatalogConfig> {
    let url = append_query(api, "ac=list");
    let mut headers = HashMap::new();
    headers.insert("Accept".into(), "application/json".into());
    let origins = [origin.to_string()];
    let resp = host_http_request("GET", &url, &headers, None, Some(&origins), MAX_PROBE_BYTES, 6)
        .await
        .ok()?;
    if !resp.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let text = resp.get("text").and_then(Value::as_str)?;
    let parsed: Value = serde_json::from_str(text.trim_start_matches('\u{feff}').trim()).ok()?;
    let classes = parsed.get("class").and_then(Value::as_array)?;
    extract_maccms_channels(classes)
}

enum ProbeStreamCandidate {
    HttpsHls(String),
    HttpsMp4(String),
    InsecureOnly,
    None,
}

fn classify_probe_stream(list: &[Value]) -> ProbeStreamCandidate {
    let mut mp4: Option<String> = None;
    let mut saw_http_only = false;
    for item in list.iter().take(5) {
        let Some(play_url) = item.get("vod_play_url").and_then(Value::as_str) else {
            continue;
        };
        for group in play_url.split("$$$") {
            for part in group.split('#') {
                let raw = part.rsplit_once('$').map_or(part, |(_, u)| u).trim();
                if raw.is_empty() {
                    continue;
                }
                let normalized = if raw.starts_with("//") {
                    format!("https:{raw}")
                } else {
                    raw.to_string()
                };
                let lower = normalized.to_ascii_lowercase();
                let path = lower.split(['?', '#']).next().unwrap_or(&lower);
                let is_hls = path.contains(".m3u8") || lower.contains(".m3u8");
                let is_mp4 = path.ends_with(".mp4");
                if !is_hls && !is_mp4 {
                    continue;
                }
                if lower.starts_with("http://") {
                    saw_http_only = true;
                    continue;
                }
                if !lower.starts_with("https://") {
                    continue;
                }
                if is_hls {
                    return ProbeStreamCandidate::HttpsHls(normalized);
                }
                if mp4.is_none() {
                    mp4 = Some(normalized);
                }
            }
        }
    }
    if let Some(url) = mp4 {
        ProbeStreamCandidate::HttpsMp4(url)
    } else if saw_http_only {
        ProbeStreamCandidate::InsecureOnly
    } else {
        ProbeStreamCandidate::None
    }
}

// Note: the reason literals returned by `short_probe_error` and `probe_maccms_site`
// are mapped as i18n dictionary keys in `src/features/settings/SubscriptionPicker.tsx`; keep them in sync.
fn short_probe_error(err: &str, prefix: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if err.contains("超时") || lower.contains("timeout") || lower.contains("timed out") {
        format!("{prefix}超时")
    } else if err.contains("DNS") || lower.contains("dns") {
        format!("{prefix}DNS 失败")
    } else if err.contains("超出上限") {
        format!("{prefix}响应过大")
    } else {
        format!("{prefix}不可达")
    }
}

/// Probe a MacCMS subscription site end-to-end: API availability + direct playable stream reachability
/// (catches dead endpoints, non-m3u8 embed-only sites, and geo-blocked 403/451 media CDNs before import).
pub(crate) async fn probe_maccms_site(id: String, api: &str) -> SubscriptionProbeResult {
    let started = Instant::now();
    let fail = |reason: String| SubscriptionProbeResult {
        id: id.clone(),
        ok: false,
        ms: started.elapsed().as_millis() as u64,
        playable: false,
        reason: Some(reason),
    };
    let parsed = match crate::network_policy::parse_target(api.trim()) {
        Ok(u) if u.scheme() == "https" => u,
        Ok(_) => return fail("仅支持 HTTPS".into()),
        Err(_) => return fail("地址无效".into()),
    };
    let origin = parsed.origin().ascii_serialization();
    let detail_url = append_query(api.trim(), "ac=detail&pg=1");
    let mut headers = HashMap::new();
    headers.insert("Accept".into(), "application/json".into());
    let resp = match host_http_request(
        "GET",
        &detail_url,
        &headers,
        None,
        Some(&[origin]),
        1024 * 1024,
        5,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return fail(short_probe_error(&e, "")),
    };
    let status = resp.get("status").and_then(Value::as_u64).unwrap_or(0);
    if !(200..300).contains(&status) {
        return fail(format!("HTTP {status}"));
    }
    let text = resp.get("text").and_then(Value::as_str).unwrap_or("");
    let json_val: Value = match serde_json::from_str(text.trim_start_matches('\u{feff}').trim()) {
        Ok(v) => v,
        Err(_) => return fail("返回格式无效".into()),
    };
    let Some(list) = json_val.get("list").and_then(Value::as_array) else {
        return fail("返回格式无效".into());
    };
    if list.is_empty() {
        return fail("暂无片源".into());
    }

    let mut media_headers = HashMap::new();
    media_headers.insert("Accept".into(), "*/*".into());
    match classify_probe_stream(list) {
        ProbeStreamCandidate::HttpsHls(stream_url) => {
            let mresp = match host_http_request(
                "GET",
                &stream_url,
                &media_headers,
                None,
                None,
                256 * 1024,
                4,
            )
            .await
            {
                Ok(r) => r,
                Err(e) => return fail(short_probe_error(&e, "片源")),
            };
            let mstatus = mresp.get("status").and_then(Value::as_u64).unwrap_or(0);
            if mstatus == 403 || mstatus == 451 {
                return fail(format!("片源受限 ({mstatus})"));
            }
            if !(200..300).contains(&mstatus) {
                return fail(format!("片源异常 ({mstatus})"));
            }
            let body = mresp.get("text").and_then(Value::as_str).unwrap_or("");
            if !body.contains("#EXTM3U") && !body.contains("#EXT-X-") {
                return fail("清单格式无效".into());
            }
        }
        ProbeStreamCandidate::HttpsMp4(stream_url) => {
            let head = host_http_request("HEAD", &stream_url, &media_headers, None, None, 16 * 1024, 4).await;
            let mstatus = match head {
                Ok(r) => r.get("status").and_then(Value::as_u64).unwrap_or(0),
                Err(e) => return fail(short_probe_error(&e, "片源")),
            };
            let final_status = if mstatus == 405 {
                let mut range_headers = media_headers;
                range_headers.insert("Range".into(), "bytes=0-63".into());
                match host_http_request("GET", &stream_url, &range_headers, None, None, 16 * 1024, 4).await {
                    Ok(r) => r.get("status").and_then(Value::as_u64).unwrap_or(0),
                    Err(e) => return fail(short_probe_error(&e, "片源")),
                }
            } else {
                mstatus
            };
            if final_status == 403 || final_status == 451 {
                return fail(format!("片源受限 ({final_status})"));
            }
            if !(200..300).contains(&final_status) {
                return fail(format!("片源异常 ({final_status})"));
            }
        }
        ProbeStreamCandidate::InsecureOnly => return fail("片源非 HTTPS".into()),
        ProbeStreamCandidate::None => return fail("无直链片源".into()),
    }

    SubscriptionProbeResult {
        id,
        ok: true,
        ms: started.elapsed().as_millis() as u64,
        playable: true,
        reason: None,
    }
}

/// Generic MacCMS v10 JSON protocol adapter executed inside HGhubX's QuickJS sandbox.
const MACCMS_ADAPTER_BODY_JS: &str = r##"
function buildUrl(params) {
  const qs = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
  if (!qs) return API_URL;
  return API_URL + (API_URL.indexOf("?") >= 0 ? "&" : "?") + qs;
}

function fetchJson(params) {
  const res = host.fetch({
    url: buildUrl(params),
    method: "GET",
    headers: { Accept: "application/json" },
    timeoutMs: 10000,
  });
  if (!res || !res.ok) {
    throw new Error("接口请求失败（HTTP " + (res ? res.status : 0) + "）");
  }
  const clean = String(res.text || "").replace(/^\uFEFF/, "").trim();
  if (!clean) throw new Error("接口返回空响应");
  return JSON.parse(clean);
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.indexOf("/") === 0 && API_ORIGIN) return API_ORIGIN + s;
  return s;
}

function parseEpisodes(v) {
  const froms = String(v.vod_play_from || "").split("$$$");
  const groups = String(v.vod_play_url || "").split("$$$");
  let best = [];
  let bestScore = -1;
  for (let i = 0; i < groups.length; i++) {
    const rawGroup = String(groups[i] || "").trim();
    if (!rawGroup) continue;
    const fromName = String(froms[i] || "").toLowerCase();
    const parts = rawGroup.split("#");
    const parsed = [];
    let hasM3u8 = false;
    let hasMp4 = false;
    let hasHttps = false;
    let looksWebPage = false;
    for (let j = 0; j < parts.length; j++) {
      const seg = String(parts[j] || "").trim();
      if (!seg) continue;
      const sep = seg.indexOf("$");
      const label = sep >= 0 ? seg.slice(0, sep).trim() : "";
      const url = normalizeUrl(sep >= 0 ? seg.slice(sep + 1) : seg);
      if (!/^https?:\/\//i.test(url)) continue;
      if (/^https:\/\//i.test(url)) hasHttps = true;
      if (/\.m3u8(\?|$)/i.test(url)) hasM3u8 = true;
      else if (/\.mp4(\?|$)/i.test(url)) hasMp4 = true;
      else if (/\.(?:html?|php)(\?|$)|\/share\//i.test(url)) looksWebPage = true;
      parsed.push({ label, url });
    }
    if (!parsed.length) continue;
    let score = Math.min(parsed.length, 40);
    if (hasM3u8 || fromName.indexOf("m3u8") >= 0) score += 100;
    else if (hasMp4) score += 40;
    else if (looksWebPage) score -= 60;
    if (hasHttps) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = parsed;
    }
  }
  return best.map((item, idx) => ({
    ep_num: idx + 1,
    title: item.label || "第 " + (idx + 1) + " 集",
    duration: 0,
    status: 1,
    url: item.url,
  }));
}

function buildTags(v) {
  const out = [];
  const push = (t) => {
    const s = String(t || "").trim();
    if (s && out.indexOf(s) < 0 && out.length < 5) out.push(s);
  };
  push(v.type_name);
  push(v.vod_area);
  push(v.vod_year);
  String(v.vod_class || "")
    .split(/[,，/\s]+/)
    .forEach(push);
  return out;
}

function mapVideoCard(v) {
  const id = Number(v.vod_id) || 0;
  const eps = parseEpisodes(v);
  const total = eps.length || Number(v.vod_total) || 1;
  const remarks = String(v.vod_remarks || "").trim();
  const isFinished =
    v.vod_isend === 1 ||
    v.vod_isend === "1" ||
    /完结|全\d|HD|BD|TC|正片|1080|4K/i.test(remarks);
  return {
    id,
    title: String(v.vod_name || "").trim() || ("视频 " + id),
    cover: normalizeUrl(v.vod_pic),
    description: stripHtml(v.vod_blurb || v.vod_content),
    tags: buildTags(v),
    score: parseFloat(v.vod_score || v.vod_douban_score || "0") || 0,
    episode_count: eps.length || total,
    total_episodes: total,
    duration: remarks || String(v.vod_duration || "").trim(),
    hot: Number(v.vod_hits) || 0,
    like_count: Number(v.vod_up) || 0,
    collect_count: 0,
    comment_count: 0,
    is_finished: Boolean(isFinished),
    is_original: 0,
    created_at: String(v.vod_time || ""),
  };
}

function mapPaged(data, reqPage, reqSize) {
  const rawList = Array.isArray(data && data.list) ? data.list : [];
  const items = rawList.map(mapVideoCard).filter((x) => x.id > 0);
  const page = Number(data && data.page) || reqPage || 1;
  const pages = Number(data && data.pagecount) || 1;
  const size = Number(data && data.limit) || reqSize || items.length || 20;
  const total = Number(data && data.total) || items.length;
  return { items, pagination: { page, pages, size, total } };
}

function readEpCache() {
  try {
    const raw = host.storage.get("ep_cache");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeEpCache(id, title, eps) {
  try {
    const numId = Number(id);
    const urls = eps.map((e) => ({ title: e.title, url: e.url }));
    const next = [{ id: numId, title, urls }]
      .concat(readEpCache().filter((x) => Number(x && x.id) !== numId))
      .slice(0, 8);
    host.storage.set("ep_cache", JSON.stringify(next));
  } catch (e) {}
}

module.exports = {
  init() {
    return { ok: true, protocol: "maccms-v10" };
  },
  home({ page = 1, size = 20 } = {}) {
    const data = fetchJson({ ac: "detail", pg: page });
    return mapPaged(data, page, size);
  },
  category({ cate = "", page = 1, size = 20 } = {}) {
    const data = fetchJson({ ac: "detail", t: cate, pg: page });
    return mapPaged(data, page, size);
  },
  topics() {
    const data = fetchJson({ ac: "list" });
    const classes = Array.isArray(data && data.class) ? data.class : [];
    const parentIds = {};
    for (let i = 0; i < classes.length; i++) {
      const pid = String(classes[i] && classes[i].type_pid || "").trim();
      if (pid && pid !== "0") parentIds[pid] = true;
    }
    const items = classes
      .filter((c) => !parentIds[String(c && c.type_id || "").trim()])
      .map((c) => ({
        id: Number(c.type_id) || 0,
        title: String(c.type_name || "").trim(),
        slug: String(c.type_id || "").trim(),
        cover: "",
      }))
      .filter((c) => c.title && c.slug);
    return { items };
  },
  topic({ slug = "", page = 1, size = 20 } = {}) {
    const data = fetchJson({ ac: "detail", t: slug, pg: page });
    const videos = mapPaged(data, page, size);
    const first = videos.items[0];
    return {
      topic: {
        id: Number(slug) || 0,
        title: (first && first.tags && first.tags[0]) || String(slug),
        slug: String(slug),
        cover: (first && first.cover) || "",
      },
      videos,
    };
  },
  search({ q = "", page = 1, size = 20 } = {}) {
    const kw = String(q || "").trim();
    if (!kw) {
      return { items: [], pagination: { page: 1, pages: 1, size, total: 0 }, keyword: "" };
    }
    const data = fetchJson({ ac: "detail", wd: kw, pg: page });
    const paged = mapPaged(data, page, size);
    return { items: paged.items, pagination: paged.pagination, keyword: kw };
  },
  detail({ id }) {
    const data = fetchJson({ ac: "detail", ids: id });
    const rawList = Array.isArray(data && data.list) ? data.list : [];
    const v = rawList[0];
    if (!v) throw new Error("未找到该视频详情");
    const card = mapVideoCard(v);
    const eps = parseEpisodes(v);
    writeEpCache(card.id, card.title, eps);
    const actor = String(v.vod_actor || v.vod_director || "").trim();
    return {
      ...card,
      duration: 0,
      description: stripHtml(v.vod_content || v.vod_blurb),
      episodes: eps.map(({ ep_num, title, duration, status }) => ({ ep_num, title, duration, status })),
      counts: {
        like: card.like_count,
        collect: 0,
        comment: 0,
        hot: card.hot,
      },
      author: { id: 0, name: actor || host.info.name },
      video_url: eps[0] ? eps[0].url : "",
    };
  },
  playback({ id, ep = 1 }) {
    const epNum = Math.max(1, Number(ep) || 1);
    const cached = readEpCache().find((x) => Number(x && x.id) === Number(id));
    if (cached && Array.isArray(cached.urls) && cached.urls[epNum - 1] && cached.urls[epNum - 1].url) {
      const hit = cached.urls[epNum - 1];
      return {
        id: String(id),
        ep: epNum,
        duration: 0,
        title: (cached.title ? cached.title + " · " : "") + hit.title,
        video_url: hit.url,
      };
    }
    const data = fetchJson({ ac: "detail", ids: id });
    const rawList = Array.isArray(data && data.list) ? data.list : [];
    const v = rawList[0];
    if (!v) throw new Error("未找到播放地址");
    const title = String(v.vod_name || "").trim();
    const eps = parseEpisodes(v);
    writeEpCache(Number(v.vod_id) || Number(id), title, eps);
    const chosen = eps[epNum - 1] || eps[0];
    if (!chosen || !chosen.url) throw new Error("当前视频暂无可用直链播放地址");
    return {
      id: String(id),
      ep: epNum,
      duration: 0,
      title: (title ? title + " · " : "") + chosen.title,
      video_url: chosen.url,
    };
  },
};
"##;

pub(crate) fn render_maccms_adapter_code(api_url: &str, origin: &str) -> Result<String, String> {
    let api_lit = serde_json::to_string(api_url).map_err(|e| format!("序列化接口地址失败：{e}"))?;
    let origin_lit =
        serde_json::to_string(origin).map_err(|e| format!("序列化来源地址失败：{e}"))?;
    Ok(format!(
        "// Generic MacCMS v10 JSON adapter\nconst API_URL = {api_lit};\nconst API_ORIGIN = {origin_lit};\n{MACCMS_ADAPTER_BODY_JS}"
    ))
}

pub(crate) fn build_maccms_package(
    site: &SubscriptionSiteInput,
    catalog: Option<SourceCatalogConfig>,
) -> Result<SourcePackage, String> {
    let parsed = crate::network_policy::parse_target(site.api.trim())?;
    if parsed.scheme() != "https" {
        return Err(format!("站点必须使用 https:// 地址：{}", site.api));
    }
    let canonical = canonical_api_url(&parsed);
    let host = parsed
        .host_str()
        .ok_or_else(|| "站点缺少主机名".to_string())?;
    let origin = parsed.origin().ascii_serialization();
    let mut used = HashSet::new();
    let id = match site.id.as_deref().map(str::trim).filter(|s| is_safe_id(s)) {
        Some(valid) => valid.to_string(),
        None => make_source_id(host, &canonical, &mut used),
    };
    let name = sanitize_label(&site.name, host, 80);
    let code = render_maccms_adapter_code(&canonical, &origin)?;
    let pkg = SourcePackage {
        schema_version: CURRENT_SCHEMA_VERSION,
        manifest: SourceManifest {
            schema_version: CURRENT_SCHEMA_VERSION,
            id,
            name,
            version: "1.0.0".into(),
            api_version: SUPPORTED_API_VERSION.into(),
            description: format!("MacCMS JSON · {host}"),
            author: "MacCMS Subscription".into(),
            runtime: SourceRuntime {
                kind: "quickjs".into(),
                entry: "inline".into(),
            },
            network: SourceNetwork {
                origins: vec![origin],
                media_origins: vec![],
                publish_origins: vec![],
            },
            capabilities: SourceCapabilities {
                home: true,
                search: true,
                catalog: CatalogCapabilities {
                    categories: true,
                    topics: Some(false),
                    tags: false,
                    rankings: false,
                    authors: false,
                },
                detail: DetailCapabilities {
                    episodes: true,
                    related: false,
                    comments: false,
                },
                playback: PlaybackCapabilities {
                    hls: true,
                    mp4: false,
                    subtitles: false,
                },
                posts: false,
                account: false,
                lines: false,
            },
            media: None,
            catalog,
            links: None,
        },
        code,
        update_urls: vec![],
        signature: None,
    };
    validate_package(&pkg)?;
    Ok(pkg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::runtime::invoke_source;
    use crate::source::store::SourceStore;
    use serde_json::json;
    use std::sync::Arc;

    fn encode_base58(input: &[u8]) -> String {
        let mut zeros = 0usize;
        for &b in input {
            if b == 0 {
                zeros += 1;
            } else {
                break;
            }
        }
        let mut digits: Vec<u8> = Vec::new();
        for &byte in &input[zeros..] {
            let mut carry = byte as u32;
            for d in digits.iter_mut() {
                carry += (*d as u32) << 8;
                *d = (carry % 58) as u8;
                carry /= 58;
            }
            while carry > 0 {
                digits.push((carry % 58) as u8);
                carry /= 58;
            }
        }
        let mut out = String::with_capacity(zeros + digits.len());
        for _ in 0..zeros {
            out.push('1');
        }
        for &d in digits.iter().rev() {
            out.push(BASE58_ALPHABET[d as usize] as char);
        }
        out
    }

    #[test]
    fn decodes_base58_api_site_subscription_and_filters_unsafe_entries() {
        let payload = json!({
            "cache_time": 7200,
            "api_site": {
                "alpha": { "name": "<b>示例影视</b>", "api": "https://vod-a.example.com/api.php/provide/vod/" },
                "alpha_dup": { "name": "重复站点", "api": "https://vod-a.example.com/api.php/provide/vod" },
                "alpha_alt": { "name": "同域备用", "api": "https://vod-a.example.com/alt/provide/vod" },
                "insecure": { "name": "明文站", "api": "http://plain.example.com/api.php/provide/vod" },
                "private": { "name": "内网站", "api": "https://127.0.0.1/api.php/provide/vod" }
            }
        })
        .to_string();
        let b58 = encode_base58(payload.as_bytes());
        assert_eq!(decode_base58(&b58).unwrap(), payload.as_bytes());

        let mut installed = HashSet::new();
        installed.insert("maccms.vod-a.example.com".to_string());
        let preview = parse_subscription(&b58, &installed)
            .expect("valid subscription")
            .expect("detected as subscription");

        assert_eq!(preview.format, "api_site");
        assert_eq!(preview.items.len(), 2);
        assert_eq!(preview.skipped_http_count, 1);
        assert_eq!(preview.skipped_unsupported_count, 1);

        let ids: HashSet<_> = preview.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "same-host distinct paths must get unique IDs");
        assert!(preview.items.iter().all(|i| !i.name.contains('<') && !i.name.contains('>')));
        assert!(preview.items.iter().any(|i| i.installed));
    }

    #[test]
    fn parses_tvbox_type1_and_rejects_jar_only_config() {
        let jar_only = json!({
            "spider": "https://cdn.example.com/spider.jar",
            "sites": [
                { "key": "s1", "name": "JAR站", "type": 3, "api": "csp_Example" }
            ]
        })
        .to_string();
        let err = parse_subscription(&jar_only, &HashSet::new()).unwrap_err();
        assert!(err.contains("JAR"), "unexpected error: {err}");

        let mixed = json!({
            "sites": [
                { "key": "jar", "name": "JAR站", "type": 3, "api": "csp_Example" },
                { "key": "cms", "name": "采集站", "type": 1, "api": "https://cms.example.com/api.php/provide/vod" }
            ]
        })
        .to_string();
        let preview = parse_subscription(&mixed, &HashSet::new())
            .unwrap()
            .expect("detected tvbox_maccms");
        assert_eq!(preview.format, "tvbox_maccms");
        assert_eq!(preview.items.len(), 1);
        assert_eq!(preview.skipped_unsupported_count, 1);
        assert_eq!(preview.items[0].origin, "https://cms.example.com");
    }

    #[test]
    fn single_source_package_is_not_misclassified_as_subscription() {
        let pkg_json = json!({
            "schemaVersion": 1,
            "manifest": { "id": "com.example.src" },
            "code": "module.exports = {};"
        })
        .to_string();
        assert!(parse_subscription(&pkg_json, &HashSet::new()).unwrap().is_none());
        assert!(parse_subscription("hghubx-src://abc123", &HashSet::new()).unwrap().is_none());
    }

    #[tokio::test]
    async fn maccms_adapter_executes_in_quickjs_and_maps_contract() {
        let site = SubscriptionSiteInput {
            id: None,
            name: "测试采集站".into(),
            api: "https://cms.example.com/api.php/provide/vod".into(),
        };
        let pkg = build_maccms_package(&site, None).expect("valid maccms package");
        assert!(pkg.manifest.capabilities.home);
        assert!(pkg.manifest.capabilities.search);
        assert!(pkg.manifest.capabilities.catalog.categories);
        assert_eq!(pkg.manifest.capabilities.catalog.topics, Some(false));
        assert!(pkg.manifest.capabilities.detail.episodes);
        assert!(pkg.manifest.capabilities.playback.hls);
        assert!(!pkg.manifest.capabilities.account);
        assert_eq!(pkg.manifest.network.origins, vec!["https://cms.example.com"]);

        // Two-level MacCMS tree should select leaf categories rather than empty parent buckets.
        let extracted = extract_maccms_channels(&[
            json!({ "type_id": 1, "type_pid": 0, "type_name": "电影" }),
            json!({ "type_id": 2, "type_pid": 0, "type_name": "连续剧" }),
            json!({ "type_id": 6, "type_pid": 1, "type_name": "动作片" }),
            json!({ "type_id": 7, "type_pid": 1, "type_name": "喜剧片" }),
        ])
        .expect("leaf channels extracted");
        let extracted_ids: Vec<&str> = extracted.channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(extracted_ids, vec!["2", "6", "7"]);

        let store = Arc::new(SourceStore::new());
        let init_res = invoke_source(store.clone(), pkg.clone(), "init", json!({}), Some(6))
            .await
            .expect("init succeeds in QuickJS");
        assert_eq!(init_res["ok"], json!(true));

        // Verify episode scoring (prefer m3u8 over share page), card normalization, and ep_cache hit
        // by wrapping the real adapter code with an offline mock `host.fetch` inside QuickJS.
        let mock_resp = json!({
            "page": "1",
            "pagecount": 3,
            "limit": "20",
            "total": 45,
            "class": [
                { "type_id": 1, "type_name": "电影" },
                { "type_id": 2, "type_name": "连续剧" }
            ],
            "list": [{
                "vod_id": 8801,
                "vod_name": "星际漫游",
                "type_id": 2,
                "type_name": "连续剧",
                "vod_pic": "//img.example.com/p/8801.jpg",
                "vod_remarks": "更新至02集",
                "vod_year": "2026",
                "vod_area": "大陆",
                "vod_class": "科幻,冒险",
                "vod_score": "8.7",
                "vod_hits": 1234,
                "vod_up": 56,
                "vod_actor": "张三,李四",
                "vod_content": "<p>一段<b>太空</b>旅程</p>",
                "vod_play_from": "shareyun$$$hkm3u8",
                "vod_play_url": "第1集$https://share.example.com/play/1#第2集$https://share.example.com/play/2$$$第1集$https://cdn.example.com/ep1.m3u8#第2集$https://cdn.example.com/ep2.m3u8"
            }]
        })
        .to_string();
        let mock_lit = serde_json::to_string(&mock_resp).unwrap();
        let mut test_pkg = pkg;
        test_pkg.code = format!(
            "const __realHost = host; {{ const host = Object.assign({{}}, __realHost, {{ fetch() {{ return {{ ok: true, status: 200, text: {mock_lit} }}; }} }});\n{}\n}}",
            test_pkg.code
        );

        let home_res = invoke_source(store.clone(), test_pkg.clone(), "home", json!({ "page": 1, "size": 20 }), Some(6))
            .await
            .expect("home maps MacCMS list");
        assert_eq!(home_res["items"][0]["id"], json!(8801));
        assert_eq!(home_res["items"][0]["cover"], json!("https://img.example.com/p/8801.jpg"));
        assert_eq!(home_res["items"][0]["episode_count"], json!(2));
        assert_eq!(home_res["pagination"]["pages"], json!(3));

        let topics_res = invoke_source(store.clone(), test_pkg.clone(), "topics", json!({}), Some(6))
            .await
            .expect("topics maps class list");
        assert_eq!(topics_res["items"].as_array().unwrap().len(), 2);
        assert_eq!(topics_res["items"][0]["slug"], json!("1"));

        let detail_res = invoke_source(store.clone(), test_pkg.clone(), "detail", json!({ "id": 8801 }), Some(6))
            .await
            .expect("detail prefers m3u8 group");
        assert_eq!(detail_res["description"], json!("一段 太空 旅程"));
        assert_eq!(detail_res["video_url"], json!("https://cdn.example.com/ep1.m3u8"));
        assert_eq!(detail_res["episodes"].as_array().unwrap().len(), 2);

        let play_res = invoke_source(store.clone(), test_pkg, "playback", json!({ "id": 8801, "ep": 2 }), Some(6))
            .await
            .expect("playback resolves episode 2");
        assert_eq!(play_res["video_url"], json!("https://cdn.example.com/ep2.m3u8"));
    }
}
