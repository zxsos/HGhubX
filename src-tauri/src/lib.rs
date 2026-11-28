mod api;
mod apple_proxy;
mod authors;
mod cache;
mod env;
#[cfg(target_os = "ios")]
mod ios_layout;
#[cfg(any(target_os = "ios", test))]
mod ios_media_http;
mod lines;
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
mod linux_http;
#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
mod linux_webview;
mod logging;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod media;
mod media_dns;
mod media_prefetch;
mod media_stats;
mod net;
mod net_diag;
mod network_policy;
mod playback_log;
mod proxy;
mod session;
mod source;
mod updater;

use api::Api;
use tauri::Manager;

/// AVFoundation loads media outside WKWebView's custom protocol handler.
/// Start its loopback bridge only when an iOS native player requests it.
#[tauri::command]
async fn media_http_origin() -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        ios_media_http::origin().await
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("原生媒体 HTTP 通道仅适用于 iOS".into())
    }
}

#[cfg(target_env = "ohos")]
static OHOS_BACK_INTERCEPT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

/// 鸿蒙系统边缘返回拦截开关：前端存在子页/弹层/全屏/非首页时拦截并派发 `hg:ohos-back`，
/// 位于首页根层级且无覆层时置 false，交回鸿蒙系统执行默认退后台。
#[tauri::command]
fn set_back_intercept(enabled: bool) -> Result<(), String> {
    #[cfg(target_env = "ohos")]
    OHOS_BACK_INTERCEPT.store(enabled, std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(target_env = "ohos"))]
    let _ = enabled;
    Ok(())
}

fn allowed_dev_host(host: &str) -> bool {
    if matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
        return true;
    }
    if let Some(configured) = option_env!("TAURI_DEV_HOST") {
        if host.eq_ignore_ascii_case(configured.trim()) {
            return true;
        }
    }
    std::env::var("TAURI_DEV_HOST")
        .ok()
        .is_some_and(|v| host.eq_ignore_ascii_case(v.trim()))
}

fn allowed_frontend_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    // 移动端开发可能使用 TAURI_DEV_HOST；严格模式下仅放行本机或显式配置的 TAURI_DEV_HOST。
    cfg!(debug_assertions)
        && url::Url::parse(origin).is_ok_and(|u| {
            u.scheme() == "http"
                && u.port() == Some(1420)
                && (!network_policy::strict_security()
                    || u.host_str().is_some_and(allowed_dev_host))
        })
}

#[cfg(all(desktop, not(target_env = "ohos")))]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg(all(desktop, not(target_env = "ohos")))]
fn deliver_desktop_deep_link(app: &tauri::AppHandle, raw: &str) {
    let trimmed = raw.trim();
    if !trimmed.to_ascii_lowercase().starts_with("hghubx://") {
        return;
    }
    source::commands::set_pending_deep_link(trimmed.to_string());
    focus_main_window(app);
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(quoted) = serde_json::to_string(trimmed) {
            let script = format!(
                "(function(){{if(window.__HG_DEEP_LINK_HANDLED__==={q})return;window.__HG_DEEP_LINK__={q};window.dispatchEvent(new CustomEvent('hg:deep-link',{{detail:{q}}}));}})();",
                q = quoted
            );
            let _ = win.eval(&script);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg_attr(target_env = "ohos", tauri::ohos::entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(all(desktop, not(target_env = "ohos")))]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                focus_main_window(app);
                if let Some(link) = argv
                    .iter()
                    .skip(1)
                    .find(|a| a.trim().to_ascii_lowercase().starts_with("hghubx://"))
                {
                    deliver_desktop_deep_link(app, link);
                }
            }))
            .plugin(tauri_plugin_deep_link::init());
    }
    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Api::new())
        .on_page_load(|webview, payload| {
            #[cfg(target_os = "ios")]
            {
                let finished = payload.event() == tauri::webview::PageLoadEvent::Finished;
                ios_layout::apply(webview, finished);
                if finished {
                    // 默认关闭 WKWebView 文本交互，消除视频长按快进时的系统放大镜。
                    // 前端在输入框聚焦时再按需打开（见 api::set_text_interaction）。
                    ios_layout::set_text_interaction_on_webview(webview, false);
                    let wv = (*webview).clone();
                    tauri::async_runtime::spawn(async move {
                        for delay_ms in [80_u64, 350] {
                            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                            ios_layout::apply(&wv, true);
                        }
                    });
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (webview, payload);
        })
        .setup(|app| {
            #[cfg(all(desktop, not(target_env = "ohos")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                if let Some(link) = std::env::args()
                    .skip(1)
                    .find(|a| a.trim().to_ascii_lowercase().starts_with("hghubx://"))
                {
                    source::commands::set_pending_deep_link(link.trim().to_string());
                } else if let Ok(Some(urls)) = app.deep_link().get_current() {
                    if let Some(url) = urls
                        .into_iter()
                        .find(|u| u.scheme().eq_ignore_ascii_case("hghubx"))
                    {
                        source::commands::set_pending_deep_link(url.to_string());
                    }
                }

                #[cfg(any(target_os = "windows", all(target_os = "linux", not(target_env = "ohos"))))]
                {
                    let _ = app.deep_link().register_all();
                }

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.scheme().eq_ignore_ascii_case("hghubx") {
                            deliver_desktop_deep_link(&handle, url.as_str());
                            break;
                        }
                    }
                });
            }
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                // 上次选择的线路（设置 → 线路）在启动时恢复
                net::bind_base(&dir);
                cache::bind(&dir);
                playback_log::bind(&dir);
                source::bind(&dir);
                let state: tauri::State<Api> = app.state();
                state.session.bind(dir);
            }
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                updater::cleanup_tv_updates(&cache_dir);
            }
            // Linux 的 <video> 由 GStreamer 播放，它只认常规 HTTP scheme；
            // 这里起一个 loopback 代理，前端与 m3u8 改写都指向它（见 linux_http.rs）
            #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
            linux_http::start();
            // macOS 主窗口在此创建：先按系统红绿灯尺寸算出居中位置（见 macos_titlebar.rs）
            #[cfg(target_os = "macos")]
            macos_titlebar::create_main_window(app)?;
            // 鸿蒙 MainPage.onBackPress 默认回退 true 会吞掉系统边缘返回手势；
            // 在此桥接至前端 `hg:ohos-back`，并按 `OHOS_BACK_INTERCEPT` 决定是否交回系统退后台。
            #[cfg(target_env = "ohos")]
            {
                use tauri::Emitter;
                if let Some(ohos_app) = tauri::ohos::APP
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone())
                {
                    let back_handle = app.handle().clone();
                    ohos_app.on_back_press_intercept(move || {
                        if !OHOS_BACK_INTERCEPT.load(std::sync::atomic::Ordering::Relaxed) {
                            return false;
                        }
                        let _ = back_handle.emit("hg:ohos-back", ());
                        true
                    });
                }
            }
            Ok(())
        })
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-guard")
                .on_webview_ready(|webview| {
                    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
                    linux_webview::configure(&webview);
                    #[cfg(not(all(target_os = "linux", not(target_env = "ohos"))))]
                    let _ = webview;
                })
                .on_navigation(|_webview, url| {
                    let host = url.host_str().unwrap_or("");
                    (url.scheme() == "tauri" && host == "localhost")
                        // Android 上自定义协议表现为 http://<scheme>.localhost，WebView 有时把它
                        // 当成一次导航进来。这是进程内的媒体代理地址，不出网，严格模式也不该拦。
                        || (matches!(url.scheme(), "http" | "https") && network_policy::is_internal_webview_host(host))
                        || allowed_frontend_origin(&url.origin().ascii_serialization())
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("hg", |_app, request, responder| {
            let request_origin = request
                .headers()
                .get("Origin")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if playback_log::enabled() {
                let resource = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                    .find(|(key, _)| key == "u")
                    .map(|(_, value)| playback_log::resource_id(&value));
                let route = match request.uri().path() { "/hls" => "playlist", "/seg" => "segment_or_key", "/img" => "image", _ => "unknown" };
                let range = request.headers().get("Range").and_then(|v| v.to_str().ok())
                    .filter(|v| v.len() <= 100 && v.bytes().all(|b| b.is_ascii_digit() || b"bytes=,- ".contains(&b)));
                let origin_kind = match request_origin.as_deref() { None => "missing", Some("null") => "null", Some(origin) if allowed_frontend_origin(origin) => "app", _ => "other" };
                playback_log::record("protocol.request", serde_json::json!({"resource": resource, "route": route, "method": request.method().as_str(), "range": range, "origin_kind": origin_kind}));
            }
            // 部分 Android WebView 在拦截 http://<scheme>.localhost 时给不出 Origin（或给空串），
            // 严格模式下会被误判成外部来源直接 403 —— 这就是「接口通了、m3u8 却立刻 networkError」。
            // 这条通道只通向 media::handle 的 /img /hls /seg，后端仍按严格模式做 SSRF 校验，
            // 所以缺 Origin 放行不等于开了个开放代理。
            let origin_ok = match request_origin.as_deref() {
                // WebView 拦截自定义协议时可能是 None、空串，甚至字面量 "null"（sandbox 语义）
                None | Some("") | Some("null") => true,
                Some(origin) => allowed_frontend_origin(origin),
            };
            if !origin_ok {
                playback_log::record("security.origin_denied", serde_json::json!({"origin_null": request_origin.as_deref() == Some("null")}));
                responder.respond(
                    tauri::http::Response::builder()
                        .status(403)
                        .body(b"origin denied".to_vec())
                        .unwrap(),
                );
                return;
            }
            let uri = request.uri().clone();
            let path = uri.path().to_string();
            let query = uri.query().unwrap_or("").to_string();
            // iOS 原生播放器会用小范围请求探测资源。只处理无条件、单头 GET Range；
            // 尚无 ETag/Last-Modified 可校验时，If-Range 保守退回完整响应。
            let range = if request.method() == tauri::http::Method::GET
                && !request.headers().contains_key("If-Range")
                && request.headers().get_all("Range").iter().count() == 1
            {
                request.headers().get("Range").and_then(|v| v.to_str().ok()).map(str::to_owned)
            } else {
                None
            };
            // 自定义协议基址随平台不同，统一定义在 media::LOCAL_ORIGIN
            // （Windows/Android 是 http://<scheme>.localhost，macOS/iOS/Linux 是 <scheme>://localhost）。
            // 它同时是 m3u8 分片/key 改写用的前缀，必须与前端 src/shared/api/api.ts 的 LOCAL 一致。
            tauri::async_runtime::spawn(async move {
                let mut resp = media::handle(&path, &query, media::LOCAL_ORIGIN, range.as_deref()).await;
                if let Some(origin) =
                    request_origin.and_then(|s| tauri::http::HeaderValue::from_str(&s).ok())
                {
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", origin);
                    resp.headers_mut()
                        .insert("Vary", tauri::http::HeaderValue::from_static("Origin"));
                } else {
                    // WKWebView 内部页面可能不给 Origin；这时回 * 才能拿到分片
                    resp.headers_mut()
                        .insert("Access-Control-Allow-Origin", tauri::http::HeaderValue::from_static("*"));
                }
                responder.respond(resp);
            });
        })
        .invoke_handler(tauri::generate_handler![
            api::platform::app_boot,
            media_http_origin,
            media_stats::media_rx_bytes,
            set_back_intercept,
            playback_log::playback_log_status,
            playback_log::playback_log_set,
            playback_log::playback_log_write,
            playback_log::playback_log_read,
            playback_log::playback_log_export_full,
            playback_log::playback_log_reveal_export,
            api::platform::security_set,
            api::platform::debug_log,
            api::platform::net_diag,
            api::lines::line_state,
            api::lines::line_set,
            api::lines::line_custom_set,
            api::lines::line_reset,
            api::lines::line_cancel,
            api::lines::line_mirrors,
            api::lines::line_probe,
            api::lines::line_auto,
            api::lines::line_try_main,
            api::lines::line_health,
            api::lines::proxy_state,
            api::lines::proxy_set,
            api::lines::proxy_test,
            api::update::check_update,
            api::update::download_tv_update,
            api::update::cancel_tv_update,
            api::update::open_url,
            api::platform::set_orientation,
            api::platform::set_text_interaction,
            api::account::api_login,
            api::account::api_register,
            api::account::api_logout,
            api::account::api_me,
            api::account::api_account_history,
            api::account::api_account_history_record,
            api::account::api_account_history_delete,
            api::feed::api_feed,
            api::feed::api_original_videos,
            api::feed::api_topics,
            api::feed::api_topic,
            api::feed::api_tags,
            api::feed::api_hot_tags,
            api::feed::api_tag_videos,
            api::feed::api_post_tag,
            api::feed::api_category,
            api::feed::api_rank,
            api::feed::api_search,
            api::feed::api_search_hot,
            api::platform::cache_stats,
            api::platform::cache_clear,
            api::platform::cache_set_limit,
            api::feed::api_posts,
            api::feed::api_post,
            api::feed::api_post_playback,
            api::interact::api_post_like,
            api::interact::api_post_collect,
            api::interact::api_post_comments,
            api::feed::api_post_categories,
            api::feed::api_post_category,
            api::feed::api_related,
            api::feed::api_following,
            api::feed::api_user,
            api::feed::api_user_stats,
            api::feed::api_user_videos,
            authors::api_popular_authors,
            api::video::api_video,
            api::video::api_play,
            api::video::api_comments,
            api::video::api_comment_send,
            api::interact::api_like,
            api::interact::api_collect,
            api::interact::api_follow,
            source::commands::source_state,
            source::commands::source_import,
            source::commands::source_resolve_import,
            source::commands::source_import_subscription,
            source::commands::source_probe_subscription,
            source::commands::source_activate,
            source::commands::source_rollback,
            source::commands::source_remove,
            source::commands::source_remove_many,
            source::commands::source_set_allow_untrusted,
            source::commands::source_export_share_code,
            source::commands::source_check_update,
            source::commands::source_test,
            source::commands::source_take_deep_link,
            source::lan_push::source_lan_push_start,
            source::lan_push::source_lan_push_stop,
            source::lan_push::source_lan_push_status,
            source::lan_push::source_lan_push_to_tv,
            source::lan_push::tv_peer_start,
            source::lan_push::tv_peer_update_snapshot,
            source::lan_push::tv_peer_discover,
            source::lan_push::tv_peer_list,
            source::lan_push::tv_peer_remove,
            source::lan_push::tv_peer_pair_qr,
            source::lan_push::tv_peer_pair_code,
            source::lan_push::tv_peer_sync,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
