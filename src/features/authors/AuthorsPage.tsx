import { useCallback, useEffect, useState } from "react";
import { api } from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Empty } from "../../shared/ui/ui";
import { IBack, IHeart, IRefresh, IUserF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { AuthorChip } from "./AuthorChip";
import { useAuthorFollow } from "./useAuthorFollow";
import { asAuthor, loadAuthors, MAX_FOLLOWED_AUTHORS, subscribeAuthors, type AuthorDirectory, type AuthorItem } from "./authorDirectory";

export function AuthorsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, lineEpoch, follows } = useStore();
  const { busyId, toggleFollow } = useAuthorFollow();
  const [authors, setAuthors] = useState<AuthorItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [followedAuthors, setFollowedAuthors] = useState<AuthorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const accept = useCallback((directory: AuthorDirectory) => {
    setAuthors(directory.items);
    setTotal(directory.total);
  }, []);

  const load = useCallback(async (force = false) => {
    setLoading(true); setError("");
    try { accept(await loadAuthors(lineEpoch, force)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : tr("作者加载失败，请重试")); }
    finally { setLoading(false); }
  }, [accept, lineEpoch]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeAuthors(accept), [accept]);

  const followedIds = follows.slice(0, MAX_FOLLOWED_AUTHORS);
  const followedKey = followedIds.join(",");
  useEffect(() => {
    const ids = followedKey ? followedKey.split(",").map(Number) : [];
    if (!ids.length) { setFollowedAuthors([]); return; }
    let alive = true;
    const known = (authors ?? []).filter(author => ids.includes(author.id));
    const knownIds = new Set(known.map(author => author.id));
    const missing = ids.filter(id => !knownIds.has(id));
    const finish = (loaded: AuthorItem[]) => {
      if (!alive) return;
      const byId = new Map([...known, ...loaded].map(author => [author.id, author]));
      setFollowedAuthors(ids.map(id => byId.get(id) ?? { id, name: tr("用户 {0}", id), followers: 0 }));
    };
    if (!missing.length) { finish([]); return; }
    Promise.all(missing.map(async id => {
      try {
        const author = asAuthor(await api.user(id));
        if (!author || author.followersKnown) return author;
        const stats = await api.userStats(id);
        const followers = Number(stats?.followers);
        return Number.isFinite(followers) && followers >= 0
          ? { ...author, followers: Math.floor(followers), followersKnown: true }
          : author;
      } catch {
        return null;
      }
    })).then(results => finish(results.filter((author): author is AuthorItem => !!author)));
    return () => { alive = false; };
  }, [authors, followedKey]);

  const openAuthor = (author: AuthorItem) => push({ kind: "user", id: author.id, name: author.name });
  const isFollowing = (id: number) => follows.includes(id);

  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="ios-subpage-bar">
        <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
        <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IUserF size={18} /></span>
        <div className="flex-1 min-w-0">
          <h1 className="text-[17px] font-bold text-on leading-tight">{tr("作者")}</h1>
          <div className="text-[12px] text-mut leading-tight mt-0.5 tabular-nums">{loading && !authors ? tr("加载中…") : tr("{0} 位作者 · {1} 位已关注", total, follows.length)}</div>
        </div>
        <Button aria-label={tr("刷新作者")} disabled={loading} aria-busy={loading} onClick={() => void load(true)} className="ios-nav-btn">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={18} />}</Button>
      </div>
    </div>
    <div className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
      {authors?.length ? <Surface data-followed-board aria-label={tr("已关注作者")} className="mb-3.5 rounded-[22px] bg-s1 p-4 a-rise">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[14.5px] font-bold text-on"><IHeart size={15} className="text-primary" />{tr("已关注作者")}</h2>
          <span className="text-[12px] text-dim tabular-nums" aria-live="polite">{tr("共 {0} 位", follows.length)}</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-mut">{follows.length ? tr("长按作者可关注或取消关注") : tr("长按下方作者可关注")}</p>
        {followedAuthors.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {followedAuthors.map(author => <AuthorChip key={author.id} author={author} followed showFollowers={false} highlight={false}
            busy={busyId === author.id} onOpen={() => openAuthor(author)} onToggleFollow={toggleFollow} />)}
        </div>}
      </Surface> : null}
      {loading && !authors ? (
        <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
      ) : error && !authors ? (
        <Empty icon={<IUserF size={26} />} title={tr("作者加载失败")} sub={error} action={tr("重试")} onAction={() => void load(true)} />
      ) : authors?.length ? (
        <Surface data-author-list className="rounded-[22px] bg-s1 p-4 a-rise">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[14.5px] font-bold text-on">{tr("全部作者")}</h2>
            <span className="text-[12px] text-dim tabular-nums" data-author-total={total}>{tr("{0} 位", total)}</span>
          </div>
          <div className={`mt-3 flex flex-wrap gap-2 ${wide ? "max-w-4xl" : ""}`}>
            {authors.map(author => <AuthorChip key={author.id} author={author} followed={isFollowing(author.id)} busy={busyId === author.id}
              onOpen={() => openAuthor(author)} onToggleFollow={toggleFollow} />)}
          </div>
        </Surface>
      ) : (
        <Empty icon={<IUserF size={26} />} title={tr("暂无作者")} />
      )}
      {wide && <div className="h-2" />}
    </div>
  </div>;
}
