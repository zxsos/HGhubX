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

const loadFeed = () => import("./Feed");
const Feed = lazy(loadFeed);

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const PINNED_FETCH_CONCURRENCY = 4;

async function fetchPinnedTagsPage(
  tags: string[],
  page: number,
  exhausted: Set<string>,
): Promise<{ items: VideoCard[]; done: boolean }> {
  const candidates = tags.filter((tag) => !exhausted.has(tag));
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
      try {
        const res = await api.tagVideos(tag, page, 30);
        succeeded++;
        const list = res?.items || [];
        collected.push(...list);
        if (!list.length || (res?.pagination && page >= res.pagination.pages)) {
          exhausted.add(tag);
        }
      } catch (err) {
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
  return {
    items: shuffle([...deduped.values()]),
    done: failed === 0 && tags.every((tag) => exhausted.has(tag)),
  };
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch, push } = useStore();
  const { preferences, revision, blockReason, storageError } = useContentPreferences();
  const pinnedTags = preferences.pinnedTags;
  const pinnedKey = useMemo(() => [...pinnedTags].sort().join("\0"), [pinnedTags]);
  const feedScope = `${lineEpoch}:${pinnedKey}`;
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const [excluded, setExcluded] = useState<{ revision: number; epoch: number; ids: number[] }>({ revision, epoch: lineEpoch, ids: [] });
  const autoFill = useRef(1);
  useEffect(() => { autoFill.current = 1; }, [revision, lineEpoch, pinnedKey]);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const attemptedScope = useRef<string | null>(null);
  const exhaustedTagsRef = useRef(new Set<string>());
  const [feedMounted, setFeedMounted] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const pinnedTagsRef = useRef(pinnedTags);
  pinnedTagsRef.current = pinnedTags;
  const pinnedKeyRef = useRef(pinnedKey);
  const feedScopeRef = useRef(feedScope);
  feedScopeRef.current = feedScope;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (pinnedKeyRef.current === pinnedKey) return;
    pinnedKeyRef.current = pinnedKey;
    exhaustedTagsRef.current.clear();
    attemptedScope.current = null;
    failStreak.current = 0;
    retryAt.current = 0;
    setItems([]);
    setPage(1);
    setDone(false);
    setError("");
  }, [pinnedKey]);

  const load = useCallback(async (p: number): Promise<void> => {
    if (!activeRef.current || loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    const requestPinnedKey = pinnedKeyRef.current;
    const requestPinned = [...pinnedTagsRef.current];
    const requestScope = `${requestEpoch}:${requestPinnedKey}`;
    if (p === 1) {
      attemptedScope.current = requestScope;
      exhaustedTagsRef.current.clear();
    }
    let retryAfterScopeChange = false;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    if (p === 1) setDone(false);
    try {
      let ordered: VideoCard[];
      let nextDone: boolean;
      if (requestPinned.length > 0) {
        const res = await fetchPinnedTagsPage(requestPinned, p, exhaustedTagsRef.current);
        ordered = res.items;
        nextDone = res.done;
      } else {
        const res = await api.feed(p, 30);
        const list = res?.items || [];
        ordered = p === 1 ? shuffle(list) : list;
        nextDone = !list.length || !!(res?.pagination && p >= res.pagination.pages);
      }
      if (!mounted.current) return;
      if (requestScope !== feedScopeRef.current) {
        retryAfterScopeChange = requestPinnedKey !== pinnedKeyRef.current || !itemsRef.current.length;
        return;
      }
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      setDone(nextDone);
    } catch (e) {
      if (!mounted.current) return;
      const message = (e as Error).message || tr("加载失败");
      const stale = requestScope !== feedScopeRef.current;
      if (!stale) {
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
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
        void load(1);
      }
    }
  }, [done, toast]);

  /* A never-visited/hidden home does no new work. New-line/pin retries resume on return.
     Loaded pages and an already mounted player remain intact across navigation. */
  useEffect(() => {
    if (!active || items.length || loadingRef.current || attemptedScope.current === feedScope) return;
    void loadFeed();
    void load(1);
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
    void load(page + 1);
  }, [active, filtering, ids.length, hiddenCount, loading, done, error, page, load, revision]);
  const loadNextFilteredPage = () => { autoFill.current = 1; void load(page + 1); };


  return (
    <div className="absolute inset-0 bg-black flex flex-col">
      {storageError && <div className="shrink-0 bg-bg px-3 pb-2" style={{ paddingTop: "var(--sat, 8px)" }}>
        <PreferenceStorageNotice />
      </div>}
      <div className="relative flex-1 min-h-0">
      {ids.length > 0 && (active || feedMounted) ? (
        <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>}>
          <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset} onBlocked={onBlocked}
            onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) load(page + 1); }} />
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
          <Empty icon={<ISearch size={26} />} title={tr("首页加载失败")} sub={error} action={tr("重试")} onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title={tr("暂无视频")} sub={tr("稍后刷新试试")} action={tr("刷新")} onAction={() => void load(1)} /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
      </div>
    </div>
  );
}
