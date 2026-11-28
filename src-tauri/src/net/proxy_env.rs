/// 手动指定代理（排查 / 公司内网用）：`HGHUBX_PROXY=http://127.0.0.1:7897`。
/// 不设时交给 reqwest 的 `system-proxy` 探测（注册表 + 环境变量）。
pub(crate) fn proxy_override() -> Option<String> {
    crate::env::var("PROXY")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 进程环境变量里有没有代理（reqwest 的 `system-proxy` 会自己读这些，不重复应用）。
pub(crate) fn env_proxy_set() -> bool {
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
        .iter()
        .any(|key| std::env::var(key).ok().is_some_and(|v| !v.trim().is_empty()))
}

/// 应用层最终采用的显式代理（不含环境变量——那部分交给 reqwest）。
/// 优先级：`HGHUBX_PROXY` > 进程环境变量（reqwest 处理）> Linux GNOME gsettings。
pub(super) fn system_explicit_proxy() -> Option<String> {
    if let Some(p) = proxy_override() {
        return Some(p);
    }
    if env_proxy_set() {
        return None;
    }
    gnome_proxy()
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 读 GNOME 系统代理配置（gsettings）。gsettings 不存在 / schema 缺失时返回 None。
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(unquote(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn format_proxy_url(scheme: &str, host: &str, port: &str) -> String {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!("{scheme}://{host}:{port}")
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
static GNOME_PROXY_CACHE: once_cell::sync::Lazy<std::sync::Mutex<Option<(std::time::Instant, Option<String>)>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
const GNOME_PROXY_TTL: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) fn clear_proxy_env_cache() {
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    if let Ok(mut guard) = GNOME_PROXY_CACHE.lock() {
        *guard = None;
    }
}

/// Linux 桌面（GNOME）的固定手动代理：`mode=manual` 时取 http，为空再试 socks。
/// PAC（mode=auto）不支持，返回 None。结果短时缓存，避免每次媒体分片请求反复拉起 gsettings 进程。
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
pub(crate) fn gnome_proxy() -> Option<String> {
    let now = std::time::Instant::now();
    if let Ok(guard) = GNOME_PROXY_CACHE.lock() {
        if let Some((expires, cached)) = guard.as_ref() {
            if now < *expires {
                return cached.clone();
            }
        }
    }
    let detected = probe_gnome_proxy();
    if let Ok(mut guard) = GNOME_PROXY_CACHE.lock() {
        *guard = Some((now + GNOME_PROXY_TTL, detected.clone()));
    }
    detected
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn probe_gnome_proxy() -> Option<String> {
    if gsettings_get("org.gnome.system.proxy", "mode").as_deref() != Some("manual") {
        return None;
    }
    let http_host = gsettings_get("org.gnome.system.proxy.http", "host").unwrap_or_default();
    let http_port = gsettings_get("org.gnome.system.proxy.http", "port").unwrap_or_default();
    if !http_host.is_empty() && !http_port.is_empty() {
        return Some(format_proxy_url("http", &http_host, &http_port));
    }
    let socks_host = gsettings_get("org.gnome.system.proxy.socks", "host").unwrap_or_default();
    let socks_port = gsettings_get("org.gnome.system.proxy.socks", "port").unwrap_or_default();
    if !socks_host.is_empty() && !socks_port.is_empty() {
        return Some(format_proxy_url("socks5", &socks_host, &socks_port));
    }
    None
}

#[cfg(not(all(target_os = "linux", not(target_env = "ohos"))))]
pub(crate) fn gnome_proxy() -> Option<String> {
    None
}

/// Windows 系统代理：读 `HKCU\...\Internet Settings`，`ProxyEnable=1` 且 `ProxyServer`
/// 非空即视为已启用。reqwest 已开 `system-proxy` 会自动按注册表走，这里只返回 bool。
#[cfg(target_os = "windows")]
pub(super) fn windows_proxy_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return false;
    };
    let enabled: u32 = match key.get_value("ProxyEnable") {
        Ok(v) => v,
        Err(_) => return false,
    };
    if enabled != 1 {
        return false;
    }
    key.get_value::<String, _>("ProxyServer")
        .is_ok_and(|server| !server.trim().is_empty())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn windows_proxy_enabled() -> bool {
    false
}

/// macOS 系统代理：`scutil --proxy` 输出里 HTTP/HTTPS/SOCKS 任一项 Enable=1 即视为已启用。
#[cfg(target_os = "macos")]
fn macos_proxy_enabled() -> bool {
    let Ok(out) = std::process::Command::new("scutil").arg("--proxy").output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    ["HTTPEnable", "HTTPSEnable", "SOCKSEnable"]
        .iter()
        .any(|key| {
            text.lines().any(|line| {
                let mut parts = line.splitn(2, ':');
                parts.next().map(str::trim) == Some(*key)
                    && parts.next().map(|value| value.trim() == "1").unwrap_or(false)
            })
        })
}

#[cfg(not(target_os = "macos"))]
fn macos_proxy_enabled() -> bool {
    false
}

/// 操作系统级系统代理是否已启用（Windows 注册表 / macOS scutil / Linux GNOME），只报 bool。
pub(crate) fn system_proxy_enabled() -> bool {
    windows_proxy_enabled() || macos_proxy_enabled() || gnome_proxy().is_some()
}

