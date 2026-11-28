import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, platform as envPlatform, type InstalledSourceSummary, type SourceStateSnapshot } from "../api/api";
import { exitDocumentFullscreen, getFullscreenElement } from "../lib/fullscreen";
import { setSiteOrigin } from "../lib/html";
import { isStrictSecurity, setStrictSecurity as setHtmlStrictSecurity } from "../lib/securityMode";
import type { User } from "../api/types";
import { readStorage, STORAGE_KEYS } from "../storage/storage";
import { pickGuestData, useAccountData, type GuestData } from "./accountData";
import { runSilentSourceUpdate } from "./sourceAutoUpdate";
import { tr } from "../i18n";

export type Platform = "android" | "ios" | "windows" | "macos" | "linux" | "harmony";
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export type Tab = "home" | "search" | "category" | "profile";

/** 播放页上下文：ids 是来源列表，index 是当前条目。 */
export type FeedContext = {
  kind: "feed";
  key: string;
  videoIds: number[];
  index: number;
  title: string;
  source: string;
  feedKind?: "video" | "post";
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export type Page =
  | FeedContext
  | { kind: "channel"; key: string; cate: string; name: string }
  | { kind: "ranks"; key: string }
  | { kind: "settings"; key: string; section?: "内容偏好" }
  | { kind: "posts"; key: string }
  | { kind: "post"; key: string; id: number }
  | { kind: "topics"; key: string }
  | { kind: "topic"; key: string; slug: string; name: string }
  | { kind: "tags"; key: string }
  | { kind: "tag"; key: string; tag: string; name: string }
  | { kind: "authors"; key: string }
  | { kind: "following"; key: string }
  | { kind: "user"; key: string; id: number; name?: string };

export type PageInput =
  | { kind: "feed"; videoIds: number[]; index: number; title: string; source?: string; feedKind?: "video" | "post"; startEp?: number; startTime?: number }
  | { kind: "channel"; cate: string; name: string }
  | { kind: "ranks" }
  | { kind: "settings"; section?: "内容偏好" }
  | { kind: "posts" }
  | { kind: "post"; id: number }
  | { kind: "topics" }
  | { kind: "topic"; slug: string; name: string }
  | { kind: "tags" }
  | { kind: "tag"; tag: string; name: string }
  | { kind: "authors" }
  | { kind: "following" }
  | { kind: "user"; id: number; name?: string };

/** Player picture-enhancement mode. CAS only sharpens; detail is the FSRCNNX 2x path. */
export type EnhanceMode = "off" | "fsr" | "cas" | "detail";

/** Production strength presets for the AI detail path. */
export const ENHANCE_STRENGTHS = ["standard", "strong", "extreme"] as const;
export type EnhanceStrength = (typeof ENHANCE_STRENGTHS)[number];

/** Test-only output scale override; "auto" keeps the normal display-driven sizing. */
export type SuperResolutionTestScale = "auto" | "1x" | "2x";

/** Test-only gain for the FSRCNNX detail composite. */
export type SuperResolutionTestDetailGain = 1 | 1.5 | 2 | 3;

/** Test-only mid-frequency contrast for skin and facial detail. */
export type SuperResolutionTestPortraitContrast = 0 | 0.2 | 0.3 | 0.4 | 0.6 | 0.8;

/** Test-only edge-preserving deblock strength for compressed sources. */
export type SuperResolutionTestDeblock = 0 | 0.2 | 0.4;

/** Test-only film-grain amplitude for synthetic faces. */
export type SuperResolutionTestGrain = 0 | 0.03 | 0.06 | 0.08;

/** Test-only soft skin-tone mask strength for portrait contrast. */
export type SuperResolutionTestFaceMask = 0 | 0.5 | 1;

export type Toast = {
  id: number;
  msg: string;
  icon?: "ok" | "heart" | "star" | "info";
  /** 线路切换专用的结构化内容，有这个就不看 msg */
  line?: { region: "cn" | "intl"; host: string; ms: number };
  /** 同 tag 的 toast 原地替换（如 playback-hint 统一承载播放状态提示），快速触发不堆叠；无 tag 正常堆叠。 */
  tag?: string;
};

/** Shared slot for transient action and playback hints; same-tag toasts replace in place. */
export const ACTION_TOAST_SLOT = "playback-hint";

/** 观看记录：看到第几集、第几秒（`dur` 用来判断是否已看完） */
export type WatchProgress = { id: number; ep: number; t: number; dur: number; at: number };

type Persist = GuestData & {
  muted: boolean;
  muteOnStartup: boolean;
  volume: number;
  searchHist: string[];
  /** 上下划切集：多集视频上下滑就换集，而不是换下一部 */
  swipeEp: boolean;
  /** 优先高清：有 HEVC 就用 HEVC，播不了自动回退标准 */
  preferHevc: boolean;
  /** App-level volume leveling: compress peaks and use slow AGC to level sources. */
  balanceVolume: boolean;
  /** 移动全屏控件无操作自动隐藏秒数：0=不自动隐藏（#146-3） */
  fsIdleSecs: number;
  /** 启动时打开的页面：默认首页；选非首页可避免开机自动播放污染观看历史（#180-1） */
  startupTab: Tab;
  /** Ambient light around the player, sampled from the current frame. */
  ambientGlow: boolean;
  /** Experimental picture enhancement for the player; "detail" is the FSRCNNX 2x path. */
  enhanceMode: EnhanceMode;
  /** Strength preset used when the picture-enhancement switch is on. */
  enhanceStrength: EnhanceStrength;
  /** Seconds to skip at video start (0 = off, max 600). */
  skipIntroSecs: number;
  /** Seconds before episode end to auto-advance to next episode (0 = off, max 600). */
  skipOutroSecs: number;
};

const LS = STORAGE_KEYS.app;
const DEFAULTS: Persist = {
  likes: [], favs: [], history: [], follows: [],
  muted: true, muteOnStartup: true, volume: 0.7, searchHist: [], swipeEp: true, preferHevc: true,
  balanceVolume: false, fsIdleSecs: 3, startupTab: "home", ambientGlow: true, enhanceMode: "off", enhanceStrength: "standard",
  skipIntroSecs: 0, skipOutroSecs: 0,
};

function clampSkipSecs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(600, Math.round(n)) : 0;
}

function normalizeEnhanceMode(raw: unknown): EnhanceMode | null {
  // The four experimental modes are collapsed into the single production
  // switch; legacy FSR/CAS values migrate to the AI detail preset.
  if (raw === "fsr" || raw === "cas" || raw === "detail") return "detail";
  return raw === "off" ? "off" : null;
}

function normalizeEnhanceStrength(raw: unknown): EnhanceStrength | null {
  return typeof raw === "string" && (ENHANCE_STRENGTHS as readonly string[]).includes(raw)
    ? raw as EnhanceStrength
    : null;
}

/** 旧版本 history 是 number[]，读出来时升级成带进度的结构 */
function normalizeHistory(raw: unknown): WatchProgress[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchProgress[] = [];
  raw.forEach((item, i) => {
    if (typeof item === "number") {
      out.push({ id: item, ep: 1, t: 0, dur: 0, at: Date.now() - i });
      return;
    }
    const h = item as Partial<WatchProgress> | null;
    if (h && typeof h.id === "number") {
      out.push({ id: h.id, ep: Number(h.ep) || 1, t: Number(h.t) || 0, dur: Number(h.dur) || 0, at: Number(h.at) || Date.now() - i });
    }
  });
  return out;
}

function loadPersist(): Persist {
  try {
    const raw = readStorage(LS);
    const swipeMigration = readStorage(STORAGE_KEYS.swipeEp);
    if (!raw) {
      try { localStorage.setItem(STORAGE_KEYS.swipeEp, "1"); } catch { /* ignore */ }
      return DEFAULTS;
    }
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persist>) };
    // 只在启动时应用；本次使用中取消静音不会关闭此偏好。
    const muteOnStartup = p.muteOnStartup !== false;
    /* 1.2.9 起上下划默认就是切集。老配置里 swipeEp 存的 false 是当年的默认值，
       不是用户主动关的，所以这里做一次性迁移；用户之后自己关掉不会再被改回来。 */
    let swipeEp = p.swipeEp !== false;
    try {
      if (swipeMigration !== "1") {
        swipeEp = true;
        localStorage.setItem(STORAGE_KEYS.swipeEp, "1");
      }
    } catch { /* ignore */ }
    const fsIdleSecs = [0, 3, 5, 10].includes(p.fsIdleSecs) ? p.fsIdleSecs : DEFAULTS.fsIdleSecs;
    const startupTab: Tab = (["home", "search", "category", "profile"] as Tab[]).includes(p.startupTab) ? p.startupTab : "home";
    const ambientGlow = p.ambientGlow !== false;
    const balanceVolume = p.balanceVolume === true;
    const enhanceMode = normalizeEnhanceMode(p.enhanceMode) ?? "off";
    const enhanceStrength = normalizeEnhanceStrength(p.enhanceStrength) ?? "standard";
    const skipIntroSecs = clampSkipSecs(p.skipIntroSecs);
    const skipOutroSecs = clampSkipSecs(p.skipOutroSecs);
    return { ...p, swipeEp, muteOnStartup, muted: muteOnStartup || p.muted === true, balanceVolume, fsIdleSecs, startupTab, ambientGlow, enhanceMode, enhanceStrength, skipIntroSecs, skipOutroSecs, history: normalizeHistory(p.history) };
  } catch {
    return DEFAULTS;
  }
}

function readThemePreference(): ThemePreference {
  try {
    const saved = readStorage(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== "system") return preference;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("theme-light", theme === "light");
  document.documentElement.style.colorScheme = theme;
  root.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && !root.hasAttribute("data-hg-launching")) {
    meta.content = theme === "light" ? "#eeece7" : "#121212";
  }
}

let themeTransitionTimer = 0;
function beginThemeTransition() {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.style.setProperty("--theme-transition-surface", getComputedStyle(root).getPropertyValue("--p-bg").trim());
  root.classList.add("theme-transitioning");
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => root.classList.remove("theme-transitioning"), 420);
}

type Store = {
  platform: Platform;
  theme: Theme; themePreference: ThemePreference; setTheme: (t: ThemePreference) => void;
  tab: Tab; setTab: (t: Tab) => void;
  stack: Page[]; push: (p: PageInput) => void; openRootPage: (p: PageInput) => void; pop: () => void;
  user: User | null; setUser: (u: User | null, origin?: string) => void;
  accountScope: string; accountSync: { busy: boolean; error: string; authError: boolean; lastSynced: number; favoritesKnown: boolean };
  accountGeneration: () => number;
  syncAccount: (options?: { manual?: boolean }) => Promise<void>;
  setCollected: (kind: "video" | "post", id: number, on: boolean, knownEpisodes?: number) => Promise<void>;
  setLiked: (kind: "video" | "post", id: number, ep: number, on: boolean) => Promise<void>;
  setFollowing: (id: number, on: boolean) => Promise<void>;
  actionPending: (key: string) => boolean;
  loginOpen: boolean; setLoginOpen: (b: boolean) => void;
  logout: () => Promise<void>;
  likes: number[]; favs: number[]; postLikes: number[]; postFavs: number[]; history: WatchProgress[]; follows: number[];
  favEpCounts: Record<number, number>;
  seedFavoriteEpisodes: (entries: Record<number, number>) => void;
  ackFavoriteEpisodes: (id: number, knownEpisodes: number) => void;
  isLiked: (id: number, ep?: number, kind?: "video" | "post") => boolean; isFav: (id: number, kind?: "video" | "post") => boolean;
  toggleLikeLocal: (id: number) => boolean;
  toggleFavLocal: (id: number) => boolean;
  /** 记一条观看记录；`ep/t/dur` 省略时保留原进度，`ep` 变了就把进度归零 */
  addHistory: (id: number, ep?: number, t?: number, dur?: number) => void;
  clearHistory: () => Promise<void>;
  removeHistory: (ids: number[]) => Promise<void>;
  mergePeerLibrary: (incoming: { favs?: readonly number[]; postFavs?: readonly number[]; history?: readonly WatchProgress[] }) => { addedFavs: number; addedPostFavs: number; updatedHistory: number };
  toggleFollowLocal: (uid: number) => boolean;
  theater: boolean; setTheater: (v: boolean | ((p: boolean) => boolean)) => void;
  fs: boolean; setFs: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 移动端「净屏」：只留画面，UI 全隐 */
  clean: boolean; setClean: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 锁屏状态：锁屏期间隐藏移动端底栏 */
  locked: boolean; setLocked: (v: boolean) => void;
  muted: boolean; setMuted: (v: boolean | ((p: boolean) => boolean)) => void;
  muteOnStartup: boolean; setMuteOnStartup: (on: boolean) => void;
  swipeEp: boolean; setSwipeEp: (on: boolean) => void;
  preferHevc: boolean; setPreferHevc: (on: boolean) => void;
  balanceVolume: boolean; setBalanceVolume: (on: boolean) => void;
  fsIdleSecs: number; setFsIdleSecs: (s: number) => void;
  startupTab: Tab; setStartupTab: (t: Tab) => void;
  ambientGlow: boolean; setAmbientGlow: (on: boolean) => void;
  enhanceMode: EnhanceMode; setEnhanceMode: (mode: EnhanceMode) => void;
  enhanceStrength: EnhanceStrength; setEnhanceStrength: (strength: EnhanceStrength) => void;
  skipIntroSecs: number; setSkipIntroSecs: (secs: number) => void;
  skipOutroSecs: number; setSkipOutroSecs: (secs: number) => void;
  /** Test-only override for the super-resolution canvas size. */
  srTestScale: SuperResolutionTestScale; setSrTestScale: (scale: SuperResolutionTestScale) => void;
  /** Test-only gain for the FSRCNNX detail composite. */
  srTestDetailGain: SuperResolutionTestDetailGain; setSrTestDetailGain: (gain: SuperResolutionTestDetailGain) => void;
  /** Test-only mid-frequency contrast for skin and facial detail. */
  srTestPortraitContrast: SuperResolutionTestPortraitContrast; setSrTestPortraitContrast: (contrast: SuperResolutionTestPortraitContrast) => void;
  /** Test-only edge-preserving deblock strength for compressed sources. */
  srTestDeblock: SuperResolutionTestDeblock; setSrTestDeblock: (strength: SuperResolutionTestDeblock) => void;
  /** Test-only film-grain amplitude for synthetic faces. */
  srTestGrain: SuperResolutionTestGrain; setSrTestGrain: (grain: SuperResolutionTestGrain) => void;
  /** Test-only soft skin-tone mask strength for portrait contrast. */
  srTestFaceMask: SuperResolutionTestFaceMask; setSrTestFaceMask: (mask: SuperResolutionTestFaceMask) => void;
  volume: number; setVolume: (v: number) => void;
  searchHist: string[]; addSearch: (q: string) => void; removeSearch: (q: string) => void; clearSearchHist: () => void;
  strictSecurity: boolean; strictSecurityReady: boolean; securityPending: boolean; cliRelaxed: boolean; setStrictSecurity: (on: boolean) => Promise<void>;
  toasts: Toast[]; toast: (msg: string, icon?: Toast["icon"], tag?: string) => void;
  /** 线路切换计数：变了就让列表页重挂载，重新拉一遍数据 */
  lineEpoch: number;
  sourceState: SourceStateSnapshot | null | "unsupported";
  sourceStateStatus: "loading" | "ready" | "unsupported";
  activeSource: InstalledSourceSummary | null;
  capabilities: ResolvedSourceCapabilities;
  refreshSourceState: () => void;
};

export type ResolvedSourceCapabilities = {
  home: boolean;
  search: boolean;
  catalog: { categories: boolean; topics: boolean; tags: boolean; rankings: boolean; authors: boolean };
  detail: { episodes: boolean; related: boolean; comments: boolean };
  playback: { hls: boolean; mp4: boolean; subtitles: boolean };
  posts: boolean;
  account: boolean;
  lines: boolean;
};

const ALL_CAPABILITIES: ResolvedSourceCapabilities = {
  home: true,
  search: true,
  catalog: { categories: true, topics: true, tags: true, rankings: true, authors: true },
  detail: { episodes: true, related: true, comments: true },
  playback: { hls: true, mp4: true, subtitles: true },
  posts: true,
  account: true,
  lines: true,
};

const NO_CAPABILITIES: ResolvedSourceCapabilities = {
  home: false,
  search: false,
  catalog: { categories: false, topics: false, tags: false, rankings: false, authors: false },
  detail: { episodes: false, related: false, comments: false },
  playback: { hls: false, mp4: false, subtitles: false },
  posts: false,
  account: false,
  lines: false,
};

/** Test-only query override used by the playback fixture; defaults to the standard gain. */
function readTestDetailGain(): SuperResolutionTestDetailGain {
  if (typeof window === "undefined") return 1;
  const raw = new URLSearchParams(window.location.search).get("srgain");
  return raw === "2" ? 2 : raw === "1.5" ? 1.5 : 1;
}

function readTestPortraitContrast(): SuperResolutionTestPortraitContrast {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("srcontrast");
  return raw === "0.4" ? 0.4 : raw === "0.3" ? 0.3 : raw === "0.2" ? 0.2 : 0;
}

function readTestDeblock(): SuperResolutionTestDeblock {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("srdeblock");
  return raw === "0.4" ? 0.4 : raw === "0.2" ? 0.2 : 0;
}

function readTestGrain(): SuperResolutionTestGrain {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("srgrain");
  return raw === "0.06" ? 0.06 : raw === "0.03" ? 0.03 : 0;
}

function readTestFaceMask(): SuperResolutionTestFaceMask {
  if (typeof window === "undefined") return 0;
  const raw = new URLSearchParams(window.location.search).get("srmask");
  return raw === "1" ? 1 : raw === "0.5" ? 0.5 : 0;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);
let seq = 0;

/* 独立订阅 Toast 列表：弹出/消失只重渲染 ToastHost，不惊动全应用 30 个 useStore() 页面 */
let toastList: Toast[] = [];
let toastNextId = 0;
const toastTimers = new Map<number, number>();
const toastListeners = new Set<() => void>();
function updateToasts(updater: (prev: Toast[]) => Toast[]) {
  toastList = updater(toastList);
  toastListeners.forEach((fn) => fn());
}
function scheduleToastRemoval(id: number, durationMs: number) {
  const prev = toastTimers.get(id);
  if (prev !== undefined) window.clearTimeout(prev);
  if (durationMs <= 0) {
    toastTimers.delete(id);
    return;
  }
  toastTimers.set(id, window.setTimeout(() => {
    toastTimers.delete(id);
    updateToasts((list) => list.filter((x) => x.id !== id));
  }, durationMs));
}
function pushToastItem(item: Omit<Toast, "id">, durationMs: number) {
  const existing = item.tag ? toastList.find((x) => x.tag === item.tag) : undefined;
  if (existing) {
    // 同 tag：原地换内容并重置计时——不新增卡片、不重放入场动画。
    updateToasts((prev) => prev.map((x) => (x.id === existing.id ? { ...item, id: existing.id } : x)));
    scheduleToastRemoval(existing.id, durationMs);
    return;
  }
  const id = ++toastNextId;
  updateToasts((prev) => [...prev.slice(-2), { ...item, id }]);
  scheduleToastRemoval(id, durationMs);
}
const subscribeToasts = (fn: () => void) => {
  toastListeners.add(fn);
  return () => { toastListeners.delete(fn); };
};
const getToasts = () => toastList;
export const useToasts = () => useSyncExternalStore(subscribeToasts, getToasts);

/** Show a toast that stays until explicitly dismissed or replaced by another same-tag toast. */
export function showStickyToast(msg: string, icon?: Toast["icon"], tag?: string) {
  pushToastItem({ msg, icon, tag }, 0);
}

/** Remove toasts with the given tag and optional exact message, and cancel their expiry timers. */
export function dismissToast(tag: string, msg?: string) {
  const matches = (item: Toast) => item.tag === tag && (msg === undefined || item.msg === msg);
  const removed = toastList.filter(matches);
  if (!removed.length) return;
  for (const item of removed) {
    const timer = toastTimers.get(item.id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.delete(item.id);
    }
  }
  updateToasts((list) => list.filter((item) => !matches(item)));
}

/**
 * Keep a tagged sticky toast in sync with a transient visible condition.
 * The toast stays mounted while visible, updates in place when the message
 * changes, and is removed when the condition or its owner goes away.
 */
export function useStickyToast(visible: boolean, msg: string, tag: string, icon?: Toast["icon"]) {
  const active = useRef(false);
  const text = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      if (!active.current) return;
      active.current = false;
      const previous = text.current;
      text.current = null;
      dismissToast(tag, previous ?? undefined);
      return;
    }
    active.current = true;
    text.current = msg;
    showStickyToast(msg, icon, tag);
  }, [icon, msg, tag, visible]);
  useEffect(() => () => {
    if (!active.current) return;
    active.current = false;
    const previous = text.current;
    text.current = null;
    dismissToast(tag, previous ?? undefined);
  }, [tag]);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [p, setP] = useState<Persist>(loadPersist);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(readThemePreference);
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(readThemePreference()));
  const themeRef = useRef(theme);
  const [tab, setTabRaw] = useState<Tab>(p.startupTab);
  const [srTestScale, setSrTestScale] = useState<SuperResolutionTestScale>("auto");
  const [srTestDetailGain, setSrTestDetailGain] = useState<SuperResolutionTestDetailGain>(readTestDetailGain);
  const [srTestPortraitContrast, setSrTestPortraitContrast] = useState<SuperResolutionTestPortraitContrast>(readTestPortraitContrast);
  const [srTestDeblock, setSrTestDeblock] = useState<SuperResolutionTestDeblock>(readTestDeblock);
  const [srTestGrain, setSrTestGrain] = useState<SuperResolutionTestGrain>(readTestGrain);
  const [srTestFaceMask, setSrTestFaceMask] = useState<SuperResolutionTestFaceMask>(readTestFaceMask);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [stack, setStack] = useState<Page[]>([]);
  // Guest library writes must not roll back sound, quality, gestures or search preferences.
  const account = useAccountData(
    pickGuestData(p),
    data => setP(previous => ({ ...previous, ...pickGuestData(data) })),
  );
  const { user, setUser } = account;
  const accountRef = useRef(account); accountRef.current = account;
  const [loginOpen, setLoginOpen] = useState(false);
  const [lineEpoch, setLineEpoch] = useState(0);
  const [theater, setTheaterState] = useState(false);
  const [fs, setFsState] = useState(false);
  const [clean, setCleanState] = useState(false);
  const [locked, setLockedState] = useState(false);
  const lastVolumeRef = useRef(p.volume > 0 ? p.volume : 0.7);
  const [strictSecurity, setStrictSecurityState] = useState<boolean>(isStrictSecurity);
  const [cliRelaxed, setCliRelaxed] = useState(false);
  const [strictSecurityReady, setStrictSecurityReady] = useState(false);
  const [securityPending, setSecurityPending] = useState(false);
  const [sourceState, setSourceState] = useState<SourceStateSnapshot | null | "unsupported">(null);
  const sourceReqRef = useRef(0);
  const loadedSourceIdRef = useRef<string | null | undefined>(undefined);
  const pendingEpochBumpRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadSourceState = useCallback((bumpEpoch = false) => {
    if (bumpEpoch === true) pendingEpochBumpRef.current = true;
    const req = ++sourceReqRef.current;
    void api.sourceState()
      .then((snap) => {
        if (!mountedRef.current || req !== sourceReqRef.current) return;
        if (snap && typeof snap === "object" && Array.isArray(snap.sources)) {
          const nextSourceId =
            snap.sources.find((s) => s.active)?.id ??
            snap.activeSourceId ??
            null;
          const prevSourceId = loadedSourceIdRef.current;
          loadedSourceIdRef.current = nextSourceId;
          const sourceChanged = prevSourceId !== undefined && prevSourceId !== nextSourceId;
          const shouldBump = pendingEpochBumpRef.current || sourceChanged;
          pendingEpochBumpRef.current = false;
          setSourceState(snap);
          if (shouldBump) {
            setLineEpoch((n) => n + 1);
          }
        } else {
          pendingEpochBumpRef.current = false;
          setSourceState("unsupported");
        }
      })
      .catch(() => {
        if (!mountedRef.current || req !== sourceReqRef.current) return;
        pendingEpochBumpRef.current = false;
        setSourceState("unsupported");
      });
  }, []);

  const refreshSourceState = useCallback(() => loadSourceState(false), [loadSourceState]);

  useEffect(() => {
    loadSourceState(false);
    const onSourceChanged = () => loadSourceState(true);
    window.addEventListener("hg:source-changed", onSourceChanged);
    return () => window.removeEventListener("hg:source-changed", onSourceChanged);
  }, [loadSourceState]);

  const sourceStateRef = useRef(sourceState);
  sourceStateRef.current = sourceState;
  const sourceReady = sourceState !== null && sourceState !== "unsupported";

  useEffect(() => {
    if (!sourceReady) return;
    const timer = window.setTimeout(() => {
      void runSilentSourceUpdate(sourceStateRef.current, { force: true });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [sourceReady]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void runSilentSourceUpdate(sourceStateRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const sourceStateStatus: "loading" | "ready" | "unsupported" =
    sourceState === null ? "loading" : sourceState === "unsupported" ? "unsupported" : "ready";

  const activeSource = useMemo<InstalledSourceSummary | null>(() => {
    if (!sourceState || sourceState === "unsupported") return null;
    return (
      sourceState.sources.find((s) => s.active) ??
      (sourceState.activeSourceId
        ? sourceState.sources.find((s) => s.id === sourceState.activeSourceId) ?? null
        : null)
    );
  }, [sourceState]);

  const capabilities = useMemo<ResolvedSourceCapabilities>(() => {
    if (sourceState === null || sourceState === "unsupported") return ALL_CAPABILITIES;
    if (!activeSource) return NO_CAPABILITIES;
    const c = activeSource.capabilities;
    return {
      home: !!c.home,
      search: !!c.search,
      catalog: {
        categories: !!c.catalog?.categories,
        topics: c.catalog?.topics ?? !!c.catalog?.categories,
        tags: !!c.catalog?.tags,
        rankings: !!c.catalog?.rankings,
        authors: !!c.catalog?.authors,
      },
      detail: {
        episodes: !!c.detail?.episodes,
        related: !!c.detail?.related,
        comments: !!c.detail?.comments,
      },
      playback: {
        hls: !!c.playback?.hls,
        mp4: !!c.playback?.mp4,
        subtitles: !!c.playback?.subtitles,
      },
      posts: !!c.posts,
      account: !!c.account,
      lines: !!c.lines,
    };
  }, [sourceState, activeSource]);

  const prevSourceIdRef = useRef<string | null | undefined>(undefined);
  const readBootRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    accountRef.current.setGuestSource(activeSource?.id ?? null);
  }, [activeSource?.id]);
  useEffect(() => {
    if (sourceState === null) return;
    const nextId = activeSource?.id ?? null;
    if (prevSourceIdRef.current !== undefined && prevSourceIdRef.current !== nextId) {
      setStack([]);
      // Run app_boot AFTER useLayoutEffect has updated guestSourceId & generation,
      // so setGuestSource cannot invalidate restoreSession when switching back to a logged-in source.
      readBootRef.current();
    }
    prevSourceIdRef.current = nextId;
  }, [sourceState, activeSource?.id]);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = resolveTheme(themePreference);
      if (themeRef.current !== next) beginThemeTransition();
      themeRef.current = next;
      setThemeState(next);
    };
    sync();
    if (themePreference === "system") {
      media.addEventListener?.("change", sync);
      return () => media.removeEventListener?.("change", sync);
    }
  }, [themePreference]);

  useLayoutEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(STORAGE_KEYS.theme, themePreference); } catch { /* ignore */ }
  }, [theme, themePreference]);

  const setTheme = useCallback((next: ThemePreference) => {
    const resolved = resolveTheme(next);
    if (resolved !== themeRef.current) beginThemeTransition();
    themeRef.current = resolved;
    setThemePreferenceState(next);
    setThemeState(resolved);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* ignore */ }
  }, [p]);

  useEffect(() => {
    let request = 0;
    let active = true;
    const readBoot = () => {
      const current = ++request;
      const generation = accountRef.current.generation();
      void api.boot().then((r) => {
        if (!active || current !== request) return;
        setSiteOrigin(r.base || "");
        accountRef.current.restoreSession(r.user && (r.user as User).id ? r.user as User : null, r.base || "", generation);
        if (typeof r.strict_security === "boolean") {
          setStrictSecurityState(r.strict_security);
          setHtmlStrictSecurity(r.strict_security);
          setStrictSecurityReady(true);
        }
        setCliRelaxed(!!r.cli_relaxed);
      }).catch(() => { /* 离线也能用 */ });
    };
    readBootRef.current = readBoot;
    readBoot();
    // 切线/代理变化后由 boot 决定会话：可信线路间后端保留登录（rebase），
    // 不再先 setUser(null) 闪退；不可信/自定义切线后端已清会话，boot 返回 null 正常登出。
    // 切源后的 boot 由上方 activeSource?.id effect 在 setGuestSource 完成后触发，避免 generation 竞态丢会话。
    const changed = () => { readBoot(); };
    window.addEventListener("hg:line-changed", changed);
    window.addEventListener("hg:proxy-changed", changed);
    return () => {
      active = false;
      readBootRef.current = () => {};
      window.removeEventListener("hg:line-changed", changed);
      window.removeEventListener("hg:proxy-changed", changed);
    };
  }, []);

  const setStrictSecurity = useCallback(async (on: boolean) => {
    if (!strictSecurityReady) throw new Error(tr("安全设置尚未读取，请重新启动应用"));
    setSecurityPending(true);
    try {
      const saved = await api.securitySet(on);
      setHtmlStrictSecurity(saved);
      setStrictSecurityState(saved);
    } finally {
      setSecurityPending(false);
    }
  }, [strictSecurityReady]);

  const toast = useCallback((msg: string, icon?: Toast["icon"], tag?: string) => {
    pushToastItem({ msg, icon, tag }, 2200);
  }, []);
  /** 自动选线切换成功后由 `autoLine.ts` 派发，这里只负责显示 */
  useEffect(() => {
    const onLine = (e: Event) => {
      const d = (e as CustomEvent<{ region: "cn" | "intl"; host: string; ms: number }>).detail;
      if (!d) return;
      pushToastItem({ msg: "", line: d }, 3200);
    };
    window.addEventListener("hg:line", onLine);
    return () => window.removeEventListener("hg:line", onLine);
  }, []);
  /** 自动选线：默认线路与备选线路全都不通。
   *
   * 只说一次（60s 节流）——巡检本身 10s 一轮，不节流会一直弹。
   * 以前这种情况会悄悄切到 `.ai`（接口全 404），用户只看到「加载失败」，
   * 根本不知道是网络的事。
   */
  useEffect(() => {
    let last = 0;
    const onDown = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      pushToastItem({ msg: tr("线路全部不可用，请检查网络或代理"), icon: "info" }, 3600);
    };
    window.addEventListener("hg:line-down", onDown);
    return () => window.removeEventListener("hg:line-down", onDown);
  }, []);
  /** 线路真的换了（自动、手切都算）：
   *
   * 旧数据全是在上一个域名上拉的，留着等于对着一条死链路。但各列表页只在
   * 挂载时拉一次，所以这里给一个递增的 key，让它们重挂载、重新请求。
   */
  useEffect(() => {
    const bump = () => setLineEpoch((n) => n + 1);
    window.addEventListener("hg:line-changed", bump);
    window.addEventListener("hg:proxy-changed", bump);
    window.addEventListener("hg:source-changed", bump);
    return () => {
      window.removeEventListener("hg:line-changed", bump);
      window.removeEventListener("hg:proxy-changed", bump);
      window.removeEventListener("hg:source-changed", bump);
    };
  }, []);

  const exitNativeFs = useCallback(() => {
    if (getFullscreenElement()) {
      void exitDocumentFullscreen().catch(() => {});
    }
  }, []);

  const setTab = useCallback((t: Tab) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setLockedState(false);
    if (t !== "home") setTheaterState(false);
    setTabRaw(t);
    setStack(s => s.length ? [] : s);
  }, [exitNativeFs]);
  useEffect(() => { if (tab === "profile") void accountRef.current.syncAccount().catch(() => {}); }, [tab]);
  const push = useCallback((pg: PageInput) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setLockedState(false);
    if (pg.kind !== "feed") setTheaterState(false);
    setStack((s) => {
      const next = [...s, { ...pg, key: `p${++seq}` } as Page];
      return next.length > 8 ? next.slice(next.length - 8) : next;
    });
  }, [exitNativeFs]);
  const openRootPage = useCallback((pg: PageInput) => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setLockedState(false);
    if (pg.kind !== "feed") setTheaterState(false);
    setStack([{ ...pg, key: `p${++seq}` } as Page]);
  }, [exitNativeFs]);
  const pop = useCallback(() => {
    exitNativeFs();
    setFsState(false);
    setCleanState(false);
    setLockedState(false);
    setStack((s) => {
      const next = s.slice(0, -1);
      if (!next.length && tabRef.current !== "home") setTheaterState(false);
      return next;
    });
  }, [exitNativeFs]);

  const addSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: [t, ...s.searchHist.filter((x) => x !== t)].slice(0, 12) }));
  }, []);
  const removeSearch = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setP((s) => ({ ...s, searchHist: s.searchHist.filter((x) => x !== t) }));
  }, []);
  const clearSearchHist = useCallback(() => setP((s) => ({ ...s, searchHist: [] })), []);

  const logout = useCallback(async () => {
    await accountRef.current.logout();
    toast(tr("已退出登录"), "info");
  }, [toast]);

  const setTheater = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setTheaterState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setFs = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setFsState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
    // 进出全屏/净屏时把「净屏」收掉，避免退出后 UI 还藏着
    setCleanState(false);
  }, []);

  const setClean = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setCleanState((prev) => (typeof v === "function" ? (v as (p: boolean) => boolean)(prev) : v));
  }, []);

  const setLocked = useCallback((v: boolean) => {
    setLockedState(v);
  }, []);

  const setMuted = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setP((s) => {
      const nextMuted = typeof v === "function" ? v(s.muted) : v;
      if (!nextMuted && s.volume === 0) {
        return { ...s, muted: false, volume: lastVolumeRef.current || 0.7 };
      }
      return { ...s, muted: nextMuted };
    });
  }, []);
  const setMuteOnStartup = useCallback((on: boolean) => {
    setP((s) => ({ ...s, muteOnStartup: on }));
  }, []);
  const setSwipeEp = useCallback((on: boolean) => {
    setP((s) => ({ ...s, swipeEp: on }));
  }, []);
  const setPreferHevc = useCallback((on: boolean) => {
    setP((s) => ({ ...s, preferHevc: on }));
  }, []);
  const setBalanceVolume = useCallback((on: boolean) => {
    setP((s) => ({ ...s, balanceVolume: on }));
  }, []);
  const setFsIdleSecs = useCallback((secs: number) => {
    setP((s) => ({ ...s, fsIdleSecs: [0, 3, 5, 10].includes(secs) ? secs : 3 }));
  }, []);
  const setStartupTab = useCallback((t: Tab) => {
    setP((s) => ({ ...s, startupTab: (["home", "search", "category", "profile"] as Tab[]).includes(t) ? t : "home" }));
  }, []);
  const setAmbientGlow = useCallback((on: boolean) => {
    setP((s) => ({ ...s, ambientGlow: on }));
  }, []);
  const setEnhanceMode = useCallback((mode: EnhanceMode) => {
    setP((s) => ({ ...s, enhanceMode: normalizeEnhanceMode(mode) ?? "off" }));
  }, []);
  const setEnhanceStrength = useCallback((strength: EnhanceStrength) => {
    setP((s) => ({ ...s, enhanceStrength: normalizeEnhanceStrength(strength) ?? "standard" }));
  }, []);
  const setSkipIntroSecs = useCallback((secs: number) => {
    setP((s) => ({ ...s, skipIntroSecs: clampSkipSecs(secs) }));
  }, []);
  const setSkipOutroSecs = useCallback((secs: number) => {
    setP((s) => ({ ...s, skipOutroSecs: clampSkipSecs(secs) }));
  }, []);
  const setVolume = useCallback((v: number) => {
    const volume = Math.max(0, Math.min(1, v));
    if (volume > 0) lastVolumeRef.current = volume;
    setP((s) => ({ ...s, volume, muted: volume === 0 }));
  }, []);

  const value = useMemo<Store>(() => ({
    platform: envPlatform,
    theme, themePreference, setTheme,
    tab, setTab, stack, push, openRootPage, pop,
    user, setUser, loginOpen, setLoginOpen, logout,
    accountScope: account.accountScope, accountSync: account.accountSync, syncAccount: account.syncAccount,
    accountGeneration: account.generation,
    likes: account.likes, favs: account.favs, postLikes: account.postLikes, postFavs: account.postFavs, history: account.history, follows: account.follows,
    favEpCounts: account.favEpCounts, seedFavoriteEpisodes: account.seedFavoriteEpisodes, ackFavoriteEpisodes: account.ackFavoriteEpisodes,
    isLiked: account.isLiked, isFav: account.isFav,
    setCollected: account.setCollected, setLiked: account.setLiked, setFollowing: account.setFollowing, actionPending: account.actionPending,
    toggleLikeLocal: account.toggleLikeLocal, toggleFavLocal: account.toggleFavLocal, toggleFollowLocal: account.toggleFollowLocal,
    addHistory: account.addHistory, clearHistory: account.clearHistory, removeHistory: account.removeHistory, mergePeerLibrary: account.mergePeerLibrary,
    muted: p.muted, setMuted, volume: p.volume, setVolume, theater, setTheater, fs, setFs, clean, setClean, locked, setLocked,
    muteOnStartup: p.muteOnStartup, setMuteOnStartup,
    swipeEp: p.swipeEp, setSwipeEp,
    preferHevc: p.preferHevc, setPreferHevc,
    balanceVolume: p.balanceVolume, setBalanceVolume,
    fsIdleSecs: p.fsIdleSecs, setFsIdleSecs,
    startupTab: p.startupTab, setStartupTab,
    ambientGlow: p.ambientGlow, setAmbientGlow,
    enhanceMode: p.enhanceMode, setEnhanceMode,
    enhanceStrength: p.enhanceStrength, setEnhanceStrength,
    skipIntroSecs: p.skipIntroSecs, setSkipIntroSecs,
    skipOutroSecs: p.skipOutroSecs, setSkipOutroSecs,
    srTestScale, setSrTestScale,
    srTestDetailGain, setSrTestDetailGain,
    srTestPortraitContrast, setSrTestPortraitContrast,
    srTestDeblock, setSrTestDeblock,
    srTestGrain, setSrTestGrain,
    srTestFaceMask, setSrTestFaceMask,
    searchHist: p.searchHist, addSearch, removeSearch, clearSearchHist,
    strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    get toasts() { return toastList; }, toast, lineEpoch,
    sourceState, sourceStateStatus, activeSource, capabilities, refreshSourceState,
  }), [theme, themePreference, setTheme, tab, setTab, stack, push, openRootPage, pop, user, loginOpen, logout,
    p, account,
    setMuted, setMuteOnStartup, setSwipeEp, setPreferHevc, setBalanceVolume, setFsIdleSecs, setStartupTab, setAmbientGlow, setEnhanceMode, setEnhanceStrength, setSkipIntroSecs, setSkipOutroSecs, srTestScale, srTestDetailGain, srTestPortraitContrast, srTestDeblock, srTestGrain, srTestFaceMask, setVolume, addSearch, removeSearch, clearSearchHist, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity,
    toast, lineEpoch, sourceState, sourceStateStatus, activeSource, capabilities, refreshSourceState, theater, setTheater, fs, setFs, clean, setClean, locked, setLocked]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
