import { Loader } from "../../shared/ui/ios/effects";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { ISearch } from "../../shared/ui/icons";
import { Empty } from "../../shared/ui/ui";
import { Button } from "../../shared/ui/ios/controls";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { PreferenceStorageNotice } from "../../shared/ui/PreferenceStorageNotice";
import { tr } from "../../shared/i18n";
import {
  buildRandomPageDeck,
  getRecentHomeIds,
  HOME_RANDOM_PAGE_POOL,
  PINNED_RANDOM_PAGE_POOL,
  rankUnseenFirst,
  readKnownPages,
  rememberRecentHomeIds,
  shuffle,
  writeKnownPages,
} from "./homeRandom";

const loadFeed = () => import("./Feed");
const Feed = lazy(loadFeed);

const PINNED_FETCH_CONCURRENCY = 4;
const HOME_REFRESH_TOAST_TAG = "home-refresh";

type PinnedDeckState = {
  decks: Map<string, number[]>;
  visited: Map<string, Set<number>>;
  exhausted: Set<string>;
  lastFirstPage: Map<string, number>;
};

function tagPageScopeKey(sourceId: string, tag: string): string {
  return `tag:${sourceId || "default"}:${tag}`;
}

async function fetchPinnedTagsBatch(
  sourceId: string,
  recentKey: string,
  tags: string[],
  state: PinnedDeckState,
  reset: boolean,
): Promise<{ items: VideoCard[]; done: boolean }> {
  const candidates = shuffle(tags.filter((tag) => !state.exhausted.has(tag)));
  if (!candidates.length) return { items: [], done: true };
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let firstError: unknown = null;
  const collected: VideoCard[] = [];

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) return;
      const tag = candidates[idx];
      const scopeKey = tagPageScopeKey(sourceId, tag);
      let deck = state.decks.get(tag);
      let visited = state.visited.get(tag);
      if (!visited) {
        visited = new Set<number>();
        state.visited.set(tag, visited);
      }
      if (!deck) {
        const known = readKnownPages(scopeKey);
        deck = known > 1
          ? buildRandomPageDeck(known, {
              maxPoolPages: PINNED_RANDOM_PAGE_POOL,
              excludeFirst: reset ? state.lastFirstPage.get(tag) : undefined,
            })
          : [1];
        state.decks.set(tag, deck);
      }
      const nextPage = deck.shift();
      if (!nextPage) {
        state.exhausted.add(tag);
        continue;
      }
      if (reset) state.lastFirstPage.set(tag, nextPage);
      visited.add(nextPage);
      try {
        let res = await api.tagVideos(tag, nextPage, 30);
        let list = res?.items || [];
        if (!list.length && nextPage > 1 && !visited.has(1)) {
          visited.add(1);
          res = await api.tagVideos(tag, 1, 30);
          list = res?.items || [];
        }
        succeeded++;
        collected.push(...list);
        const totalPages = res?.pagination?.pages ?? 0;
        if (totalPages >= 1) {
          writeKnownPages(scopeKey, totalPages);
          const refreshedDeck = buildRandomPageDeck(totalPages, {
            maxPoolPages: PINNED_RANDOM_PAGE_POOL,
            exclude: visited,
          });
          state.decks.set(tag, refreshedDeck);
          if (!list.length || refreshedDeck.length === 0) {
            state.exhausted.add(tag);
          }
        } else if (!list.length || deck.length === 0) {
          state.exhausted.add(tag);
        }
      } catch (err) {
        visited.delete(nextPage);
        deck.unshift(nextPage);
        failed++;
        if (firstError === null) firstError = err;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(PINNED_FETCH_CONCURRENCY, candidates.length) }, () => worker()),
  );

  if (succeeded === 0 && firstError !== null) throw firstError;
  const deduped = new Map<number, VideoCard>();
  for (const item of collected) deduped.set(item.id, item);
  const recentIds = getRecentHomeIds(recentKey);
  const ranked = rankUnseenFirst([...deduped.values()], recentIds);
  return {
    items: ranked,
    done: failed === 0 && tags.every((tag) => state.exhausted.has(tag)),
  };
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch, push, activeSource, accountScope } = useStore();
  const sourceId = activeSource?.id ?? "";
  const { preferences, revision, blockReason, storageError } = useContentPreferences();
  const pinnedTags = preferences.pinnedTags;
  const pinnedKey = useMemo(() => [...pinnedTags].sort().join("\0"), [pinnedTags]);
  const feedScope = `${accountScope}:${lineEpoch}:${pinnedKey}`;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [excluded, setExcluded] = useState<{ revision: number; epoch: number; ids: number[] }>({ revision, epoch: lineEpoch, ids: [] });
  const autoFill = useRef(1);
  useEffect(() => { autoFill.current = 1; }, [revision, lineEpoch, pinnedKey]);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const attemptedScope = useRef<string | null>(null);
  const feedDeckRef = useRef<number[]>([]);
  const feedVisitedRef = useRef(new Set<number>());
  const lastFeedFirstPageRef = useRef(0);
  const pinnedDeckRef = useRef<PinnedDeckState>({
    decks: new Map(),
    visited: new Map(),
    exhausted: new Set(),
    lastFirstPage: new Map(),
  });
  const [feedMounted, setFeedMounted] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const accountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;
  const sourceIdRef = useRef(sourceId);
  sourceIdRef.current = sourceId;
  const pinnedTagsRef = useRef(pinnedTags);
  pinnedTagsRef.current = pinnedTags;
  const pinnedKeyRef = useRef(pinnedKey);
  const feedScopeRef = useRef(feedScope);
  feedScopeRef.current = feedScope;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const resetDecks = useCallback(() => {
    feedDeckRef.current = [];
    feedVisitedRef.current.clear();
    pinnedDeckRef.current.decks.clear();
    pinnedDeckRef.current.visited.clear();
    pinnedDeckRef.current.exhausted.clear();
  }, []);

  useEffect(() => {
    if (pinnedKeyRef.current === pinnedKey) return;
    pinnedKeyRef.current = pinnedKey;
    resetDecks();
    attemptedScope.current = null;
    failStreak.current = 0;
    retryAt.current = 0;
    setItems([]);
    setDone(false);
    setError("");
  }, [pinnedKey, resetDecks]);

  const load = useCallback(async (reset: boolean, options?: { manual?: boolean }): Promise<void> => {
    if (!activeRef.current || loadingRef.current || (done && !reset)) return;
    const requestEpoch = lineEpochRef.current;
    const requestAccountScope = accountScopeRef.current;
    const requestSourceId = sourceIdRef.current;
    const requestPinnedKey = pinnedKeyRef.current;
    const requestPinned = [...pinnedTagsRef.current];
    const requestScope = `${requestAccountScope}:${requestEpoch}:${requestPinnedKey}`;
    const recentKey = `${requestAccountScope}:${requestSourceId || "default"}`;
    const prevFeedDeck = [...feedDeckRef.current];
    const prevFeedVisited = new Set(feedVisitedRef.current);
    const prevPinnedDecks = new Map([...pinnedDeckRef.current.decks.entries()].map(([k, v]) => [k, [...v]]));
    const prevPinnedVisited = new Map([...pinnedDeckRef.current.visited.entries()].map(([k, v]) => [k, new Set(v)]));
    const prevPinnedExhausted = new Set(pinnedDeckRef.current.exhausted);
    if (reset) {
      attemptedScope.current = requestScope;
      resetDecks();
    }
    let retryAfterScopeChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    if (reset) setDone(false);
    try {
      let ordered: VideoCard[];
      let nextDone: boolean;
      if (requestPinned.length > 0) {
        const res = await fetchPinnedTagsBatch(requestSourceId, recentKey, requestPinned, pinnedDeckRef.current, reset);
        ordered = res.items;
        nextDone = res.done;
      } else {
        const feedPageKey = `feed:${requestSourceId || "default"}`;
        if (reset) {
          const known = readKnownPages(feedPageKey);
          feedDeckRef.current = known > 1
            ? buildRandomPageDeck(known, {
                maxPoolPages: HOME_RANDOM_PAGE_POOL,
                excludeFirst: lastFeedFirstPageRef.current || undefined,
              })
            : [1];
        }
        const targetPage = feedDeckRef.current.shift();
        if (!targetPage) {
          ordered = [];
          nextDone = true;
        } else {
          if (reset) lastFeedFirstPageRef.current = targetPage;
          feedVisitedRef.current.add(targetPage);
          let res = await api.feed(targetPage, 30);
          let list = res?.items || [];
          if (!list.length && targetPage > 1 && !feedVisitedRef.current.has(1)) {
            feedVisitedRef.current.add(1);
            res = await api.feed(1, 30);
            list = res?.items || [];
          }
          const totalPages = res?.pagination?.pages ?? 0;
          if (totalPages >= 1) {
            writeKnownPages(`feed:${sourceIdRef.current || requestSourceId || "default"}`, totalPages);
            feedDeckRef.current = buildRandomPageDeck(totalPages, {
              maxPoolPages: HOME_RANDOM_PAGE_POOL,
              exclude: feedVisitedRef.current,
            });
            nextDone = !list.length || feedDeckRef.current.length === 0;
          } else {
            nextDone = !list.length || feedDeckRef.current.length === 0;
          }
          const recentIds = getRecentHomeIds(recentKey);
          ordered = rankUnseenFirst(list, recentIds);
        }
      }
      if (!mounted.current) return;
      if (requestScope !== feedScopeRef.current) {
        retryAfterScopeChange = requestPinnedKey !== pinnedKeyRef.current || !itemsRef.current.length;
        return;
      }
      rememberRecentHomeIds(recentKey, ordered.map((x) => x.id));
      setItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...ordered.filter((x) => !seen.has(x.id))];
      });
      if (reset && options?.manual && ordered.length > 0) {
        setRefreshCycle((cycle) => cycle + 1);
        toast(tr("已换一批推荐"), "info", HOME_REFRESH_TOAST_TAG);
      }
      failStreak.current = 0;
      retryAt.current = 0;
      setDone(nextDone);
    } catch (e) {
      if (!mounted.current) return;
      if (reset && itemsRef.current.length > 0) {
        feedDeckRef.current = prevFeedDeck;
        feedVisitedRef.current = prevFeedVisited;
        pinnedDeckRef.current.decks = prevPinnedDecks;
        pinnedDeckRef.current.visited = prevPinnedVisited;
        pinnedDeckRef.current.exhausted = prevPinnedExhausted;
      }
      const message = (e as Error).message || tr("加载失败");
      const stale = requestScope !== feedScopeRef.current;
      if (!stale) {
        if (!options?.manual || !itemsRef.current.length) setError(message);
        if (!reset) retryAt.current = Date.now() + 5000;
        if (options?.manual || failStreak.current++ === 0) {
          toast(message, "info", options?.manual ? HOME_REFRESH_TOAST_TAG : undefined);
        }
      }
      /* 请求在旧线路或旧置顶集合上发出：等 finally 里按新作用域补拉一次 */
      if (stale && (requestPinnedKey !== pinnedKeyRef.current || !itemsRef.current.length)) {
        retryAfterScopeChange = true;
      }
    } finally {
      loadingRef.current = false;
      if (!mounted.current) return;
      setLoading(false);
      if (retryAfterScopeChange && activeRef.current) {
        setDone(false);
        setError("");
        void load(true);
      }
    }
  }, [done, resetDecks, toast]);

  useEffect(() => {
    const onRefresh = () => {
      if (!activeRef.current) return;
      autoFill.current = 1;
      void load(true, { manual: true });
    };
    window.addEventListener("hg:home-refresh", onRefresh);
    return () => window.removeEventListener("hg:home-refresh", onRefresh);
  }, [load]);

  /* A never-visited/hidden home does no new work. New-line/pin retries resume on return.
     Loaded pages and an already mounted player remain intact across navigation. */
  useEffect(() => {
    if (!active || items.length || loadingRef.current || attemptedScope.current === feedScope) return;
    void loadFeed();
    void load(true);
  }, [active, feedScope, items.length, load]);
  useEffect(() => { if (active && items.length) setFeedMounted(true); }, [active, items.length]);

  const ids = useMemo(() => {
    const blocked = new Set(excluded.revision === revision && excluded.epoch === lineEpoch ? excluded.ids : []);
    return items.filter(item => !blocked.has(item.id) && !blockReason(item.tags)).map(item => item.id);
  }, [items, excluded, revision, lineEpoch, blockReason]);
  const onBlocked = useCallback((id: number) => setExcluded(previous => {
    const ids = previous.revision === revision && previous.epoch === lineEpoch ? previous.ids : [];
    return ids.includes(id) ? previous : { revision, epoch: lineEpoch, ids: [...ids, id] };
  }), [revision, lineEpoch]);
  const hiddenCount = items.length - ids.length;
  // A fully filtered page may be followed by usable content. Stop after three pages
  // per automatic fill cycle; user-initiated continuation is explicit and bounded.
  useEffect(() => {
    if (!active || !filtering || ids.length || !hiddenCount || loading || loadingRef.current || done || error || autoFill.current >= 3) return;
    autoFill.current++;
    void load(false);
  }, [active, filtering, ids.length, hiddenCount, loading, done, error, load, revision]);
  const loadNextFilteredPage = () => { autoFill.current = 1; void load(false); };


  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      {storageError && <div className="shrink-0 bg-bg px-3 pb-2" style={{ paddingTop: "var(--sat, 8px)" }}>
        <PreferenceStorageNotice />
      </div>}
      <div className="relative flex-1 min-h-0">
      {ids.length > 0 && (active || feedMounted) ? (
        <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>}>
          <Feed key={refreshCycle} videoIds={ids} mode="home" active={active} bottomInset={bottomInset} onBlocked={onBlocked}
            onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) void load(false); }} />
        </Suspense>
      ) : hiddenCount > 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg px-5 pb-24">
          <Empty icon={<ISearch size={26} />} title={tr("已隐藏不感兴趣的内容")}
            sub={loading ? tr("正在补充其他内容…") : error ? tr("继续加载失败：{0}", error) : done ? tr("当前推荐已筛选完，可调整屏蔽标签。") : tr("已达到本次自动补充上限，可继续加载。")} />
          {loading ? <Loader label={tr("正在补充内容")} /> : !done && <Button className="mt-3 px-5 rounded-full bg-s3" onClick={loadNextFilteredPage}>{error ? tr("重试加载") : tr("继续加载")}</Button>}
          <Button className="mt-3 px-4 text-primary" onClick={() => push({ kind: "settings", section: "内容偏好" })}>{tr("管理屏蔽标签")}</Button>
        </div>
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title={tr("首页加载失败")} sub={error} action={tr("重试")} onAction={() => void load(true)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title={tr("暂无视频")} sub={tr("稍后刷新试试")} action={tr("刷新")} onAction={() => void load(true)} /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
      </div>
    </div>
  );
}
