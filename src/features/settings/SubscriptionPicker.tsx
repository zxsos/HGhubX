import { useMemo, useState } from "react";
import {
  hostOf,
  type SubscriptionPreview,
  type SubscriptionSiteInput,
} from "../../shared/api/api";
import { tr } from "../../shared/i18n";
import { Button, Input } from "../../shared/ui/ios/controls";

function defaultSelectedIds(preview: SubscriptionPreview): Set<string> {
  const uninstalled = preview.items.filter((item) => !item.installed);
  if (!uninstalled.length) return new Set();
  const initial = uninstalled.length <= 5 ? uninstalled : uninstalled.slice(0, 3);
  return new Set(initial.map((item) => item.id));
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
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelectedIds(preview));

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return preview.items;
    return preview.items.filter(
      (item) =>
        item.name.toLowerCase().includes(kw) ||
        item.api.toLowerCase().includes(kw) ||
        item.key.toLowerCase().includes(kw),
    );
  }, [preview.items, query]);

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

  const submit = () => {
    const chosen = preview.items
      .filter((item) => selected.has(item.id))
      .map(({ id, name, api }) => ({ id, name, api }));
    if (chosen.length) void onConfirm(chosen);
  };

  const skipNotes: string[] = [];
  if (preview.skippedHttpCount > 0) {
    skipNotes.push(tr("已跳过 {0} 个非 HTTPS 站点", preview.skippedHttpCount));
  }
  if (preview.skippedUnsupportedCount > 0) {
    skipNotes.push(tr("已忽略 {0} 个不兼容条目", preview.skippedUnsupportedCount));
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-on">{tr("订阅清单")}</div>
          <div className="text-[11px] text-mut">
            {tr("发现 {0} 个可用站点", preview.items.length)}
            {skipNotes.length > 0 ? ` · ${skipNotes.join(" · ")}` : ""}
          </div>
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
          <div className="py-4 text-center text-[12px] text-mut">{tr("未找到匹配的视频源")}</div>
        ) : filtered.map((item) => {
          const checked = selected.has(item.id);
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
            </label>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <Button disabled={busy} onClick={onCancel} className="h-9 px-3.5 rounded-(--r-ctl) bg-s3 text-[13px] text-on pressable">
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
