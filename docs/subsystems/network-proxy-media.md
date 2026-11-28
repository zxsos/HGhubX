# 网络、代理与媒体

## 责任与边界

网络层负责通用 HTTP(S) 客户端缓存、系统/自定义代理、DNS 解析与地址固定、逐跳重定向、超时与
有限重试、媒体字节下载、诊断和脱敏；业务接口的协议封装、请求信封与加解密已全部交由 QuickJS
视频源插件通过受限 `host.fetch` 与 `host.crypto` 承担，Rust 壳不包含站点专属网关协议。
媒体层复用同一套网络策略，把封面、HLS 清单、密钥和分片经本地路由交给 WebView/原生播放器。

不在这里负责：线路候选与持久化（见 [upstream-lines.md](upstream-lines.md)）、播放器的 HLS 恢复
状态机（见 [playback.md](playback.md)）、平台监听器的生命周期（见
[platform-shells.md](platform-shells.md)）。

## 事实来源

- 下载与重试：[`src-tauri/src/net/edge.rs`](../../src-tauri/src/net/edge.rs) 的 `retryable_error()`、
  `with_retry()`、`fetch_bytes()`、`fetch_bytes_with_url()`（流式分块读取并向 [`src-tauri/src/media_stats.rs`](../../src-tauri/src/media_stats.rs) 的无锁原子计数器 `MEDIA_RX_BYTES` 累计接收字节，供前端缓冲态经 `media_rx_bytes` 计算实时网速；`edge_redirect_target()` 仅用于 `#[cfg(test)]`）。
- 源沙箱 HTTP 与加密原语：[`src-tauri/src/source/runtime.rs`](../../src-tauri/src/source/runtime.rs) 的
  `host_http_request()`、`send_host_attempt()`、`run_crypto_op()`（`host.fetch` 与 `host.crypto`）。
- 线路基准同步：[`src-tauri/src/net/line.rs`](../../src-tauri/src/net/line.rs) 的
  `base()`、`sync_base_for_source()`、`normalize_base()`。
- 客户端与 DNS 固定：[`src-tauri/src/net/client.rs`](../../src-tauri/src/net/client.rs) 的
  `build_client()`、`ProxyRoute`、`client_key()`、`client_for_dns()`、`prefers_public_dns()`、
  `mark_public_dns()`、`CLIENTS`、`CLIENT_TTL`、`refresh_client()`、`RequestScope`、`request_scope()`、
  `refresh_media_scope()`、`system_proxy_fingerprint()`、`get()`、`get_with_dns()`；
  `reqwest` 精简启用 `rustls-tls`、`system-proxy`、`socks`、`gzip`、`json`（不含 `brotli`/`charset`）。
- 代理配置：[`src-tauri/src/proxy.rs`](../../src-tauri/src/proxy.rs) 的 `Mode`、`Config`、
  `bind()`、`set()`、`normalize_proxy()`、`write_atomic()`；系统探测在
  [`src-tauri/src/net/proxy_env.rs`](../../src-tauri/src/net/proxy_env.rs) 的
  `proxy_override()`、`system_explicit_proxy()`、`gnome_proxy()`、`windows_proxy_enabled()`、
  `macos_proxy_enabled()`。
- 公网 DNS 回退：[`src-tauri/src/media_dns.rs`](../../src-tauri/src/media_dns.rs) 的 `HOST`、
  `BOOTSTRAP`、`resolve()`、`answers()`、`eligible()`、`Routes`。
- 地址策略：[`src-tauri/src/network_policy.rs`](../../src-tauri/src/network_policy.rs) 的
  `strict_security()`、`parse_target()`、`parse_target_with_mode()`、`allowed_ip()`、
  `resolve_target()`、`redirect_target()`。
- 媒体入口与整形：[`src-tauri/src/media/mod.rs`](../../src-tauri/src/media/mod.rs) 的
  `LOCAL_ORIGIN`、`handle()`、`clear_caches()`；
  [`hls.rs`](../../src-tauri/src/media/hls.rs) 的 `load_playlist()`、`rewrite_playlist()`；
  [`image.rs`](../../src-tauri/src/media/image.rs) 的 `load_image()`；
  [`segment.rs`](../../src-tauri/src/media/segment.rs) 的 `load_segment()`、`load_segment_raw()`；
  [`response.rs`](../../src-tauri/src/media/response.rs) 的 `respond()`、`apply_byte_range()`、
  `segment_response()`；
  HLS 并发预读：[`src-tauri/src/media_prefetch.rs`](../../src-tauri/src/media_prefetch.rs) 的
  `on_playlist()`、`on_segment_access()`、`clear()`。
- 诊断、脱敏与错误层：[`src-tauri/src/net_diag.rs`](../../src-tauri/src/net_diag.rs) 的
  `diagnose()`、`proxy_state()`、`test_proxy()`；
  [`src-tauri/src/net/redact.rs`](../../src-tauri/src/net/redact.rs) 的
  `redact_proxy()`、`is_proxy_error()`、`heal_client()`、`err_text()`、
  `redact_error_proxy_auth()`；
  前端统一错误归一化 [`src/shared/api/errorFormat.ts`](../../src/shared/api/errorFormat.ts)
  （`classifyApiError()`、`formatErrorWithCode()`、`sanitizeErrorForLog()`）与
  [`src/shared/api/api.ts`](../../src/shared/api/api.ts) 的 `call()`/`READ_ONLY`。

## 主运行时路径

1. 业务接口由各模块经 `Api::source_call()` / `account_source_call()` 委托给 QuickJS 视频源插件；
   插件通过 `host.fetch()`（即 `host_http_request()`）发起 HTTPS 请求，复用 `net::client_for_dns()`
   （共享 `CLIENTS` 180 秒 HTTP/2 连接池与固定 DNS 缓存，按同一代理/严格模式/重定向守卫运行），并强制校验目标与重定向
   origin 属于 `manifest.network` 白名单、过滤 `Cookie`/`Host` 等受限头、限制响应体积 2 MB。直连无代理且遇
   `media_dns::eligible()` 错误（含 `InvalidContentType` 明文响应、超时、DNS 失败；非幂等写请求仅在连接/TLS 握手
   尚未发出 HTTP 请求前重试）时自动切换至 AliDNS DoH 回退并在 `MEDIA_DNS_ROUTES` 记忆成功路由。
   `source/runtime.rs` 将插件抛出的 `"401"` / `status: 401` / `"HTTP 401..."` 统一规范为 `"401"`，其余 `"HTTP <nnn>..."`
   原样透传以供前端识别 403 并触发自动切线；同时在 `HOST_SHIM_JS` 标记宿主网络/桥接错误（`__isHostError` → `__hostError`）
   并与脚本自身异常（`__sourceError`）分离返回，剥离 QuickJS 内部 `eval_script` 堆栈。前端 `api.ts` 的 `call()` 统一经
   `classifyApiError()` 归类，界面只展示「简明中文原因 + 统一代号」（`NET_TIMEOUT`/`NET_DNS`/`NET_PROXY`/`NET_TLS`/
   `NET_CONN`/`NET_REDIRECT`/`HTTP_*`/`SEC_POLICY`/`SRC_TIMEOUT`/`SRC_PARSE`/`SRC_UNSUPPORTED`/`SRC_RUNTIME`，
   保留精确 `"401"` 与业务侧明确中文提示），诊断日志记录结构化 `code` 与去 URL 摘要，且只读重试名单 `READ_ONLY` 包含
   `api_account_history`。
2. `with_retry()` 只对逻辑 GET、无 body 的请求重试，最多 3 次；408/425/429/5xx、超时/连接类
   错误可重试，401、404、403、地址策略拒绝和重定向错误一次即终止。重试前 `heal_client()` 会在
   3 秒节流内重建客户端，解决代理软件开关后的 tunnel error。
3. `client_for_dns()` 先做 `parse_target()`，再按严格模式、主机、端口、公网 DNS 标志和
   `ProxyRoute` 生成缓存键，并对同一键的并发建连通过 `CLIENT_BUILDING` 做单飞去重（避免 Key 与首片
   对同一新 CDN 域名重复触发 DNS 解析）。系统代理匹配器与 GNOME `gsettings` 探针各缓存 10 秒并在
   `refresh_client()` 时立即清空。直连严格模式下优先走系统 DNS（保障本机 FakeIP 毫秒返回），若 HTTPS
   域名系统解析超过 900ms 未返回或快速失败，则并发竞速 AliDNS DoH，所有结果均经 `check_addresses_with_mode()`
   完整校验后通过 `resolve_to_addrs()` 固定进客户端；有代理时跳过本地解析把域名交给代理。缓存 180 秒
   （DoH 胜出时取 `min(180s, TTL)`），命中不延长 TTL，最多 64 项，配置/代理/安全模式变化会推进 generation 并清空。
4. `get_with_dns()` 关闭自动重定向，最多跟 5 跳。每一跳都重新检查 scheme、主机/IP、DNS 和固定地址；
   `redirect_target_with_mode()` 拒绝跨协议降级、认证信息和非法目标。
5. 媒体下载统一走 `fetch_bytes()`：`get_with_dns()` 取字节，失败时按
   `media_dns::eligible()` 判断是否切换公网 DNS。只对 HTTPS 域名、DNS/timeout/transport
   类错误回退；403/404/503 或地址策略拒绝不回退。成功的公网 DNS 路由按 host 记住 30 秒。
6. `media::handle()` 接受 `/img?u=`、`/hls?u=`、`/seg?u=`。当激活源通过 `manifest.media.imageDecrypt`
   声明解密参数且响应字节不是已知图片魔数时，`/img` 使用该参数执行 AES-128-CBC 解密并校验图片魔数；
   明文 JPEG/PNG/GIF/WebP 直接透传；未声明解密参数且非图片魔数时直接报错，不在壳内内置默认密钥。
   `/hls` 拉清单（以及 `/seg` 遇到嵌套子清单）时，在把 variant、key、init、part、media 等 URI 改写到本地
   `LOCAL_ORIGIN`、移除可派生 URI 字段的同时，由 `media_prefetch::on_playlist()` 索引当前媒体清单并立刻后台并发
   预热首个非 `NONE` Key/Map 与前 2 个分片；当播放器通过 `/seg` 请求第 `N` 片时，`media_prefetch::on_segment_access()`
   立即后台并发滑窗预读 `N+1`、`N+2` 两片进入 `KEY_CACHE`/`SEG_CACHE`（调用无递归的 `load_segment_raw()`，复用
   `coalesce` 单飞去重、全局上限 3 路并发，按代次与 `request_scope` 取消过期队列，清缓存时同步清空）。
7. `apply_byte_range()` 只处理单段 `bytes=`，支持 `start-end`、`start-`、`-suffix`；无效/多段
   范围退回完整 200，越界返回 416。m3u8 永远完整返回，避免原生播放器的 0-1 字节探测把
   `#EXTM3U` 截掉。Linux 的 loopback HTTP 还支持 HEAD，并只发送一份 `Content-Length`/CORS 头。
8. `diagnose()` 用与真实请求相同的路径做 DNS → TCP → HTTP 探测，读取 Windows 注册表、
   macOS `scutil`、Linux `gsettings` 和进程环境变量，输出 `verdict/summary/advice`。`heal_client()`、`verdict()` 与
   `proxy_probe_error()` 均识别 `InvalidContentType` / `corrupt message`（TLS 端口返回明文 HTTP），
   在有代理时提示核对本机 HTTP 代理协议勿误填 `https://`，直连时归类 `tls_fail` 并给出切 DNS/代理建议。`test_proxy()`
   通过 `probe_proxy_origin()` 对当前激活 origin 发起 `GET {origin}/`（尊重 `strict` 校验并跟进最多 5 跳
   `301|302|303` 重定向）；未导入源或 `base()` 为空时直接返回明确提示。代理地址只保留协议/主机/端口，
   `NO_PROXY` 只报“已配置”，错误链中的 userinfo 替换成 `[redacted]@`。

## 状态转换

- 客户端缓存：未命中 → 解析并检查地址 → 构建 client → 写入 `(expires, client)`；
  命中且未过期 → 复用；过期/配置变化 → 重新解析，不复用旧连接绕过新检查。
- 媒体作用域：线路、严格模式、有效代理模式/地址或系统代理指纹变化 → `MEDIA_CONFIG_GENERATION`
  增加；只有 active 配置参与指纹，保存一个未启用的自定义地址不使媒体缓存失效。
- 公网 DNS：首次失败且 eligible → 翻转 `public_dns` 重试；成功 → `Routes.remember(host)`；
  后续失败或过期 → 回到系统解析路径。
- 代理：`system` 每次建客户端时重新读系统设置；`custom` 用用户保存的地址；`off` 强制
  `no_proxy()`。保存代理会推进线路选择代次，旧探测不能在新代理保存后切换线路。
- 响应：媒体字节请求返回 2xx 读取字节并按需经源声明参数解密；业务返回由源插件自行解包并遵循
  统一数据结构，HTTP 401 → `"401"`，HTTP `<nnn>` → 原样透传，网络错误保留 source chain 的脱敏文本。

## 约束与失败行为

- 严格模式默认开启。禁止 HTTPS 降级、普通内网/回环/链路本地/保留地址和危险的 IPv6 转换；
  198.18.0.0/15 的 FakeIP 是明确例外，不能当普通私网拒绝。
- 系统解析的严格校验只固定可放行地址：TUN fake-IP 合成的 IPv6 ULA 假地址会被丢弃，
  fake-IP IPv4 保留；只有整组地址都不可放行才报错。外部 DNS（DoH）结果仍整体校验。
- 不使用自动重定向。每一跳都要重新检查 scheme、主机/IP、DNS 和固定地址；视频源 `host.fetch` 还会逐跳校验目标属于 `manifest.network`（`origins` / `publishOrigins`）白名单，代理路径也必须保留逐跳检查，不能把安全判断交给代理。
- 只有 `reqwest` 的 `system-proxy` feature 能读取 Windows/macOS 固定系统代理；PAC 不支持。
  Android 的系统 Wi-Fi 代理不生效，只有 VPN/TUN 或显式 `HGHUBX_PROXY`。
- 媒体路由是有限入口，不是开放代理：只允许 `/img`、`/hls`、`/seg`，只接受 `u=` 目标，
  不接受任意 path/host。不得把 iOS capability 端口或 Linux 17650 扩成通用转发。
- 播放列表和分片缓存有上限；缓存键包含请求作用域（严格模式 + 媒体配置代次），旧配置的
  在途响应不能写进新作用域。
- 失败读取不伪装成空数据：错误响应、HTML 落地页、缺少 `items/pagination` 都返回错误；
  媒体层返回 502/400，不返回 200 空 body。
- 日志不写 token、Cookie、代理认证、播放直链或查询参数；只记录固定操作名、主机/端口、
  资源编号、状态、耗时和脱敏错误类别。

## 验证命令

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/test-network-settings.mjs
node scripts/test-diagnostic-copy.mjs
node scripts/test-ios-native-media.mjs
```

`src-tauri/src/net/`、`src-tauri/src/source/`、`media_dns.rs`、`media/*`、`network_policy.rs` 的
单元测试覆盖重试终止、代理缓存键、DNS 回退、`host.fetch`/`host.crypto`、401/403 错误传播、
按需封面解密、Range、嵌套清单和脱敏。联网测试标记为 `#[ignore]`，需要显式环境变量；
浏览器脚本使用本地 fixture，不证明真实 CDN 或系统代理环境。
