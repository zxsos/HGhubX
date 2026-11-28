import { LiquidIndicator, Loader } from "../shared/ui/ios/effects";
import { Button } from "../shared/ui/ios/controls";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useStore, type Page, type Tab } from "../shared/model/store";
import { PageCoveredContext } from "../shared/model/pageVisibility";
import { isMobile, selfTest } from "../shared/api/api";
import { invoke } from "@tauri-apps/api/core";
import { runBack, subscribeNativeBack, syncOhosBackIntercept, useHasBackConsumer } from "../shared/lib/back";
import { useEdgeSwipeBack } from "../shared/ui/hooks/useEdgeSwipeBack";
import { exitApp } from "../shared/lib/appLifecycle";
import { exitDocumentFullscreen, getFullscreenElement } from "../shared/lib/fullscreen";
import { initMobileHaptics, triggerHaptic } from "../shared/lib/haptics";
import Home from "../features/feed/Home";
import LoginModal from "../features/account/LoginModal";
import { Empty, ToastHost } from "../shared/ui/ui";
import { DesktopRail, DesktopTitleBar } from "./shell/DesktopChrome";
import ResizeHandles from "./shell/ResizeHandles";
import { tracePlayback } from "../shared/diagnostics/playbackDiagnostics";
import { IGrid, IGridF, IHome, IHomeF, ISearch, IUser, IUserF } from "../shared/ui/icons";
import { tr, useLocale } from "../shared/i18n";
import DemoSourceBanner from "./DemoSourceBanner";
import { isDemoOfflineSource } from "../shared/lib/demoSource";

// Local chunks load on first visit; visited tabs stay mounted as before.
// Feed (+ hls.js) is separated from the initial shell so cold start mounts chrome and
// starts app_boot / autoLine / api_feed before compiling the 524 kB media engine.
const Feed = lazy(() => import("../features/feed/Feed"));
const Search = lazy(() => import("../features/search/Search"));
const RankPage = lazy(() => import("../features/search/Search").then(module => ({ default: module.RankPage })));
const Category = lazy(() => import("../features/category/Category"));
const ChannelPage = lazy(() => import("../features/category/Category").then(module => ({ default: module.ChannelPage })));
const Profile = lazy(() => import("../features/account/Profile"));
const SettingsPage = lazy(() => import("../features/settings/Settings"));
const PostsPage = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostsPage })));
const PostDetail = lazy(() => import("../features/posts/Posts").then(module => ({ default: module.PostDetail })));
const TopicsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicsPage })));
const TopicPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TopicPage })));
const TagsPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagsPage })));
const AuthorsPage = lazy(() => import("../features/authors/AuthorsPage").then(module => ({ default: module.AuthorsPage })));
const TagPage = lazy(() => import("../features/discover/Discover").then(module => ({ default: module.TagPage })));
const FollowingPage = lazy(() => import("../features/account/User").then(module => ({ default: module.FollowingPage })));
const UserPage = lazy(() => import("../features/account/User").then(module => ({ default: module.UserPage })));

function PageLoading() {
  return <div className="absolute inset-0 grid place-items-center bg-bg"><Loader label={tr("页面加载中")} /></div>;
}

const SELECTABLE_TEXT = 'input, textarea, [contenteditable="true"], .select-text, .article-body';
const isSelectableText = (target: EventTarget | null) => target instanceof Element && !!target.closest(SELECTABLE_TEXT);

function useAvailableTabs(): readonly Tab[] {
  const { capabilities, activeSource } = useStore();
  const canCategory = capabilities.catalog.categories || capabilities.catalog.tags || capabilities.catalog.rankings || capabilities.catalog.authors || capabilities.posts || Boolean(activeSource?.catalog?.channels?.some((c) => (c.kind === "post" ? capabilities.posts : capabilities.catalog.categories)));
  const tabs: Tab[] = [];
  if (capabilities.home) tabs.push("home");
  if (capabilities.search) tabs.push("search");
  if (canCategory) tabs.push("category");
  tabs.push("profile");
  return tabs;
}

type TabSwipeVisual = {
  phase: "idle" | "dragging" | "settling";
  visibleTabs: readonly Tab[];
  targetTab: Tab | null;
  targetIndex: number;
  fromPos: number;
  suppressAnimTab: Tab | null;
};

const IDLE_TAB_SWIPE: TabSwipeVisual = {
  phase: "idle",
  visibleTabs: [],
  targetTab: null,
  targetIndex: 0,
  fromPos: 0,
  suppressAnimTab: null,
};

type TabSwipeBridge = {
  visual: TabSwipeVisual;
  panesRef: { current: Partial<Record<Tab, HTMLDivElement | null>> };
  posRef: { current: number };
  startDrag: (startIndex: number, tabs: readonly Tab[]) => void;
  moveDrag: (pos: number, tabs: readonly Tab[]) => void;
  endDrag: (fromPos: number, targetIndex: number, tabs: readonly Tab[]) => void;
  finishSettle: () => void;
  clearSuppress: () => void;
};

const TAB_SWIPE_SETTLE_MS = 280;
const TAB_SWIPE_SETTLE_TRANSITION = `transform ${TAB_SWIPE_SETTLE_MS}ms cubic-bezier(.22, 1, .36, 1)`;

function applyTabEdgeRubberBand(raw: number, maxIndex: number): number {
  if (maxIndex <= 0) return 0;
  if (raw < 0) return -Math.min(0.18, -raw * 0.22);
  if (raw > maxIndex) return maxIndex + Math.min(0.18, (raw - maxIndex) * 0.22);
  return raw;
}

function sameTabList(a: readonly Tab[], b: readonly Tab[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function TabBar({ swipe }: { swipe: TabSwipeBridge }) {
  const { tab, setTab } = useStore();
  const availableTabs = useAvailableTabs();
  const allItems = [
    { key: "home", label: tr("首页"), Icon: IHome, Active: IHomeF },
    { key: "search", label: tr("搜索"), Icon: ISearch, Active: ISearch },
    { key: "category", label: tr("分类"), Icon: IGrid, Active: IGridF },
    { key: "profile", label: tr("我的"), Icon: IUser, Active: IUserF },
  ] as const;
  const items = allItems.filter(item => availableTabs.includes(item.key));
  const tabKeys = items.map(item => item.key);
  const index = Math.max(0, items.findIndex(item => item.key === tab));
  const glassRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    vx: number;
    startIndex: number;
    left: number;
    width: number;
    dragging: boolean;
    lastSlot: number;
    lastPos: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef(0);
  const dragRafRef = useRef(0);
  const pendingDragRef = useRef<{ pos: number; lightX: number; tabs: readonly Tab[] } | null>(null);
  const settleRafRef = useRef(0);
  const wasDraggingRef = useRef(false);
  const dropPosRef = useRef(index);
  const [dragState, setDragState] = useState<{ active: boolean; previewIndex: number }>({
    active: false,
    previewIndex: index,
  });

  const moveGlow = (x: number, visible: boolean) => {
    const glow = glowRef.current;
    if (!glow) return;
    glow.style.transform = `translate3d(${x}px, 0, 0)`;
    glow.style.opacity = visible ? "1" : "0";
  };

  useEffect(() => () => {
    window.clearTimeout(suppressTimerRef.current);
    if (dragRafRef.current) window.cancelAnimationFrame(dragRafRef.current);
    if (settleRafRef.current) window.cancelAnimationFrame(settleRafRef.current);
  }, []);

  useLayoutEffect(() => {
    const drop = dropRef.current;
    const justEndedDrag = wasDraggingRef.current && !dragState.active;
    wasDraggingRef.current = dragState.active;
    if (dragState.active || !drop) return;
    const targetTransform = `translate3d(${index * 100}%, 0, 0)`;
    if (settleRafRef.current) {
      window.cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
    }
    if (justEndedDrag) {
      // Keep the dragged position on the frame .is-dragging is removed, then glide to target.
      drop.style.transform = `translate3d(${dropPosRef.current * 100}%, 0, 0)`;
      settleRafRef.current = window.requestAnimationFrame(() => {
        settleRafRef.current = 0;
        dropPosRef.current = index;
        if (dropRef.current) dropRef.current.style.transform = targetTransform;
      });
      return;
    }
    dropPosRef.current = index;
    drop.style.transform = targetTransform;
  }, [dragState.active, index]);

  const flushDragFrame = () => {
    dragRafRef.current = 0;
    const pending = pendingDragRef.current;
    if (!pending) return;
    pendingDragRef.current = null;
    dropPosRef.current = pending.pos;
    if (dropRef.current) {
      dropRef.current.style.transform = `translate3d(${pending.pos * 100}%, 0, 0)`;
    }
    moveGlow(pending.lightX, true);
    swipe.moveDrag(pending.pos, pending.tabs);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClickRef.current = false;
    window.clearTimeout(suppressTimerRef.current);
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    const rect = glassRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    moveGlow(Math.max(0, Math.min(rect.width, e.clientX - rect.left)), true);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastTime: performance.now(),
      vx: 0,
      startIndex: index,
      left: rect.left,
      width: rect.width,
      dragging: false,
      lastSlot: index,
      lastPos: index,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const now = performance.now();
    const dt = now - drag.lastTime;
    if (dt >= 4) {
      const instantVx = (e.clientX - drag.lastX) / dt;
      drag.vx = drag.vx * 0.45 + instantVx * 0.55;
      drag.lastX = e.clientX;
      drag.lastTime = now;
    }
    if (!drag.dragging) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.1) return;
      drag.dragging = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      swipe.startDrag(drag.startIndex, tabKeys);
      setDragState({ active: true, previewIndex: drag.startIndex });
    }
    const maxIndex = Math.max(0, items.length - 1);
    const slotWidth = drag.width / Math.max(1, items.length);
    const rawPos = drag.startIndex + dx / slotWidth;
    const pos = applyTabEdgeRubberBand(rawPos, maxIndex);
    drag.lastPos = pos;
    const lightX = Math.max(0, Math.min(drag.width, e.clientX - drag.left));
    pendingDragRef.current = { pos, lightX, tabs: tabKeys };
    if (!dragRafRef.current) {
      dragRafRef.current = window.requestAnimationFrame(flushDragFrame);
    }
    const slot = Math.round(Math.max(0, Math.min(maxIndex, pos)));
    if (slot !== drag.lastSlot) {
      drag.lastSlot = slot;
      setDragState({ active: true, previewIndex: slot });
      triggerHaptic("tick");
    }
  };

  const finishDrag = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (dragRafRef.current) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    if (drag.dragging && pendingDragRef.current) {
      flushDragFrame();
    } else {
      pendingDragRef.current = null;
    }
    if (drag.dragging) {
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch { /* ignore */ }
      suppressClickRef.current = true;
      window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = window.setTimeout(() => { suppressClickRef.current = false; }, 80);
      const maxIndex = Math.max(0, items.length - 1);
      const slotWidth = drag.width / Math.max(1, items.length);
      const dx = e.clientX - drag.startX;
      const fromPos = drag.lastPos;
      let target = drag.startIndex;
      if (!cancelled) {
        const clamped = Math.max(0, Math.min(maxIndex, drag.startIndex + dx / slotWidth));
        const flickBias = Math.abs(drag.vx) >= 0.55 ? Math.sign(drag.vx) * 0.25 : 0;
        target = Math.round(Math.max(0, Math.min(maxIndex, clamped + flickBias)));
        if (target === drag.startIndex && (Math.abs(dx) >= 24 || Math.abs(drag.vx) >= 0.35)) {
          const dir = Math.abs(drag.vx) >= 0.35 ? Math.sign(drag.vx) : Math.sign(dx);
          target = Math.max(0, Math.min(maxIndex, drag.startIndex + dir));
        }
      }
      swipe.endDrag(fromPos, target, tabKeys);
      if (!cancelled && target !== drag.startIndex) setTab(items[target].key);
    }
    if (glowRef.current) glowRef.current.style.opacity = "0";
    setDragState({ active: false, previewIndex: index });
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const previewIndex = dragState.active ? dragState.previewIndex : index;
  const overVideo = tab === "home";

  return <nav className="hg-tabbar ios-mobile-nav" aria-label={tr("主导航")} data-over-video={overVideo}>
      <div ref={glassRef} className="hg-glass" data-dragging={dragState.active ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finishDrag(e, false)}
        onPointerCancel={(e) => finishDrag(e, true)}
        onClickCapture={onClickCapture}>
      <span ref={glowRef} className="ios-nav-glow" aria-hidden="true" />
      <div ref={dropRef} className={`hg-drop${dragState.active ? " is-dragging" : ""}`} aria-hidden="true"><LiquidIndicator /></div>
      <div className="ios-mobile-nav-items">
        {items.map(({ key, label, Icon, Active }, i) => {
          const isHighlighted = previewIndex === i;
          const Glyph = isHighlighted ? Active : Icon;
          return <Button key={key} className="ios-mobile-nav-item"
            data-preview={dragState.active && isHighlighted ? "true" : undefined}
            onClick={() => {
              if (key === "home" && tab === "home") {
                window.dispatchEvent(new Event("hg:home-refresh"));
                return;
              }
              /* Re-tapping the active Search tab returns to the search landing state;
                 the input clear button is hard to reach on tall screens. */
              if (key === "search" && tab === "search") {
                window.dispatchEvent(new Event("hg:search-reset"));
                return;
              }
              if (key === "profile" && tab === "profile") {
                window.dispatchEvent(new Event("hg:profile-reset"));
                return;
              }
              if (key === tab) return;
              swipe.clearSuppress();
              setTab(key);
            }}
            aria-current={tab === key ? "page" : undefined}>
            <Glyph size={22} /><span>{label}</span>
          </Button>;
        })}
      </div>
    </div>
  </nav>;
}

/* ============ 堆栈页面 ============ */
function StackPage(props: Parameters<typeof StackPageContent>[0]) {
  return <Suspense fallback={<PageLoading />}><StackPageContent {...props} /></Suspense>;
}

function StackPageContent({ page, onBack, wide, top, bottomInset, loginOpen }: {
  page: Page; onBack: () => void; wide: boolean; top: boolean; bottomInset: number; loginOpen: boolean;
}) {
  const { capabilities } = useStore();
  const unsupported = <Empty icon={<IGrid size={26} />} title={tr("当前视频源不支持该功能")} action={tr("返回")} onAction={onBack} />;
  if (page.kind === "feed") {
    return (
      <Feed videoIds={page.videoIds} startIndex={page.index} title={page.title} kind={page.feedKind || "video"}
        startEp={page.startEp} startTime={page.startTime}
        mode="context" active={top && !loginOpen} bottomInset={bottomInset} onBack={onBack} />
    );
  }
  if (page.kind === "channel") return <ChannelPage cate={page.cate} name={page.name} onBack={onBack} wide={wide} />;
  if (page.kind === "ranks") return capabilities.catalog.rankings ? <RankPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "settings") return <SettingsPage onBack={onBack} wide={wide} initialSection={page.section} />;
  if (page.kind === "posts") return capabilities.posts ? <PostsPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "post") return capabilities.posts ? <PostDetail id={page.id} onBack={onBack} active={top && !loginOpen} /> : unsupported;
  if (page.kind === "topics") return capabilities.catalog.topics ? <TopicsPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "topic") return capabilities.catalog.topics ? <TopicPage slug={page.slug} name={page.name} onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "tags") return capabilities.catalog.tags ? <TagsPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "tag") return capabilities.catalog.tags ? <TagPage tag={page.tag} name={page.name} onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "authors") return capabilities.catalog.authors ? <AuthorsPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "following") return capabilities.account ? <FollowingPage onBack={onBack} wide={wide} /> : unsupported;
  if (page.kind === "user") return capabilities.catalog.authors || capabilities.account ? <UserPage id={page.id} name={page.name} onBack={onBack} wide={wide} /> : unsupported;
  return null;
}

/** Hide covered pages from the compositor while keeping React state and scroll offsets intact. */
function LayerBox({
  hidden, inert, ariaHidden, className, enterClass, style, swipeBack, children,
}: {
  hidden: boolean;
  inert: boolean;
  ariaHidden: boolean;
  className: string;
  enterClass?: string;
  style?: CSSProperties;
  swipeBack?: { enabled: boolean; onBack: () => void };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeSwipeBack(ref, !!swipeBack?.enabled && !hidden, swipeBack?.onBack);
  const scrollOffsetsRef = useRef<Map<HTMLElement, number>>(new Map());
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [entered, setEntered] = useState(() => !enterClass || hidden);
  const [hasPip, setHasPip] = useState(false);

  useEffect(() => {
    if (hidden) setEntered(true);
  }, [hidden]);

  useEffect(() => {
    if (hidden || entered || !enterClass) return undefined;
    // Fallback for prefers-reduced-motion or interrupted animations where animationend never fires.
    const timer = window.setTimeout(() => setEntered(true), 480);
    return () => window.clearTimeout(timer);
  }, [hidden, entered, enterClass]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      if (hiddenRef.current) return;
      const target = e.target;
      if (target instanceof HTMLElement && root.contains(target)) {
        scrollOffsetsRef.current.set(target, target.scrollTop);
      }
    };
    const syncPip = () => {
      const pip = document.pictureInPictureElement;
      setHasPip(!!pip && root.contains(pip));
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    root.addEventListener("enterpictureinpicture", syncPip, true);
    root.addEventListener("leavepictureinpicture", syncPip, true);
    syncPip();
    return () => {
      root.removeEventListener("scroll", onScroll, true);
      root.removeEventListener("enterpictureinpicture", syncPip, true);
      root.removeEventListener("leavepictureinpicture", syncPip, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (hidden) return;
    const saved = scrollOffsetsRef.current;
    if (!saved.size) return;
    for (const [el, top] of Array.from(saved.entries())) {
      if (!el.isConnected) {
        saved.delete(el);
        continue;
      }
      if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    }
  }, [hidden]);

  const entering = !hidden && !entered && !!enterClass;
  const baseStyle: CSSProperties | undefined = entering
    ? { ...style, borderLeft: "1px solid var(--ios-edge)" }
    : style;
  const boxStyle: CSSProperties | undefined = hidden && hasPip
    ? { ...baseStyle, visibility: "hidden", pointerEvents: "none" }
    : baseStyle;
  const boxClass = hidden
    ? (hasPip ? `${className} pointer-events-none` : `${className} ios-layer-hidden`)
    : `${className}${entering ? ` ${enterClass}` : ""}`;

  return (
    <PageCoveredContext.Provider value={hidden}>
      <div ref={ref} inert={inert} aria-hidden={ariaHidden} className={boxClass} style={boxStyle}
        onAnimationEnd={entering ? (e) => { if (e.target === ref.current) setEntered(true); } : undefined}>
        {children}
      </div>
    </PageCoveredContext.Provider>
  );
}

/* ============ 应用主体 ============ */
function MainTabs({ wide, pageActive, covered, bottomInset, swipe }: {
  wide: boolean;
  pageActive: boolean;
  covered: boolean;
  bottomInset: number;
  swipe?: TabSwipeBridge;
}) {
  const { tab, activeSource } = useStore();
  const sourceScope = activeSource?.id ?? "";
  const availableTabs = useAvailableTabs();
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set());
  useEffect(() => {
    if (pageActive && availableTabs.includes(tab)) setVisited(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab, pageActive, availableTabs]);
  const swipeVisual = swipe?.visual ?? IDLE_TAB_SWIPE;
  const swiping = !covered && swipeVisual.phase !== "idle";
  const swipeRef = useRef(swipe);
  swipeRef.current = swipe;
  const availableTabsRef = useRef(availableTabs);
  availableTabsRef.current = availableTabs;
  const availableTabsKey = availableTabs.join(",");

  const wasCoveredRef = useRef(covered);
  const [restoredTab, setRestoredTab] = useState<Tab | null>(null);
  useLayoutEffect(() => {
    const returnedFromCover = wasCoveredRef.current && !covered;
    wasCoveredRef.current = covered;
    if (returnedFromCover) setRestoredTab(tab);
    else if (covered) setRestoredTab(null);
  }, [covered, tab]);
  useEffect(() => {
    if (restoredTab && restoredTab !== tab) setRestoredTab(null);
  }, [tab, restoredTab]);

  useLayoutEffect(() => {
    const currentSwipe = swipeRef.current;
    if (!currentSwipe) return;
    const { phase, visibleTabs, targetIndex, fromPos, targetTab } = swipeVisual;
    const panes = currentSwipe.panesRef.current;
    const tabs = availableTabsRef.current;
    if (covered || phase === "idle") {
      for (const el of Object.values(panes)) {
        if (!el) continue;
        el.style.transition = "";
        el.style.transform = "";
      }
      return;
    }
    const positionAll = (pos: number, transition: string) => {
      for (const key of visibleTabs) {
        const el = panes[key];
        if (!el) continue;
        const idx = tabs.indexOf(key);
        if (idx < 0) continue;
        el.style.transition = transition;
        el.style.transform = `translate3d(${(idx - pos) * 100}%, 0, 0)`;
      }
    };
    if (phase === "dragging") {
      positionAll(currentSwipe.posRef.current, "none");
      return;
    }
    positionAll(fromPos, "none");
    const targetEl = targetTab ? panes[targetTab] : null;
    const rafId = window.requestAnimationFrame(() => {
      positionAll(targetIndex, TAB_SWIPE_SETTLE_TRANSITION);
    });
    const onEnd = (e: TransitionEvent) => {
      if (e.target === targetEl && e.propertyName === "transform") swipeRef.current?.finishSettle();
    };
    targetEl?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(() => swipeRef.current?.finishSettle(), TAB_SWIPE_SETTLE_MS + 60);
    return () => {
      window.cancelAnimationFrame(rafId);
      targetEl?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [swipeVisual, covered, availableTabsKey]);

  const inSwipeView = (key: Tab) => swiping && swipeVisual.visibleTabs.includes(key);
  const mounted = (key: Tab) => availableTabs.includes(key)
    && (visited.has(key) || (pageActive && tab === key) || inSwipeView(key));
  const paneClass = (key: Tab) => {
    const isVisible = tab === key || inSwipeView(key);
    if (!isVisible) return "absolute inset-0 ios-tab-pane-hidden";
    const bgClass = key === "home" ? "bg-black overflow-hidden" : "bg-bg overflow-hidden";
    const activeClass = key === "home" ? "" : "ios-tab-active";
    const suppressAnim = swipeVisual.suppressAnimTab === key || restoredTab === key || (wasCoveredRef.current && !covered);
    const swipeClass = swiping
      ? "ios-tab-pane-swiping"
      : suppressAnim
        ? "ios-tab-pane-settled"
        : "";
    const pointerClass = swiping || tab !== key ? "pointer-events-none" : "";
    return `absolute inset-0 ${activeClass} ${bgClass} ${swipeClass} ${pointerClass}`.trim();
  };
  const setPaneRef = (key: Tab) => (node: HTMLDivElement | null) => {
    if (swipe) swipe.panesRef.current[key] = node;
  };
  // First visits mount on demand; subsequent switches preserve queries, scroll and playback state.
  // DialogFrame's syncBackground() owns modal inertness so portals inside fullscreenElement never inherit ancestor inert.
  return (
    <LayerBox hidden={covered} inert={covered} ariaHidden={covered} className="absolute inset-0">
      <div ref={setPaneRef("home")} data-tab-pane="home" data-visited={visited.has("home") ? "true" : undefined} className={paneClass("home")} inert={covered || tab !== "home"} aria-hidden={!pageActive || tab !== "home"}>{mounted("home") && <Home key={sourceScope} active={pageActive && tab === "home" && !swiping} bottomInset={bottomInset} />}</div>
      <div ref={setPaneRef("search")} data-tab-pane="search" data-visited={visited.has("search") ? "true" : undefined} className={paneClass("search")} inert={covered || tab !== "search"} aria-hidden={!pageActive || tab !== "search"}>{mounted("search") && <Suspense fallback={<PageLoading />}><Search key={sourceScope} active={pageActive && tab === "search" && !swiping} wide={wide} /></Suspense>}</div>
      <div ref={setPaneRef("category")} data-tab-pane="category" data-visited={visited.has("category") ? "true" : undefined} className={paneClass("category")} inert={covered || tab !== "category"} aria-hidden={!pageActive || tab !== "category"}>{mounted("category") && <Suspense fallback={<PageLoading />}><Category key={sourceScope} wide={wide} active={pageActive && tab === "category" && !swiping} /></Suspense>}</div>
      <div ref={setPaneRef("profile")} data-tab-pane="profile" data-visited={visited.has("profile") ? "true" : undefined} className={paneClass("profile")} inert={covered || tab !== "profile"} aria-hidden={!pageActive || tab !== "profile"}>{mounted("profile") && <Suspense fallback={<PageLoading />}><Profile key={sourceScope} wide={wide} active={pageActive && tab === "profile" && !swiping} /></Suspense>}</div>
    </LayerBox>
  );
}

function AppBody() {
  const { platform, tab, setTab, stack, pop, loginOpen, setLoginOpen, fs, setFs, clean, locked, activeSource } = useStore();
  const availableTabs = useAvailableTabs();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [shortLandscape, setShortLandscape] = useState(false);
  const tabSwipePanesRef = useRef<Partial<Record<Tab, HTMLDivElement | null>>>({});
  const tabSwipePosRef = useRef(0);
  const [tabSwipeVisual, setTabSwipeVisual] = useState<TabSwipeVisual>(IDLE_TAB_SWIPE);
  const tabSwipeVisualRef = useRef(tabSwipeVisual);
  tabSwipeVisualRef.current = tabSwipeVisual;

  const tabSwipe: TabSwipeBridge = {
    visual: tabSwipeVisual,
    panesRef: tabSwipePanesRef,
    posRef: tabSwipePosRef,
    startDrag(startIndex, tabs) {
      tabSwipePosRef.current = startIndex;
      const startTab = tabs[startIndex];
      if (!startTab) return;
      const initialTabs: Tab[] = [];
      if (startIndex > 0 && tabs[startIndex - 1]) initialTabs.push(tabs[startIndex - 1]);
      initialTabs.push(startTab);
      if (startIndex + 1 < tabs.length && tabs[startIndex + 1]) initialTabs.push(tabs[startIndex + 1]);
      const next: TabSwipeVisual = {
        phase: "dragging",
        visibleTabs: initialTabs,
        targetTab: null,
        targetIndex: startIndex,
        fromPos: startIndex,
        suppressAnimTab: null,
      };
      tabSwipeVisualRef.current = next;
      setTabSwipeVisual(next);
    },
    moveDrag(pos, tabs) {
      tabSwipePosRef.current = pos;
      const maxIndex = Math.max(0, tabs.length - 1);
      const low = Math.max(0, Math.min(maxIndex, Math.floor(pos)));
      const high = Math.max(0, Math.min(maxIndex, Math.ceil(pos)));
      const needed: Tab[] = low === high ? [tabs[low]] : [tabs[low], tabs[high]];
      const prev = tabSwipeVisualRef.current;
      const visibleTabs = prev.phase === "dragging" && needed.every(k => prev.visibleTabs.includes(k))
        ? prev.visibleTabs
        : needed;
      if (prev.phase !== "dragging" || !sameTabList(prev.visibleTabs, visibleTabs)) {
        const next: TabSwipeVisual = {
          phase: "dragging",
          visibleTabs,
          targetTab: null,
          targetIndex: low,
          fromPos: pos,
          suppressAnimTab: null,
        };
        tabSwipeVisualRef.current = next;
        setTabSwipeVisual(next);
      }
      for (const key of visibleTabs) {
        const el = tabSwipePanesRef.current[key];
        if (!el) continue;
        const idx = tabs.indexOf(key);
        if (idx < 0) continue;
        el.style.transform = `translate3d(${(idx - pos) * 100}%, 0, 0)`;
      }
    },
    endDrag(fromPos, targetIndex, tabs) {
      const targetTab = tabs[targetIndex] ?? null;
      const reducedMotion = typeof window !== "undefined"
        && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!targetTab || reducedMotion || Math.abs(fromPos - targetIndex) < 0.002) {
        const next: TabSwipeVisual = { ...IDLE_TAB_SWIPE, suppressAnimTab: targetTab };
        tabSwipeVisualRef.current = next;
        setTabSwipeVisual(next);
        return;
      }
      const maxIndex = Math.max(0, tabs.length - 1);
      const low = Math.max(0, Math.min(maxIndex, Math.floor(fromPos)));
      const high = Math.max(0, Math.min(maxIndex, Math.ceil(fromPos)));
      const visibleSet = new Set<Tab>([tabs[low], tabs[high], targetTab]);
      const next: TabSwipeVisual = {
        phase: "settling",
        visibleTabs: [...visibleSet],
        targetTab,
        targetIndex,
        fromPos,
        suppressAnimTab: targetTab,
      };
      tabSwipePosRef.current = fromPos;
      tabSwipeVisualRef.current = next;
      setTabSwipeVisual(next);
    },
    finishSettle() {
      if (tabSwipeVisualRef.current.phase !== "settling") return;
      // Do not clear pane transforms before React hides outgoing panes; useLayoutEffect cleans up post-commit.
      const next: TabSwipeVisual = {
        ...IDLE_TAB_SWIPE,
        suppressAnimTab: tabSwipeVisualRef.current.targetTab,
      };
      tabSwipeVisualRef.current = next;
      setTabSwipeVisual(next);
    },
    clearSuppress() {
      if (tabSwipeVisualRef.current.suppressAnimTab !== null) {
        const next: TabSwipeVisual = { ...tabSwipeVisualRef.current, suppressAnimTab: null };
        tabSwipeVisualRef.current = next;
        setTabSwipeVisual(next);
      }
    },
  };

  useEffect(() => {
    if ((stack.length > 0 || fs || clean || locked) && tabSwipeVisualRef.current.phase !== "idle") {
      tabSwipeVisualRef.current = IDLE_TAB_SWIPE;
      setTabSwipeVisual(IDLE_TAB_SWIPE);
    }
  }, [stack.length, fs, clean, locked]);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const sync = () => {
      setWide(el.clientWidth > 640);
      setShortLandscape(el.clientWidth > el.clientHeight && el.clientHeight <= 500);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    sync();
    return () => ro.disconnect();
  }, []);

  /* 全局键盘 */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") { if (runBack()) return; if (fs) { setFs(false); return; } if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; } if (stack.length) pop(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/" && availableTabs.includes("search")) { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        const next = availableTabs[Number(e.key) - 1];
        if (next) setTab(next);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs, setFs, availableTabs]);

  const pageActive = stack.length === 0 && !loginOpen;
  const bottomInset = fs || clean || locked ? 0 : (shortLandscape ? 56 : 78);
  /* 栈页（从搜索/分类/我的进入的播放页、图文页）没有底栏，
     底部只让出安全区。之前多留了 20px，视频底边会露出一条
     「底栏」似的窄缝（底部的压暗渐变到不了屏幕最底）。 */
  const stackInset = 0;
  const showDemoBanner = isDemoOfflineSource(activeSource) && !fs && !clean && !locked;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      <div ref={mainRef} className="relative flex-1 min-w-0 overflow-hidden win-main flex flex-col">
        {showDemoBanner && <DemoSourceBanner />}
        <div className="relative flex-1 min-h-0 overflow-hidden" style={showDemoBanner ? ({ "--sat": "0px" } as CSSProperties) : undefined}>
          <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={bottomInset} swipe={tabSwipe} />

          {stack.map((p, i) => {
            const top = i === stack.length - 1;
            return (
              <LayerBox key={p.key} hidden={!top} inert={!top} ariaHidden={!top || loginOpen}
                className="absolute inset-0 bg-bg isolate"
                enterClass={platform === "android" && p.kind === "feed" ? undefined : "a-page-in"}
                style={{ zIndex: 30 + i }}
                swipeBack={p.kind === "feed" ? undefined : { enabled: top && !loginOpen && !fs, onBack: pop }}>
                <StackPage page={p} onBack={pop} wide={wide} top={top} bottomInset={stackInset} loginOpen={loginOpen} />
              </LayerBox>
            );
          })}

          {!fs && !clean && !locked && stack.length === 0 && <TabBar swipe={tabSwipe} />}
        </div>
      </div>
    </div>
  );
}

/* ============ 桌面窗口壳（Windows / macOS / Linux）============ */
function DesktopShell() {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  useEffect(() => {
    const query = matchMedia("(max-width: 1099px)");
    const update = () => setCollapsed(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const { theater, platform } = useStore();
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas win-root plat-${platform}`}>
      <DesktopTitleBar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative flex-1 min-h-0">
        <ShellInner collapsed={collapsed || theater} theater={theater} />
      </div>
      {/* 边缘缩放热区只对无边框窗口（Windows / Linux）有效，macOS 走原生窗口边框 */}
      {(platform === "windows" || platform === "linux") && <ResizeHandles />}
    </div>
  );
}

function ShellInner({ collapsed, theater }: { collapsed: boolean; theater: boolean }) {
  const { stack, pop, loginOpen, setLoginOpen, tab, setTab, platform, fs, setFs, setTheater, clean, locked, activeSource } = useStore();
  const availableTabs = useAvailableTabs();
  const mainRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth > 640));
    ro.observe(el);
    setWide(el.clientWidth > 640);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (loginOpen) { if (e.key === "Escape") setLoginOpen(false); return; }
      if (e.key === "Escape") {
        if (runBack()) return;
        if (fs) { setFs(false); return; }
        if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; }
        if (stack.length) { pop(); return; }
        if (theater) { setTheater(false); return; }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key === "/" && availableTabs.includes("search")) { e.preventDefault(); setTab("search"); return; }
      if (["1", "2", "3", "4"].includes(e.key) && !e.repeat) {
        const next = availableTabs[Number(e.key) - 1];
        if (next) setTab(next);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [stack.length, pop, setTab, loginOpen, setLoginOpen, fs, setFs, theater, setTheater, availableTabs]);

  const pageActive = stack.length === 0 && !loginOpen;
  const showDemoBanner = isDemoOfflineSource(activeSource) && !fs && !clean && !locked;

  return (
    <div className={`absolute inset-0 flex bg-canvas plat-${platform}`}>
      {!theater && <DesktopRail collapsed={collapsed} />}
      <div ref={mainRef} className={`relative flex-1 min-w-0 overflow-hidden win-main flex flex-col ${theater ? "is-theater-main" : ""}`}>
        {showDemoBanner && <DemoSourceBanner />}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <MainTabs wide={wide} pageActive={pageActive} covered={stack.length > 0} bottomInset={14} />
          {stack.map((p, i) => {
            const top = i === stack.length - 1;
            return (
              <LayerBox key={p.key} hidden={!top} inert={!top} ariaHidden={!top || loginOpen}
                className="absolute inset-0 bg-bg isolate" enterClass="win-page-in"
                style={{ zIndex: 30 + i }}>
                <StackPage page={p} onBack={pop} wide={wide} top={top} bottomInset={14} loginOpen={loginOpen} />
              </LayerBox>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const supportsCssMax = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("top", "max(1px, 2px)");

/* ============ 移动端（无壳） ============ */
function MobileShell() {
  const { platform } = useStore();
  const minBottom = platform === "android" ? "24px" : "16px";
  const safeStyle = supportsCssMax
    ? {
        "--sat": "max(var(--native-sat, 0px), env(safe-area-inset-top, 0px), 12px)",
        "--sab": `max(var(--native-sab, 0px), env(safe-area-inset-bottom, 0px), ${minBottom})`,
        "--sal": "max(var(--native-sal, 0px), env(safe-area-inset-left, 0px))",
        "--sar": "max(var(--native-sar, 0px), env(safe-area-inset-right, 0px))",
      }
    : {
        "--sat": "var(--native-sat, 12px)",
        "--sab": `var(--native-sab, ${minBottom})`,
        "--sal": "var(--native-sal, 0px)",
        "--sar": "var(--native-sar, 0px)",
      };
  return (
    <div className={`absolute inset-0 flex flex-col bg-canvas plat-${platform}`}
      style={safeStyle as React.CSSProperties}>
      <div className="relative flex-1 min-h-0">
        <AppBody />
      </div>
    </div>
  );
}

/* ============ 入口 ============ */
export default function App() {
  useLocale();
  const { platform, loginOpen, setLoginOpen, tab, setTab, stack, pop, fs, setFs, capabilities, sourceStateStatus, activeSource } = useStore();
  const availableTabs = useAvailableTabs();
  const defaultTab = availableTabs[0] ?? "profile";
  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab(defaultTab);
  }, [availableTabs, tab, defaultTab, setTab]);
  useEffect(() => {
    tracePlayback("navigation.change", { tab, stack: stack.map(p => ({ page: p.kind, key: p.key })), login_open: loginOpen });
  }, [tab, stack, loginOpen]);

  /* iOS keeps player gestures free of selection handles while inputs and reading text
     retain native selection/copy. Pointer targeting also handles non-focusable articles. */
  useEffect(() => {
    if (platform !== "ios") return;
    let last: boolean | null = null;
    const setTI = (enabled: boolean) => {
      if (last === enabled) return;
      last = enabled;
      invoke("set_text_interaction", { enabled }).catch(() => { last = null; });
    };
    const onDown = (e: Event) => setTI(isSelectableText(e.target));
    const onFocusOut = (e: FocusEvent) => {
      // A touch on an article can blur an input with relatedTarget=null after pointerdown.
      // Keep that pointer decision; the next control interaction explicitly disables selection.
      if (e.relatedTarget) setTI(isSelectableText(e.relatedTarget));
    };
    document.addEventListener("touchstart", onDown, { capture: true, passive: true });
    document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    document.addEventListener("focusin", onDown, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onDown, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, [platform]);

  /* —— 安卓 / 鸿蒙硬件与系统边缘返回 ——
     层级：面板/弹层 → 全屏 → 登录框 → 页面栈 → 回首页 → 退出/退后台。
     不注册这个监听，Android 会直接 webView.goBack() 或退出，HarmonyOS 则被原生默认拦截吞掉。 */
  const hasBackConsumer = useHasBackConsumer();
  const canConsumeBack = hasBackConsumer || fs || loginOpen || stack.length > 0 || tab !== defaultTab;
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    if (runBack()) return;                                  // 最上层弹窗/播放器面板
    if (fs) { setFs(false); return; }                        // 沉浸全屏
    if (getFullscreenElement()) { void exitDocumentFullscreen().catch(() => {}); return; }
    if (loginOpen) { setLoginOpen(false); return; }
    if (stack.length) { pop(); return; }
    if (tab !== defaultTab) { setTab(defaultTab); return; }
    if (platform === "android") exitApp().catch(() => {});
  };

  useEffect(() => subscribeNativeBack(platform, () => backRef.current()), [platform]);
  useEffect(() => { syncOhosBackIntercept(platform, canConsumeBack); }, [platform, canConsumeBack]);

  useEffect(() => {
    const prevent = (e: Event) => { if (!isSelectableText(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", prevent);
    return () => document.removeEventListener("contextmenu", prevent);
  }, []);

  useEffect(() => initMobileHaptics(), []);

  useEffect(() => {
    if (!import.meta.env.DEV || sourceStateStatus !== "ready" || !activeSource?.capabilities.home) return;
    const t = window.setTimeout(() => {
      selfTest().then((r) => { invoke("debug_log", { msg: r }).catch(() => {}); }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(t);
  }, [sourceStateStatus, activeSource]);

  return (
    <>
      {isMobile ? <MobileShell /> : <DesktopShell />}
      {capabilities.account && <LoginModal />}
      <ToastHost />
    </>
  );
}
