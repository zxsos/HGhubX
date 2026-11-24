import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { IChevronDown } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

export type WorkStatus = "all" | "ongoing" | "finished";
export type WorkStatusCounts = { ongoing: number; finished: number } | null;

const OPTIONS: { value: WorkStatus; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "ongoing", label: "连载中" },
  { value: "finished", label: "已完结" },
];

const optionIndex = (status: WorkStatus) => OPTIONS.findIndex(option => option.value === status);

/** Tag video count button that opens a compact release-status menu. */
export function TagStatusMenu({ status, counts, total, onChange, className = "" }: {
  status: WorkStatus;
  counts: WorkStatusCounts;
  total: number;
  onChange: (status: WorkStatus) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const active = status !== "all";
  const activeLabel = tr(OPTIONS[optionIndex(status)].label);
  const activeCount = counts ? status === "finished" ? counts.finished : status === "ongoing" ? counts.ongoing : null : null;

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) buttonRef.current?.focus();
  }, []);

  const select = (next: WorkStatus) => {
    onChange(next);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    items?.[Math.max(optionIndex(status), 0)]?.focus();
  }, [open, status]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  return <div ref={wrapRef} className={`ios-sort-control ${className}`.trim()}>
    <Button ref={buttonRef} data-tag-status-trigger
      aria-label={active ? tr("筛选连载状态：{0}", activeLabel) : tr("筛选连载状态")}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(current => !current)} onKeyDown={onTriggerKeyDown}
      className="group inline-flex min-h-9 min-w-0 items-center gap-1.5 rounded-full px-1.5 text-left pressable">
      <span className="text-[15px] font-bold text-on">{tr("短剧")}</span>
      <span className="text-[12px] text-mut tabular-nums">{total}</span>
      {active && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
        {activeLabel}{activeCount !== null ? ` ${activeCount}` : ""}
      </span>}
      <IChevronDown size={14} aria-hidden="true" className={`text-mut transition-transform ${open ? "rotate-180" : ""}`} />
    </Button>
    {open && <div ref={menuRef} id={menuId} role="menu" aria-label={tr("连载状态")}
      className="ios-sort-menu" style={{ left: 0, right: "auto", width: 196 }} onKeyDown={onMenuKeyDown}>
      <span className="ios-sort-menu-title">{tr("连载状态")}</span>
      {OPTIONS.map(option => {
        const count = option.value === "all" ? total : option.value === "finished" ? counts?.finished : counts?.ongoing;
        return <button key={option.value} type="button" role="menuitemradio" data-tag-status-option={option.value}
          aria-checked={status === option.value} onClick={() => select(option.value)}>
          <span>{tr(option.label)}</span>
          {count !== undefined && <span className="ml-auto text-[12px] font-normal text-mut tabular-nums">{count}</span>}
        </button>;
      })}
    </div>}
  </div>;
}
