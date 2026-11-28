import { useEffect, useMemo, useRef, useState } from "react";
import {
  api, isMobile,
  type SourceStateSnapshot, type SourceTestOutcome, type SubscriptionPreview, type SubscriptionSiteInput,
} from "../../shared/api/api";
import { useStore } from "../../shared/model/store";
import { Button, Input, Surface, TextArea } from "../../shared/ui/ios/controls";
import { Modal, Sheet } from "../../shared/ui/ui";
import { ICheck, IClose, ILink, IRefresh, IScan } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { pasteText } from "../../shared/lib/clipboard";
import { buildDemoOfflinePackageJson, isDemoOfflineSource } from "../../shared/lib/demoSource";
import SubscriptionPicker from "./SubscriptionPicker";
import TvQrSyncModal from "./TvQrSyncModal";

function notifySourceChanged() {
  window.dispatchEvent(new CustomEvent("hg:line-changed"));
  window.dispatchEvent(new CustomEvent("hg:source-changed"));
}

export default function SourceManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const [state, setState] = useState<SourceStateSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState("");
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, SourceTestOutcome>>({});
  const [scanOpen, setScanOpen] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionPreview | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setState(await api.sourceState());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("加载失败")));
    }
  };

  useEffect(() => {
    if (open) void load();
    else {
      setScanOpen(false);
      setSubscription(null);
      setSourceQuery("");
      setManaging(false);
      setSelectedIds(new Set());
      setConfirmBatch(false);
    }
  }, [open]);

  const doImport = async () => {
    const raw = draft.trim();
    if (!raw || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.sourceResolveImport(raw, true);
      if (res.kind === "subscription") {
        setSubscription(res.preview);
        return;
      }
      setDraft("");
      await load();
      notifySourceChanged();
      toast(tr("已导入 {0} v{1}", res.summary.name, res.summary.version), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  const confirmSubscription = async (items: SubscriptionSiteInput[]) => {
    if (busy || !items.length) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.sourceImportSubscription(items, true);
      const failedNote = res.failed.length > 0
        ? tr("{0} 个站点导入失败：{1}", res.failed.length, res.failed.map((f) => `${f.name}（${f.error}）`).join("；"))
        : "";
      if (!res.imported.length) {
        // 全部失败：保留选择器和草稿，便于调整勾选后重试。
        setError(failedNote || tr("失败"));
        return;
      }
      setSubscription(null);
      setDraft("");
      await load();
      notifySourceChanged();
      if (failedNote) setError(failedNote);
      toast(
        res.failed.length > 0
          ? tr("已导入 {0} 个视频源（{1} 个失败）", res.imported.length, res.failed.length)
          : tr("已导入 {0} 个视频源", res.imported.length),
        res.failed.length > 0 ? "info" : "ok",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  const visibleSources = useMemo(() => {
    const list = state?.sources ?? [];
    const kw = sourceQuery.trim().toLowerCase();
    if (!kw) return list;
    return list.filter(
      (s) =>
        s.name.toLowerCase().includes(kw) ||
        s.id.toLowerCase().includes(kw) ||
        s.origins.some((o) => o.toLowerCase().includes(kw)),
    );
  }, [state?.sources, sourceQuery]);

  const tryDemoOffline = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.sourceImport(buildDemoOfflinePackageJson(), true);
      await load();
      notifySourceChanged();
      toast(tr("已启用离线示例源"), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e || tr("失败")));
    } finally {
      setBusy(false);
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = (await pasteText()).trim();
      if (text) setDraft(text);
      else toast(tr("剪贴板为空"), "info");
    } catch {
      toast(tr("读取剪贴板失败，请手动粘贴"), "info");
    }
  };

  const onFilePick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft((await file.text()).trim());
    } catch {
      setError(tr("读取文件失败"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const activate = async (id: string | null, name?: string) => {
    setActionId(id ?? "__off__");
    setError("");
    try {
      setState(await api.sourceActivate(id));
      notifySourceChanged();
      toast(id ? tr("已启用：{0}", name || id) : tr("已停用"), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const runTest = async (id: string) => {
    setActionId(`test:${id}`);
    try {
      const res = await api.sourceTest(id);
      setTests((prev) => ({ ...prev, [id]: res }));
      if (res.ok) {
        toast(tr("测试通过 · {0}ms · {1} 条", res.ms, res.itemCount), "ok");
      } else {
        toast(tr("测试失败：{0}", res.error || tr("失败")), "info");
      }
    } catch (e) {
      toast(tr("测试失败：{0}", e instanceof Error ? e.message : String(e)), "info");
    } finally {
      setActionId("");
    }
  };

  const checkUpdate = async (id: string) => {
    setActionId(`upd:${id}`);
    try {
      const res = await api.sourceCheckUpdate(id);
      await load();
      if (res.updated) {
        notifySourceChanged();
        toast(tr("已更新至 v{0}", res.toVersion), "ok");
      } else {
        toast(tr("已是最新 v{0}", res.fromVersion), "ok");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const rollback = async (id: string) => {
    setActionId(`rb:${id}`);
    try {
      const res = await api.sourceRollback(id);
      await load();
      notifySourceChanged();
      toast(tr("已回滚至 v{0}", res.version), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const remove = async (id: string) => {
    setActionId(`rm:${id}`);
    try {
      setState(await api.sourceRemove(id));
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      notifySourceChanged();
      toast(tr("已移除"), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitManaging = () => {
    setManaging(false);
    setSelectedIds(new Set());
    setConfirmBatch(false);
  };

  const selectedSources = (state?.sources ?? []).filter((s) => selectedIds.has(s.id));
  const selectedActive = selectedSources.some((s) => s.active);
  const selectedHidden = selectedSources.filter((s) => !visibleSources.includes(s)).length;

  const removeSelected = async () => {
    const ids = selectedSources.map((s) => s.id);
    if (!ids.length || actionId) return;
    setActionId("rm:batch");
    setError("");
    try {
      setState(await api.sourceRemoveMany(ids));
      setSelectedIds(new Set());
      setManaging(false);
      notifySourceChanged();
      toast(tr("已移除 {0} 个视频源", ids.length), "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionId("");
      setConfirmBatch(false);
    }
  };

  const body = (
    <div className="flex flex-col min-h-0 max-h-[82dvh]">
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3.5 border-b border-s3">
        <div className="flex items-center gap-2 min-w-0">
          <ILink size={16} className="text-primary shrink-0" />
          <h2 className="text-[16px] font-bold text-on truncate">{tr("视频源")}</h2>
        </div>
        <Button onClick={onClose} aria-label={tr("关闭")} className="ios-icon-button"><IClose size={18} /></Button>
      </div>

      <div className="flex-1 min-h-0 scroll-y p-4 space-y-4">
        <Surface className="rounded-(--r-md) bg-s2 p-3.5 space-y-2.5">
          {subscription ? (
            <>
              {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
              <SubscriptionPicker
                preview={subscription}
                busy={busy}
                onCancel={() => { setSubscription(null); setError(""); }}
                onConfirm={confirmSubscription}
              />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-on">{tr("导入视频源")}</span>
                <div className="flex items-center gap-2">
                  {isMobile && <Button onClick={() => setScanOpen(true)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable inline-flex items-center gap-1"><IScan size={12} /> {tr("扫码")}</Button>}
                  <Button onClick={pasteClipboard} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("粘贴")}</Button>
                  <Button onClick={() => fileRef.current?.click()} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("文件")}</Button>
                  <input ref={fileRef} type="file" accept=".json,.hgsrc,.txt" className="hidden" onChange={(e) => void onFilePick(e.target.files?.[0])} />
                </div>
              </div>
              <TextArea
                aria-label={tr("导入视频源")}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full h-20 p-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on font-mono resize-none"
              />
              {error && <p role="alert" className="text-[12px] text-danger break-words">{error}</p>}
              <Button disabled={busy || !draft.trim()} onClick={() => void doImport()} className="w-full h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50">
                {busy ? tr("导入中…") : tr("导入")}
              </Button>
            </>
          )}
        </Surface>

        <div className="space-y-2">
          <div className="px-1 flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-dim">
              {tr("已安装")}{(state?.sources.length ?? 0) > 0 ? ` (${state?.sources.length})` : ""}
            </div>
            {(state?.sources.length ?? 0) >= 2 && (
              <Button
                disabled={!!actionId}
                onClick={() => (managing ? exitManaging() : setManaging(true))}
                className="h-7 px-2.5 rounded-(--r-sm) bg-s2 text-[11.5px] font-medium text-on pressable"
              >
                {managing ? tr("完成") : tr("批量管理")}
              </Button>
            )}
          </div>
          {((state?.sources.length ?? 0) >= 6 || !!sourceQuery) && (
            <Input
              value={sourceQuery}
              onChange={(e) => setSourceQuery(e.target.value)}
              placeholder={tr("搜索已安装视频源")}
              className="w-full h-8 px-2.5 rounded-(--r-sm) bg-s2 text-[12px] text-on"
            />
          )}
          {managing && confirmBatch && selectedSources.length > 0 && (
            <div role="alertdialog" aria-label={tr("批量移除")} className="rounded-(--r-md) bg-danger/10 ring-1 ring-danger/40 p-3 space-y-2">
              <p className="text-[12.5px] font-medium text-on">{tr("确认移除选中的 {0} 个视频源？", selectedSources.length)}</p>
              {selectedActive && <p className="text-[11.5px] text-danger">{tr("其中包含正在使用的视频源。")}</p>}
              {selectedHidden > 0 && <p className="text-[11.5px] text-mut">{tr("其中 {0} 个不在当前筛选结果中。", selectedHidden)}</p>}
              <div className="flex items-center gap-2 pt-0.5">
                <Button
                  autoFocus
                  disabled={!!actionId}
                  onClick={() => setConfirmBatch(false)}
                  className="flex-1 h-8 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable"
                >
                  {tr("取消")}
                </Button>
                <Button
                  variant="danger"
                  disabled={!!actionId}
                  aria-busy={actionId === "rm:batch"}
                  onClick={() => void removeSelected()}
                  className="flex-1 h-8 rounded-(--r-sm) text-[12px] font-semibold pressable disabled:opacity-50"
                >
                  {actionId === "rm:batch" ? tr("正在移除…") : tr("确认移除")}
                </Button>
              </div>
            </div>
          )}
          {managing && !confirmBatch && (state?.sources.length ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                disabled={!!actionId}
                onClick={() => setSelectedIds((prev) => {
                  const next = new Set(prev);
                  visibleSources.forEach((s) => next.add(s.id));
                  return next;
                })}
                className="h-7 px-2.5 rounded-(--r-sm) bg-s2 text-[11.5px] text-on pressable"
              >
                {tr("全选")}
              </Button>
              <Button
                disabled={!!actionId}
                onClick={() => setSelectedIds(new Set(visibleSources.filter((s) => !s.active).map((s) => s.id)))}
                className="h-7 px-2.5 rounded-(--r-sm) bg-s2 text-[11.5px] text-on pressable"
              >
                {tr("仅未启用")}
              </Button>
              <Button
                disabled={!!actionId}
                onClick={() => setSelectedIds(new Set())}
                className="h-7 px-2.5 rounded-(--r-sm) bg-s2 text-[11.5px] text-mut pressable"
              >
                {tr("清空")}
              </Button>
              <Button
                disabled={!!actionId || selectedSources.length === 0}
                onClick={() => setConfirmBatch(true)}
                className="h-7 px-2.5 rounded-(--r-sm) bg-danger/15 text-[11.5px] font-medium text-danger pressable ml-auto disabled:opacity-45"
              >
                {tr("移除所选（{0}）", selectedSources.length)}
              </Button>
            </div>
          )}

          {!state?.sources.length ? (
            <Surface className="rounded-(--r-md) bg-s2 p-4 text-center space-y-2.5">
              <div className="text-[12px] text-mut">{tr("暂无视频源")}</div>
              <Button disabled={busy} onClick={() => void tryDemoOffline()} className="h-8 px-3 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable disabled:opacity-50">
                {tr("试用离线示例源")}
              </Button>
            </Surface>
          ) : !visibleSources.length ? (
            <Surface className="rounded-(--r-md) bg-s2 p-4 text-center text-[12px] text-mut">
              {tr("未找到匹配的视频源")}
            </Surface>
          ) : visibleSources.map((src) => {
            const t = tests[src.id];
            const checked = selectedIds.has(src.id);
            if (managing) {
              return (
                <label
                  key={src.id}
                  className={`flex items-center gap-2.5 rounded-(--r-md) p-3 cursor-pointer select-none transition-colors ${
                    checked ? "bg-danger/10 ring-1 ring-danger/40" : src.active ? "bg-s3/80 ring-1 ring-primary/40" : "bg-s2"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!!actionId}
                    onChange={() => toggleSelect(src.id)}
                    className="w-4 h-4 shrink-0 accent-danger"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13.5px] font-semibold text-on truncate">{src.name}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-s4 text-mut font-mono">v{src.version}</span>
                      {src.active && (
                        <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                          <ICheck size={11} /> {tr("使用中")}
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              );
            }
            return (
              <Surface key={src.id} className={`rounded-(--r-md) p-3.5 space-y-2 ${src.active ? "bg-s3/80 ring-1 ring-primary/50" : "bg-s2"}`}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[14px] font-semibold text-on truncate">{src.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-s4 text-mut font-mono">v{src.version}</span>
                  {isDemoOfflineSource(src) && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                      {tr("示例")}
                    </span>
                  )}
                  {src.active && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">
                      <ICheck size={11} /> {tr("使用中")}
                    </span>
                  )}
                </div>

                {t && (
                  <div className={`text-[11px] px-2 py-1 rounded ${t.ok ? "bg-mint/15 text-mint" : "bg-danger/15 text-danger"}`}>
                    {t.ok
                      ? tr("测试通过 · {0}ms · {1} 条", t.ms, t.itemCount)
                      : tr("测试失败：{0}", t.error || tr("失败"))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {src.active ? (
                    <Button disabled={!!actionId} onClick={() => void activate(null)} className="h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[12px] text-on pressable">{tr("停用")}</Button>
                  ) : (
                    <Button disabled={!!actionId} onClick={() => void activate(src.id, src.name)} className="h-7 px-2.5 rounded-(--r-sm) bg-primary text-[12px] font-medium text-on-primary pressable">{tr("启用")}</Button>
                  )}
                  <Button disabled={!!actionId} onClick={() => void runTest(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">{tr("测试")}</Button>
                  {src.updateUrls.length > 0 && (
                    <Button disabled={!!actionId} onClick={() => void checkUpdate(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable inline-flex items-center gap-1">
                      <IRefresh size={11} /> {tr("更新")}
                    </Button>
                  )}
                  {src.previousVersion && (
                    <Button disabled={!!actionId} onClick={() => void rollback(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on pressable">
                      {tr("回滚")}
                    </Button>
                  )}
                  <Button disabled={!!actionId} onClick={() => void remove(src.id)} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-danger pressable ml-auto">{tr("移除")}</Button>
                </div>
              </Surface>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {isMobile
        ? <Sheet open={open && !scanOpen} onClose={onClose} label={tr("视频源")}>{body}</Sheet>
        : <Modal open={open && !scanOpen} onClose={onClose} label={tr("视频源")} width={520}>{body}</Modal>}
      {isMobile && <TvQrSyncModal open={scanOpen} initialView="scan" onClose={() => setScanOpen(false)} onSuccess={() => { void load(); }} onSubscription={(p) => { setError(""); setSubscription(p); }} />}
    </>
  );
}
