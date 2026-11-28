use super::client::refresh_media_scope;
use super::{LineConfig, BASE, BASE_FILE, DEFAULT_BASE};
use crate::network_policy;
use serde_json::{json, Value};

/// 当前上游基址（若本地尚未指定线路，则使用当前激活视频源的首个 origin）。
pub fn base() -> String {
    let cur = BASE
        .read()
        .map(|b| b.base.clone())
        .unwrap_or_default();
    if !cur.is_empty() {
        cur
    } else {
        crate::source::active_default_origin()
    }
}

/// 切换/激活视频源时同步当前线路基址：若 `line.json` 里已保存的线路属于新激活源的可信固定线路或已验证镜像，
/// 优先恢复该可用线路（切回原源时免去重撞不可达主域名或与会话 origin 失配）；否则回退为新源默认 origin。
pub fn sync_base_for_source(origin: &str) {
    let restored = BASE_FILE
        .read()
        .ok()
        .and_then(|f| f.as_ref().and_then(|p| std::fs::read_to_string(p).ok()))
        .and_then(|text| persisted_line(&text))
        .filter(|cfg| {
            !cfg.base.is_empty()
                && (crate::lines::is_fixed(&cfg.base) || crate::lines::is_trusted_mirror(&cfg.base))
        });
    let next = restored.unwrap_or_else(|| LineConfig {
        base: normalize_base(origin).unwrap_or_default(),
        custom: false,
    });
    if let Ok(mut current) = BASE.write() {
        if current.base != next.base || current.custom != next.custom {
            *current = next;
            drop(current);
            refresh_media_scope();
        }
    }
}

pub fn is_custom_line() -> bool {
    BASE.read().is_ok_and(|line| line.custom)
}

/// 线路必须是纯 HTTPS origin，不允许路径、认证、查询串或片段。
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target_with_mode(raw.trim(), true).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// 哪些 origin 允许携带凭据：当前激活视频源 manifest 声明的固定线路、
/// 本进程从激活源发现的可信镜像，或用户显式保存的自定义线路。
pub fn trusted_auth_origin(origin: &str) -> bool {
    !origin.is_empty()
        && (crate::lines::is_fixed(origin)
            || crate::lines::is_trusted_mirror(origin)
            || BASE.read().is_ok_and(|line| line.custom && line.base == origin))
}

pub(super) fn persisted_base(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    normalize_base(value.get("base")?.as_str()?)
}

pub(super) fn persisted_line(text: &str) -> Option<LineConfig> {
    let base = persisted_base(text)?;
    let value: Value = serde_json::from_str(text).ok()?;
    // Accept the fork's v2 format as well as legacy {base}. Only explicit v2
    // custom selections carry custom-origin consent across restarts.
    let custom = value.get("v").and_then(Value::as_u64) == Some(2)
        && value.get("custom").and_then(Value::as_bool).unwrap_or(false)
        && base != DEFAULT_BASE;
    Some(LineConfig { base, custom })
}

/// 启动时恢复旧线路，但本地文件本身不会授予镜像凭据权限。
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    crate::proxy::bind(dir);
    let path = dir.join("line.json");
    let restored = std::fs::read_to_string(&path).ok()
        .and_then(|text| persisted_line(&text)).unwrap_or_default();
    if let Ok(mut current) = BASE.write() {
        *current = restored;
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
    refresh_media_scope();
}

/// 切换线路并落盘，返回规整后的地址。
pub fn set_base(url: &str) -> Result<String, String> {
    apply_base(url, false)
}

/// An explicit custom selection, separate from published/automatic candidates.
pub fn set_custom_base(url: &str) -> Result<String, String> {
    apply_base(url, true)
}

pub(super) fn save_line(current: &mut LineConfig, next: LineConfig, path: Option<&std::path::Path>) -> Result<(), String> {
    if let Some(path) = path {
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json!({ "v": 2, "base": next.base, "custom": next.custom }).to_string())
            .and_then(|_| std::fs::rename(&temp, path))
            .map_err(|_| "线路保存失败，已保持原线路，请检查应用数据目录")?;
    }
    *current = next;
    Ok(())
}

fn apply_base(url: &str, custom: bool) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    if !custom && !crate::lines::is_fixed(&next) && !crate::lines::is_trusted_mirror(&next) {
        return Err("线路不在固定线路或可信发布页清单中".into());
    }
    let mut current = BASE.write().map_err(|_| "线路设置锁失败")?;
    let previous = current.base.clone();
    let file = BASE_FILE.read().map_err(|_| "线路配置锁失败")?;
    save_line(&mut current, LineConfig { base: next.clone(), custom: custom && next != DEFAULT_BASE }, file.as_deref())?;
    drop(current);
    if previous != next {
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}
