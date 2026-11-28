import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import type Hls from "hls.js";
import type { FragBufferedData, FragLoadedData, FragLoadingData, HlsListeners } from "hls.js";
import { N_ } from "../i18n";
import { copyText } from "../lib/clipboard";

let registeredHlsVersion: string | null = null;
export function registerHlsVersion(version: string) {
  registeredHlsVersion = version;
}

type Data = Record<string, unknown>;
type Status = { enabled: boolean; path: string | null; error: string | null };
type Entry = { event: string; data: Data };
type Snapshot = Status & { ready: boolean; pending: boolean };
export type FullLogExport = {
  filename: string;
  path: string | null;
  content: string;
  bytes: number;
  lineCount: number;
  truncated: boolean;
  nativeOpened: boolean;
  nativeOutcome?: string | null;
  nativeError?: string | null;
};
export type NativeExportResult = {
  opened: boolean;
  outcome: string;
  detail: string | null;
};
export type ShareLogResult = {
  method: "share" | "reveal" | "download" | "saved" | "cancelled";
  filename: string;
  path: string | null;
  bytes: number;
  lineCount: number;
};

// Separate transport also lets browser regressions verify diagnostics without Tauri or upstream.
export const playbackLogApi = {
  status: () => invoke<Status>("playback_log_status"),
  set: (enabled: boolean) => invoke<Status>("playback_log_set", { enabled }),
  write: (entries: Entry[]) => invoke<void>("playback_log_write", { entries }),
  read: () => invoke<string>("playback_log_read"),
  exportFull: (reveal = false, title?: string) => invoke<FullLogExport>("playback_log_export_full", { reveal, title }),
  revealExport: (title?: string) => invoke<NativeExportResult | boolean>("playback_log_reveal_export", { title }),
};
let state: Snapshot = { enabled: false, path: null, error: null, ready: false, pending: false };
const listeners = new Set<() => void>();
const session = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let init: Promise<void> | undefined;
let queue: Entry[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> = Promise.resolve();
let nextPlayer = 0;
function publish(next: Partial<Snapshot>) {
  state = { ...state, ...next };
  listeners.forEach(fn => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePlaybackLog = () => useSyncExternalStore(subscribe, () => state);
export const playbackLogEnabled = () => state.enabled && !state.pending && !state.error;

export function tracePlayback(event: string, data: Data = {}) {
  if (!playbackLogEnabled()) return;
  // Bounded batches; sustained dragging must not create unlimited IPC or disk work.
  if (queue.length >= 512) {
    queue.splice(0, queue.length - 510);
    queue.unshift({ event: "queue.dropped", data: { session } });
  }
  queue.push({ event, data: { ...data, session, at: new Date().toISOString(), mono_ms: Math.round(performance.now()) } });
  if (!timer) timer = setTimeout(() => { void flushPlaybackLog(); }, 250);
}

export async function flushPlaybackLog() {
  clearTimeout(timer); timer = undefined;
  const entries = queue; queue = [];
  writing = writing.catch(() => {}).then(async () => {
    for (let i = 0; i < entries.length; i += 128) await playbackLogApi.write(entries.slice(i, i + 128));
  });
  try { await writing; }
  catch { publish({ error: "诊断日志写入失败，请检查可用空间后重新开启" }); }
}

export function initPlaybackLog() {
  return init ??= playbackLogApi.status().then(saved => {
    publish({ ...saved, ready: true });
    tracePlayback("app.start", { version: __APP_VERSION__, platform: navigator.platform, user_agent: navigator.userAgent, hls_version: registeredHlsVersion, media_source: !!window.MediaSource, managed_media_source: "ManagedMediaSource" in window });
  }).catch(() => { init = undefined; publish({ error: "无法读取诊断日志设置" }); });
}

export async function setPlaybackLog(on: boolean) {
  if (!state.ready || state.pending) throw new Error(N_("日志设置尚未就绪"));
  publish({ pending: true });
  try {
    await flushPlaybackLog();
    const saved = await playbackLogApi.set(on);
    publish({ ...saved, pending: false });
    tracePlayback("app.snapshot", { version: __APP_VERSION__, platform: navigator.platform, user_agent: navigator.userAgent, hls_version: registeredHlsVersion, media_source: !!window.MediaSource, managed_media_source: "ManagedMediaSource" in window });
  } finally { if (state.pending) publish({ pending: false }); }
}

export async function copyPlaybackLog() {
  await flushPlaybackLog();
  const text = await playbackLogApi.read();
  if (!text) throw new Error(N_("尚无诊断日志，请开启后复现问题"));
  await copyText(text);
}

export function formatLogSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.max(0, bytes)} B`;
}

function triggerBlobDownload(filename: string, content: string): boolean {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
  try {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch {
    return false;
  }
}

async function tryWebShareFile(filename: string, content: string, title: string): Promise<"shared" | "cancelled" | "unsupported"> {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return "unsupported";
  if (typeof File === "function") {
    const file = new File([content], filename, { type: "text/plain;charset=utf-8" });
    const shareData: ShareData = { files: [file], title };
    let canShareFile = true;
    if (typeof navigator.canShare === "function") {
      try {
        canShareFile = navigator.canShare(shareData);
      } catch {
        canShareFile = false;
      }
    }
    if (canShareFile) {
      try {
        await navigator.share(shareData);
        return "shared";
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return "cancelled";
      }
    }
  }
  // Fallback for WebViews that support navigator.share({ text }) but not files
  try {
    await navigator.share({ title, text: content.length > 262144 ? content.slice(-262144) : content });
    return "shared";
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") return "cancelled";
    return "unsupported";
  }
}

export async function sharePlaybackLog(opts: { title: string; isMobile: boolean; platform: string }): Promise<ShareLogResult> {
  await flushPlaybackLog();
  const isHarmony = opts.platform === "harmony";
  const isIos = opts.platform === "ios";
  const res = await playbackLogApi.exportFull(!opts.isMobile || isHarmony || isIos, opts.title);
  if (!res.content) throw new Error(N_("尚无诊断日志，请开启后复现问题"));
  const base = { filename: res.filename, path: res.path, bytes: res.bytes, lineCount: res.lineCount };

  if (!opts.isMobile && !isHarmony) {
    if (res.nativeOpened) return { ...base, method: "reveal" };
    const webShare = await tryWebShareFile(res.filename, res.content, opts.title);
    if (webShare === "shared") return { ...base, method: "share" };
    if (webShare === "cancelled") return { ...base, method: "cancelled" };
    if (res.path) return { ...base, method: "saved" };
    if (triggerBlobDownload(res.filename, res.content)) return { ...base, method: "download" };
    return { ...base, method: "saved" };
  }

  // iOS / iPadOS: Rust 侧直接拉起原生 UIActivityViewController（无 WKWebView 安全上下文/手势过期限制）
  if (isIos && res.nativeOpened) {
    return { ...base, method: "share" };
  }

  // HarmonyOS: Rust -> ShareBridgePlugin.ets 依次拉起系统分享 / 打开方式 / 原生 DocumentViewPicker 保存弹窗
  if (isHarmony) {
    if (res.nativeOutcome === "cancelled") return { ...base, method: "cancelled" };
    if (res.nativeOpened) {
      return { ...base, method: res.nativeOutcome === "saved" ? "saved" : "share" };
    }
    if (res.path) {
      try {
        const revealed = await playbackLogApi.revealExport(opts.title);
        if (revealed === true) return { ...base, method: "share" };
        if (revealed && typeof revealed === "object") {
          if (revealed.outcome === "cancelled") return { ...base, method: "cancelled" };
          if (revealed.opened) return { ...base, method: revealed.outcome === "saved" ? "saved" : "share" };
        }
      } catch { /* fall through */ }
    }
  }

  // Android WebView 无 Web Share 文件支持，优先走 MainActivity.AppBridge.shareFile（FileProvider + ACTION_SEND）。
  // 注意：Android WebView addJavascriptInterface（Gin Java Bridge）必须以 bridge 对象作为 receiver 调用，
  // 拆出方法引用直接调用会抛 `TypeError: Illegal invocation`。
  const androidBridge = (window as Window & { __HG_ANDROID__?: { shareFile?: (path: string, title: string) => boolean | string } }).__HG_ANDROID__;
  let androidShareErr = "";
  if (opts.platform === "android" && res.path && androidBridge && typeof androidBridge.shareFile === "function") {
    try {
      const ret = androidBridge.shareFile(res.path, opts.title);
      if (ret === true || ret === "ok") return { ...base, method: "share" };
      if (typeof ret === "string" && ret.startsWith("err:")) androidShareErr = ret.slice(4);
    } catch (err) {
      androidShareErr = err instanceof Error ? err.message : String(err);
    }
  }

  // iOS WKWebView / 支持 Web Share 的移动端 WebView 直接拉起系统分享面板
  const webShare = await tryWebShareFile(res.filename, res.content, opts.title);
  if (webShare === "shared") return { ...base, method: "share" };
  if (webShare === "cancelled") return { ...base, method: "cancelled" };

  if (androidShareErr) throw new Error(androidShareErr);
  // 移动端导出文件位于应用私有缓存目录，WebView 中 <a download> 不会真正保存文件；
  // 原生分享与 Web Share 均未成功时直接报错，不再误报“已保存”并暴露沙盒路径。
  if (res.path) throw new Error(res.nativeError || "");
  if (triggerBlobDownload(res.filename, res.content)) return { ...base, method: "download" };
  throw new Error("");
}

function isLocalMediaWrapper(url: URL) {
  return url.protocol === "hg:" || url.hostname === "hg.localhost"
    || (url.hostname === "127.0.0.1" && (/^\/([0-9a-f]{64}\/)?(img|hls|seg)$/.test(url.pathname)));
}

export function mediaResource(raw: string) {
  try {
    const url = new URL(raw);
    if (isLocalMediaWrapper(url)) raw = url.searchParams.get("u") || raw;
  } catch { /* still fingerprint invalid targets without logging their contents */ }
  let hash = 2166136261;
  for (const b of new TextEncoder().encode(raw)) hash = Math.imul(hash ^ b, 16777619) >>> 0;
  return `r${hash.toString(16).padStart(8, "0")}`;
}

/**
 * 只取 host，用来判断「是哪条 CDN / 哪个接口域名」。
 * 不含 path 与 query，所以能落盘：出问题时一眼看出是源站、还是某个分片域名挂了。
 */
export function mediaHost(raw: string): string {
  try {
    const url = new URL(raw);
    if (isLocalMediaWrapper(url)) {
      const inner = url.searchParams.get("u");
      if (inner) return new URL(inner).host;
    }
    return url.host;
  } catch {
    return "?";
  }
}

function ranges(value: TimeRanges) {
  return Array.from({ length: Math.min(value.length, 12) }, (_, i) => [round(value.start(i)), round(value.end(i))]);
}
const round = (n: number) => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const engines = new WeakMap<Hls, string>();
export function mediaSnapshot(v: HTMLVideoElement, hls?: Hls | null) {
  return { time: round(v.currentTime), duration: round(v.duration), paused: v.paused, seeking: v.seeking, ready: v.readyState, network: v.networkState,
    buffered: ranges(v.buffered), seekable: ranges(v.seekable), muted: v.muted, volume: v.volume, rate: v.playbackRate,
    buffering_enabled: hls?.bufferingEnabled, loading_enabled: hls?.loadingEnabled, media_error: v.error?.code ?? null,
    engine: hls ? engines.get(hls) : "native", prefer_managed: hls?.config.preferManagedMediaSource,
    visible: getComputedStyle(v).visibility !== "hidden" && v.getClientRects().length > 0 };
}

export function usePlayerDiagnostics(videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>, context: Data) {
  const id = useRef<string>("");
  if (!id.current) id.current = `player-${++nextPlayer}`;
  const current = useRef(context); current.current = context;
  const snapshot = () => {
    const v = videoRef.current;
    return { player: id.current, ...current.current, ...(v ? mediaSnapshot(v, hlsRef.current) : {}) };
  };
  const trace = (event: string, data: Data = {}) => {
    if (!playbackLogEnabled()) return;
    try { tracePlayback(event, { ...snapshot(), seek: pending.current?.id, ...data }); } catch { /* diagnostics must never interrupt playback */ }
  };
  const pending = useRef<{ id: number; target: number; start: number; seeks: number; seeked: boolean } | null>(null);
  const seekSeq = useRef(0);
  const requestSeek = (target: number, source: string) => {
    if (!playbackLogEnabled()) return;
    const previous = pending.current;
    if (previous) trace("seek.superseded", { seek: previous.id, next_target: round(target), elapsed_ms: Math.round(performance.now() - previous.start) });
    pending.current = { id: ++seekSeq.current, target, start: performance.now(), seeks: 0, seeked: false };
    trace("seek.request", { seek: seekSeq.current, target: round(target), source });
    if (videoRef.current && !videoRef.current.seeking && Math.abs(videoRef.current.currentTime - target) < .001) {
      trace("seek.noop", { seek: seekSeq.current });
      pending.current = null;
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let frame: number | undefined;
    let lastHeartbeat = 0;
    let timeoutReported = 0;
    const emit = (event: string, data: Data = {}) => {
      if (playbackLogEnabled()) {
        try { tracePlayback(event, { player: id.current, ...current.current, ...mediaSnapshot(v, hlsRef.current), ...data }); } catch { /* detached or changing ranges */ }
      }
    };
    const finish = (method: string, frameTime?: number) => {
      const p = pending.current;
      if (!p || !p.seeked) return;
      emit(method === "paused_ready" ? "seek.ready" : "seek.resumed", { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start), method, frame_time: frameTime == null ? null : round(frameTime) });
      pending.current = null;
    };
    const onEvent = (e: Event) => {
      if (!playbackLogEnabled()) return;
      const p = pending.current;
      if (e.type === "seeking" && p) p.seeks++;
      if (e.type === "seeked" && p) p.seeked = true;
      emit(`media.${e.type}`, p ? { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start), seeking_events: p.seeks } : {});
      if (e.type === "seeked") {
        if (frame != null) v.cancelVideoFrameCallback?.(frame);
        if (v.paused && v.readyState >= 2) finish("paused_ready");
        else if (v.requestVideoFrameCallback) {
          const expected = p?.id;
          frame = v.requestVideoFrameCallback((_now, metadata) => {
            if (pending.current?.id === expected) finish("video_frame", metadata.mediaTime);
          });
        }
      }
      if (e.type === "playing" && !v.requestVideoFrameCallback) finish("playing");
    };
    const events = ["loadstart", "loadedmetadata", "loadeddata", "play", "pause", "playing", "waiting", "stalled", "seeking", "seeked", "ended", "error", "emptied", "abort", "ratechange", "volumechange", "canplay"];
    events.forEach(event => v.addEventListener(event, onEvent));
    const stateChange = () => { if (playbackLogEnabled()) emit("player.snapshot"); else pending.current = null; };
    const unsubscribe = subscribe(stateChange);
    const heartbeat = setInterval(() => {
      if (!playbackLogEnabled()) return;
      const p = pending.current;
      if (p && performance.now() - p.start > 8000 && timeoutReported !== p.id) {
        timeoutReported = p.id;
        emit("seek.timeout", { seek: p.id, target: round(p.target), elapsed_ms: Math.round(performance.now() - p.start) });
      }
      if (performance.now() - lastHeartbeat >= 5000) { lastHeartbeat = performance.now(); emit("player.heartbeat"); }
    }, 1000);
    emit("player.mount");
    return () => {
      emit("player.unmount");
      events.forEach(event => v.removeEventListener(event, onEvent));
      clearInterval(heartbeat); unsubscribe();
      if (frame != null) v.cancelVideoFrameCallback?.(frame);
    };
  }, []);
  useEffect(() => { trace("player.context"); }, [context.active, context.view, context.video_id, context.episode, context.resource]);
  return { trace, requestSeek };
}

type HlsEventsMap = typeof Hls.Events;

export function observeHls(hls: Hls, trace: (event: string, data?: Data) => void, eventsMap: HlsEventsMap) {
  hls.on(eventsMap.MEDIA_ATTACHED, (_event, data) => {
    const source = data.mediaSource;
    engines.set(hls, source?.constructor.name || "MediaSource");
    trace("hls.attached", { engine: engines.get(hls), prefer_managed: hls.config.preferManagedMediaSource });
    if (source) {
      const start = () => trace("mms.startstreaming");
      const end = () => trace("mms.endstreaming");
      source.addEventListener("startstreaming", start);
      source.addEventListener("endstreaming", end);
      hls.once(eventsMap.DESTROYING, () => { source.removeEventListener("startstreaming", start); source.removeEventListener("endstreaming", end); });
    }
  });
  hls.on(eventsMap.MANIFEST_PARSED, () => trace("hls.manifest", { levels: hls.levels.length }));
  for (const event of [eventsMap.FRAG_LOADING, eventsMap.FRAG_LOADED, eventsMap.FRAG_BUFFERED, eventsMap.FRAG_LOAD_EMERGENCY_ABORTED] as (keyof HlsListeners)[]) {
    hls.on(event, ((_event: string, data: FragLoadingData | FragLoadedData | FragBufferedData) => {
      if (!playbackLogEnabled()) return;
      const { frag } = data;
      const loading = frag.stats.loading;
      trace(String(event), { resource: mediaResource(frag.url), host: mediaHost(frag.url), fragment: frag.sn, start: round(frag.start), duration: round(frag.duration), bytes: frag.stats.loaded,
        load_ms: loading.end > 0 && loading.end >= loading.start ? round(loading.end - loading.start) : null,
        first_byte_ms: loading.first > 0 && loading.first >= loading.start ? round(loading.first - loading.start) : null });
    }) as HlsListeners[typeof event]);
  }
  hls.on(eventsMap.ERROR, (_event, data) => trace("hls.error", { type: data.type, detail: data.details, fatal: data.fatal, status: data.response?.code,
    fragment: data.frag?.sn, resource: data.frag ? mediaResource(data.frag.url) : undefined, host: data.frag ? mediaHost(data.frag.url) : undefined }));
}

export function installPlaybackPageEvents() {
  document.addEventListener("visibilitychange", () => tracePlayback("page.visibility", { visibility: document.visibilityState }));
  window.addEventListener("pagehide", () => { tracePlayback("page.hide"); void flushPlaybackLog(); });
  document.addEventListener("securitypolicyviolation", e => tracePlayback("security.csp_violation", { directive: e.effectiveDirective, disposition: e.disposition, resource: mediaResource(e.blockedURI) }));
}
