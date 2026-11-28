//! Source package manifest, share-code (`hghubx-src://`) codec, and schema validation.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const SHARE_CODE_PREFIX: &str = "hghubx-src://";
pub const CURRENT_SCHEMA_VERSION: u32 = 1;
pub const SUPPORTED_API_VERSION: &str = "1";
pub const MAX_SHARE_CODE_BYTES: usize = 512 * 1024;
pub const MAX_PACKAGE_JSON_BYTES: usize = 512 * 1024;
pub const MAX_CODE_BYTES: usize = 256 * 1024;
pub const MAX_ORIGINS: usize = 16;
pub const MAX_UPDATE_URLS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRuntime {
    pub kind: String,
    #[serde(default = "default_entry")]
    pub entry: String,
}

fn default_entry() -> String {
    "inline".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceNetwork {
    #[serde(default)]
    pub origins: Vec<String>,
    #[serde(default)]
    pub media_origins: Vec<String>,
    #[serde(default)]
    pub publish_origins: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCapabilities {
    #[serde(default)]
    pub categories: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topics: Option<bool>,
    #[serde(default)]
    pub tags: bool,
    #[serde(default)]
    pub rankings: bool,
    #[serde(default)]
    pub authors: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetailCapabilities {
    #[serde(default)]
    pub episodes: bool,
    #[serde(default)]
    pub related: bool,
    #[serde(default)]
    pub comments: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackCapabilities {
    #[serde(default)]
    pub hls: bool,
    #[serde(default)]
    pub mp4: bool,
    #[serde(default)]
    pub subtitles: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapabilities {
    #[serde(default)]
    pub home: bool,
    #[serde(default)]
    pub search: bool,
    #[serde(default)]
    pub catalog: CatalogCapabilities,
    #[serde(default)]
    pub detail: DetailCapabilities,
    #[serde(default)]
    pub playback: PlaybackCapabilities,
    #[serde(default)]
    pub posts: bool,
    #[serde(default)]
    pub account: bool,
    #[serde(default)]
    pub lines: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageDecryptConfig {
    pub algorithm: String,
    pub key: String,
    pub iv: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceMediaConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_decrypt: Option<ImageDecryptConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogChannel {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sorts: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogShortcut {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sorts: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceCatalogConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shortcuts: Vec<CatalogShortcut>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channels: Vec<CatalogChannel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLinksConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_id_path_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    pub runtime: SourceRuntime,
    #[serde(default)]
    pub network: SourceNetwork,
    #[serde(default)]
    pub capabilities: SourceCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<SourceMediaConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<SourceCatalogConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub links: Option<SourceLinksConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSignature {
    pub algorithm: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    pub sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourcePackage {
    pub schema_version: u32,
    pub manifest: SourceManifest,
    pub code: String,
    #[serde(default)]
    pub update_urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<SourceSignature>,
}

/// Encode a `SourcePackage` as a Legado-style clipboard share code (`hghubx-src://<gzip+b64url>`).
pub fn encode_share_code(pkg: &SourcePackage) -> Result<String, String> {
    let raw = serde_json::to_vec(pkg).map_err(|e| format!("序列化视频源失败：{e}"))?;
    if raw.len() > MAX_PACKAGE_JSON_BYTES {
        return Err("视频源体积超出限制（最大 512 KB）".into());
    }
    let mut enc = GzEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&raw)
        .map_err(|e| format!("压缩分享口令失败：{e}"))?;
    let gz = enc.finish().map_err(|e| format!("结束压缩失败：{e}"))?;
    Ok(format!("{SHARE_CODE_PREFIX}{}", B64_URL.encode(gz)))
}

/// Decode either a `hghubx-src://` share code or raw JSON text into a `SourcePackage`.
pub fn decode_package_input(raw: &str) -> Result<SourcePackage, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请输入视频源口令、JSON 内容或 HTTPS 链接".into());
    }
    if trimmed.len() > MAX_SHARE_CODE_BYTES {
        return Err("视频源输入体积超出限制（最大 512 KB）".into());
    }
    if let Some(rest) = trimmed.strip_prefix(SHARE_CODE_PREFIX) {
        let compact: String = rest.chars().filter(|c| !c.is_whitespace()).collect();
        let gz = B64_URL
            .decode(compact.as_bytes())
            .map_err(|_| "分享口令编码无效（Base64URL 解码失败）")?;
        let decoder = GzDecoder::new(&gz[..]);
        let mut out = Vec::new();
        decoder
            .take(MAX_PACKAGE_JSON_BYTES as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|_| "分享口令解压失败，请确认复制完整")?;
        if out.len() > MAX_PACKAGE_JSON_BYTES {
            return Err("分享口令解压后超出大小上限（最大 512 KB）".into());
        }
        return serde_json::from_slice::<SourcePackage>(&out)
            .map_err(|e| format!("分享口令内容格式无效：{e}"));
    }
    if trimmed.starts_with('{') {
        if trimmed.len() > MAX_PACKAGE_JSON_BYTES {
            return Err("视频源 JSON 超出大小上限（最大 512 KB）".into());
        }
        return serde_json::from_str::<SourcePackage>(trimmed)
            .map_err(|e| format!("视频源 JSON 格式无效：{e}"));
    }
    Err("无法识别的格式：请粘贴 hghubx-src:// 口令、JSON 文本或 https:// 链接".into())
}

pub fn parse_semver(version: &str) -> Option<(u32, u32, u32)> {
    let core = version.trim().split('-').next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn semver_gt(candidate: &str, current: &str) -> bool {
    match (parse_semver(candidate), parse_semver(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

pub fn is_safe_id(id: &str) -> bool {
    (3..=96).contains(&id.len())
        && !id.contains("..")
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_'))
        && id.as_bytes().first().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.as_bytes().last().is_some_and(|b| b.is_ascii_alphanumeric())
}

fn validate_origin_list(label: &str, list: &[String], max: usize) -> Result<(), String> {
    if list.len() > max {
        return Err(format!("{label} 数量超出限制（最多 {max} 个）"));
    }
    for raw in list {
        let parsed = crate::network_policy::parse_target(raw)
            .map_err(|e| format!("{label} 包含非法地址（{raw}）：{e}"))?;
        if parsed.scheme() != "https" {
            return Err(format!("{label} 必须使用 https:// 地址：{raw}"));
        }
    }
    Ok(())
}

pub fn validate_package(pkg: &SourcePackage) -> Result<(), String> {
    if pkg.schema_version != CURRENT_SCHEMA_VERSION || pkg.manifest.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "不支持的视频源格式版本（schemaVersion={}，当前支持 {}）",
            pkg.schema_version, CURRENT_SCHEMA_VERSION
        ));
    }
    if pkg.manifest.api_version.trim() != SUPPORTED_API_VERSION {
        return Err(format!(
            "不兼容的契约版本（apiVersion={}，当前客户端支持 {}）",
            pkg.manifest.api_version, SUPPORTED_API_VERSION
        ));
    }
    if !is_safe_id(&pkg.manifest.id) {
        return Err("视频源 id 无效：仅允许 3~96 位小写字母、数字、点、横杠或下划线".into());
    }
    if parse_semver(&pkg.manifest.version).is_none() || pkg.manifest.version.len() > 32 || pkg.manifest.version.contains("..") || pkg.manifest.version.contains('/') || pkg.manifest.version.contains('\\') {
        return Err("视频源版本号必须符合语义化版本（如 1.0.0）".into());
    }
    let name = pkg.manifest.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.contains('<') || name.contains('>') {
        return Err("视频源名称无效（不能为空、不超过 80 字符且不含 HTML 标签）".into());
    }
    if pkg.manifest.runtime.kind != "quickjs" {
        return Err(format!(
            "不支持的运行环境：{}（当前版本仅支持 quickjs）",
            pkg.manifest.runtime.kind
        ));
    }
    if pkg.manifest.runtime.entry.contains("..") || pkg.manifest.runtime.entry.starts_with('/') || pkg.manifest.runtime.entry.starts_with('\\') {
        return Err("runtime.entry 包含非法路径".into());
    }
    let caps = &pkg.manifest.capabilities;
    let has_playback = caps.playback.hls || caps.playback.mp4;
    let offline_demo = pkg.manifest.network.origins.is_empty()
        && pkg.manifest.network.media_origins.is_empty()
        && pkg.manifest.network.publish_origins.is_empty();
    if !caps.search || !caps.detail.episodes || (!has_playback && !offline_demo) {
        return Err("视频源缺少必选核心能力（需要 search、detail.episodes 与 playback）".into());
    }
    if pkg.code.trim().is_empty() {
        return Err("视频源脚本 code 不能为空".into());
    }
    if pkg.code.len() > MAX_CODE_BYTES {
        return Err("视频源脚本超出大小上限（最大 256 KB）".into());
    }
    validate_origin_list("network.origins", &pkg.manifest.network.origins, MAX_ORIGINS)?;
    validate_origin_list("network.mediaOrigins", &pkg.manifest.network.media_origins, MAX_ORIGINS)?;
    validate_origin_list("network.publishOrigins", &pkg.manifest.network.publish_origins, MAX_ORIGINS)?;
    validate_origin_list("updateUrls", &pkg.update_urls, MAX_UPDATE_URLS)?;
    if let Some(dec) = pkg.manifest.media.as_ref().and_then(|m| m.image_decrypt.as_ref()) {
        parse_image_decrypt_bytes(dec)?;
    }
    if let Some(cat) = pkg.manifest.catalog.as_ref() {
        if cat.shortcuts.len() > 8 {
            return Err("catalog.shortcuts 数量超出限制（最多 8 个）".into());
        }
        for sc in &cat.shortcuts {
            let sc_id = sc.id.trim();
            let sc_label = sc.label.trim();
            if sc_id.is_empty()
                || sc_id.chars().count() > 64
                || sc_label.is_empty()
                || sc_label.chars().count() > 64
                || sc_label.contains('<')
                || sc_label.contains('>')
            {
                return Err("catalog.shortcuts 条目无效（id 与 label 不能为空、不超过 64 字符且不含 HTML 标签）".into());
            }
            if let Some(icon) = sc.icon.as_deref() {
                let ic = icon.trim();
                if ic.is_empty() || ic.chars().count() > 24 || ic.contains('<') || ic.contains('>') {
                    return Err("catalog.shortcuts.icon 无效".into());
                }
            }
            if sc.sorts.len() > 16
                || sc.sorts.iter().any(|s| s.trim().is_empty() || s.chars().count() > 32)
            {
                return Err("catalog.shortcuts.sorts 条目无效".into());
            }
        }
        if cat.channels.len() > 24 {
            return Err("catalog.channels 数量超出限制（最多 24 个）".into());
        }
        for ch in &cat.channels {
            let ch_id = ch.id.trim();
            let ch_label = ch.label.trim();
            if ch_id.is_empty()
                || ch_id.chars().count() > 64
                || ch_label.is_empty()
                || ch_label.chars().count() > 64
                || ch_label.contains('<')
                || ch_label.contains('>')
            {
                return Err("catalog.channels 条目无效（id 与 label 不能为空、不超过 64 字符且不含 HTML 标签）".into());
            }
            if let Some(icon) = ch.icon.as_deref() {
                let ic = icon.trim();
                if ic.is_empty() || ic.chars().count() > 24 || ic.contains('<') || ic.contains('>') {
                    return Err("catalog.channels.icon 无效".into());
                }
            }
            if ch.sorts.len() > 16
                || ch.sorts.iter().any(|s| s.trim().is_empty() || s.chars().count() > 32)
            {
                return Err("catalog.channels.sorts 条目无效".into());
            }
        }
    }
    if let Some(links) = pkg.manifest.links.as_ref() {
        if let Some(pat) = links.video_id_path_pattern.as_deref() {
            if pat.trim().is_empty() || pat.len() > 128 {
                return Err("links.videoIdPathPattern 长度无效（需为 1~128 字符）".into());
            }
        }
    }
    Ok(())
}

pub fn decode_16_bytes(raw: &str) -> Result<[u8; 16], String> {
    if raw.len() == 16 && raw.is_ascii() {
        let mut out = [0u8; 16];
        out.copy_from_slice(raw.as_bytes());
        return Ok(out);
    }
    use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
    let bytes = B64_STD
        .decode(raw.trim().as_bytes())
        .or_else(|_| B64_URL.decode(raw.trim().as_bytes()))
        .map_err(|_| "media.imageDecrypt 密钥/IV 编码无效".to_string())?;
    bytes
        .try_into()
        .map_err(|_| "media.imageDecrypt 密钥与 IV 必须为 16 字节".to_string())
}

pub fn parse_image_decrypt_bytes(cfg: &ImageDecryptConfig) -> Result<([u8; 16], [u8; 16]), String> {
    if !cfg.algorithm.eq_ignore_ascii_case("aes-128-cbc") {
        return Err(format!("不支持的封面解密算法：{}", cfg.algorithm));
    }
    Ok((decode_16_bytes(&cfg.key)?, decode_16_bytes(&cfg.iv)?))
}
