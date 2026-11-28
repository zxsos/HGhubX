import { Button, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, APP_VERSION, fmt, isMobile, platform } from "../../shared/api/api";
import type { Detail, Post } from "../../shared/api/types";
import {
  detailEpisodeCount, favoriteWatchState, filterFavoriteVideoIds, formatWatchProgress, resolveResumeTarget,
  unwatchedEpisodeCount, unwatchedNewEpisodes, type FavoriteSeriesFilter, type FavoriteWatchFilter,
} from "../../shared/model/favoriteProgress";
import { useStore } from "../../shared/model/store";
import { Avatar, Empty, Modal } from "../../shared/ui/ui";
import { MediaCard } from "../../shared/ui/cards";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { ICheck, IChevR, IClock, IHeart, ILogout, IRefresh, IScan, ISettings, IStar, IUser, IFilter } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { triggerHaptic } from "../../shared/lib/haptics";
import { useTabSwipe } from "../../shared/ui/hooks/useTabSwipe";
import { registerOverlayBack } from "../../shared/lib/back";
import TvQrSyncModal from "../settings/TvQrSyncModal";

/* Account changes discard cached details synchronously, before another account can paint. */
export default function Profile({ wide, active = true }: { wide: boolean; active?: boolean }) {
  const { accountScope, lineEpoch } = useStore();
  return <ProfileContent key={`${accountScope}:${lineEpoch}`} wide={wide} active={active} />;
}

function ProfileContent({ wide, active }: { wide: boolean; active: boolean }) {
  const { blockReason } = useContentPreferences();
  const {
    user, setLoginOpen, logout, history, favs, postFavs, favEpCounts,
    seedFavoriteEpisodes, ackFavoriteEpisodes, setCollected, toast,
    clearHistory, removeHistory, push, accountSync, syncAccount, accountGeneration,
    capabilities, setTab: setAppTab,
  } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [scanOpen, setScanOpen] = useState(false);
  const [favKind, setFavKind] = useState<"video" | "post">("video");
  const [favFilter, setFavFilter] = useState<FavoriteWatchFilter>("all");
  const [favSeriesFilter, setFavSeriesFilter] = useState<FavoriteSeriesFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [videoCache, setVideoCache] = useState<Record<number, Detail>>({});
  const videoCacheRef = useRef(videoCache);
  videoCacheRef.current = videoCache;
  const refreshedFavorites = useRef(new Set<number>());
  const [postCache, setPostCache] = useState<Record<number, Post>>({});
  const postCacheRef = useRef(postCache);
  postCacheRef.current = postCache;
  const [limits, setLimits] = useState({ favVideo: 12, favPost: 12, history: 12 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const favRefreshRegionRef = useRef<HTMLDivElement>(null);
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [failedIds, setFailedIds] = useState<number[]>([]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pullStage, setPullStage] = useState<"idle" | "pulling" | "ready">("idle");
  const pullDistanceRef = useRef(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullRefreshingRef = useRef(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutPending = useRef(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const removalPending = useRef(false);
  const tabIndex = tab === "fav" ? 0 : 1;
  const tabSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: scrollRef,
    tabIndex,
    tabCount: 2,
    onTabChange: index => {
      const next = index === 0 ? "fav" : "history";
      if (next === tab) return;
      setTab(next);
      setSelectedIds([]);
    },
  });
  const [blockedPrompt, setBlockedPrompt] = useState<{
    id: number; kind: "video" | "post"; reason: string; removableFav: boolean;
  } | null>(null);
  const [removingBlocked, setRemovingBlocked] = useState(false);
  const mounted = useRef(true);
  const actionRevision = useRef(0);
  useLayoutEffect(() => {
    mounted.current = true;
    const invalidate = () => { actionRevision.current++; };
    window.addEventListener("hg:line-changed", invalidate);
    window.addEventListener("hg:proxy-changed", invalidate);
    return () => {
      mounted.current = false;
      invalidate();
      window.removeEventListener("hg:line-changed", invalidate);
      window.removeEventListener("hg:proxy-changed", invalidate);
    };
  }, []);

  const favsRef = useRef(favs);
  favsRef.current = favs;
  const postFavsRef = useRef(postFavs);
  postFavsRef.current = postFavs;
  const userRef = useRef(user);
  userRef.current = user;
  const showingPostsRef = useRef(false);
  showingPostsRef.current = capabilities.posts && tab === "fav" && favKind === "post";

  const refreshFavoritesForUpdates = async () => {
    if (pullRefreshingRef.current) return;
    const generation = accountGeneration();
    const revision = actionRevision.current;
    const current = () => mounted.current && accountGeneration() === generation && actionRevision.current === revision;
    pullRefreshingRef.current = true;
    setPullRefreshing(true);
    setFailedIds([]);
    try {
      const beforeCounts = new Map<number, number>();
      for (const id of favsRef.current) {
        const prevDetail = videoCacheRef.current[id];
        if (prevDetail) beforeCounts.set(id, detailEpisodeCount(prevDetail));
      }
      if (userRef.current) {
        await syncAccount({ manual: true }).catch(() => {});
        if (!current()) return;
      }
      refreshedFavorites.current.clear();
      if (showingPostsRef.current) {
        const targets = [...postFavsRef.current];
        const loaded: Record<number, Post> = {};
        const failedList: number[] = [];
        for (let offset = 0; offset < targets.length; offset += 6) {
          const batch = targets.slice(offset, offset + 6);
          const results = await Promise.allSettled(batch.map((id) => api.post(id)));
          if (!current()) return;
          results.forEach((result, index) => {
            const id = batch[index];
            if (result.status === "fulfilled" && result.value) loaded[id] = result.value;
            else failedList.push(id);
          });
        }
        setPostCache((previous) => ({ ...previous, ...loaded }));
        setFailedIds(failedList);
        toast(tr("收藏已刷新"), "ok");
      } else {
        const targets = [...favsRef.current];
        let updatedShows = 0;
        let addedEpisodes = 0;
        const failedList: number[] = [];
        for (let offset = 0; offset < targets.length; offset += 6) {
          const batch = targets.slice(offset, offset + 6);
          const results = await Promise.allSettled(batch.map((id) => api.video(id)));
          if (!current()) return;
          const loaded: Record<number, Detail> = {};
          results.forEach((result, index) => {
            const id = batch[index];
            if (result.status === "fulfilled" && result.value) {
              loaded[id] = result.value;
              refreshedFavorites.current.add(id);
              const before = beforeCounts.get(id) ?? 0;
              const after = detailEpisodeCount(result.value);
              if (before > 0 && after > before) {
                updatedShows += 1;
                addedEpisodes += after - before;
              }
            } else if (!videoCacheRef.current[id]) {
              failedList.push(id);
            }
          });
          setVideoCache((previous) => ({ ...previous, ...loaded }));
        }
        setFailedIds(failedList);
        if (updatedShows > 0) {
          triggerHaptic("tap");
          toast(tr("发现 {0} 部收藏更新，新增 {1} 集", updatedShows, addedEpisodes), "ok");
        } else if (targets.length > 0) {
          toast(tr("收藏已刷新，暂无新集更新"), "info");
        } else {
          toast(tr("收藏已刷新"), "ok");
        }
      }
    } finally {
      pullRefreshingRef.current = false;
      if (mounted.current) setPullRefreshing(false);
    }
  };
  const refreshFavoritesRef = useRef(refreshFavoritesForUpdates);
  refreshFavoritesRef.current = refreshFavoritesForUpdates;

  useEffect(() => {
    if (!filterMenuOpen) return;
    const frame = requestAnimationFrame(() => {
      const menu = filterMenuRef.current;
      (menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
        ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [filterMenuOpen]);

  useEffect(() => {
    if (!filterMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterMenuOpen(false);
    };
    const isCovered = () => !filterMenuRef.current || Boolean(filterMenuRef.current.closest("[inert]"));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || isCovered()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setFilterMenuOpen(false);
      filterButtonRef.current?.focus();
    };
    const removeBack = registerOverlayBack(() => {
      if (isCovered()) return false;
      setFilterMenuOpen(false);
      filterButtonRef.current?.focus();
      return true;
    });
    document.addEventListener("pointerdown", closeOnOutsidePress, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      removeBack();
      document.removeEventListener("pointerdown", closeOnOutsidePress, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [filterMenuOpen]);

  useEffect(() => {
    setFilterMenuOpen(false);
  }, [tab, favKind, active]);

  useEffect(() => {
    if (!capabilities.posts && favKind === "post") setFavKind("video");
  }, [capabilities.posts, favKind]);

  const showingPosts = capabilities.posts && tab === "fav" && favKind === "post";
  const refreshFavorites = tab === "fav" && !showingPosts;
  const selectionMode = selectedIds.length > 0;

  useEffect(() => {
    const scroller = scrollRef.current;
    const region = favRefreshRegionRef.current;
    if (!scroller || !region || !active || tab !== "fav" || selectionMode) {
      pullDistanceRef.current = 0;
      setPullStage("idle");
      return;
    }
    let tracking = false;
    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let currentPull = 0;
    let armedHaptic = false;
    let suppressClick = false;
    let suppressTimer = 0;
    let stage: "idle" | "pulling" | "ready" = "idle";
    let pointerWindowBound = false;

    const inRefreshRegion = (target: EventTarget | null) =>
      target instanceof Element
      && region.contains(target)
      && !target.closest("input, textarea, select, [role=menu]");

    const syncIndicatorHeight = (height: number) => {
      pullDistanceRef.current = height;
      const indicator = pullIndicatorRef.current;
      if (indicator) indicator.style.height = `${Math.round(height)}px`;
    };

    const setStage = (next: "idle" | "pulling" | "ready") => {
      if (stage === next) return;
      stage = next;
      setPullStage(next);
    };

    const unbindWindowPointer = () => {
      if (!pointerWindowBound) return;
      pointerWindowBound = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };

    const resetGesture = () => {
      tracking = false;
      activePointerId = null;
      currentPull = 0;
      armedHaptic = false;
      unbindWindowPointer();
      syncIndicatorHeight(0);
      setStage("idle");
    };

    const updatePull = (dx: number, dy: number, threshold: number, event: Event) => {
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        if (currentPull === 0) {
          tracking = false;
          activePointerId = null;
          unbindWindowPointer();
        }
        return;
      }
      if (scroller.scrollTop > 1) {
        resetGesture();
        return;
      }
      if (dy > threshold) {
        if (event.cancelable) event.preventDefault();
        currentPull = Math.min(84, (dy - threshold) * 0.48);
        syncIndicatorHeight(currentPull);
        setStage(currentPull >= 54 ? "ready" : "pulling");
        if (currentPull >= 54 && !armedHaptic) {
          armedHaptic = true;
          triggerHaptic("tap");
        } else if (currentPull < 54) {
          armedHaptic = false;
        }
      }
    };

    const finishGesture = (cancelled: boolean) => {
      if (!tracking) return;
      const engaged = currentPull > 0;
      const shouldRefresh = !cancelled && currentPull >= 54 && !pullRefreshingRef.current;
      resetGesture();
      if (engaged) {
        suppressClick = true;
        window.clearTimeout(suppressTimer);
        suppressTimer = window.setTimeout(() => { suppressClick = false; }, 160);
      }
      if (shouldRefresh) {
        void refreshFavoritesRef.current();
      }
    };

    const clearClickSuppression = () => {
      window.clearTimeout(suppressTimer);
      suppressTimer = 0;
      suppressClick = false;
    };

    const onTouchStart = (event: TouchEvent) => {
      clearClickSuppression();
      if (pullRefreshingRef.current || event.touches.length !== 1 || scroller.scrollTop > 1 || !inRefreshRegion(event.target)) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      tracking = true;
      activePointerId = null;
      startX = touch.clientX;
      startY = touch.clientY;
      currentPull = 0;
      armedHaptic = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || activePointerId !== null || event.touches.length !== 1) return;
      const touch = event.touches[0];
      updatePull(touch.clientX - startX, touch.clientY - startY, 8, event);
    };

    const onTouchEnd = () => {
      if (activePointerId !== null) return;
      finishGesture(false);
    };

    const onTouchCancel = () => {
      if (activePointerId !== null) return;
      finishGesture(true);
    };

    const onPointerDown = (event: PointerEvent) => {
      clearClickSuppression();
      if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
      if (pullRefreshingRef.current || scroller.scrollTop > 1 || !inRefreshRegion(event.target)) return;
      tracking = true;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      currentPull = 0;
      armedHaptic = false;
      if (!pointerWindowBound) {
        pointerWindowBound = true;
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!tracking || activePointerId !== event.pointerId) return;
      updatePull(event.clientX - startX, event.clientY - startY, 12, event);
    };

    const onPointerUp = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return;
      finishGesture(false);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activePointerId !== event.pointerId) return;
      finishGesture(true);
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    region.addEventListener("touchstart", onTouchStart, { passive: true });
    region.addEventListener("touchmove", onTouchMove, { passive: false });
    region.addEventListener("touchend", onTouchEnd, { passive: true });
    region.addEventListener("touchcancel", onTouchCancel, { passive: true });
    region.addEventListener("pointerdown", onPointerDown);
    region.addEventListener("click", onClickCapture, true);
    return () => {
      window.clearTimeout(suppressTimer);
      unbindWindowPointer();
      region.removeEventListener("touchstart", onTouchStart);
      region.removeEventListener("touchmove", onTouchMove);
      region.removeEventListener("touchend", onTouchEnd);
      region.removeEventListener("touchcancel", onTouchCancel);
      region.removeEventListener("pointerdown", onPointerDown);
      region.removeEventListener("click", onClickCapture, true);
    };
  }, [active, selectionMode, tab]);
  const limitKey = tab === "history" ? "history" : showingPosts ? "favPost" : "favVideo";
  const favoriteUnwatchedCount = (id: number, detail: Detail) =>
    unwatchedEpisodeCount(detail, history.find(h => h.id === id));
  const favoriteWatchStateOf = (id: number, detail: Detail) =>
    favoriteWatchState(detail, history.find(h => h.id === id));
  const filteredFavIds = useMemo(
    () => (refreshFavorites
      ? filterFavoriteVideoIds(favs, videoCache, favFilter, favSeriesFilter, favoriteWatchStateOf)
      : favs),
    [refreshFavorites, favs, videoCache, favFilter, favSeriesFilter, history, favEpCounts],
  );
  const favoriteFilterData = useMemo(() => {
    const watchCounts = { all: 0, watching: 0, watched: 0 };
    const seriesCounts = { all: 0, ongoing: 0, finished: 0 };
    for (const id of favs) {
      const detail = videoCache[id];
      if (!detail) continue;
      const watch = favoriteWatchStateOf(id, detail);
      const series: "ongoing" | "finished" = detail.is_finished ? "finished" : "ongoing";
      if (favSeriesFilter === "all" || series === favSeriesFilter) {
        watchCounts.all++;
        if (watch) watchCounts[watch]++;
      }
      if (favFilter === "all" || watch === favFilter) {
        seriesCounts.all++;
        seriesCounts[series]++;
      }
    }
    return { watchCounts, seriesCounts };
  }, [favs, videoCache, history, favEpCounts, favFilter, favSeriesFilter]);
  const activeFavoriteFilterLabel = favFilter === "watching" ? tr("未看完")
    : favFilter === "watched" ? tr("已看完") : "";
  const activeFavoriteFilterCount = favFilter === "watching" ? favoriteFilterData.watchCounts.watching
    : favFilter === "watched" ? favoriteFilterData.watchCounts.watched : 0;
  const activeSeriesFilterLabel = favSeriesFilter === "ongoing" ? tr("连载中")
    : favSeriesFilter === "finished" ? tr("已完结") : "";
  const activeSeriesFilterCount = favSeriesFilter === "ongoing" ? favoriteFilterData.seriesCounts.ongoing
    : favSeriesFilter === "finished" ? favoriteFilterData.seriesCounts.finished : 0;
  const activeFilterCount = (favFilter !== "all" ? 1 : 0) + (favSeriesFilter !== "all" ? 1 : 0);
  const activeFilterSummary = [
    favFilter !== "all" ? `${activeFavoriteFilterLabel} ${activeFavoriteFilterCount}` : "",
    favSeriesFilter !== "all" ? `${activeSeriesFilterLabel} ${activeSeriesFilterCount}` : "",
  ].filter(Boolean).join(" · ");
  const ids = tab === "history" ? history.map((h) => h.id) : showingPosts ? postFavs : filteredFavIds;
  const visibleIds = ids.slice(0, limits[limitKey]);
  const hasMore = visibleIds.length < ids.length;
  const videoCards = !showingPosts ? visibleIds.map(id => videoCache[id]).filter((card): card is Detail => !!card) : [];
  const postCards = showingPosts ? visibleIds.map(id => postCache[id]).filter((card): card is Post => !!card) : [];
  const cardsCount = showingPosts ? postCards.length : videoCards.length;
  const failed = failedIds.filter(id => visibleIds.includes(id));
  // Filter pills show live category counts, so every favorite detail is needed
  // even before the user selects a filter.
  const filterNeedsAllDetails = refreshFavorites;
  const hydrateIds = filterNeedsAllDetails ? favs : visibleIds;
  const hydrateKey = hydrateIds.join(",");
  const filteringHydrating = filterNeedsAllDetails && loading
    && favs.some(id => !videoCache[id] && !failedIds.includes(id));
  const filterFailedIds = filterNeedsAllDetails ? failedIds.filter(id => favs.includes(id)) : [];
  const filterEmpty = filterNeedsAllDetails && (favFilter !== "all" || favSeriesFilter !== "all")
    && favs.length > 0 && !loading && !filterFailedIds.length && filteredFavIds.length === 0;
  const favoriteStateUnknown = tab === "fav" && !!user && !accountSync.favoritesKnown && favs.length === 0 && postFavs.length === 0;
  const favoriteSyncFailed = favoriteStateUnknown && !accountSync.busy;
  const syncingFavorites = favoriteStateUnknown && !favoriteSyncFailed;
  /** 观看记录里这条的进度（我的收藏与观看历史共享） */
  const progressOf = (id: number) => history.find((h) => h.id === id);

  useEffect(() => {
    if (!favs.length) return;
    const toSeed: Record<number, number> = {};
    for (const id of favs) {
      if (favEpCounts[id] !== undefined) continue;
      const detail = videoCache[id];
      if (!detail) continue;
      const latest = detailEpisodeCount(detail);
      if (latest <= 0) continue;
      const unwatched = unwatchedNewEpisodes(detail, history.find(h => h.id === id), undefined);
      toSeed[id] = Math.max(1, latest - unwatched);
    }
    if (Object.keys(toSeed).length > 0) seedFavoriteEpisodes(toSeed);
  }, [favs, videoCache, history, favEpCounts, seedFavoriteEpisodes]);

  useEffect(() => {
    if (!active) { refreshedFavorites.current.clear(); return; }
    let alive = true;
    const targetIds = filterNeedsAllDetails ? favs : visibleIds;
    const missing = showingPosts
      ? targetIds.filter(id => !postCacheRef.current[id])
      : targetIds.filter(id => !videoCacheRef.current[id] || (refreshFavorites && !refreshedFavorites.current.has(id)));
    setFailedIds([]);
    if (!missing.length) { setLoading(false); return; }
    setLoading(true);
    if (showingPosts) {
      Promise.allSettled(missing.map(id => api.post(id)))
        .then(results => {
          if (!alive) return;
          const loaded: Record<number, Post> = {};
          const failedList: number[] = [];
          results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value) loaded[missing[index]] = result.value;
            else failedList.push(missing[index]);
          });
          setPostCache(previous => ({ ...previous, ...loaded }));
          setFailedIds(failedList);
          setLoading(false);
        });
    } else {
      void (async () => {
        const failedList: number[] = [];
        // Keep existing cards visible while revalidating. Limit concurrent reads
        // when returning to a list that had already loaded several pages.
        for (let offset = 0; offset < missing.length; offset += 6) {
          const batch = missing.slice(offset, offset + 6);
          const results = await Promise.allSettled(batch.map(id => api.video(id)));
          if (!alive) return;
          const loaded: Record<number, Detail> = {};
          results.forEach((result, index) => {
            const id = batch[index];
            if (result.status === "fulfilled" && result.value) {
              loaded[id] = result.value;
              if (refreshFavorites) refreshedFavorites.current.add(id);
            } else if (!videoCacheRef.current[id]) failedList.push(id);
          });
          setVideoCache(previous => ({ ...previous, ...loaded }));
        }
        setFailedIds(failedList);
        setLoading(false);
      })();
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hydrateKey, tab, showingPosts, refreshFavorites, filterNeedsAllDetails, reload]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (!active || !hasMore || loading || !cardsCount || !sentinel || !scroller) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      setLimits(previous => ({ ...previous, [limitKey]: previous[limitKey] + 12 }));
    }, { root: scroller, rootMargin: "300px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active, cardsCount, hasMore, limitKey, loading, visibleIds.length]);

  const confirmLogout = async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      await logout();
      if (mounted.current) setLogoutOpen(false);
    } catch (error) {
      if (mounted.current) setLogoutError(error instanceof Error ? error.message : tr("退出失败，请重试"));
    } finally {
      logoutPending.current = false;
      if (mounted.current) setLogoutBusy(false);
    }
  };

  const toggleSelection = (id: number) => {
    setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };
  const beginSelection = (id: number) => {
    setSelectedIds(current => current.includes(id) ? current : [...current, id]);
  };
  /* Re-tapping the active Profile tab restores the default favorites landing. */
  useEffect(() => {
    const reset = () => {
      setTab("fav");
      setFavKind("video");
      setFavFilter("all");
      setFavSeriesFilter("all");
      setFilterMenuOpen(false);
      setSelectedIds([]);
      setRemoveOpen(false);
      setRemoveError("");
      setFailedIds([]);
      scrollRef.current?.scrollTo({ top: 0 });
    };
    window.addEventListener("hg:profile-reset", reset);
    return () => window.removeEventListener("hg:profile-reset", reset);
  }, []);
  const allSelected = ids.length > 0 && ids.every((id) => selectedIds.includes(id));
  const selectAll = () => setSelectedIds([...ids]);
  const confirmRemoveSelected = async () => {
    if (removalPending.current || !selectedIds.length) return;
    const generation = accountGeneration();
    const revision = actionRevision.current;
    const current = () => mounted.current && accountGeneration() === generation && actionRevision.current === revision;
    removalPending.current = true;
    setRemoving(true); setRemoveError("");
    const targets = [...selectedIds];
    try {
      if (!current()) return;
      if (tab === "history") {
        if (history.length > 0 && history.every((h) => targets.includes(h.id))) await clearHistory();
        else await removeHistory(targets);
        if (!current()) return;
      } else {
        const failed: number[] = [];
        for (const id of targets) {
          if (!current()) return;
          try {
            await setCollected(showingPosts ? "post" : "video", id, false);
            if (!current()) return;
          } catch {
            if (!current()) return;
            failed.push(id);
          }
        }
        if (failed.length) {
          if (!current()) return;
          setSelectedIds(failed);
          throw new Error(failed.length === targets.length ? tr("移除失败，请重试") : tr("已移除 {0} 项，{1} 项失败，请重试", targets.length - failed.length, failed.length));
        }
      }
      if (current()) {
        setSelectedIds([]);
        setRemoveOpen(false);
        toast(tab === "history" ? tr("已删除 {0} 条观看历史", targets.length) : tr("已取消收藏 {0} 项", targets.length), "info");
      }
    } catch (error) {
      if (current()) setRemoveError(error instanceof Error ? error.message : tr("移除失败，请重试"));
    } finally {
      removalPending.current = false;
      if (current()) setRemoving(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className={`ios-page-heading shrink-0 flex items-center ${scrolled ? "is-scrolled" : ""}`}>
        <h1 className="ios-page-title text-on">{tr("我的")}</h1>
        {isMobile && (
          <div className="ml-auto flex items-center gap-2">
            <Button onClick={() => setScanOpen(true)} aria-label={tr("扫一扫")}
              className="ios-icon-button">
              <IScan size={17} strokeWidth={1.7} />
            </Button>
            <Button onClick={() => push({ kind: "settings" })} aria-label={tr("设置")}
              className="ios-icon-button">
              <ISettings size={17} strokeWidth={1.7} />
            </Button>
          </div>
        )}
      </div>

      <div ref={scrollRef} {...tabSwipe} style={{ touchAction: "pan-y" }}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}
        className="ios-page-body flex-1 scroll-y pt-2 pb-24">
        <div className="min-h-full flex flex-col">
        {/* 资料卡：已登录 / 未登录（点开登录抽屉） */}
        {user ? (
          <Surface className="ios-account-card shrink-0 flex flex-col gap-3 a-rise">
            <div className="flex items-center gap-3.5 min-w-0">
              <Avatar size={56} name={user.nickname} hue={280} ring />
              <div className="flex-1 min-w-0">
                <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
                <div className="text-[12px] text-mut mt-0.5 flex flex-wrap items-center gap-x-1.5">
                  <span className="truncate max-w-full">@{user.username}</span>
                  <span className="whitespace-nowrap">· ID {user.id}</span>
                </div>
              </div>
              <Button onClick={() => { setLogoutError(""); setLogoutOpen(true); }}
                className="ios-icon-button" aria-label={tr("退出登录")}>
                <ILogout size={17} />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-mut tabular-nums">
              <span className="whitespace-nowrap">{tr("点赞")}{" "}<b className="text-on font-semibold">{fmt(user.counts?.like)}</b></span>
              <span className="whitespace-nowrap">{tr("收藏")}{" "}<b className="text-on font-semibold">{fmt(user.counts?.collect)}</b></span>
              <span className="whitespace-nowrap">{tr("关注")}{" "}<b className="text-on font-semibold">{fmt(user.counts?.following)}</b></span>
            </div>
          </Surface>
        ) : capabilities.account ? (
          <Button onClick={() => setLoginOpen(true)}
            className="ios-account-card shrink-0 w-full text-left flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">{tr("未登录")}</div>
              <div className="text-[12px] text-mut mt-0.5">{tr("登录后查看账号收藏、关注和观看记录")}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[12px] text-mut">
                <span className="whitespace-nowrap">{tr("收藏")}{" "}<b className="text-on">{favs.length + postFavs.length}</b></span>
                <span className="whitespace-nowrap">{tr("观看")}{" "}<b className="text-on">{history.length}</b></span>
              </div>
            </div>
            <span className="inline-flex items-center gap-0.5 h-9 pl-3.5 pr-2.5 rounded-full bg-primary text-on-primary text-[13px] font-semibold shrink-0">{tr("登录")}<IChevR size={14} />
            </span>
          </Button>
        ) : (
          <Surface className="ios-account-card shrink-0 w-full text-left flex items-center gap-3.5 a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">{tr("本机片库")}</div>
              <div className="text-[12px] text-mut mt-0.5">{tr("当前视频源仅支持本地收藏与观看记录")}</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[12px] text-mut">
                <span className="whitespace-nowrap">{tr("收藏")}{" "}<b className="text-on">{favs.length + postFavs.length}</b></span>
                <span className="whitespace-nowrap">{tr("观看")}{" "}<b className="text-on">{history.length}</b></span>
              </div>
            </div>
          </Surface>
        )}

        {user && capabilities.account && accountSync.error && <div role="alert" className="mt-3 shrink-0 rounded-(--r-sm) bg-s3 px-3.5 py-3 text-[13px] flex flex-wrap items-center justify-between gap-2">
          <p className={`${accountSync.authError ? "text-on" : "text-danger"} break-words flex-1 min-w-[200px]`}>{accountSync.error}</p>
          <div className="flex items-center gap-2 shrink-0">
            {accountSync.authError && (
              <Button onClick={() => setLoginOpen(true)}
                className="inline-flex items-center min-h-9 px-3 rounded-full bg-primary text-on-primary text-[12px] font-semibold shrink-0">{tr("重新登录")}</Button>
            )}
            <Button disabled={accountSync.busy} onClick={() => { void syncAccount({ manual: true }).catch(() => {}); }}
              className="inline-flex items-center min-h-9 -mx-2 px-2 text-primary font-semibold shrink-0">{accountSync.busy ? tr("正在重试…") : tr("重试同步")}</Button>
          </div>
        </div>}

        {/* 关注 / 我的主页 */}
        {user && capabilities.account && (
          <CollectionLinks className="ios-profile-links mt-4 shrink-0">
            <CollectionLink icon={<IHeart size={18} />} title={tr("我的关注")}
              onClick={() => push({ kind: "following" })} />
            <CollectionLink icon={<IUser size={18} />} title={tr("我的主页")}
              onClick={() => push({ kind: "user", id: user.id, name: user.nickname })} />
          </CollectionLinks>
        )}

        {/* 我的内容 */}
        <SegmentedControl className="mt-4 shrink-0" aria-label={tr("我的内容")} activeIndex={tabIndex}>
          {([["fav", tr("我的收藏")], ["history", tr("观看历史")]] as const).map(([k, l]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => { setTab(k); setSelectedIds([]); }}>{l}</Button>
          ))}
        </SegmentedControl>

        {tab === "fav" && !favoriteStateUnknown && (favs.length > 0 || (capabilities.posts && (postFavs.length > 0 || favKind === "post"))) && (
          <div className="mt-2.5 shrink-0 flex items-center gap-2" role="group" aria-label={tr("收藏内容类型")}>
            <div className="flex items-center gap-2">
              <Button aria-pressed={favKind === "video"} onClick={() => { setFavKind("video"); setSelectedIds([]); }} className="ios-filter-pill gap-1.5">
                <span>{tr("视频")}</span>
                <span data-favorite-short-total className="text-[12px] opacity-80 tabular-nums">{favoriteFilterData.seriesCounts.all}</span>
              </Button>
              {capabilities.posts && (
                <Button aria-pressed={favKind === "post"} onClick={() => { setFavKind("post"); setFavFilter("all"); setFavSeriesFilter("all"); setSelectedIds([]); }} className="ios-filter-pill gap-1.5">
                  <span>{tr("帖子")}</span>
                  {postFavs.length > 0 && <span className="text-[12px] opacity-80 tabular-nums">{postFavs.length}</span>}
                </Button>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {favKind === "video" && favs.length > 0 && (
                <div ref={filterMenuRef} className="relative" role="group" aria-label={tr("收藏筛选")}>
                <Button ref={filterButtonRef} data-favorite-filter-trigger
                  aria-label={activeFilterCount ? `${tr("收藏筛选")}: ${activeFilterSummary}` : tr("收藏筛选")}
                  aria-haspopup="menu" aria-expanded={filterMenuOpen} aria-pressed={activeFilterCount > 0}
                  className={`ios-filter-pill ${activeFilterCount === 0 ? "is-icon" : "is-labeled"}`}
                  onClick={() => setFilterMenuOpen(current => !current)}>
                  {activeFilterCount > 0 && (
                    <span data-favorite-filter-summary className="ios-filter-active-label">{tr("筛选")} {activeFilterCount}</span>
                  )}
                  <IFilter size={19} strokeWidth={1.8} />
                </Button>
                {filterMenuOpen && (
                  <div className="ios-filter-menu" role="menu" aria-label={tr("收藏筛选")} onKeyDownCapture={event => {
                    const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
                    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
                    if (event.key === "Escape") {
                      event.preventDefault(); event.stopPropagation(); setFilterMenuOpen(false);
                      filterButtonRef.current?.focus();
                    } else if (event.key === "Tab") {
                      setFilterMenuOpen(false);
                    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      event.preventDefault(); event.stopPropagation();
                      const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
                        : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
                      entries[next]?.focus();
                    }
                  }}>
                    <div className="ios-filter-menu-section">
                      <span className="ios-filter-menu-title">{tr("观看状态")}</span>
                      <button type="button" data-favorite-watch-filter-option="all" role="menuitemradio" aria-checked={favFilter === "all"}
                        className="ios-filter-menu-any"
                        onClick={() => { setFavFilter("all"); setFailedIds([]); setSelectedIds([]); }}>
                        {tr("不限")} {favoriteFilterData.watchCounts.all}
                      </button>
                    </div>
                    {([
                      ["watching", tr("未看完"), favoriteFilterData.watchCounts.watching],
                      ["watched", tr("已看完"), favoriteFilterData.watchCounts.watched],
                    ] as const).map(([key, label, count]) => (
                      <Button key={`watch-${key}`} data-favorite-watch-filter-option={key} role="menuitemradio" aria-checked={favFilter === key}
                        onClick={() => { setFavFilter(key); setFailedIds([]); setSelectedIds([]); }}>
                        <span>{label}</span>
                        <span className="ios-filter-menu-side">
                          {favFilter === key && <ICheck size={13} strokeWidth={2.2} aria-hidden="true" />}
                          <span className="ios-filter-menu-count">{count}</span>
                        </span>
                      </Button>
                    ))}
                    <div className="ios-filter-menu-section" style={{ borderTop: "1px solid var(--ios-edge)", marginTop: 4, paddingTop: 9 }}>
                      <span className="ios-filter-menu-title">{tr("连载状态")}</span>
                      <button type="button" data-favorite-series-filter-option="all" role="menuitemradio" aria-checked={favSeriesFilter === "all"}
                        className="ios-filter-menu-any"
                        onClick={() => { setFavSeriesFilter("all"); setSelectedIds([]); }}>
                        {tr("不限")} {favoriteFilterData.seriesCounts.all}
                      </button>
                    </div>
                    {([
                      ["ongoing", tr("连载中"), favoriteFilterData.seriesCounts.ongoing],
                      ["finished", tr("已完结"), favoriteFilterData.seriesCounts.finished],
                    ] as const).map(([key, label, count]) => (
                      <Button key={`series-${key}`} data-favorite-series-filter-option={key} role="menuitemradio" aria-checked={favSeriesFilter === key}
                        onClick={() => { setFavSeriesFilter(key); setSelectedIds([]); }}>
                        <span>{label}</span>
                        <span className="ios-filter-menu-side">
                          {favSeriesFilter === key && <ICheck size={13} strokeWidth={2.2} aria-hidden="true" />}
                          <span className="ios-filter-menu-count">{count}</span>
                        </span>
                      </Button>
                    ))}
                    <Button onClick={() => { setFilterMenuOpen(false); filterButtonRef.current?.focus(); }}
                      className="ios-filter-menu-done">
                      {tr("完成")}
                    </Button>
                  </div>
                )}
              </div>
              )}
            </div>
          </div>
        )}
        {filteringHydrating && (
          <span role="status" className="mt-1 shrink-0 block text-[12px] text-mut">{tr("正在加载全部收藏详情…")}</span>
        )}

        {selectionMode && <div role="region" aria-label={tr("批量管理")} className="sticky top-0 z-20 -mx-1 mt-2 shrink-0 flex items-center gap-2 bg-bg/95 px-1 py-2 text-[13px] backdrop-blur">
          <span className="font-semibold text-on">{tr("已选 {0} 项", selectedIds.length)}</span>
          <Button disabled={allSelected} className="ml-auto px-2 text-primary disabled:opacity-40" onClick={selectAll}>{tr("全选")}</Button>
          <Button className="px-2 text-primary" onClick={() => { setSelectedIds([]); setRemoveError(""); }}>{tr("取消")}</Button>
          <Button variant="danger" className="rounded-(--r-ctl) px-3" onClick={() => { setRemoveError(""); setRemoveOpen(true); }}>{tr("移除")}</Button>
        </div>}

        <div ref={favRefreshRegionRef} data-favorite-refresh-region className="mt-3 flex-1" aria-busy={loading || syncingFavorites}>
          {tab === "fav" && (pullRefreshing || pullStage !== "idle") && (
            <div ref={pullIndicatorRef} role="status" data-favorite-pull-indicator className="mb-2 flex items-center justify-center gap-2 text-[12px] text-mut overflow-hidden"
              style={{ height: pullRefreshing ? 38 : Math.round(pullDistanceRef.current) }}>
              {pullRefreshing
                ? <Loader className="w-4 h-4 spinner" />
                : <IRefresh size={14} className={pullStage === "ready" ? "text-primary rotate-180 transition-transform" : "transition-transform"} />}
              <span>{pullRefreshing ? tr("正在检查收藏更新…") : pullStage === "ready" ? tr("松开检查更新") : tr("下拉检查收藏更新")}</span>
            </div>
          )}
          {favoriteSyncFailed ? (
            <Empty icon={<IStar size={24} />} title={tr("收藏状态未知")}
              sub={accountSync.authError ? tr("登录已过期，重新登录后继续同步") : tr("账号同步未完成，暂时无法确认收藏内容。")}
              action={accountSync.authError ? tr("重新登录") : tr("重试")}
              onAction={() => { if (accountSync.authError) setLoginOpen(true); else void syncAccount({ manual: true }).catch(() => {}); }} />
          ) : syncingFavorites ? (
            <FavoriteSyncState wide={wide} />
          ) : loading && !cardsCount ? (
            <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
          ) : showingPosts && postCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {postCards.map((p) => {
                const reason = blockReason(p.tags);
                return <MediaCard key={p.id} blockedReason={reason} title={p.title} cover={p.cover}
                  subtitle={p.tags?.slice(0, 2).join(" · ") || tr("{0} 次浏览", fmt(p.hot))}
                  selectionMode={selectionMode} selected={selectedIds.includes(p.id)} onLongPress={() => beginSelection(p.id)}
                  onOpen={() => {
                    if (selectionMode) { toggleSelection(p.id); return; }
                    if (reason) setBlockedPrompt({ id: p.id, kind: "post", reason, removableFav: true });
                    else push({ kind: "post", id: p.id });
                  }} />;
              })}
            </div>
          ) : !showingPosts && videoCards.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {videoCards.map((c) => {
                const progress = progressOf(c.id);
                const reason = blockReason(c.tags);
                const latestCount = detailEpisodeCount(c);
                const unwatchedNew = tab === "fav" ? unwatchedNewEpisodes(c, progress, favEpCounts[c.id]) : 0;
                const unwatchedLeft = tab === "fav" ? favoriteUnwatchedCount(c.id, c) : 0;
                const tagLine = c.tags?.slice(0, 2).join(" · ");
                const episodeTotal = latestCount || c.episode_count;
                const cardBadge = tab === "fav" && favFilter === "watching"
                  ? tr("未看 {0} 集", unwatchedLeft)
                  : c.is_finished ? tr("全 {0} 集", episodeTotal) : tr("更新至 {0} 集", episodeTotal);
                return <MediaCard key={c.id} blockedReason={reason} title={c.title} cover={c.cover} score={c.score}
                  badge={cardBadge} badgeTone={tab === "fav" && favFilter === "watching" ? "update" : "default"}
                  subtitle={tagLine}
                  progress={formatWatchProgress(progress, latestCount, c.is_finished)}
                  selectionMode={selectionMode} selected={selectedIds.includes(c.id)} onLongPress={() => beginSelection(c.id)}
                  onOpen={() => {
                    if (selectionMode) { toggleSelection(c.id); return; }
                    if (reason) {
                      setBlockedPrompt({ id: c.id, kind: "video", reason, removableFav: tab === "fav" });
                      return;
                    }
                    if (tab === "fav" && unwatchedNew > 0 && latestCount > 0 && (progress?.ep ?? 0) < (favEpCounts[c.id] ?? latestCount)) {
                      ackFavoriteEpisodes(c.id, latestCount);
                    }
                    const playableIds = ids.filter(id => {
                      const cached = videoCache[id];
                      return !cached || !blockReason(cached.tags);
                    });
                    const targetIndex = Math.max(0, playableIds.indexOf(c.id));
                    const resume = resolveResumeTarget(c, progress);
                    push({
                      kind: "feed", videoIds: playableIds, index: targetIndex,
                      title: tab === "fav" ? tr("我的收藏") : tr("观看历史"), startEp: resume.startEp, startTime: resume.startTime,
                    });
                  }} />;
              })}
            </div>
          ) : filterFailedIds.length ? (
            <Empty icon={<IStar size={24} />} title={tr("收藏加载失败")}
              sub={tr("部分收藏未能加载，筛选结果可能不完整。")} action={tr("重试")} onAction={() => setReload(n => n + 1)} />
          ) : filterEmpty ? (
            <Empty icon={<IStar size={24} />}
              title={favFilter === "watching" ? tr("没有未看完的收藏")
                : favFilter === "watched" ? tr("没有已看完的收藏")
                  : favSeriesFilter === "finished" ? tr("没有已完结的收藏") : tr("没有连载中的收藏")}
              sub={tr("当前筛选条件下没有收藏。")}
              action={tr("查看全部收藏")} onAction={() => { setFavFilter("all"); setFavSeriesFilter("all"); }} />
          ) : failed.length ? (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? tr("收藏加载失败") : tr("观看记录加载失败")}
              sub={tr("记录仍在，重试后继续浏览。")} action={tr("重试")} onAction={() => setReload(n => n + 1)} />
          ) : showingPosts ? (
            <Empty icon={<IStar size={24} />} title={tr("还没有收藏帖子")}
              sub={tr("在帖子页面点收藏，之后就能在这里找到")}
              action={tr("去看帖子")} onAction={() => push({ kind: "posts" })} />
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? tr("还没有收藏") : tr("还没有观看记录")}
              sub={tab === "fav" ? tr("在视频页面点收藏，之后就能在这里找到") : tr("看过的视频会出现在这里")}
              action={capabilities.catalog.rankings || capabilities.home || capabilities.search ? tr("去逛逛") : undefined}
              onAction={capabilities.catalog.rankings ? () => push({ kind: "ranks" })
                : capabilities.home ? () => setAppTab("home")
                : capabilities.search ? () => setAppTab("search")
                : undefined} />
          )}
          {cardsCount > 0 && (filterFailedIds.length > 0 || failed.length > 0) && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mut">
            <span>{filterFailedIds.length > 0
              ? favFilter === "all"
                ? tr("{0} 项收藏详情未能加载，分类计数可能不完整。", filterFailedIds.length)
                : tr("{0} 项收藏未能加载，筛选结果可能不完整。", filterFailedIds.length)
              : tr("{0} 项内容加载失败，已加载内容仍可浏览。", failed.length)}</span>
            <Button disabled={loading} onClick={() => setReload(n => n + 1)} className="px-3 text-primary">{tr("重试失败内容")}</Button>
          </div>}
          {cardsCount > 0 && loading && <div className="flex justify-center py-3"><Loader label={tr("加载更多内容")} /></div>}
          {ids.length > 0 && <p role="status" className="mt-3 text-[12px] text-mut">{tr("已显示 {0} / {1} 项{2}", cardsCount, ids.length, user ? tr("账号记录") : tr("本机记录"))}</p>}
          {hasMore && <div ref={sentinelRef} className="h-4" aria-hidden="true" />}
        </div>

        {isMobile && <div className="shrink-0 text-center text-[12px] text-dim mt-5">{tr("HGhubX {0} · {1} 客户端", APP_VERSION, platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "harmony" ? "HarmonyOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows")}</div>}
        </div>
      </div>
      <Modal open={removeOpen} onClose={() => { if (!removalPending.current) setRemoveOpen(false); }} label={tr("批量移除")}>
        <div className="p-5">
          <h2 className="text-[18px] font-bold">{tab === "history" ? tr("删除所选观看历史") : tr("取消收藏所选内容")}</h2>
          <p className="mt-2 text-[14px] text-mut">
            {tab === "history"
              ? tr("确认删除选中的 {0} 条观看历史？收藏不会受影响。", selectedIds.length)
              : tr("确认取消收藏选中的 {0} 项内容？观看历史不会受影响。", selectedIds.length)}
            {user ? tr("当前账号的云端数据与本机缓存都会更新。") : tr("此操作只会修改本机记录。")}
          </p>
          {removeError && <p role="alert" className="mt-3 text-[13px] text-danger">{removeError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={removing} onClick={() => setRemoveOpen(false)} className="flex-1">{tr("取消")}</Button>
            <Button variant="danger" disabled={removing || !selectedIds.length} aria-busy={removing} onClick={() => void confirmRemoveSelected()} className="flex-1 rounded-(--r-ctl) px-3">
              {removing ? tr("正在移除…") : tr("确认移除")}
            </Button>
          </div>
        </div>
      </Modal>
      <Modal open={!!blockedPrompt} onClose={() => { if (!removingBlocked) setBlockedPrompt(null); }} label={tr("内容已屏蔽")}>
        {blockedPrompt && (
          <div className="p-5">
            <h2 className="text-[18px] font-bold">{tr("该内容命中屏蔽规则")}</h2>
            <p className="mt-2 text-[14px] text-mut break-words">{tr("{0}。你可以在内容偏好中调整屏蔽标签{1}。", blockedPrompt.reason, blockedPrompt.removableFav ? tr("，或将此内容移出收藏") : "")}</p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Button variant="secondary" disabled={removingBlocked} onClick={() => setBlockedPrompt(null)} className="flex-1">{tr("关闭")}</Button>
              {blockedPrompt.removableFav && (
                <Button variant="danger" disabled={removingBlocked} onClick={() => {
                  setRemovingBlocked(true);
                  void setCollected(blockedPrompt.kind, blockedPrompt.id, false)
                    .then(() => { if (mounted.current) { setBlockedPrompt(null); toast(tr("已取消收藏"), "info"); } })
                    .catch(e => { if (mounted.current) toast(e instanceof Error ? e.message : tr("操作失败"), "info"); })
                    .finally(() => { if (mounted.current) setRemovingBlocked(false); });
                }} className="flex-1 rounded-(--r-ctl) px-3">
                  {removingBlocked ? tr("处理中…") : tr("取消收藏")}
                </Button>
              )}
              <Button variant="primary" disabled={removingBlocked} onClick={() => {
                setBlockedPrompt(null);
                push({ kind: "settings", section: "内容偏好" });
              }} className="w-full rounded-(--r-ctl) min-h-11 px-4 font-semibold">{tr("管理屏蔽标签")}</Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={logoutOpen} onClose={() => { if (!logoutPending.current) setLogoutOpen(false); }} label={tr("退出登录")}>
        <div className="p-5">
          <h2 className="text-[18px] font-bold">{tr("退出登录")}</h2>
          <p className="mt-2 text-[14px] text-mut">{tr("退出当前账户？账号数据和本机进度会保留，退出后显示游客的本机记录。")}</p>
          {logoutError && <p role="alert" className="mt-3 text-[13px] text-danger">{logoutError}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" disabled={logoutBusy} onClick={() => setLogoutOpen(false)} className="flex-1">{tr("取消")}</Button>
            <Button variant="danger" disabled={logoutBusy} onClick={() => void confirmLogout()} className="flex-1 rounded-(--r-ctl) px-3">
              {logoutBusy ? tr("正在退出…") : tr("确认退出")}
            </Button>
          </div>
        </div>
      </Modal>
      {isMobile && <TvQrSyncModal open={scanOpen} initialView="scan" onClose={() => setScanOpen(false)} />}
    </div>
  );
}

function FavoriteSyncState({ wide }: { wide: boolean }) {
  return <>
    <div role="status" aria-live="polite" aria-label={tr("正在同步收藏")}
      className="mb-4 flex items-center justify-center gap-2.5 text-[13px] text-mut">
      <span aria-hidden="true" className="ios-loader spinner w-5 h-5" />
      <span>{tr("正在同步收藏…")}</span>
    </div>
    <div aria-hidden="true" className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
      {[0, 1, 2, 3].map(index => (
        <div key={index} className="min-w-0">
          <div className="aspect-[3/4] w-full rounded-[22px] bg-s3 animate-pulse" />
          <div className="mt-2.5 h-3.5 w-4/5 rounded-full bg-s3 animate-pulse" />
          <div className="mt-2 h-3 w-1/2 rounded-full bg-s2 animate-pulse" />
        </div>
      ))}
    </div>
  </>;
}
