use super::proxy_env::{clear_proxy_env_cache, proxy_override, system_explicit_proxy};
use super::redact::{err_text, redact_proxy};
use super::{
    base, ClientCache, ClientFlight, CLIENTS, CLIENT_BUILDING, CLIENT_GENERATION, CLIENT_TTL,
    MEDIA_CONFIG_FINGERPRINT, MEDIA_CONFIG_GENERATION, MEDIA_DNS_ROUTES,
};
use crate::network_policy;
use once_cell::sync::Lazy;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const SYSTEM_PROXY_TTL: Duration = Duration::from_secs(10);
const SYSTEM_DNS_RACE_DELAY: Duration = Duration::from_millis(900);
static SYSTEM_PROXY_MATCHER: Lazy<Mutex<Option<(Instant, Arc<hyper_util::client::proxy::matcher::Matcher>)>>> =
    Lazy::new(|| Mutex::new(None));

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 按**当前**系统代理设置新建一个客户端。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，症状是满屏 `tunnel error: failed to create
/// underlying connection`（浏览器却是通的，因为它每次都重读系统代理）。所以这里允许重建。
pub(crate) fn build_client(host: &str, addrs: &[SocketAddr], route: &ProxyRoute) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .tcp_nodelay(true)
        .pool_max_idle_per_host(8)
        .pool_idle_timeout(Duration::from_secs(90));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if route.mode == crate::proxy::Mode::Off {
        builder = builder.no_proxy();
    } else if let Some(proxy) = &route.explicit {
        let proxy = reqwest::Proxy::all(proxy).map_err(|_| "代理配置无效（已隐藏原始值）")?;
        builder = builder.no_proxy().proxy(proxy);
    }
    builder.build().map_err(|_| "无法创建 HTTP 客户端".to_string())
}

/// One immutable selection is used for DNS, cache identity and client creation.
/// An in-flight request may finish on its old route; it cannot populate the new
/// configuration's cache entry after the user saves a different proxy.
pub(crate) struct ProxyRoute {
    mode: crate::proxy::Mode,
    pub(crate) explicit: Option<String>,
    pub(crate) active: bool,
    generation: u64,
}

impl ProxyRoute {
    pub(crate) fn for_config(config: &crate::proxy::Config, target: &url::Url) -> Self {
        use crate::proxy::Mode;
        let explicit = match config.mode {
            Mode::Off => None,
            Mode::Custom => Some(config.url.clone()),
            Mode::System => system_explicit_proxy(),
        };
        let active = match config.mode {
            Mode::Off => false,
            Mode::Custom => true,
            Mode::System => explicit.is_some() || system_proxy_routes_target(target),
        };
        Self { mode: config.mode, explicit, active, generation: CLIENT_GENERATION.load(Ordering::Acquire) }
    }

    fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        self.mode.hash(&mut hash);
        self.explicit.hash(&mut hash);
        hash.finish()
    }

    pub(crate) fn label(&self) -> String {
        if self.mode == crate::proxy::Mode::Off {
            "direct".into()
        } else if let Some(proxy) = &self.explicit {
            redact_proxy(proxy)
        } else if self.active {
            "system".into()
        } else {
            "direct".into()
        }
    }
}


/// Immutable transport identity captured when a media single-flight starts.
///
/// Only an effective line/proxy/security change increments `generation`.
/// Routine connection/DNS refreshes leave completed media caches usable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RequestScope {
    pub(crate) strict: bool,
    pub(crate) generation: u64,
}

pub(crate) fn request_scope() -> RequestScope {
    RequestScope {
        strict: network_policy::strict_security(),
        generation: MEDIA_CONFIG_GENERATION.load(Ordering::Acquire),
    }
}

pub(super) fn media_config_fingerprint(
    origin: &str,
    strict: bool,
    config: &crate::proxy::Config,
    system_proxy: u64,
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    origin.hash(&mut hash);
    strict.hash(&mut hash);
    config.mode.hash(&mut hash);
    match config.mode {
        crate::proxy::Mode::Custom => config.url.hash(&mut hash),
        crate::proxy::Mode::System => system_proxy.hash(&mut hash),
        crate::proxy::Mode::Off => {}
    }
    hash.finish()
}

/// Snapshot system settings only when rebuilding clients, never per segment.
/// Values (including proxy credentials) are hashed in memory and never logged.
fn system_proxy_fingerprint() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    proxy_override().hash(&mut hash);
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] {
        name.hash(&mut hash);
        std::env::var_os(name).hash(&mut hash);
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    system_explicit_proxy().hash(&mut hash);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    format!("{:?}", hyper_util::client::proxy::matcher::Matcher::from_system()).hash(&mut hash);
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        {
            key.get_value::<u32, _>("ProxyEnable").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyServer").ok().hash(&mut hash);
            key.get_value::<String, _>("ProxyOverride").ok().hash(&mut hash);
        }
    }
    hash.finish()
}

pub(super) fn update_media_generation(
    previous: &mut Option<u64>,
    fingerprint: u64,
    generation: &std::sync::atomic::AtomicU64,
) {
    if *previous != Some(fingerprint) {
        *previous = Some(fingerprint);
        generation.fetch_add(1, Ordering::AcqRel);
    }
}

pub(super) fn refresh_media_scope() {
    if let Ok(mut previous) = MEDIA_CONFIG_FINGERPRINT.lock() {
        let config = crate::proxy::snapshot();
        let system_proxy = if config.mode == crate::proxy::Mode::System {
            system_proxy_fingerprint()
        } else {
            0
        };
        let fingerprint = media_config_fingerprint(&base(), network_policy::strict_security(), &config, system_proxy);
        update_media_generation(&mut previous, fingerprint, &MEDIA_CONFIG_GENERATION);
    }
}

pub(super) fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// 缓存按模式、主机和端口隔离；有效期内仅复用已经检查并固定地址的客户端。
/// 到期后重新检查全部 DNS 答案，不使用旧连接绕过新的目标检查。
#[allow(dead_code)]
pub(super) async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    client_for_dns(raw, false).await
}

/// Keep per-target NO_PROXY/per-scheme/system matching consistent with reqwest.
fn system_proxy_matcher() -> Arc<hyper_util::client::proxy::matcher::Matcher> {
    let now = Instant::now();
    if let Ok(guard) = SYSTEM_PROXY_MATCHER.lock() {
        if let Some((expires, matcher)) = guard.as_ref() {
            if now < *expires {
                return matcher.clone();
            }
        }
    }
    let fresh = Arc::new(hyper_util::client::proxy::matcher::Matcher::from_system());
    if let Ok(mut guard) = SYSTEM_PROXY_MATCHER.lock() {
        *guard = Some((now + SYSTEM_PROXY_TTL, fresh.clone()));
    }
    fresh
}

fn system_proxy_routes_target(target: &url::Url) -> bool {
    let matcher = system_proxy_matcher();
    crate::apple_proxy::routes_target(&matcher, target.as_str())
}

pub(crate) fn proxy_active(target: &url::Url) -> bool {
    ProxyRoute::for_config(&crate::proxy::snapshot(), target).active
}

pub(super) fn client_key(strict: bool, host: &str, port: u16, public_dns: bool, route: &ProxyRoute) -> String {
    format!("{strict}:{host}:{port}:{public_dns}:{}:{:x}:{}", route.active, route.fingerprint(), route.generation)
}

async fn resolve_doh_checked(
    host: &str,
    port: u16,
    strict: bool,
    route: &ProxyRoute,
) -> Result<(Vec<SocketAddr>, Duration), String> {
    let resolver = build_client(crate::media_dns::HOST, &crate::media_dns::BOOTSTRAP, route)?;
    let resolution = crate::media_dns::resolve(&resolver, host, port).await?;
    network_policy::check_addresses_with_mode(&resolution.addresses, strict)?;
    Ok((resolution.addresses, CLIENT_TTL.min(resolution.ttl)))
}

/// Prefer OS DNS so local FakeIP/TUN resolvers answer in <2ms without touching DoH;
/// only when OS DNS stalls past `SYSTEM_DNS_RACE_DELAY` (or fails fast on an eligible
/// HTTPS domain) do we race AliDNS DoH in parallel and still enforce full strict IP checks.
async fn resolve_strict_fast(
    target: &url::Url,
    host: &str,
    port: u16,
    route: &ProxyRoute,
) -> Result<(Vec<SocketAddr>, Duration), String> {
    let can_race_doh =
        target.scheme() == "https" && matches!(target.host(), Some(url::Host::Domain(_)));
    if !can_race_doh {
        return network_policy::resolve_target(target, true)
            .await
            .map(|addrs| (addrs, CLIENT_TTL));
    }
    let started = Instant::now();
    let sys_fut = network_policy::resolve_target(target, true);
    tokio::pin!(sys_fut);
    let fast = tokio::select! {
        res = &mut sys_fut => Some(res),
        _ = tokio::time::sleep(SYSTEM_DNS_RACE_DELAY) => None,
    };
    match fast {
        Some(Ok(addrs)) => return Ok((addrs, CLIENT_TTL)),
        Some(Err(sys_err)) => {
            if crate::media_dns::eligible(target, &sys_err) {
                if let Ok(doh_ok) = resolve_doh_checked(host, port, true, route).await {
                    crate::playback_log::record(
                        "network.dns_race_doh",
                        json!({"reason": "fast_fallback", "elapsed_ms": started.elapsed().as_millis() as u64}),
                    );
                    return Ok(doh_ok);
                }
            }
            return Err(sys_err);
        }
        None => {}
    }
    let doh_fut = resolve_doh_checked(host, port, true, route);
    tokio::pin!(doh_fut);
    tokio::select! {
        sys_res = &mut sys_fut => match sys_res {
            Ok(addrs) => Ok((addrs, CLIENT_TTL)),
            Err(sys_err) => match (&mut doh_fut).await {
                Ok(doh_ok) => {
                    crate::playback_log::record(
                        "network.dns_race_doh",
                        json!({"reason": "system_failed", "elapsed_ms": started.elapsed().as_millis() as u64}),
                    );
                    Ok(doh_ok)
                }
                Err(_) => Err(sys_err),
            },
        },
        doh_res = &mut doh_fut => match doh_res {
            Ok(doh_ok) => {
                crate::playback_log::record(
                    "network.dns_race_doh",
                    json!({"reason": "slow_system_dns", "elapsed_ms": started.elapsed().as_millis() as u64}),
                );
                Ok(doh_ok)
            }
            Err(_) => (&mut sys_fut).await.map(|addrs| (addrs, CLIENT_TTL)),
        },
    }
}

pub(crate) async fn client_for_dns(raw: &str, public_dns: bool) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("目标缺少主机名")?;
    let port = target.port_or_known_default().ok_or("目标端口无效")?;
    let route = ProxyRoute::for_config(&crate::proxy::snapshot(), &target);
    let proxy = route.active;
    let key = client_key(strict, host, port, public_dns, &route);
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    // Single-flight per (strict, host, port, dns, proxy, generation) key so concurrent
    // AES key + first segment requests share one DNS resolution and client build.
    let flight = {
        let mut flights = CLIENT_BUILDING.lock().map_err(|_| "HTTP 客户端锁失败")?;
        flights.retain(|_, w| w.strong_count() > 0);
        if let Some(existing) = flights.get(&key).and_then(Weak::upgrade) {
            existing
        } else {
            let created = Arc::new(ClientFlight::new());
            flights.insert(key.clone(), Arc::downgrade(&created));
            created
        }
    };
    let host_owned = host.to_string();
    let key_owned = key.clone();
    let target_for_build = target.clone();
    let result = flight
        .get_or_init(|| async move {
            {
                let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败".to_string())?;
                if let Some(http) = cached_client(&cache, &key_owned, Instant::now()) {
                    return Ok(http);
                }
            }
            let (addrs, ttl) = if proxy {
                // 有代理：跳过本地解析与 IP 校验，addrs 留空，域名交给代理。
                (Vec::new(), CLIENT_TTL)
            } else if public_dns {
                resolve_doh_checked(&host_owned, port, strict, &route).await?
            } else if strict {
                resolve_strict_fast(&target_for_build, &host_owned, port, &route).await?
            } else {
                (Vec::new(), CLIENT_TTL)
            };
            let http = Arc::new(build_client(&host_owned, &addrs, &route)?);
            let now = Instant::now();
            let mut cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败".to_string())?;
            // 同时到达的请求可能已完成解析；不延长已有结果的有效期。
            let http = cached_client(&cache, &key_owned, now).unwrap_or(http);
            if !cache.get(&key_owned).is_some_and(|(expires, _)| now < *expires) {
                cache.retain(|_, (expires, _)| now < *expires);
                if cache.len() >= 64 {
                    cache.clear();
                }
                cache.insert(key_owned, (now + ttl, http.clone()));
            }
            Ok(http)
        })
        .await
        .clone();
    if result.is_err() {
        if let Ok(mut flights) = CLIENT_BUILDING.lock() {
            if flights
                .get(&key)
                .and_then(Weak::upgrade)
                .is_some_and(|f| Arc::ptr_eq(&f, &flight))
            {
                flights.remove(&key);
            }
        }
    }
    result.map(|http| (target, http))
}

pub fn refresh_client() {
    clear_proxy_env_cache();
    if let Ok(mut matcher) = SYSTEM_PROXY_MATCHER.lock() {
        *matcher = None;
    }
    // A periodic main-site probe can rebuild clients without changing proxy or
    // line. Preserve KEY/SEG caches unless the actual configuration changed.
    refresh_media_scope();
    // Builders still resolving DNS must not repopulate the new generation.
    CLIENT_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
    if let Ok(mut flights) = CLIENT_BUILDING.lock() {
        flights.clear();
    }
    if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
        *routes = crate::media_dns::Routes::default();
    }
}

pub(crate) fn prefers_public_dns(host: &str) -> bool {
    MEDIA_DNS_ROUTES
        .lock()
        .ok()
        .is_some_and(|routes| routes.prefers_public(host, Instant::now()))
}

pub(crate) fn mark_public_dns(host: &str, ok: bool) {
    if let Ok(mut routes) = MEDIA_DNS_ROUTES.lock() {
        if ok {
            routes.remember(host, Instant::now());
        } else {
            routes.forget(host);
        }
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    get_with_dns(raw, timeout, accept, referer, false).await
}

pub(crate) async fn get_with_dns(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
    public_dns: bool,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for_dns(next.as_str(), public_dns).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

