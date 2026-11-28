//! 媒体层：封面解密 + HLS 代理。
//!
//! 当活动视频源通过 `manifest.media.imageDecrypt` 声明封面解密参数时在此解密，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

mod hls;
mod image;
mod response;
mod segment;

use tauri::http::Response;

#[cfg(test)]
pub(crate) use response::fixture_response;
use hls::{dec, load_playlist};
use image::load_image;
use segment::load_segment;
pub(crate) use segment::{is_cached_segment, load_segment_raw};
use response::{apply_byte_range, respond, segment_response, PROXIED_IMAGE_CACHE_CONTROL};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/shared/api/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux 走 loopback HTTP：WebKitGTK 的播放器是 GStreamer，它拿不到自定义 scheme。
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", all(target_os = "linux", not(target_env = "ohos")))))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

/// 清空封面 / 播放列表 / Key / 分片内存缓存
pub fn clear_caches() {
    crate::media_prefetch::clear();
    image::clear_cache();
    hls::clear_cache();
    segment::clear_cache();
}

pub fn cache_stats() -> (usize, usize, usize, u64, u64) {
    let (ic, ib, il) = image::stats();
    let (sc, sb, sl) = segment::stats();
    let (pc, pb, pl) = hls::stats();
    (ic, sc, pc, (ib + sb + pb) as u64, (il + sl + pl) as u64)
}

pub fn apply_cache_limits(l: &crate::cache::CacheBucketLimits) {
    image::set_limits(l.img_items, l.img_bytes);
    segment::set_limits(l);
    hls::set_limits(l.pl_items, l.pl_bytes);
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。正常情况下调用方直接传 [`LOCAL_ORIGIN`]。
pub async fn handle(path: &str, query: &str, origin: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let target = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = match path {
        "/img" => match load_image(&target).await {
            Ok((kind, bytes)) => respond(
                200,
                &kind,
                bytes.as_ref().clone(),
                PROXIED_IMAGE_CACHE_CONTROL,
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/hls" => match load_playlist(&target, origin).await {
            Ok(text) => respond(
                200,
                "application/vnd.apple.mpegurl",
                text.as_bytes().to_vec(),
                "no-store",
            ),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        "/seg" => match load_segment(&target).await {
            Ok((ctype, bytes)) => segment_response(&target, ctype.as_deref(), bytes.as_ref().clone(), origin),
            Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
        },
        _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
    };
    let response = apply_byte_range(response, range);
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "content_type": response.headers().get("Content-Type").and_then(|v| v.to_str().ok()), "content_range": response.headers().get("Content-Range").and_then(|v| v.to_str().ok()), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::hls::enc;
    use super::*;
    use crate::net::fetch_bytes;

    /// 联网测试：默认跳过，需要 HGHUBX_TEST_HLS_URL 传入真实 m3u8 地址。
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_HLS_URL，手动用 --ignored 运行"]
    async fn live_play_chain() {
        let url = crate::env::var("TEST_HLS_URL").expect("需要设置 HGHUBX_TEST_HLS_URL");
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }
}
