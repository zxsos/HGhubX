import { Button, Form, Image, Input } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, fmt, cover as imageCover } from "../../shared/api/api";
import { handleArticleClick, parseInternalVideoId, sanitizeHtml } from "../../shared/lib/html";
import { formatTimestamp } from "../../shared/lib/time";
import { commentText } from "./commentText";
import type { Comment, CommentPage, Episode } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { copyText } from "../../shared/lib/clipboard";
import { Avatar, Empty } from "../../shared/ui/ui";
import { IClose, IComment, IHeart, ISendF } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

/* ================= 选集 ================= */
export function EpisodesPanel({ episodes, current, onPick, onClose, bare = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏 */
  bare?: boolean;
}) {
  const [asc, setAsc] = useState(true);
  const gridRef = useRef<HTMLDivElement>(null);
  const list = asc ? episodes : [...episodes].reverse();
  useLayoutEffect(() => {
    const activeEl = gridRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [current, asc, episodes.length]);
  return (
    <div className="flex flex-col h-full min-h-0">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[12px] text-mut">{tr("共 {0} 集", episodes.length)}</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto ios-filter-pill !min-h-8 px-3 text-[12px] text-on/90 pressable">{asc ? tr("倒序") : tr("正序")}</Button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 min-h-[52px]">
          <span className="text-[14px] font-bold text-on">{tr("选集")}</span>
          <span className="text-[12px] text-mut">{tr("共 {0} 集", episodes.length)}</span>
          <Button onClick={() => setAsc((v) => !v)} className="ml-auto ios-filter-pill !min-h-8 px-3 text-[12px] text-on/90 pressable">{asc ? tr("倒序") : tr("正序")}</Button>
          <Button onClick={onClose} aria-label={tr("关闭")} className="ios-icon-button">
            <IClose size={15} />
          </Button>
        </div>
      )}
      <div ref={gridRef} className="flex-1 min-h-0 scroll-y px-4 pb-4">
        <div className="grid grid-cols-4 gap-2">
          {list.map((e) => (
            <Button key={e.ep_num} aria-current={e.ep_num === current ? "true" : undefined} onClick={() => onPick(e.ep_num)}
              className={`inline-flex items-center justify-center h-10 rounded-(--r-sm) text-[13px] font-semibold tabular-nums pressable ${e.ep_num === current ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
              {e.ep_num}
            </Button>
          ))}
        </div>
        {!episodes.length && <div className="text-center text-[12px] text-dim py-8">{tr("暂无剧集")}</div>}
      </div>
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose, onTotalChange }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void; onTotalChange?: (total: number) => void;
}) {
  const { user, setLoginOpen, toast, accountScope, lineEpoch, capabilities } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loadedTotal, setLoadedTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryPage, setRetryPage] = useState(1);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Comment[]>([]);
  itemsRef.current = items;
  const loadSequence = useRef(0);
  const loadBusy = useRef(false);
  const sendBusy = useRef(false);
  const sendSequence = useRef(0);
  const scope = `${accountScope}:${lineEpoch}:${kind}:${videoId}:${ep}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const alive = useRef(true);

  const onTotalChangeRef = useRef(onTotalChange);
  onTotalChangeRef.current = onTotalChange;
  const load = useCallback(async (p: number) => {
    if (p > 1 && loadBusy.current) return;
    const token = ++loadSequence.current;
    loadBusy.current = true;
    setLoading(true); setError("");
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      if (!alive.current || token !== loadSequence.current || currentScope.current !== scope) return;
      const rawItems = Array.isArray(res) ? res : (res?.items || []);
      const incoming = rawItems.map((x) => ({ ...x, text: commentText(x.text) }));
      const base = p === 1 ? [] : itemsRef.current;
      const seen = new Set(base.map((x) => x.id).filter((id) => id !== undefined && id !== null));
      const merged = [...base, ...incoming.filter((x) => x.id === undefined || x.id === null || !seen.has(x.id))];
      itemsRef.current = merged;
      setItems(merged);
      setPage(p);
      setPages(Number(res?.pagination?.pages) || 1);
      const rawTotal = res?.pagination?.total;
      const parsedTotal = rawTotal === null || rawTotal === undefined || String(rawTotal).trim() === "" ? Number.NaN : Number(rawTotal);
      const effectiveTotal = Number.isFinite(parsedTotal) && parsedTotal > 0
        ? Math.max(parsedTotal, merged.length)
        : merged.length > 0
          ? Math.max(total, merged.length)
          : (Number.isFinite(parsedTotal) && parsedTotal === 0 ? 0 : null);
      if (effectiveTotal !== null) {
        setLoadedTotal(effectiveTotal);
        onTotalChangeRef.current?.(effectiveTotal);
      }
    } catch (e) {
      if (alive.current && token === loadSequence.current && currentScope.current === scope) {
        setError((e as Error).message || tr("加载失败，请重试")); setRetryPage(p);
      }
    } finally {
      if (alive.current && token === loadSequence.current && currentScope.current === scope) {
        loadBusy.current = false; setLoading(false);
      }
    }
  }, [videoId, ep, kind, scope]);

  const loadNext = useCallback(() => {
    if (!alive.current || loadBusy.current || loading || error || page < 1 || page >= pages) return;
    void load(page + 1);
  }, [error, load, loading, page, pages]);

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120) loadNext();
  }, [loadNext]);

  useEffect(() => {
    alive.current = true;
    setItems([]); setPage(0); setPages(1); setLoadedTotal(null); setText(""); setSending(false); sendBusy.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    void load(1);
    return () => { alive.current = false; loadSequence.current++; sendSequence.current++; loadBusy.current = false; };
  }, [load]);

  useEffect(() => {
    if (!loading && !error) checkNearBottom();
  }, [checkNearBottom, error, items.length, loading, page]);

  const send = async () => {
    if (kind === "post") return;
    const t = text.trim();
    if (!t || sendBusy.current) return;
    if (!user) { setLoginOpen(true); return; }
    sendBusy.current = true;
    const token = ++sendSequence.current;
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t);
      if (!alive.current || token !== sendSequence.current || currentScope.current !== scope) return;
      setText("");
      toast(tr("评论已提交，审核通过后展示"), "ok");
      void load(1);
    } catch (e) {
      if (alive.current && token === sendSequence.current && currentScope.current === scope) toast((e as Error).message || tr("评论失败"), "info");
    } finally {
      if (alive.current && token === sendSequence.current && currentScope.current === scope) { sendBusy.current = false; setSending(false); }
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 min-h-[54px] border-b border-[var(--ios-edge)]">
        <span className="text-[14px] font-bold text-on">{tr("评论")}</span>
        <span className="text-[12px] text-mut">{fmt(Math.max(loadedTotal ?? total, items.length))}{kind === "video" ? tr(" · 第 {0} 集", ep) : tr(" 条")}</span>
        <Button onClick={onClose} aria-label={tr("关闭")} className="ml-auto ios-icon-button">
          <IClose size={15} />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 scroll-y px-4" aria-busy={loading} onScroll={checkNearBottom} data-testid="comments-scroll">
        {items.length ? items.map((c, idx) => (
          <div key={c.id ?? `comment-${idx}`} className="flex gap-2.5 py-3 border-b border-[var(--ios-edge)] last:border-0" data-testid="comment-item">
            <Avatar size={32} name={c.nickname} hue={Number.isFinite(c.user_id) ? (c.user_id * 37) % 360 : 210} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="min-w-0 text-[12px] font-semibold text-on/90 [overflow-wrap:anywhere]">{c.nickname}</span>
                <span className="shrink-0 text-[12px] text-mut">{formatTimestamp(c.time) || formatTimestamp(c.created_at)}</span>
              </div>
              <p className="text-[14px] text-on/85 mt-1 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text || tr("该评论包含不支持的内容")}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[12px] text-mut tabular-nums">
                <span className="inline-flex items-center gap-1"><IHeart size={12} aria-hidden="true" />{c.like_count || 0}</span>
                {c.reply_count > 0 && <span>{tr("{0} 条回复", c.reply_count)}</span>}
              </div>
            </div>
          </div>
        )) : (
          <div className="min-h-full flex items-center justify-center">
            {loading ? (
              <div className="flex justify-center py-10"><Loader className="w-7 h-7 spinner" /></div>
            ) : error ? (
              <Empty icon={<IComment size={22} />} title={tr("评论加载失败")} sub={error} action={tr("重试")} onAction={() => void load(1)} />
            ) : (
              <Empty icon={<IComment size={22} />} title={tr("还没有评论")} />
            )}
          </div>
        )}
        {items.length > 0 && (loading || error || page >= pages) && (
          <div className="flex justify-center py-4">
            {loading ? <Loader className="w-5 h-5 spinner" label={tr("正在加载更多评论")} />
              : error ? <div role="status" className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-mut"><span>{tr("评论加载失败：{0}", error)}</span><Button className="px-3 text-primary" onClick={() => void load(retryPage)}>{tr("重试")}</Button></div>
              : <span className="text-[12px] text-mut">{tr("— 到底啦 —")}</span>}
          </div>
        )}
      </div>

      {kind === "video" && capabilities.account && (
        <div className="comment-composer-bar shrink-0 px-4 pt-2.5 pb-3 border-t border-[var(--ios-edge)]">
          <Form className="comment-composer-form flex items-center gap-2 px-2.5 py-1.5" onSubmit={(e) => { e.preventDefault(); send(); }}>
            {user && <Avatar size={28} name={user.nickname || tr("我")} hue={322} />}
            <Input ref={inputRef} disabled={sending} value={text} onChange={(e) => setText(e.target.value)}
              readOnly={!user} onClick={() => { if (!user) setLoginOpen(true); }}
              onKeyDown={(event) => { if (!user && event.key === "Enter") { event.preventDefault(); setLoginOpen(true); } }}
              placeholder={user ? tr("说点什么…") : tr("登录后参与评论")}
              className="flex-1 min-w-0 h-8 px-1.5 text-[14px] text-on placeholder-mut outline-none" />
            <Button type="submit" aria-label={tr("发送评论")} disabled={!text.trim() || sending}
              className={`comment-send-btn w-8 h-8 min-h-0 rounded-full flex items-center justify-center pressable ${text.trim() ? "brand-grad glow-neon" : "bg-s4 text-on/70"}`}>
              {sending ? <Loader className="w-4 h-4 spinner" /> : <ISendF size={15} />}
            </Button>
          </Form>
        </div>
      )}
    </div>
  );
}
/* ================= 图文正文 ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity, push, activeSource } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    const videoId = parseInternalVideoId(url, activeSource?.origins ?? [], activeSource?.links?.videoIdPathPattern);
    if (videoId !== null) {
      push({ kind: "feed", videoIds: [videoId], index: 0, title: title || tr("图文详情") });
      return;
    }
    api.openUrl(url).catch(() => {
      copyText(url).then(() => toast(tr("链接已复制"), "ok")).catch(() => toast(tr("复制失败"), "info"));
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 min-h-[52px]">
        <span className="text-[14px] font-bold text-on">{tr("图文详情")}</span>
        {hot ? <span className="text-[12px] text-mut">{tr("{0} 热度", fmt(hot))}</span> : null}
        <Button onClick={onClose} aria-label={tr("关闭")} className="ml-auto ios-icon-button">
          <IClose size={15} />
        </Button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <Image src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[13px] text-dim mt-4">{tr("这篇内容没有正文，可能只有图片或视频。")}</p>}
      </div>
    </div>
  );
}
