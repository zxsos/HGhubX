import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  hostOf,
  type SubscriptionPreview,
  type SubscriptionProbeResult,
  type SubscriptionSiteInput,
} from "../../shared/api/api";
import { N_, tr } from "../../shared/i18n";
import { Button, Input } from "../../shared/ui/ios/controls";

const PROBE_BATCH_SIZE = 6;

const PROBE_REASON_KEYS: ReadonlySet<string> = new Set([
  N_("仅支持 HTTPS"),
  N_("地址无效"),
  N_("返回格式无效"),
  N_("暂无片源"),
  N_("清单格式无效"),
  N_("片源非 HTTPS"),
  N_("无直链片源"),
  N_("超时"),
  N_("DNS 失败"),
  N_("响应过大"),
  N_("不可达"),
  N_("片源超时"),
  N_("片源DNS 失败"),
  N_("片源响应过大"),
  N_("片源不可达"),
]);

function probeReasonLabel(reason?: string | null): string {
  if (!reason) return tr("不可用");
  if (PROBE_REASON_KEYS.has(reason)) return tr(reason);
  const restricted = /^片源受限 \((\d+)\)$/.exec(reason);
  if (restricted) return tr("片源受限 ({0})", restricted[1]);
  const streamErr = /^片源异常 \((\d+)\)$/.exec(reason);
  if (streamErr) return tr("片源异常 ({0})", streamErr[1]);
  return reason;
}

export default function SubscriptionPicker({
  preview,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: SubscriptionPreview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (items: SubscriptionSiteInput[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [probes, setProbes] = useState<Record<string, SubscriptionProbeResult>>({});
  const [probing, setProbing] = useState(false);
  const [probingIds, setProbingIds] = useState<Set<string>>(() => new Set());
  const [probeTotal, setProbeTotal] = useState(0);
  const [probeDone, setProbeDone] = useState(0);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const probeRunRef = useRef(0);

  useEffect(() => () => {
    probeRunRef.current += 1;
  }, []);

  const stopProbe = () => {
    probeRunRef.current += 1;
    setProbing(false);
    setProbingIds(new Set());
  };

  const searched = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return preview.items;
    return preview.items.filter(
      (item) =>
        item.name.toLowerCase().includes(kw) ||
        item.api.toLowerCase().includes(kw) ||
        item.key.toLowerCase().includes(kw),
    );
  }, [preview.items, query]);

  const filtered = useMemo(() => {
    if (!onlyAvailable) return searched;
    return searched.filter((item) => probes[item.id]?.ok);
  }, [searched, onlyAvailable, probes]);

  const testedCount = useMemo(
    () => preview.items.reduce((acc, item) => acc + (probes[item.id] ? 1 : 0), 0),
    [preview.items, probes],
  );
  const availableCount = useMemo(
    () => preview.items.reduce((acc, item) => acc + (probes[item.id]?.ok ? 1 : 0), 0),
    [preview.items, probes],
  );
  const availableSelectable = useMemo(() => {
    const okItems = searched.filter((item) => probes[item.id]?.ok);
    const okUninstalled = okItems.filter((item) => !item.installed);
    return okUninstalled.length > 0 ? okUninstalled : okItems;
  }, [searched, probes]);

  const startProbe = async () => {
    if (probing) {
      stopProbe();
      return;
    }
    const untested = searched.filter((item) => !probes[item.id]);
    const targets = untested.length > 0 ? untested : searched;
    if (!targets.length) return;

    const runId = ++probeRunRef.current;
    if (untested.length === 0) {
      setProbes((prev) => {
        const next = { ...prev };
        targets.forEach((item) => { delete next[item.id]; });
        return next;
      });
    }
    setProbing(true);
    setProbeTotal(targets.length);
    setProbeDone(0);

    try {
      for (let i = 0; i < targets.length; i += PROBE_BATCH_SIZE) {
        if (probeRunRef.current !== runId) return;
        const batch = targets.slice(i, i + PROBE_BATCH_SIZE);
        setProbingIds(new Set(batch.map((item) => item.id)));
        try {
          const results = await api.sourceProbeSubscription(
            batch.map(({ id, name, api: url }) => ({ id, name, api: url })),
          );
          if (probeRunRef.current !== runId) return;
          setProbes((prev) => {
            const next = { ...prev };
            results.forEach((r) => { next[r.id] = r; });
            return next;
          });
        } catch {
          if (probeRunRef.current !== runId) return;
          setProbes((prev) => {
            const next = { ...prev };
            batch.forEach((item) => {
              next[item.id] = { id: item.id, ok: false, ms: 0, playable: false, reason: null };
            });
            return next;
          });
        }
        setProbeDone(Math.min(targets.length, i + batch.length));
      }
    } finally {
      if (probeRunRef.current === runId) {
        setProbing(false);
        setProbingIds(new Set());
      }
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      filtered.forEach((item) => next.add(item.id));
      return next;
    });
  };

  const selectUninstalledVisible = () => {
    setSelected(new Set(filtered.filter((item) => !item.installed).map((item) => item.id)));
  };

  const selectAvailable = () => {
    if (!availableSelectable.length) return;
    setSelected(new Set(availableSelectable.map((item) => item.id)));
  };

  const handleCancel = () => {
    stopProbe();
    onCancel();
  };

  const submit = () => {
    stopProbe();
    const chosen = preview.items
      .filter((item) => selected.has(item.id))
      .map(({ id, name, api: url }) => ({ id, name, api: url }));
    if (chosen.length) void onConfirm(chosen);
  };

  const skipNotes: string[] = [];
  if (preview.skippedHttpCount > 0) {
    skipNotes.push(tr("已跳过 {0} 个非 HTTPS 站点", preview.skippedHttpCount));
  }
  if (preview.skippedUnsupportedCount > 0) {
    skipNotes.push(tr("已忽略 {0} 个不兼容条目", preview.skippedUnsupportedCount));
  }

  const allSearchedTested = searched.length > 0 && searched.every((item) => !!probes[item.id]);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-on">{tr("订阅清单")}</div>
          <div className="text-[11px] text-mut">
            {tr("发现 {0} 个可用站点", preview.items.length)}
            {skipNotes.length > 0 ? ` · ${skipNotes.join(" · ")}` : ""}
          </div>
          {testedCount > 0 && (
            <div className="text-[11px] text-mint tabular-nums mt-0.5">
              {tr("已测 {0}/{1} · {2} 个可播", testedCount, preview.items.length, availableCount)}
            </div>
          )}
        </div>
      </div>

      {preview.items.length > 6 && (
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("筛选站点名称或域名")}
          className="w-full h-8 px-2.5 rounded-(--r-sm) bg-s3 text-[12px] text-on"
        />
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          disabled={busy || searched.length === 0}
          onClick={() => { void startProbe(); }}
          className={`h-7 px-2.5 rounded-(--r-sm) text-[11.5px] font-medium pressable tabular-nums ${
            probing
              ? "bg-amber-500/20 text-amber-500 ring-1 ring-amber-500/40"
              : "bg-primary/20 text-primary ring-1 ring-primary/35"
          }`}
        >
          {probing
            ? tr("停止测试（{0}/{1}）", probeDone, probeTotal)
            : allSearchedTested
              ? tr("重新测试")
              : tr("测试可用性")}
        </Button>
        {availableSelectable.length > 0 && (
          <Button
            disabled={busy}
            onClick={selectAvailable}
            className="h-7 px-2.5 rounded-(--r-sm) bg-mint/15 text-mint ring-1 ring-mint/35 text-[11.5px] font-medium pressable tabular-nums"
          >
            {tr("一键选可用（{0}）", availableSelectable.length)}
          </Button>
        )}
        {testedCount > 0 && (
          <Button
            disabled={busy}
            onClick={() => setOnlyAvailable((v) => !v)}
            className={`h-7 px-2.5 rounded-(--r-sm) text-[11.5px] pressable ${
              onlyAvailable
                ? "bg-mint/15 text-mint ring-1 ring-mint/35"
                : "bg-s3 text-on"
            }`}
          >
            {tr("仅看可用")}
          </Button>
        )}
        <Button disabled={busy} onClick={selectAllVisible} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[11.5px] text-on pressable">
          {tr("全选")}
        </Button>
        <Button disabled={busy} onClick={selectUninstalledVisible} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[11.5px] text-on pressable">
          {tr("未安装")}
        </Button>
        <Button disabled={busy} onClick={() => setSelected(new Set())} className="h-7 px-2.5 rounded-(--r-sm) bg-s3 text-[11.5px] text-mut pressable">
          {tr("清空")}
        </Button>
      </div>

      <div className="max-h-[34vh] overflow-y-auto space-y-1 pr-0.5">
        {filtered.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-mut">
            {onlyAvailable ? tr("暂无可用的已测站点") : tr("未找到匹配的视频源")}
          </div>
        ) : filtered.map((item) => {
          const checked = selected.has(item.id);
          const probe = probes[item.id];
          const testing = probingIds.has(item.id);
          return (
            <label
              key={item.id}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-(--r-sm) cursor-pointer select-none transition-colors ${
                checked ? "bg-primary/15 ring-1 ring-primary/40" : "bg-s3/70 hover:bg-s3"
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={() => toggle(item.id)}
                className="w-4 h-4 shrink-0 accent-primary"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-medium text-on truncate">{item.name}</span>
                  {item.installed && (
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-s4 text-mut">
                      {tr("已安装")}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-dim font-mono truncate">{hostOf(item.api)}</div>
              </div>
              {testing ? (
                <span className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded bg-s4/90 text-mut tabular-nums">
                  {tr("测速中…")}
                </span>
              ) : probe ? (
                probe.ok ? (
                  <span className="shrink-0 text-[10.5px] px-1.5 py-0.5 rounded bg-mint/15 text-mint font-medium tabular-nums">
                    {tr("可用 · {0}ms", probe.ms)}
                  </span>
                ) : (() => {
                  const label = probeReasonLabel(probe.reason);
                  return (
                    <span title={label} className="shrink-0 max-w-[110px] truncate text-[10.5px] px-1.5 py-0.5 rounded bg-danger/15 text-danger">
                      {label}
                    </span>
                  );
                })()
              ) : null}
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <Button disabled={busy} onClick={handleCancel} className="h-9 px-3.5 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">
          {tr("返回")}
        </Button>
        <Button
          disabled={busy || selected.size === 0}
          onClick={submit}
          className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[13px] font-semibold text-on-primary pressable disabled:opacity-50"
        >
          {busy ? tr("导入中…") : tr("导入所选（{0}）", selected.size)}
        </Button>
      </div>
    </div>
  );
}
