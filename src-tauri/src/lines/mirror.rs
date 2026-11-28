//! Plugin-driven line list and mirror discovery (zero hardcoded site origins).

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

pub(super) const MIRROR_MAX: usize = 20;
const RECOMMENDED_MAX: usize = 20;

/// Only origins actually returned by each source's `discoverMirrors` enter its scoped set.
static TRUSTED_MIRRORS: Lazy<RwLock<HashMap<String, Vec<String>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

fn remember_published(items: &[Value]) {
    let scope = crate::source::active_source_id();
    let mut all = TRUSTED_MIRRORS
        .write()
        .unwrap_or_else(|error| error.into_inner());
    let known = all.entry(scope).or_default();
    for origin in items
        .iter()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
    {
        if !known.iter().any(|value| value == origin) {
            if known.len() >= 256 {
                known.remove(0);
            }
            known.push(origin.to_owned());
        }
    }
}

pub fn is_trusted_mirror(origin: &str) -> bool {
    let scope = crate::source::active_source_id();
    TRUSTED_MIRRORS
        .read()
        .ok()
        .and_then(|all| all.get(&scope).map(|known| known.iter().any(|value| value == origin)))
        .unwrap_or(false)
}

pub fn trusted_mirrors_snapshot() -> Vec<String> {
    let scope = crate::source::active_source_id();
    TRUSTED_MIRRORS
        .read()
        .ok()
        .and_then(|all| all.get(&scope).cloned())
        .unwrap_or_default()
}

pub fn fixed() -> Value {
    let list: Vec<Value> = crate::source::active_origins()
        .into_iter()
        .enumerate()
        .map(|(i, url)| json!({ "name": format!("主线路 {}", i + 1), "url": url }))
        .collect();
    json!(list)
}

pub fn is_fixed(url: &str) -> bool {
    crate::source::active_origins()
        .iter()
        .any(|known| known.eq_ignore_ascii_case(url))
}

/// Ask the active QuickJS source plugin to discover mirrors (if implemented).
pub async fn mirrors() -> Result<Value, String> {
    let raw = crate::source::invoke_active("discoverMirrors", json!({}), None, None).await?;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    if let Some(arr) = raw.get("items").and_then(Value::as_array) {
        for entry in arr {
            let Some(url_str) = entry.get("url").and_then(Value::as_str) else {
                continue;
            };
            let Some(origin) = crate::net::normalize_base(url_str) else {
                continue;
            };
            if items.len() < MIRROR_MAX && seen.insert(origin.clone()) {
                let host = url::Url::parse(&origin)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or_default();
                let name = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| host.clone());
                items.push(json!({ "name": name, "host": host, "url": origin }));
            }
        }
    }
    if !items.is_empty() {
        remember_published(&items);
    }
    let mut recommended = Vec::new();
    let mut rec_seen = HashSet::new();
    if let Some(cur) = crate::net::normalize_base(&crate::net::base()) {
        if let Some(host) = url::Url::parse(&cur)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
        {
            rec_seen.insert(cur.clone());
            recommended.push(json!({ "url": cur, "host": host }));
        }
    }
    for item in &items {
        if recommended.len() >= RECOMMENDED_MAX {
            break;
        }
        if let Some(origin) = item.get("url").and_then(Value::as_str) {
            if rec_seen.insert(origin.to_owned()) {
                recommended.push(item.clone());
            }
        }
    }
    let source_label = raw
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("plugin")
        .to_string();
    Ok(json!({
        "source": source_label,
        "script": raw.get("script").and_then(Value::as_str).unwrap_or(""),
        "items": items,
        "recommended_source": source_label,
        "recommended": recommended,
        "errors": raw.get("errors").cloned().unwrap_or_else(|| json!([])),
    }))
}

pub async fn verify_published_origin(origin: &str) -> Result<bool, String> {
    if is_fixed(origin) || is_trusted_mirror(origin) {
        return Ok(true);
    }
    let _ = mirrors().await?;
    Ok(is_trusted_mirror(origin))
}
