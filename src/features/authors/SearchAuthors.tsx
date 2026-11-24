import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../shared/model/store";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { IRefresh, IUserF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { AuthorChip } from "./AuthorChip";
import { useAuthorFollow } from "./useAuthorFollow";
import { loadAuthors, type AuthorItem } from "./authorDirectory";

const TOP_COUNT = 12;

/** Popular authors on the search landing page, with hold-to-follow author chips. */
export function SearchAuthors({ active }: { active: boolean }) {
  const { push, lineEpoch, follows } = useStore();
  const { busyId, toggleFollow } = useAuthorFollow();
  const [authors, setAuthors] = useState<AuthorItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const loadedKey = useRef("");

  const load = useCallback(async (force = false) => {
    const token = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const items = await loadAuthors(lineEpoch, force);
      if (sequence.current !== token) return;
      setAuthors(items);
      loadedKey.current = String(lineEpoch);
    } catch (cause) {
      if (sequence.current === token) setError(cause instanceof Error ? cause.message : tr("作者加载失败，请重试"));
    } finally {
      if (sequence.current === token) setLoading(false);
    }
  }, [lineEpoch]);

  useEffect(() => { if (active && loadedKey.current !== String(lineEpoch)) void load(); }, [active, lineEpoch, load]);
  useEffect(() => () => { sequence.current++; }, []);

  const openAuthor = (author: AuthorItem) => push({ kind: "user", id: author.id, name: author.name });
  const isFollowing = (id: number) => follows.includes(id);
  const top = (authors ?? []).slice(0, TOP_COUNT);

  return <Surface role="region" aria-label={tr("热门作者")} aria-busy={loading}
    className="mt-4 rounded-(--r-md) bg-s2 p-3.5 a-rise">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IUserF size={15} className="text-primary" />{tr("热门作者")}</h2>
      <Button onClick={() => push({ kind: "authors" })} className="-mr-2 px-2 inline-flex items-center justify-end min-h-9 text-[12px] text-primary font-semibold pressable">{tr("全部作者 ›")}</Button>
    </div>
    {error && <p role="status" className="mt-2 text-[12px] text-mut break-words">
      {authors?.length ? tr("刷新失败，保留已加载作者。") : tr("作者暂未加载成功。")}{error}
    </p>}
    {top.length > 0 ? <div className="mt-3 flex flex-wrap gap-2">
      {top.map(author => <AuthorChip key={author.id} author={author} followed={isFollowing(author.id)} busy={busyId === author.id}
        onOpen={() => openAuthor(author)} onToggleFollow={toggleFollow} />)}
    </div> : !error && <p role="status" className="mt-3 text-[13px] text-mut">
      {loading || authors === null ? tr("正在加载作者…") : tr("暂无可用作者")}
    </p>}
    {authors && authors.length > TOP_COUNT && <p className="mt-2 text-[12px] text-dim">{tr("仅展示粉丝数前 {0} 位，更多作者见全部作者", TOP_COUNT)}</p>}
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      <Button onClick={() => void load(true)} disabled={loading} aria-label={error ? tr("重试加载作者") : tr("刷新作者")}
        className="-ml-2 px-2 min-h-9 inline-flex items-center gap-1 text-[12px] text-mut pressable">
        {loading ? <Loader className="w-3 h-3" /> : <IRefresh size={13} />}{loading ? tr("加载中…") : error ? tr("重试") : tr("刷新")}
      </Button>
      {authors && authors.length > 0 && <span className="text-[12px] text-dim tabular-nums">{tr("{0} 位作者", authors.length)}</span>}
    </div>
  </Surface>;
}
