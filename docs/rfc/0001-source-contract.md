# RFC 0001：视频源插件契约 v0.1（实验支线草案）

- 状态：Active Contract（分支 `exp/decoupled-shell`）
- 关联讨论：[zxsos/HGhubX #237](https://github.com/zxsos/HGhubX/discussions/237)
- 更新日期：2026-11-26

## 1. 设计目标与收窄原则

1. **单源优先 + 纯壳 UI 骨架**：壳（Shell）只保留播放器、交互、媒体代理、本地片库与插件管理；页面模块由 `manifest.capabilities` 控制显隐，可选频道列表由 `manifest.catalog.channels` 声明，站内视频链接解析规则由 `manifest.links.videoIdPathPattern` 声明；客户端零硬编码站点域名、slug、密钥或选择器。
2. **Legado 风格单份自包含格式**：一个视频源打包为单份 JSON，可编码为剪贴板分享口令（`hghubx-src://<gzip+base64url>`），同时支持「剪贴板口令导入」「HTTPS 链接导入」「本地文件导入」三种入口，底层走同一套验签与原子安装流程。
3. **双轨热更新（零账单风险）**：
   - 路径 A（纯离线）：发一段新版 `hghubx-src://` 口令，用户粘贴覆盖同一 `id`，保留历史/收藏/状态，失败自动回滚；
   - 路径 B（可选 `updateUrls`）：源内可携带多个静态镜像 URL，仅在用户手动点「检查源更新」时拉取（不冷启动后台静默轮询），验签并确认语义化版本递增后原子替换。
4. **安全边界在 Rust Host，不在 JS 引擎**：QuickJS（`rquickjs`）配置硬内存上限（16 MiB）、栈上限（512 KiB）与执行中断超时（12 秒）；脚本无任何直接网络、文件、环境变量或 IPC 权限，所有特权能力均通过 capability-scoped `host.*` 原语访问。

## 2. 包格式与分享口令

单份 `SourcePackage` JSON：

```json
{
  "schemaVersion": 1,
  "manifest": {
    "schemaVersion": 1,
    "id": "com.example.source",
    "name": "示例源",
    "version": "1.0.0",
    "apiVersion": "1",
    "runtime": { "kind": "quickjs", "entry": "inline" },
    "network": {
      "origins": ["https://example.com"],
      "mediaOrigins": ["https://cdn.example.com"],
      "publishOrigins": []
    },
    "capabilities": {
      "home": true,
      "search": true,
      "catalog": { "categories": false, "tags": true, "rankings": false, "authors": false },
      "detail": { "episodes": true, "related": false, "comments": false },
      "playback": { "hls": false, "mp4": false, "subtitles": false },
      "posts": false,
      "account": false,
      "lines": true
    },
    "media": {
      "imageDecrypt": { "algorithm": "aes-128-cbc", "key": "<16-byte utf8/hex>", "iv": "<16-byte utf8/hex>" }
    },
    "catalog": {
      "shortcuts": [
        { "id": "latest", "label": "最新上线", "icon": "clock" }
      ],
      "channels": [
        { "id": "featured", "label": "精选频道", "icon": "film", "sorts": ["latest", { "key": "hot_window", "name": "当前热播", "default": true }, "random"] }
      ]
    },
    "links": {
      "videoIdPathPattern": "^/video/(\\d+)/?$"
    }
  },
  "code": "module.exports = { ... };",
  "updateUrls": [],
  "signature": {
    "algorithm": "ed25519",
    "keyId": "hghubx-2026",
    "publicKey": "<32-byte raw pubkey base64url>",
    "sig": "<64-byte ed25519 sig base64url>"
  }
}
```

分享口令编码：`hghubx-src://` + `base64url(gzip(utf8(JSON)))`，客户端解压采用有界流读取（最大 512 KB），防止压缩炸弹。

## 3. Ed25519 签名与信任策略

- 签名载荷为跨语言确定性规范文本（覆盖 `id`、`version`、`apiVersion`、`runtime.kind`、三类 origin 列表、`updateUrls`、`imgdec`（`media.imageDecrypt`）及 `sha256(code)`），由 `src-tauri/src/source/verify.rs` 与 `scripts/pack-source.mjs` 共同遵循。
- **篡改零容忍**：只要带签名但验签失败，无论是否开启「允许自签/测试源」，一律拒绝导入。
- 纯壳客户端内置 `TRUSTED_KEYS` 为空（不预置官方或站方签名公钥），默认配置 `allow_untrusted = true`，允许自由导入未签名与自签社区源并展示指纹标识；若包内附带 Ed25519 `signature`，仍强制校验签名完整性。
- 说明：`catalog.authors`、`media.imageDecrypt`、`catalog.shortcuts`、`catalog.channels`（含可选 `icon`）与 `links.videoIdPathPattern` 均为可选字段，向后兼容最小 `schemaVersion: 1` 插件包。
- 排序项：`sorts` 的每一项可以是字符串 key，也可以是 `{ "key": "...", "name": "...", "default": true }`。使用对象时，tab 显示 `name`，请求仍发送 `key`；tab 顺序与 `sorts` 数组一致。默认选中带 `default: true` 的项；没有标记时选中第一项。每个频道最多一个 `default: true`。旧的字符串形式继续兼容。

## 4. Rust Host 原语（v0.1）

| 原语 | 能力与安全边界 |
| :--- | :--- |
| `host.info` | 只读元信息（`sourceId`、`version`、`baseUrl`、允许的 origins 与限额） |
| `host.auth` | 只读当前线路绑定的登录凭据（`{ token }`，未登录或不可信线路时为 `null`） |
| `host.fetch(req)` | 复用现有 `network_policy` 严格模式、DNS 固定与代理路由；强制校验 `manifest.network` 白名单与逐跳重定向；禁止 `Cookie`/`Host` 等受限头；响应上限 2 MB |
| `host.htmlQuery(html, selector)` | 桥接 Rust `dom_query`，只读提取文本与属性；输入上限 2 MB，结果上限 200 条 |
| `host.crypto` | 基于 `ring 0.17` 暴露 `sha256Hex`、`hmacSha256`、`randomBytes`、`base64Encode/Decode`、`ecdhP256Create/Derive`（私钥留驻 Rust 侧不暴露给 JS）、`aes256GcmEncrypt/Decrypt` |
| `host.storage` | 按 `sourceId` 严格隔离的 KV 存储（最多 64 键、单值 32 KB），不接触壳账号与其他源状态 |

## 5. 当前实现与配套工具

- 默认引导与空态：未导入或未激活视频源时，标准版默认停留在 `SourceOnboarding`、TV 端展示 `TvLanPushPanel`（局域网扫码推源/同步），业务 IPC 返回未导入提示；`manifest.capabilities` 控制标准版与 TV 端模块显隐。
- 内置零网络示例试玩：引导页与源管理页提供「试用离线示例源」次级入口，一键导入 [`examples/sources/demo-offline/`](../../examples/sources/demo-offline/) 并在界面顶部提供一键「移除示例源」；零网络示例源可声明 `playback: { hls: false, mp4: false }`，客户端置灰播放控件并引导导入真实源。
- 配套工具与示例：[`scripts/pack-source.mjs`](../../scripts/pack-source.mjs)（打包与 Ed25519 签名）、[`examples/sources/demo-offline/`](../../examples/sources/demo-offline/)（零网络离线契约示例源）。
