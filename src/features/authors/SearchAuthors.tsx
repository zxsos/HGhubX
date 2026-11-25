import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../shared/model/store";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { IRefresh, IUserF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { AuthorChip } from "./AuthorChip";
import { useAuthorFollow } from "./useAuthorFollow";
import { loadAuthors, subscribeAuthors, type AuthorItem } from "./authorDirectory";

const TOP_COUNT = 14;
const BATCH_SIZE = 7;

/** Popular authors on the search landing page, with hold-to-follow author chips. */
export function SearchAuthors({ active }: { active: boolean }) {
  const { push, lineEpoch, follows } = useStore();
  const { busyId, toggleFollow } = useAuthorFollow();
  const [authors, setAuthors] = useState<AuthorItem[] | null>(null);
  const [batch, setBatch] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const loadedKey = useRef("");

  const load = useCallback(async (force = false) => {
    const token = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const directory = await loadAuthors(lineEpoch, force);
      if (sequence.current !== token) return;
      setAuthors(directory.items);
      setBatch(0);
      loadedKey.current = String(lineEpoch);
    } catch (cause) {
      if (sequence.current === token) setError(cause instanceof Error ? cause.message : tr("作者加载失败，请重试"));
    } finally {
      if (sequence.current === token) setLoading(false);
    }
  }, [lineEpoch]);

  useEffect(() => { if (active && loadedKey.current !== String(lineEpoch)) void load(); }, [active, lineEpoch, load]);
  useEffect(() => subscribeAuthors(directory => setAuthors(directory.items)), []);
  useEffect(() => () => { sequence.current++; }, []);

  const openAuthor = (author: AuthorItem) => push({ kind: "user", id: author.id, name: author.name });
  const isFollowing = (id: number) => follows.includes(id);
  const topAuthors = (authors ?? []).slice(0, TOP_COUNT);
  const batchCount = Math.max(1, Math.ceil(topAuthors.length / BATCH_SIZE));
  const safeBatch = batch % batchCount;
  const visible = topAuthors.slice(safeBatch * BATCH_SIZE, (safeBatch + 1) * BATCH_SIZE);

  return <Surface role="region" aria-label={tr("热门作者")} aria-busy={loading}
    className="mt-4 rounded-(--r-md) bg-s2 p-3.5 a-rise">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IUserF size={15} className="text-primary" />{tr("热门作者")}</h2>
      <Button onClick={() => push({ kind: "authors" })} className="-mr-2 px-2 inline-flex items-center justify-end min-h-9 text-[12px] text-primary font-semibold pressable">{tr("全部作者 ›")}</Button>
    </div>
    {error && <p role="status" className="mt-2 text-[12px] text-mut break-words">
      {authors?.length ? tr("刷新失败，保留已加载作者。") : tr("作者暂未加载成功。")}{error}
    </p>}
    {visible.length > 0 ? <div className="mt-3 flex flex-wrap gap-2">
      {visible.map(author => <AuthorChip key={author.id} author={author} followed={isFollowing(author.id)} showFollowers={false} busy={busyId === author.id}
        onOpen={() => openAuthor(author)} onToggleFollow={toggleFollow} />)}
    </div> : !error && <p role="status" className="mt-3 text-[13px] text-mut">
      {loading || authors === null ? tr("正在加载作者…") : tr("暂无可用作者")}
    </p>}
    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
      <Button onClick={() => void load(true)} disabled={loading} aria-label={tr("刷新作者")}
        className="-ml-2 px-2 min-h-9 inline-flex items-center gap-1 text-[12px] text-mut pressable">
        {loading ? <Loader className="w-3 h-3" /> : <IRefresh size={13} />}{loading ? tr("加载中…") : tr("刷新")}
      </Button>
      {topAuthors.length > BATCH_SIZE && <Button onClick={() => setBatch(value => (value + 1) % batchCount)}
        className="-mr-2 px-2 min-h-9 inline-flex items-center justify-end text-[12px] text-primary pressable">{tr("换一批")}</Button>}
    </div>
  </Surface>;
}
