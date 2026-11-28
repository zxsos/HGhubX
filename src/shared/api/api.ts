import { invoke } from "@tauri-apps/api/core";
import { tracePlayback } from "../diagnostics/playbackDiagnostics";
import type {
  AccountHistoryPage, AccountIdentity, AccountSnapshot, CommentPage, Detail, HotSearchVideo, HotTagItem, Paged, PlayInfo, Post, PostCategory, RankItem, TagGroup, TopicCard, TopicDetail, User, UserDirectory, UserProfile, VideoCard,
} from "./types";
import { tr } from "../i18n";
import { classifyApiError } from "./errorFormat";

/* ── 运行环境 ───────────────────────────────────────────── */

/** 应用版本（构建时由 vite.config.ts 从 package.json 注入） */
export const APP_VERSION = __APP_VERSION__;

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
/** iPhone 的 UA 也带「like Mac OS X」，必须先于 macOS 判断；iPadOS 默认伪装成 Mac，用触点数区分。 */
export const isIos =
  /iPhone|iPad|iPod/i.test(ua) ||
  (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ||
  // iPadOS 13+ 默认把自己报成 MacIntel，只能靠触点数认
  (typeof navigator.platform === "string" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isMacos = !isIos && /Macintosh|Mac OS X/i.test(ua);
export const isHarmony = /OpenHarmony|HarmonyOS|ArkWeb/i.test(ua);
/** Linux 桌面：webkit2gtk 的 UA 是「X11; Linux x86_64」。必须排在 Windows 之前判断，
 *  否则会被当成 Windows；而 Android / OpenHarmony 的 UA 里同样可能带「Linux」，必须先排除。 */
export const isLinux = !isAndroid && !isIos && !isMacos && !isHarmony && /Linux|X11/i.test(ua);
/** Linux 桌面 WebKitGTK 宿主（区别于 Linux 下的 Chromium 自动化测试环境）。 */
export const isLinuxWebKit = isLinux && !/Chrome|Chromium|Edg\//i.test(ua);
export const platform: "android" | "ios" | "windows" | "macos" | "linux" | "harmony" =
  isAndroid ? "android" : isIos ? "ios" : isHarmony ? "harmony" : isMacos ? "macos" : isLinux ? "linux" : "windows";
/** WebView 内核版本：能不能走 MSE、能解哪些封装，是「无法播放」的首要判据。
 *  安卓取 Chrome/xxx（System WebView），Linux/macOS 取 WebKit 的 Version/xxx。 */
export const webviewVersion =
  /Chrome\/([\d.]+)/.exec(ua)?.[1] || /Version\/([\d.]+)/.exec(ua)?.[1] || "?";
/** 移动端（安卓 / iOS / 鸿蒙手持设备）共用触屏界面 */
export const isMobile = isAndroid || isIos || (isHarmony && !/\bPC\b/i.test(ua));

/** 媒体基址随平台不同（Rust 侧对应 `media::LOCAL_ORIGIN`，两边必须一致）：
 *  Windows / Android → `http://<scheme>.localhost`（自定义协议，WebView 自己加载）
 *  macOS / iOS / HarmonyOS → `hg://localhost`（原生 scheme handler）
 *  Linux → `http://127.0.0.1:17650`：WebKitGTK 的 <video> 由 GStreamer 播放，
 *          它拿不到自定义 scheme，所以由 Rust 侧在 loopback 上起 HTTP 代理
 *          （`src-tauri/src/linux_http.rs`，端口必须与此一致）。 */
export const LOCAL =
  isMacos || isIos || isHarmony ? "hg://localhost" : isLinux ? "http://127.0.0.1:17650" : "http://hg.localhost";

const SAFE_INLINE_IMAGE = /^data:image\/(?:svg\+xml|png|jpeg|webp|gif)(?:;charset=[^;,]+)?(?:;base64)?,/i;

/** 封面：经本地协议加载或解码（离线示例的静态 data:image 内联图直接透传）。 */
export const cover = (url?: string, _w = 480) =>
  !url ? "" : SAFE_INLINE_IMAGE.test(url) ? url : `${LOCAL}/img?u=${encodeURIComponent(url)}`;

/** 播放列表：经本地协议改写分片地址，规避 CORS 与防盗链。 */
export const playlist = (url: string) => `${LOCAL}/hls?u=${encodeURIComponent(url)}`;

/* ── 调用封装 ───────────────────────────────────────────── */

/** 写一行到应用数据目录 debug.log（用户反馈「打不开」时要的就是它） */
export const logLine = (msg: string) => invoke("debug_log", { msg }).catch(() => {});

/** 只读命令：链路抖动时可以安全重试一次；写操作绝不重试（避免重复提交） */
const READ_ONLY = new Set([
  "api_me", "api_account_history", "api_feed", "api_original_videos", "api_category", "api_rank", "api_search",
  "api_posts", "api_post", "api_post_comments", "api_video", "api_play", "api_comments",
  "api_topics", "api_topic", "api_tags", "api_hot_tags", "api_tag_videos", "api_search_hot",
  "api_post_playback", "api_post_categories", "api_post_category", "api_post_tag", "api_related", "api_following", "api_user", "api_user_stats", "api_user_videos", "api_popular_authors",
]);
/** 给自动选线用的观察点。api.ts 不反向依赖 autoLine，避免循环 import。 */
export type NetObserver = (r: { ok: boolean; cmd: string; msg?: string; networkish?: boolean }) => void;
let netObserver: NetObserver | null = null;
export const setNetObserver = (fn: NetObserver | null) => { netObserver = fn; };
const notifyNet = (r: Parameters<NetObserver>[0]) => {
  try { netObserver?.(r); } catch { /* 观察者不能影响请求本身 */ }
};

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const once = () => invoke(cmd, args) as Promise<T>;
  try {
    const r = await once();
    notifyNet({ ok: true, cmd });
    return r;
  } catch (e) {
    const first = classifyApiError(e);
    // 完整底层原因写入 debug.log；诊断日志记录代号与脱敏摘要；界面统一展示代号与原因
    logLine(`[api] ${cmd} [${first.code}] → ${typeof e === "string" ? e : first.logSummary}`);
    tracePlayback("api.fail", { cmd, code: first.code, err: first.logSummary, status: first.status, networkish: first.networkish });
    notifyNet({ ok: false, cmd, msg: first.message, networkish: first.networkish || first.status === "403" });
    // 线路可能正被自动切走：给切换留一点时间，只读请求重试一次，用户就不用看见这条错误
    if (first.networkish && READ_ONLY.has(cmd)) {
      logLine(`[api] ${cmd} [${first.code}] 链路异常，1.2s 后重试一次`);
      tracePlayback("api.retry", { cmd, code: first.code, err: first.logSummary });
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await once();
        logLine(`[api] ${cmd} 重试成功`);
        tracePlayback("api.retry_ok", { cmd });
        notifyNet({ ok: true, cmd });
        return r;
      } catch (e2) {
        const second = classifyApiError(e2 ?? e);
        logLine(`[api] ${cmd} [${second.code}] 重试仍失败 → ${typeof e2 === "string" ? e2 : second.logSummary}`);
        tracePlayback("api.retry_failed", { cmd, code: second.code, err: second.logSummary, status: second.status });
        throw new Error(second.message);
      }
    }
    throw new Error(first.message);
  }
}

/* ── 接口 ───────────────────────────────────────────────── */

export type CacheStatsReport = {
  usedBytes: number;
  memoryBytes?: number;
  diskBytes?: number;
  limitBytes: number;
  limitMb?: number;
  unlimited?: boolean;
  imageCount: number;
  segmentCount: number;
  playlistCount: number;
};

export type CacheClearReport = {
  webCache: boolean;
  platform: string;
  freedBytes?: number;
  remainingBytes?: number;
};

type WindowWithCacheBridge = Window & {
  __HG_CACHE__?: { clearWebCache?: () => number };
};

export const api = {
  boot: () =>
    call<{
      user: User | null;
      logged_in: boolean;
      base: string;
      strict_security?: boolean;
      cli_relaxed?: boolean;
      pending_migration_identity?: { origin: string; user_id: number } | null;
    }>("app_boot"),
  securitySet: (strict: boolean) => call<boolean>("security_set", { strict }),
  login: (username: string, password: string, reauth?: AccountIdentity & { credentialOrigin: string }) =>
    call<AccountSnapshot>("api_login", { username, password, ...reauth }),
  register: (username: string, password: string, email = "") =>
    call<AccountSnapshot>("api_register", { username, password, email }),
  logout: (identity?: AccountIdentity) => call<{ ok: boolean }>("api_logout", identity ? { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin } : {}),
  me: (identity?: AccountIdentity) => call<AccountSnapshot>("api_me", identity ? { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin } : {}),
  accountHistory: (identity: AccountIdentity, page = 1, size = 50) => call<AccountHistoryPage>("api_account_history", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, page, size }),
  accountHistoryRecord: (identity: AccountIdentity, videoId: number, ep: number) => call<unknown>("api_account_history_record", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, videoId, ep }),
  accountHistoryDelete: (identity: AccountIdentity, ids: number[]) => call<unknown>("api_account_history_delete", { expectedUserId: identity.expectedUserId, expectedOrigin: identity.expectedOrigin, ids }),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>("api_feed", { page, size }),
  topics: () => call<{ items: TopicCard[] }>("api_topics"),
  topic: (slug: string, page = 1, size = 20) => call<TopicDetail>("api_topic", { slug, page, size }),
  tags: () => call<{ categories: TagGroup[] }>("api_tags"),
  hotTags: () => call<{ items: HotTagItem[] }>("api_hot_tags"),
  tagVideos: (tag: string, page = 1, size = 20, sort: "latest" | "hot" = "latest") =>
    call<Paged<VideoCard>>("api_tag_videos", { tag, page, size, sort }),
  postTag: (tag: string, page = 1, size = 20) =>
    call<Paged<Post>>("api_post_tag", { tag, page, size }),
  category: (cate: string, page = 1, size = 20, sort?: string, jsonOnly = false) =>
    call<Paged<VideoCard>>("api_category", { cate, page, size, sort: sort ?? null, jsonOnly }),
  originalVideos: (cate: string, page = 1, size = 20, sort?: string, jsonOnly = false) =>
    call<Paged<VideoCard>>("api_original_videos", { cate, page, size, sort: sort ?? null, jsonOnly }),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>("api_rank", { kind }),
  /** 全站搜索。`kind` 省略时默认搜视频；图文帖子需显式传 "post"。 */
  search: (q: string, page = 1, size = 20, kind?: "video" | "post") =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: kind ?? null },
    ),
  /** 只搜图文帖子：返回结构是 Post 而不是 VideoCard。 */
  searchPosts: (q: string, page = 1, size = 20) =>
    call<{ items: Post[]; pagination: Paged<Post>["pagination"]; keyword: string }>(
      "api_search", { q, page, size, kind: "post" },
    ),
  searchHot: () => call<{ items: HotSearchVideo[] }>("api_search_hot"),
  posts: (page = 1, size = 20, sort?: string) =>
    call<Paged<Post>>("api_posts", { page, size, sort: sort ?? null }),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>("api_post", { id }),
  /** 帖子视频：详情里 video_url 为空时，由 playback 接口下发地址（可能多段）。 */
  postPlayback: (id: number) => call<{ mode?: number; videos?: { index: number; url: string }[] }>("api_post_playback", { id }),

  video: (id: number) => call<Detail>("api_video", { id }),
  play: (id: number, ep: number) => call<PlayInfo>("api_play", { id, ep }),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>("api_comments", { id, ep, page, size }),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>("api_comment_send", { id, ep, text, replyId: replyId ?? null }),

  cacheStats: () => invoke<CacheStatsReport>("cache_stats"),
  setCacheLimit: (limitMb: number) => invoke<CacheStatsReport>("cache_set_limit", { limitMb }),
  clearCache: async (): Promise<CacheClearReport> => {
    let nativeCleared = false;
    let nativeFreed = 0;
    try {
      const res = (window as WindowWithCacheBridge).__HG_CACHE__?.clearWebCache?.();
      if (typeof res === "number" && res >= 0) {
        nativeCleared = true;
        nativeFreed = res;
      }
    } catch { /* ignore */ }
    try {
      if (typeof caches !== "undefined" && typeof caches.keys === "function") {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
    } catch { /* ignore */ }
    const report = await invoke<CacheClearReport>("cache_clear");
    return {
      ...report,
      webCache: Boolean(report?.webCache || nativeCleared),
      freedBytes: (typeof report?.freedBytes === "number" ? report.freedBytes : 0) + nativeFreed,
    };
  },
  netDiag: () => invoke<Record<string, unknown>>("net_diag"),
  postLike: (id: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_post_like", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),
  postCollect: (id: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_post_collect", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),
  postComments: (id: number, page: number, size: number) => call<CommentPage>("api_post_comments", { id, page, size }),
  postCategories: () => call<{ items: PostCategory[] }>("api_post_categories"),
  postCategory: (route: string, page = 1, size = 20, sort?: string) =>
    call<Paged<Post>>("api_post_category", { route, page, size, sort: sort ?? null }),
  related: (id: number) => call<{ items: VideoCard[] }>("api_related", { id }),
  following: (page = 1, size = 20) => call<Paged<VideoCard>>("api_following", { page, size }),
  popularAuthors: (page = 1, size = 100) => call<UserDirectory>("api_popular_authors", { page, size }),
  user: (id: number) => call<UserProfile>("api_user", { id }),
  userStats: (id: number) => call<{ user_id: number; like_count: number; following: number; followers: number; video_count: number; post_count: number }>("api_user_stats", { id }),
  userVideos: (id: number, page = 1, size = 20) => call<Paged<VideoCard>>("api_user_videos", { id, page, size }),
  like: (id: number, ep: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_like", { id, ep, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),
  collect: (id: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_collect", { id, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),
  follow: (uid: number, on: boolean, identity?: AccountIdentity) => call<unknown>("api_follow", { uid, on, expectedUserId: identity?.expectedUserId, expectedOrigin: identity?.expectedOrigin }),

  /* 线路（数据源）：由当前激活的视频源声明与管理 */
  lineState: () => call<LineState>("line_state"),
  lineSet: (url: string) => call<string>("line_set", { url }),
  lineCustomSet: (url: string) => call<LineApply>("line_custom_set", { url }),
  lineReset: () => call<LineApply>("line_reset"),
  lineCancel: () => call<void>("line_cancel"),
  lineMirrors: () => call<LineMirrors>("line_mirrors"),
  lineProbe: (urls: string[]) => call<LineProbe[]>("line_probe", { urls }),
  lineAuto: () => call<LineAuto>("line_auto"),
  /* 当前为备选线路时尝试切回主线路（不清会话） */
  lineTryMain: () => call<LineTryMain>("line_try_main"),
  /* 线路体检：按当前视频源的探活规则检测连通性 */
  lineHealth: () => call<LineHealth>("line_health"),

  /* 应用内代理：只影响本应用的上游网络请求。 */
  proxyState: () => call<ProxyState>("proxy_state"),
  proxySet: (mode: ProxyMode, url: string) => call<ProxyState>("proxy_set", { mode, url }),
  proxyTest: (mode: ProxyMode, url: string) => call<ProxyProbe>("proxy_test", { mode, url }),

  /* 视频源插件（QuickJS 沙箱 + 剪贴板口令 / JSON / 链接导入） */
  sourceState: () => call<SourceStateSnapshot>("source_state"),
  sourceImport: (input: string, activate = false) =>
    call<InstalledSourceSummary>("source_import", { input, activate }),
  sourceResolveImport: (input: string, activate = false) =>
    call<SourceResolveResult>("source_resolve_import", { input, activate }),
  sourceImportSubscription: (items: SubscriptionSiteInput[], activateFirst = true) =>
    call<SubscriptionImportOutcome>("source_import_subscription", { items, activateFirst }),
  sourceProbeSubscription: (items: SubscriptionSiteInput[]) =>
    call<SubscriptionProbeResult[]>("source_probe_subscription", { items }),
  sourceActivate: (id: string | null) => call<SourceStateSnapshot>("source_activate", { id }),
  sourceRollback: (id: string) => call<InstalledSourceSummary>("source_rollback", { id }),
  sourceRemove: (id: string) => call<SourceStateSnapshot>("source_remove", { id }),
  sourceRemoveMany: (ids: string[]) => call<SourceStateSnapshot>("source_remove_many", { ids }),
  sourceSetAllowUntrusted: (allow: boolean) =>
    call<SourceStateSnapshot>("source_set_allow_untrusted", { allow }),
  sourceExportShareCode: (id: string) => call<string>("source_export_share_code", { id }),
  sourceCheckUpdate: (id: string) => call<SourceUpdateOutcome>("source_check_update", { id }),
  sourceTest: (id: string, query?: string) =>
    call<SourceTestOutcome>("source_test", { id, query: query ?? null }),
  sourceTakeDeepLink: () => call<string | null>("source_take_deep_link"),
  sourceLanPushStart: () => call<LanPushSession>("source_lan_push_start"),
  sourceLanPushStop: () => call<void>("source_lan_push_stop"),
  sourceLanPushStatus: () => call<LanPushStatus>("source_lan_push_status"),
  sourceLanPushToTv: (targetUrl: string, includeSource: boolean, sync?: TvSyncData | null) =>
    call<LanPushClientResult>("source_lan_push_to_tv", { targetUrl, includeSource, sync: sync ?? null }),
  tvPeerStart: (deviceName?: string) => call<LanPushSession>("tv_peer_start", { deviceName: deviceName ?? null }),
  tvPeerUpdateSnapshot: (snapshot: TvSyncData) => call<void>("tv_peer_update_snapshot", { snapshot }),
  tvPeerDiscover: () => call<DiscoveredTv[]>("tv_peer_discover"),
  tvPeerList: () => call<PairedPeerSummary[]>("tv_peer_list"),
  tvPeerRemove: (pairId: string) => call<PairedPeerSummary[]>("tv_peer_remove", { pairId }),
  tvPeerPairQr: (targetUrl: string, phoneName: string, includeSource: boolean, sync?: TvSyncData | null) =>
    call<TvBidirectionalSyncResult>("tv_peer_pair_qr", { targetUrl, phoneName, includeSource, sync: sync ?? null }),
  tvPeerPairCode: (ip: string, port: number, code: string, phoneName: string, includeSource: boolean, sync?: TvSyncData | null) =>
    call<TvBidirectionalSyncResult>("tv_peer_pair_code", { ip, port, code, phoneName, includeSource, sync: sync ?? null }),
  tvPeerSync: (pairId: string, ipOverride?: string | null, portOverride?: number | null, includeSource = true, sync?: TvSyncData | null) =>
    call<TvBidirectionalSyncResult>("tv_peer_sync", { pairId, ipOverride: ipOverride ?? null, portOverride: portOverride ?? null, includeSource, sync: sync ?? null }),

  /* 更新检查：对比 GitHub Release 的 tag */
  checkUpdate: (opts?: { edition?: "tv"; currentVersion?: string }) =>
    call<UpdateInfo>("check_update", opts),
  openUrl: (url: string) => call<void>("open_url", { url }),
};

/* ── 更新检查 ───────────────────────────────────────────── */

export type UpdateAsset = {
  name: string;
  url: string;
  size?: number | null;
  sha256?: string | null;
};

export type UpdateInfo = {
  /** 当前平台对应的安装包；没有就是这次 release 没给本平台出包 */
  asset?: UpdateAsset | null;
  current: string;
  latest: string;
  tag?: string;
  has_update: boolean;
  url: string;
  name?: string;
  published_at?: string;
  notes?: string;
};

/* ── 线路（数据源） ─────────────────────────────────────── */

export type LineItem = { name?: string; url: string; host?: string };
export type LineState = { base: string; default: string; fixed: LineItem[]; custom?: boolean };
export type LineApply = { base: string; custom: boolean };
export type LineMirrors = { source: string; script?: string; items: LineItem[]; recommended_source?: string; recommended: LineItem[] };
export type LineProbe = { url: string; ok: boolean; status?: number; ms: number; error?: string };
export type LineHealth = { base: string; ok: boolean; ms: number; status: number | null };

export type ProxyMode = "system" | "custom" | "off";
export type ProxyState = {
  mode: ProxyMode;
  /** 保存过的自定义地址，仅用于设置表单回填，不写入日志。 */
  url: string;
  /** 不含认证信息的实际出口。 */
  effective?: string | null;
  system_proxy?: boolean;
  env_proxy?: boolean;
};
export type ProxyProbe = { ok: boolean; status?: number | null; ms: number; error?: string; via?: string };

/** 自动选线：优先主线路，不可用时检测视频源提供的备选线路。 */
export type LineAutoCandidate = {
  tier: "main" | "cn" | "mirror";
  url: string;
  ok: boolean;
  reachable: boolean;
  ms: number;
  status: number | null;
};
export type LineAuto = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  pick: {
    base: string;
    tier: "main" | "cn" | "mirror" | "none";
    ms: number;
    reason: string;
    candidates: LineAutoCandidate[];
  };
};

/** 回切默认线路的探测结果 */
export type LineTryMain = {
  cancelled?: boolean;
  previous: string;
  base: string;
  switched: boolean;
  probe: { ok: boolean; base: string; tier: string; ms: number; status: number | null };
};

export type CatalogChannel = {
  id: string;
  label: string;
  kind?: string;
  icon?: string;
  sorts?: string[];
};

export type CatalogShortcut = {
  id: string;
  label: string;
  icon?: string;
  sorts?: string[];
};

export type SourceCatalogConfig = {
  shortcuts?: CatalogShortcut[];
  channels?: CatalogChannel[];
};

export type SourceLinksConfig = {
  videoIdPathPattern?: string;
};

export type SourceCapabilities = {
  home: boolean;
  search: boolean;
  catalog: { categories: boolean; topics?: boolean; tags: boolean; rankings: boolean; authors?: boolean };
  detail: { episodes: boolean; related: boolean; comments: boolean };
  playback: { hls: boolean; mp4: boolean; subtitles: boolean };
  posts: boolean;
  account: boolean;
  lines: boolean;
};

export type InstalledSourceSummary = {
  id: string;
  name: string;
  version: string;
  previousVersion?: string | null;
  description: string;
  author: string;
  apiVersion: string;
  runtimeKind: string;
  origins: string[];
  capabilities: SourceCapabilities;
  catalog?: SourceCatalogConfig;
  links?: SourceLinksConfig;
  updateUrls: string[];
  signature: { status: "trusted" | "self_signed" | "unsigned" | string; keyId: string; fingerprint: string };
  installedAt: number;
  active: boolean;
};

export type SourceStateSnapshot = {
  activeSourceId: string | null;
  allowUntrusted: boolean;
  sources: InstalledSourceSummary[];
};

export type SourceUpdateOutcome = {
  updated: boolean;
  fromVersion: string;
  toVersion: string;
  summary: InstalledSourceSummary;
};

export type SourceTestOutcome = {
  ok: boolean;
  ms: number;
  method: string;
  itemCount: number;
  sampleTitle?: string | null;
  error?: string | null;
};

export type SubscriptionSitePreview = {
  id: string;
  key: string;
  name: string;
  api: string;
  origin: string;
  installed: boolean;
};

export type SubscriptionPreview = {
  format: string;
  totalCount: number;
  skippedHttpCount: number;
  skippedUnsupportedCount: number;
  items: SubscriptionSitePreview[];
};

export type SourceResolveResult =
  | { kind: "imported"; summary: InstalledSourceSummary }
  | { kind: "subscription"; preview: SubscriptionPreview };

export type SubscriptionSiteInput = {
  id?: string;
  name: string;
  api: string;
};

export type SubscriptionProbeResult = {
  id: string;
  ok: boolean;
  ms: number;
  playable: boolean;
  reason: string | null;
};

export type SubscriptionImportFailure = {
  name: string;
  api: string;
  error: string;
};

export type SubscriptionImportOutcome = {
  imported: InstalledSourceSummary[];
  failed: SubscriptionImportFailure[];
  activeSourceId: string | null;
};

export type LanPushSession = {
  url: string;
  ip: string;
  port: number;
  token: string;
  code?: string;
  deviceId?: string;
  name?: string;
};

export type TvSyncHistoryItem = {
  id: number;
  ep: number;
  t: number;
  dur: number;
  at: number;
};

export type TvSyncContentPrefs = {
  blockedTags: string[];
  pinnedTags: string[];
  paused: boolean;
  hideUntagged: boolean;
};

export type TvSyncData = {
  favs: number[];
  postFavs: number[];
  history: TvSyncHistoryItem[];
  contentPreferences?: TvSyncContentPrefs | null;
  preferHevc?: boolean | null;
  autoLine?: boolean | null;
  lineBase?: string | null;
};

export type TvSyncEnvelope = {
  syncId: number;
  source?: InstalledSourceSummary | null;
  sync: TvSyncData;
  peerName?: string | null;
};

export type PairedPeerSummary = {
  pairId: string;
  peerDeviceId: string;
  name: string;
  lastIp: string;
  lastPort: number;
  pairedAt: number;
  lastSyncedAt: number;
};

export type DiscoveredTv = {
  deviceId: string;
  name: string;
  ip: string;
  port: number;
  pairing: boolean;
  pairId?: string | null;
  lastSyncedAt?: number | null;
};

export type TvBidirectionalSyncResult = {
  ok: boolean;
  pairId?: string | null;
  tvName: string;
  tvIp: string;
  sourceName?: string | null;
  sourceVersion?: string | null;
  pushedFavs: number;
  pushedPostFavs: number;
  pushedHistory: number;
  tvSync: TvSyncData;
  importedSourceFromTv?: InstalledSourceSummary | null;
  legacySourceOnly: boolean;
};

export type LanPushClientResult = {
  ok: boolean;
  sourceName?: string | null;
  sourceVersion?: string | null;
  syncedFavs: number;
  syncedPostFavs: number;
  syncedHistory: number;
  legacySourceOnly: boolean;
};

export type LanPushStatus = {
  active: boolean;
  pairing?: boolean;
  url?: string | null;
  code?: string | null;
  lastImported?: InstalledSourceSummary | null;
  lastSync?: TvSyncEnvelope | null;
};

/** `https://a.b/c` → `a.b`（线路展示用） */
export const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
};

/* ── 自检：验证 webview → 本地协议 → 上游 的取流链路 ───────── */
export async function selfTest(): Promise<string> {
  const steps: string[] = [];
  try {
    const feed = await api.feed(1, 1);
    const firstId = feed?.items?.[0]?.id;
    if (!firstId) return "skip:no-item";
    const detail = await api.video(firstId).catch(() => null);
    const ep = detail?.episodes?.[0]?.ep_num ?? 1;
    const info = await api.play(firstId, ep);
    const playUrl = info?.streams?.main || info?.video_url || info?.streams?.hevc || info?.video_url_hevc || "";
    steps.push(`play:${playUrl ? "ok" : "empty"}`);
    if (!playUrl) return steps.join(" | ");
    const hlsUrl = `${LOCAL}/hls?u=${encodeURIComponent(playUrl)}`;
    const r1 = await fetch(hlsUrl);
    const txt = await r1.text();
    steps.push(`hls:${r1.status}/${txt.length}/${txt.startsWith("#EXTM3U") ? "m3u8" : "bad"}`);
    const keyLine = txt.split("\n").find((l) => l.startsWith("#EXT-X-KEY"));
    if (keyLine) {
      const m = keyLine.match(/URI="([^"]+)"/);
      if (m) {
        const rustUrl = m[1];
        // A/B：用 JS 重新编码同一条上游地址（不在日志中输出原始 key URL）
        const inner = decodeURIComponent(rustUrl.split("?u=")[1] || "");
        try {
          const rk = await fetch(rustUrl);
          const bk = await rk.arrayBuffer();
          steps.push(`keyRust:${rk.status}/${bk.byteLength}`);
        } catch (e) { steps.push(`keyRust:throw:${(e as Error).message.slice(0, 30)}`); }
        try {
          const rk2 = await fetch(`${LOCAL}/seg?u=${encodeURIComponent(inner)}`);
          const bk2 = await rk2.arrayBuffer();
          steps.push(`keyJs:${rk2.status}/${bk2.byteLength}`);
        } catch (e) { steps.push(`keyJs:throw:${(e as Error).message.slice(0, 30)}`); }
      }
    }
    const segLine = txt.split("\n").find((l) => l && !l.startsWith("#") && l.includes("/seg?u="));
    if (segLine) {
      try {
        const r2 = await fetch(segLine.trim());
        const buf = await r2.arrayBuffer();
        steps.push(`seg:${r2.status}/${buf.byteLength}`);
      } catch (e) { steps.push(`seg:throw:${(e as Error).message.slice(0, 40)}`); }
    } else steps.push("seg:no-line");
  } catch (e) {
    steps.push(`err:${(e as Error).message.slice(0, 60)}`);
  }
  return steps.join(" | ");
}

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return tr("{0}亿", (v / 100_000_000).toFixed(1).replace(/\.0$/, ""));
  if (v >= 10_000) return tr("{0}万", (v / 10_000).toFixed(1).replace(/\.0$/, ""));
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};
