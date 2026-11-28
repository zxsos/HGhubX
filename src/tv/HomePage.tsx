import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api/api";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, type TvContent } from "./model";
import { rankCard, videoCard } from "./catalogCards";
import { indexMetadata } from "./search/catalog";
import { useTv } from "./TvProvider";
import { TvCard, TvStatus } from "./ui";
import { LibraryCard } from "./LibraryCard";
export default function HomePage({ onOpen, active = true }: { onOpen: (content: TvContent) => void; active?: boolean }) {
  const { source, sourceKey, library, activeSource, sourceState } = useTv(), { blockReason, revision } = useContentPreferences();
  const [rows, setRows] = useState<{title:string;items:TvContent[]}[]>([]), [error,setError] = useState(""), [busy,setBusy] = useState(true), [retry,setRetry] = useState(0);
  const fulfilled = useRef("");
  const canHome = !activeSource || activeSource.capabilities.home;
  const canRank = sourceState === "unsupported" || Boolean(activeSource?.capabilities.catalog.rankings);
  const videoChannels = activeSource?.capabilities.catalog.categories
    ? (activeSource.catalog?.channels?.filter((ch) => ch.kind !== "post") ?? [])
    : [];
  const shelfChannels = videoChannels.slice(0, canRank ? 1 : 3);
  const shelfChannelKey = shelfChannels.map((c) => c.id).join(",");
  const identity = `${sourceKey}:${activeSource?.id ?? ""}:${shelfChannelKey}:${retry}:${revision}`;
  useEffect(() => {
    if (!active || !source) return;
    if (!canHome) { setRows([]); setBusy(false); setError(""); return; }
    if (fulfilled.current === identity) return;
    let current = true; setBusy(true); setError(""); setRows([]);
    void (async () => {
      try {
        const next: { title: string; items: TvContent[] }[] = [];
        const recommendation = await api.feed(1, 15); if (!current) return;
        next.push({ title: "推荐", items: recommendation.items.map(videoCard) });
        if (canRank) {
          const popular = await api.rank("hot"); if (!current) return;
          next.push({ title: "热门", items: popular.items.slice(0, 15).map(rankCard) });
        }
        if (shelfChannels.length) {
          const settled = await Promise.allSettled(
            shelfChannels.map((ch) => api.category(ch.id, 1, 15, ch.sorts?.[0]).then((res) => ({ title: ch.label, items: res.items.map(videoCard) }))),
          );
          if (!current) return;
          for (const item of settled) {
            if (item.status === "fulfilled" && item.value.items.length > 0) {
              next.push(item.value);
            }
          }
        }
        fulfilled.current = identity; setRows(next); void indexMetadata(source, next.flatMap(row => row.items)).catch(() => {});
      } catch(e) { if(current) setError(String(e)); } finally { if(current) setBusy(false); }
    })(); return () => { current = false; };
  }, [sourceKey, source, retry, revision, active, identity, canHome, canRank, shelfChannelKey]);
  const history = library.filter(entry => entry.progress).sort((a,b) => b.progress!.updatedAt - a.progress!.updatedAt).slice(0,15).map(entry => entry.content);
  return <><header className="tv-page-heading"><h1>首页</h1></header>
    {canHome && <TvStatus busy={busy} error={error} onRetry={() => setRetry(r=>r+1)} />}
    {!canHome && !history.length && <p className="tv-status">当前视频源未开启首页推荐</p>}
    {[...(history.length ? [{title:"继续观看",items:history}] : []), ...rows].map(row => <section className="tv-shelf" key={row.title}><h2>{row.title}</h2><div className="tv-shelf-track" data-tv-region={`home-${row.title}`} data-tv-scroll-id={`home-${row.title}`}>
      {row.items.filter(content=>row.title === "继续观看" || !blockReason(content.tags)).map(content=>row.title === "继续观看" ? <LibraryCard key={contentKey(content)} content={content} onOpen={onOpen} active={active}/> : <TvCard key={contentKey(content)} content={content} onOpen={onOpen}/>)}
    </div></section>)}
  </>;
}
