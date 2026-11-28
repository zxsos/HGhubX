//! Generic media byte download with retry and DNS fallback (no site-specific API envelope).

use super::client::get_with_dns;
use super::line::base;
use super::redact::{err_text, heal_client};
use super::{MEDIA_DNS_ROUTES, NEXT_REQUEST};
#[cfg(test)]
use crate::network_policy;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<u16>().ok())
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

pub(super) async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

#[cfg(test)]
pub(crate) fn edge_redirect_target(
    current: &url::Url,
    status: u16,
    location: &str,
    guest_get: bool,
) -> Result<url::Url, String> {
    if !guest_get || !matches!(status, 301 | 302 | 303) {
        return Err("重定向已拒绝".into());
    }
    network_policy::redirect_target(current, location)
}

/// 拉原始字节（图片 / m3u8 / 分片），保留重定向后的最终 URL。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    fetch_bytes_with_url(url)
        .await
        .map(|(_, ctype, bytes)| (ctype, bytes))
}

pub async fn fetch_bytes_with_url(url: &str) -> Result<(String, Option<String>, Vec<u8>), String> {
    let request = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let target = url::Url::parse(&url).ok();
    let host = target
        .as_ref()
        .and_then(|target| target.host_str())
        .unwrap_or("")
        .to_string();
    let public_dns = AtomicBool::new(
        MEDIA_DNS_ROUTES
            .lock()
            .ok()
            .is_some_and(|routes| routes.prefers_public(&host, Instant::now())),
    );
    let cur_base = base();
    let referer_owned = (!cur_base.is_empty()).then(|| format!("{cur_base}/"));
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer_owned.clone();
        let host = &host;
        let target = &target;
        let public_dns = &public_dns;
        async move {
            let using_public_dns = public_dns.load(Ordering::Relaxed);
            let started = Instant::now();
            crate::playback_log::record(
                "network.begin",
                json!({"request": request, "resource": resource, "attempt": attempt}),
            );
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let mut resp = get_with_dns(
                    &url,
                    Duration::from_secs(20),
                    None,
                    referer.as_deref(),
                    using_public_dns,
                )
                .await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let final_url = resp.url().to_string();
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let cap = resp.content_length().and_then(|n| usize::try_from(n).ok()).map_or(0, |n| n.min(8 * 1024 * 1024));
                let mut bytes = Vec::with_capacity(cap);
                while let Some(chunk) = resp.chunk().await.map_err(|e| err_text(&e))? {
                    crate::media_stats::record_rx(chunk.len() as u64);
                    bytes.extend_from_slice(&chunk);
                }
                Ok((final_url, ctype, bytes))
            }
            .await;
            if using_public_dns {
                if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
                    if result.is_ok() {
                        routes.remember(host, Instant::now());
                    } else {
                        routes.forget(host);
                    }
                }
            }
            if let Err(error) = &result {
                if target.as_ref().is_some_and(|target| {
                    !super::client::proxy_active(target) && crate::media_dns::eligible(target, error)
                }) {
                    public_dns.store(!using_public_dns, Ordering::Relaxed);
                    crate::playback_log::record(
                        "network.dns_fallback",
                        json!({"resource": resource, "attempt": attempt, "public_dns": !using_public_dns, "error_kind": crate::playback_log::error_kind(error)}),
                    );
                }
            }
            crate::playback_log::record(
                "network.end",
                json!({"request": request, "resource": resource, "attempt": attempt, "public_dns": using_public_dns, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, _, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}),
            );
            result
        }
    })
    .await
}
