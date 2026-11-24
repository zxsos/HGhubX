import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../shared/model/store";
import { AUTHOR_TOAST_SLOT, MAX_PINNED_AUTHORS, useAuthorPins } from "../../shared/model/authorPins";
import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { Empty } from "../../shared/ui/ui";
import { IBack, IPin, IRefresh, IUserF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { AuthorPinChip } from "./AuthorPinChip";
import { loadAuthors, type AuthorItem } from "./authorDirectory";

export function AuthorsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast, lineEpoch } = useStore();
  const { pinnedAuthors, togglePinnedAuthor, isAuthorPinned } = useAuthorPins();
  const [authors, setAuthors] = useState<AuthorItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (force = false) => {
    setLoading(true); setError("");
    try { setAuthors(await loadAuthors(lineEpoch, force)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : tr("作者加载失败，请重试")); }
    finally { setLoading(false); }
  }, [lineEpoch]);

  useEffect(() => { void load(); }, [load]);

  const togglePin = (author: AuthorItem) => {
    const currentlyPinned = isAuthorPinned(author.id);
    if (!currentlyPinned && pinnedAuthors.length >= MAX_PINNED_AUTHORS) {
      toast(tr("最多置顶 {0} 位作者", MAX_PINNED_AUTHORS), "info", AUTHOR_TOAST_SLOT);
      return;
    }
    togglePinnedAuthor({ id: author.id, name: author.name, followers: author.followers });
    toast(currentlyPinned ? tr("已取消置顶作者：{0}", author.name) : tr("已置顶作者：{0}", author.name), currentlyPinned ? "info" : "ok", AUTHOR_TOAST_SLOT);
  };
  const openAuthor = (author: AuthorItem) => push({ kind: "user", id: author.id, name: author.name });

  return <div className="ios-page absolute inset-0 bg-bg flex flex-col">
    <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
      <div className="ios-subpage-bar">
        <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
        <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><IUserF size={18} /></span>
        <div className="flex-1 min-w-0">
          <h1 className="text-[17px] font-bold text-on leading-tight">{tr("作者")}</h1>
          <div className="text-[12px] text-mut leading-tight mt-0.5 tabular-nums">{loading && !authors ? tr("加载中…") : tr("{0} 位作者 · {1} 位置顶", authors?.length ?? 0, pinnedAuthors.length)}</div>
        </div>
        <Button aria-label={tr("刷新作者")} disabled={loading} aria-busy={loading} onClick={() => void load(true)} className="ios-nav-btn">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={18} />}</Button>
      </div>
    </div>
    <div className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
      {authors && authors.length > 0 && <Surface data-pin-board className="mb-3.5 rounded-[22px] bg-s1 p-4 a-rise" aria-label={tr("置顶作者")}>
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-[14.5px] font-bold text-on"><IPin size={15} className="text-primary" />{tr("置顶作者")}</h2>
          <span className="text-[12px] text-dim tabular-nums" aria-live="polite">{tr("{0} 位", pinnedAuthors.length)}</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-mut">{pinnedAuthors.length ? tr("长按作者置顶，再长按取消") : tr("长按下方作者可置顶")}</p>
        {pinnedAuthors.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {pinnedAuthors.map(author => <AuthorPinChip key={author.id} author={author} pinned board onOpen={() => openAuthor(author)} onTogglePin={togglePin} />)}
        </div>}
      </Surface>}
      {loading && !authors ? (
        <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
      ) : error && !authors ? (
        <Empty icon={<IUserF size={26} />} title={tr("作者加载失败")} sub={error} action={tr("重试")} onAction={() => void load(true)} />
      ) : authors?.length ? (
        <Surface className="rounded-[22px] bg-s1 p-4 a-rise">
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <h2 className="text-[14.5px] font-bold text-on">{tr("全部作者")}</h2>
            <span className="text-[12px] text-dim tabular-nums">{tr("{0} 位", authors.length)}</span>
          </div>
          <div className={`flex flex-wrap gap-2 ${wide ? "max-w-4xl" : ""}`}>
            {authors.map(author => <AuthorPinChip key={author.id} author={author} pinned={isAuthorPinned(author.id)} onOpen={() => openAuthor(author)} onTogglePin={togglePin} />)}
          </div>
        </Surface>
      ) : (
        <Empty icon={<IUserF size={26} />} title={tr("暂无作者")} />
      )}
      {wide && <div className="h-2" />}
    </div>
  </div>;
}
