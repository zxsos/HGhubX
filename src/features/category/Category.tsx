import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MediaCard, Masonry, RowCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { AUTO_LOAD_EMPTY_PAGE_LIMIT, useAutoLoadMore } from "../../shared/lib/useAutoLoadMore";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty } from "../../shared/ui/ui";
import { IAward, IBack, IChevR, IClock, IFilm, IFlame, ILayers, ISearch, ISpark, IStar, ITag, ITrophy, IUser } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { useTabSwipe } from "../../shared/ui/hooks/useTabSwipe";
import { VideoSortMenu } from "../../shared/ui/VideoSortMenu";
import { sortVideosByMetric, type VideoSortDirection, type VideoSortMetric } from "../../shared/model/videoSort";

export const CHANNELS: readonly { cate: string; name: string; Icon: typeof IFilm }[] = [];

function resolveCatalogIcon(icon?: string, fallback: typeof IFilm = IFilm): typeof IFilm {
  switch (icon?.trim().toLowerCase()) {
    case "clock": return IClock;
    case "star": return IStar;
    case "spark": return ISpark;
    case "award": return IAward;
    case "flame": return IFlame;
    case "film": return IFilm;
    case "layers": return ILayers;
    case "trophy": return ITrophy;
    default: return fallback;
  }
}

/** Half-width shortcut used to fit two destinations in one collection cell. */
function CompactCollectionLink({ icon, title, onClick }: { icon: ReactNode; title: string; onClick: () => void }) {
  return <Button onClick={onClick} aria-label={title}
    className="ios-collection-link ios-compact-collection-link flex w-full h-full min-w-0 items-center justify-center gap-1.5 rounded-[20px] px-2 py-2 text-center overflow-hidden pressable">
    <span aria-hidden="true" className="ios-collection-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-pc text-on-pc">{icon}</span>
    <span className="ios-collection-title inline-flex items-center whitespace-nowrap text-[12.5px] font-semibold leading-[1.2] text-on">{title}</span>
  </Button>;
}

/** Horizontal shelf with edge-to-edge mobile bleed and hover chevrons + fade masks on desktop. */
function ShelfRow({ label, children }: { label: string; children: ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const sync = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setFade(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    sync();
    const el = railRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, children]);
  const step = (dir: -1 | 1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, Math.round(el.clientWidth * 0.78)), behavior: "smooth" });
  };
  return (
    <div className="ios-shelf-wrap">
      <div ref={railRef} className="scroll-x ios-shelf-rail snap-x" role="group" aria-label={label}
        data-fade-left={fade.left ? "true" : undefined} data-fade-right={fade.right ? "true" : undefined}
        onScroll={sync}
        onWheel={(e) => {
          const el = railRef.current;
          if (!el || !e.shiftKey || !e.deltaY || el.scrollWidth <= el.clientWidth) return;
          el.scrollLeft += e.deltaY;
        }}>
        {children}
      </div>
      <Button type="button" aria-label={tr("向左滚动")} onClick={() => step(-1)} tabIndex={fade.left ? 0 : -1}
        className={`ios-icon-button ios-shelf-arrow is-prev ${fade.left ? "is-visible" : ""}`}>
        <IBack size={16} />
      </Button>
      <Button type="button" aria-label={tr("向右滚动")} onClick={() => step(1)} tabIndex={fade.right ? 0 : -1}
        className={`ios-icon-button ios-shelf-arrow is-next ${fade.right ? "is-visible" : ""}`}>
        <IChevR size={16} />
      </Button>
    </div>
  );
}

/** Section heading with a dedicated "all" hit target; the row itself must stay inert for vertical scrolling. */
function ChannelHeading({ icon, label, onOpenAll }: { icon: ReactNode; label: string; onOpenAll: () => void }) {
  return <div className="flex items-center gap-3 mb-3">
    <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">{icon}</span>
    <span className="flex-1 min-w-0">
      <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">{label}</span>
    </span>
    <Button onClick={onOpenAll} aria-label={`${tr("全部")} · ${label}`}
      className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut hover:text-primary transition-colors shrink-0 pressable">
      <span>{tr("全部")}</span><IChevR size={14} />
    </Button>
  </div>;
}

type ResolvedChannel = {
  id: string;
  label: string;
  kind: "video" | "post" | "feed";
  sorts?: readonly string[];
  Icon: typeof IFilm;
};

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch, activeSource, capabilities } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [postRows, setPostRows] = useState<Record<string, Post[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  const declaredShortcuts = useMemo(
    () => (capabilities.catalog.categories ? (activeSource?.catalog?.shortcuts ?? []) : []),
    [activeSource?.catalog?.shortcuts, capabilities.catalog.categories],
  );
  const declaredChannels = activeSource?.catalog?.channels;
  const channels = useMemo<ResolvedChannel[]>(() => {
    const activeDeclared = declaredChannels?.filter((ch) =>
      ch.kind === "post" ? capabilities.posts : capabilities.catalog.categories,
    );
    if (activeDeclared?.length) {
      return activeDeclared.map((ch, idx) => ({
        id: ch.id,
        label: ch.label,
        kind: ch.kind === "post" ? "post" : "video",
        sorts: ch.sorts,
        Icon: resolveCatalogIcon(ch.icon, ch.kind === "post" ? IFlame : idx === 0 ? IFilm : idx === 1 ? ISpark : IAward),
      }));
    }
    const list: ResolvedChannel[] = [];
    if (capabilities.home) {
      list.push({ id: "__feed__", label: tr("推荐发现"), kind: "feed", Icon: IFilm });
    }
    return list;
  }, [declaredChannels, capabilities.posts, capabilities.catalog.categories, capabilities.home]);
  const showDefaultPosts = capabilities.posts && !channels.some((c) => c.kind === "post");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string, ch?: ResolvedChannel): Promise<void> => {
    if (pending.current.has(key)) return;
    const requestEpoch = lineEpochRef.current;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "__posts__") {
        const result = await api.posts(1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setPostRows(m => ({ ...m, [key]: result?.items || [] }));
      } else if (ch?.kind === "post") {
        const result = await api.postCategory(ch.id, 1, 8, ch.sorts?.[0]);
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setPostRows(m => ({ ...m, [key]: result?.items || [] }));
      } else if (ch?.kind === "feed" || key === "__feed__") {
        const result = await api.feed(1, 8);
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      } else {
        const result = await api.category(key, 1, 8, ch?.sorts?.[0]);
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || tr("加载失败") }));
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
      const retry = retryKeys.current.delete(key);
      if (retry && mounted.current) void loadPreview(key, ch);
    }
  }, []);

  const channelSig = useMemo(
    () => `${channels.map((c) => `${c.id}:${c.kind}`).join("|")}|posts:${showDefaultPosts ? 1 : 0}`,
    [channels, showDefaultPosts],
  );
  const prevSig = useRef("");

  useEffect(() => {
    if (!active) return;
    if (!started.current || prevSig.current !== channelSig) {
      started.current = true;
      prevSig.current = channelSig;
      channels.forEach((c) => { void loadPreview(c.id, c); });
      if (showDefaultPosts) void loadPreview("__posts__");
    }
  }, [active, channelSig, channels, showDefaultPosts, loadPreview]);

  /* 线路/视频源切换后：已打开过的分类在新线路上重新获取，避免残留旧数据 */
  const prevEpoch = useRef(lineEpoch);
  useEffect(() => {
    if (prevEpoch.current === lineEpoch) return;
    prevEpoch.current = lineEpoch;
    if (!started.current) return;
    setRows({});
    setPostRows({});
    setErrors({});
    channels.forEach((c) => { void loadPreview(c.id, c); });
    if (showDefaultPosts) void loadPreview("__posts__");
  }, [lineEpoch, channels, showDefaultPosts, loadPreview]);

  const totalChannels = channels.length + (showDefaultPosts ? 1 : 0);
  const hasShortcuts = declaredShortcuts.length > 0 || capabilities.catalog.topics || capabilities.catalog.tags || capabilities.catalog.authors;
  const [scrolled, setScrolled] = useState(false);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className={`ios-page-heading shrink-0 ${scrolled ? "is-scrolled" : ""}`}>
        <div className="flex items-baseline gap-2.5">
          <h1 className="ios-page-title text-on">{tr("分类")}</h1>
          <span className="text-[13px] font-medium text-mut">{tr("{0} 个频道", totalChannels)}</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
        {hasShortcuts && (
          <CollectionLinks className="ios-category-links mb-6">
            {declaredShortcuts.map((sc, idx) => {
              const ShortcutIcon = resolveCatalogIcon(sc.icon, idx === 0 ? IClock : IStar);
              return (
                <CollectionLink key={sc.id} icon={<ShortcutIcon size={18} />} title={sc.label}
                  onClick={() => push({ kind: "channel", cate: sc.id, name: sc.label })} />
              );
            })}
            {capabilities.catalog.topics && (
              <CollectionLink icon={<ILayers size={18} />} title={tr("专题")}
                onClick={() => push({ kind: "topics" })} />
            )}
            {capabilities.catalog.tags && capabilities.catalog.authors ? (
              <div className="ios-compact-collection-group grid min-w-0 h-full grid-cols-2 gap-2">
                <CompactCollectionLink icon={<ITag size={15} />} title={tr("标签")}
                  onClick={() => push({ kind: "tags" })} />
                <CompactCollectionLink icon={<IUser size={15} />} title={tr("作者")}
                  onClick={() => push({ kind: "authors" })} />
              </div>
            ) : capabilities.catalog.tags ? (
              <CollectionLink icon={<ITag size={18} />} title={tr("标签")}
                onClick={() => push({ kind: "tags" })} />
            ) : capabilities.catalog.authors ? (
              <CollectionLink icon={<IUser size={18} />} title={tr("作者")}
                onClick={() => push({ kind: "authors" })} />
            ) : null}
          </CollectionLinks>
        )}

        {channels.map((c, ci) => {
          const ChannelIcon = c.Icon;
          if (c.kind === "post") {
            const list = postRows[c.id] || [];
            return (
              <section key={c.id} aria-label={c.label} className="mb-6 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
                <ChannelHeading icon={<ChannelIcon size={18} strokeWidth={1.9} />} label={c.label}
                  onOpenAll={() => push({ kind: "posts" })} />
                <FilteredContent items={list} scopeKey={`posts:${c.id}`}>{visible => <ShelfRow label={tr("{0}内容预览", c.label)}>
                  {visible.map((post) => (
                    <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                      subtitle={tr("{0} 次浏览", fmt(post.hot))} onOpen={() => push({ kind: "post", id: post.id })} /></div>
                  ))}
                  {!list.length && <PreviewStatus name={c.label} loading={loading[c.id] !== false} error={errors[c.id]} onRetry={() => void loadPreview(c.id, c)} />}
                </ShelfRow>}</FilteredContent>
              </section>
            );
          }
          const list = rows[c.id] || [];
          return (
            <section key={c.id} aria-label={c.label} className="mb-6 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <ChannelHeading icon={<ChannelIcon size={18} strokeWidth={1.9} />} label={c.label}
                onOpenAll={() => push({ kind: "channel", cate: c.id, name: c.label })} />
              <FilteredContent items={list} scopeKey={c.id}>{visible => <ShelfRow label={tr("{0}影片预览", c.label)}>
                {visible.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: c.label })} />
                ))}
                {!list.length && <PreviewStatus name={c.label} loading={loading[c.id] !== false} error={errors[c.id]} onRetry={() => void loadPreview(c.id, c)} />}
              </ShelfRow>}</FilteredContent>
            </section>
          );
        })}

        {showDefaultPosts && (
          <section aria-label={tr("图文帖子")} className="mb-5 a-rise">
            <ChannelHeading icon={<IFlame size={18} strokeWidth={1.9} />} label={tr("图文帖子")}
              onOpenAll={() => push({ kind: "posts" })} />
            <FilteredContent items={postRows.__posts__ || []} scopeKey="posts">{visible => <ShelfRow label={tr("帖子内容预览")}>
              {visible.map((post) => (
                <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                  subtitle={tr("{0} 次浏览", fmt(post.hot))} onOpen={() => push({ kind: "post", id: post.id })} /></div>
              ))}
              {!(postRows.__posts__ || []).length && <PreviewStatus name={tr("图文帖子")} loading={loading.__posts__ !== false} error={errors.__posts__} onRetry={() => void loadPreview("__posts__")} />}
            </ShelfRow>}</FilteredContent>
          </section>
        )}

        <div className="text-center text-[12px] text-dim pt-1">{tr("— 已展示全部频道 —")}</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div role="status" aria-busy={loading} className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? tr("加载中…") : error || tr("暂无内容")}</span>
    {!loading && error && <Button aria-label={tr("重试{0}", name)} onClick={onRetry} className="text-primary pressable">{tr("重试")}</Button>}
  </div>;
}

/* ================= 频道详情页 ================= */
function sortLabel(sort: string): string {
  if (sort === "latest" || sort === "new") return tr("最近更新");
  if (sort === "hot" || sort === "hot_window") return tr("当前热播");
  if (sort === "random" || sort === "recommend") return tr("精选推荐");
  return sort;
}

const METRIC_PAGE_SIZE = 100;
const METRIC_MAX_PAGES = 30;

export function ChannelPage({ cate, name, onBack, wide, sorts }: {
  cate: string; name: string; onBack: () => void; wide: boolean; sorts?: readonly string[];
}) {
  const { push, lineEpoch, activeSource, capabilities } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const blockReasonRef = useRef(blockReason);
  blockReasonRef.current = blockReason;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const channelMeta = useMemo(
    () =>
      activeSource?.catalog?.channels?.find((c) => c.id === cate) ??
      activeSource?.catalog?.shortcuts?.find((c) => c.id === cate),
    [activeSource, cate],
  );
  const channelSorts = useMemo(
    () => (sorts?.length ? [...sorts] : channelMeta?.sorts?.length ? [...channelMeta.sorts] : []),
    [sorts, channelMeta],
  );
  const isFeedChannel = cate === "__feed__";
  const hasServerSorts = !isFeedChannel && channelSorts.length > 0;
  const defaultSort = channelSorts[0] ?? "";
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState(defaultSort);
  const [metricSort, setMetricSort] = useState<VideoSortMetric>("default");
  const [metricDirection, setMetricDirection] = useState<VideoSortDirection>("desc");
  const [metricVisible, setMetricVisible] = useState(20);
  const metricLoaded = useRef(false);
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const sortedItems = useMemo(() => sortVideosByMetric(items, metricSort, metricDirection), [items, metricSort, metricDirection]);
  const visibleItems = metricSort === "default" ? sortedItems : sortedItems.slice(0, metricVisible);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [emptyStreak, setEmptyStreak] = useState(0);
  const filterKey = (sort: string, metric: VideoSortMetric = "default") =>
    `${cate}:${hasServerSorts ? sort : "default"}:${metric}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey(defaultSort));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const fetchChannelPage = (targetPage: number, size: number, sortValue: string, jsonOnly = false) =>
    isFeedChannel
      ? api.feed(targetPage, size)
      : api.category(cate, targetPage, size, hasServerSorts && sortValue ? sortValue : undefined, jsonOnly);

  const loadMetricPages = async (metric: VideoSortMetric, sortOverride: string = serverSort) => {
    if (metric === "default") return;
    const seq = ++requestSeq.current;
    busy.current = true;
    setLoading(true);
    setRefreshing(true);
    setErr(null);
    setMetricVisible(20);
    let all: VideoCard[] = [];
    let totalPages = 1;
    let requestedPages = 1;
    try {
      const first = await fetchChannelPage(1, METRIC_PAGE_SIZE, sortOverride, true);
      if (seq !== requestSeq.current) return;
      totalPages = Math.max(1, first?.pagination?.pages || 1);
      requestedPages = Math.min(totalPages, METRIC_MAX_PAGES);
      all = first?.items || [];
      for (let start = 2; start <= requestedPages; start += 4) {
        const batch: Promise<Awaited<ReturnType<typeof fetchChannelPage>>>[] = [];
        for (let p = start; p < Math.min(start + 4, requestedPages + 1); p += 1) {
          batch.push(fetchChannelPage(p, METRIC_PAGE_SIZE, sortOverride, true));
        }
        const results = await Promise.all(batch);
        if (seq !== requestSeq.current) return;
        for (const result of results) all.push(...(result?.items || []));
      }
      if (seq !== requestSeq.current) return;
      const seen = new Set<number>();
      const unique = all.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
      setPageItems([unique]);
      setPage(requestedPages);
      setPages(totalPages);
      setDisplayedFilter(filterKey(sortOverride, metric));
      metricLoaded.current = true;
      setEmptyStreak(0);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      if (all.length) {
        const seen = new Set<number>();
        setPageItems([all.filter((item) => !seen.has(item.id) && !!seen.add(item.id))]);
        setPage(requestedPages);
        setPages(totalPages);
        setDisplayedFilter(filterKey(sortOverride, metric));
      }
      setErr((e as Error).message || tr("加载失败"));
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const loadMore = async (reset = false, sortOverride: string = serverSort) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    setErr(null);
    if (reset) { setRefreshing(true); setEmptyStreak(0); }
    try {
      const next = reset ? 1 : page + 1;
      const res = await fetchChannelPage(next, 20, sortOverride);
      if (seq !== requestSeq.current) return;
      const incoming = res?.items || [];
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.flat().map((x) => x.id));
        return [...base, incoming.filter((x) => !seen.has(x.id))];
      });
      if (filteringRef.current && incoming.length > 0) {
        const visibleCount = incoming.filter((x) => !blockReasonRef.current(x.tags)).length;
        setEmptyStreak((prev) => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
      } else {
        setEmptyStreak(0);
      }
      setDisplayedFilter(filterKey(sortOverride));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      if (seq === requestSeq.current) setErr((e as Error).message || tr("加载失败"));
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const changeMetricSort = (value: VideoSortMetric, direction: VideoSortDirection = "desc") => {
    if (value === metricSort && direction === metricDirection) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setErr(null);
    setMetricVisible(20);
    if (value === "default") {
      metricLoaded.current = false;
      setMetricSort("default");
      setMetricDirection("desc");
      void loadMore(true, serverSort);
      return;
    }
    const metricChanged = value !== metricSort;
    setMetricSort(value);
    setMetricDirection(direction);
    if (!metricChanged) return;
    if (metricLoaded.current) {
      setDisplayedFilter(filterKey(serverSort, value));
      return;
    }
    void loadMetricPages(value);
  };

  const changeServerSort = (value: string) => {
    if (value === serverSort) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setErr(null);
    if (metricSort !== "default") {
      metricLoaded.current = false;
      void loadMetricPages(metricSort, value);
    } else {
      void loadMore(true, value);
    }
  };

  const channelTabIndex = channelSorts.indexOf(serverSort);
  const channelTabSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: scrollContainer,
    tabIndex: hasServerSorts ? Math.max(0, channelTabIndex) : 0,
    tabCount: hasServerSorts ? channelSorts.length : 1,
    onTabChange: (index) => {
      if (!hasServerSorts) return;
      const next = channelSorts[index];
      if (next) changeServerSort(next);
    },
  });

  useEffect(() => {
    setPageItems([]); setPage(0); setPages(1);
    setServerSort(defaultSort); setSearching(false);
    setMetricSort("default"); setMetricDirection("desc"); setMetricVisible(20); metricLoaded.current = false;
    void loadMore(true, defaultSort);
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate, defaultSort, lineEpoch]);
  const filterPending = displayedFilter !== filterKey(serverSort, metricSort);
  const replacing = refreshing || filterPending;
  useEffect(() => { setEmptyStreak(0); }, [filtering, preferences.blockedTags, preferences.hideUntagged]);
  const autoLoadPaused = filtering && emptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT;
  useAutoLoadMore({
    scrollRef: scrollContainer,
    sentinelRef: sentinel,
    enabled: !loading && !err && !replacing
      && (metricSort === "default" ? page < pages && !autoLoadPaused : metricVisible < sortedItems.length),
    watchKey: `${page}:${pages}:${items.length}:${metricSort}:${metricDirection}:${metricVisible}`,
    onLoadMore: () => {
      if (metricSort !== "default") {
        setMetricVisible(count => Math.min(count + 20, sortedItems.length));
      } else {
        void loadMore();
      }
    },
    rootMargin: "300px",
  });

  const ChannelGlyph = CHANNELS.find(c => c.cate === cate)?.Icon ?? IFilm;
  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ChannelGlyph size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{replacing ? (!hasServerSorts ? (loading ? tr("加载中…") : tr("加载失败")) : (loading && metricSort !== "default" ? tr("正在加载全部结果以排序…") : (loading ? tr("正在更新筛选结果…") : tr("筛选更新失败")))) : tr("已加载 {0} 部 · {1}/{2} 页", sortedItems.length, page, Math.max(pages, 1))}</div>
          </div>
          {capabilities.search && (
            <Button onClick={() => setSearching(true)} aria-label={tr("搜索")} className="ios-nav-btn"><ISearch size={18} /></Button>
          )}
        </div>
        {hasServerSorts && (
          <div className="ios-subpage-inner ios-channel-tabs pb-3 flex flex-wrap items-center gap-1.5">
            {channelSorts.map((s) => (
              <Button aria-pressed={serverSort === s} key={s} onClick={() => changeServerSort(s)}
                className="ios-filter-pill">{sortLabel(s)}</Button>
            ))}
            <VideoSortMenu className="ml-auto" value={metricSort} direction={metricDirection} onChange={changeMetricSort} />
          </div>
        )}
        {!hasServerSorts && !isFeedChannel && (
          <div className="ios-subpage-inner ios-channel-tabs pb-3 flex flex-wrap items-center gap-1.5">
            <VideoSortMenu className="ml-auto" value={metricSort} direction={metricDirection} onChange={changeMetricSort} />
          </div>
        )}
      </div>
      <div ref={scrollContainer} {...channelTabSwipe} style={{ touchAction: "pan-y" }}
        className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {sortedItems.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? tr("正在更新，暂时保留上次结果…") : tr("当前显示上次结果，请重试以更新筛选。")}</p>}
        {sortedItems.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void (metricSort === "default" ? loadMore(replacing) : loadMetricPages(metricSort))}>{tr("重试")}</Button></div>}
        {visibleItems.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={visibleItems} scopeKey={`${filterKey(serverSort, metricSort)}:${metricDirection}`} wide={wide} onOpen={(v, visible) => { if (!replacing) push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: name }); }} />
          </div>
        ) : err ? (
          <Empty icon={<ChannelGlyph size={26} />} title={tr("加载失败")} sub={err} action={tr("重试")} onAction={() => void (metricSort === "default" ? loadMore(true) : loadMetricPages(metricSort))} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<ChannelGlyph size={26} />} title={!hasServerSorts ? tr("暂无内容") : tr("该筛选下暂无内容")} sub={!hasServerSorts ? undefined : tr("换个筛选试试")} />}
        <div ref={sentinel} className="h-10" aria-hidden="true" />
        {loading && visibleItems.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && metricSort === "default" && page < pages && autoLoadPaused && (
          <div className="flex justify-center"><Button onClick={() => { setEmptyStreak(0); void loadMore(); }} className="my-3 px-4 text-primary">{tr("加载更多")}</Button></div>
        )}
        {!loading && !replacing && !err && (metricSort === "default" ? page >= pages : metricVisible >= sortedItems.length) && visibleItems.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">{tr("— 已经到底啦 —")}</div>
        )}
      </div>
      {searching && capabilities.search && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索 · {0}", name) })} />}
    </div>
  );
}
