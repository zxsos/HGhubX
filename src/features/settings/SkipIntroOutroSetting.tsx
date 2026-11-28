import { useEffect, useState } from "react";
import { IClock } from "../../shared/ui/icons";
import { Button, Input, SegmentedControl } from "../../shared/ui/ios/controls";
import { useStore } from "../../shared/model/store";
import { tr } from "../../shared/i18n";

const PRESETS = [0, 30, 60, 90, 120] as const;

function clamp(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.min(600, Math.round(raw)) : 0;
}

function SkipSecondsRow({
  title,
  subtitle,
  value,
  decreaseLabel,
  increaseLabel,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: number;
  decreaseLabel: string;
  increaseLabel: string;
  onChange: (secs: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      onChange(0);
      setDraft("0");
      return;
    }
    const parsed = clamp(Number(trimmed));
    onChange(parsed);
    setDraft(String(parsed));
  };

  return (
    <div className="ios-settings-row flex-wrap">
      <span className="ios-setting-icon"><IClock size={16} /></span>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] text-on">{title}</div>
        <div className="text-[12px] text-mut">{subtitle}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button
          type="button"
          aria-label={decreaseLabel}
          disabled={value <= 0}
          onClick={() => onChange(clamp(value - 5))}
          className="h-8 w-8 rounded-(--r-sm) bg-s3 text-[13px] font-semibold text-on pressable disabled:opacity-40"
        >
          -5
        </Button>
        <Input
          type="text"
          inputMode="numeric"
          aria-label={title}
          value={draft}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
            setDraft(digits);
            if (digits) onChange(clamp(Number(digits)));
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(draft); }}
          className="skip-secs-input w-14 h-8 px-2 rounded-(--r-sm) bg-s3 text-center text-[13px] font-mono text-on tabular-nums"
        />
        <span className="text-[12px] text-mut">{tr("秒")}</span>
        <Button
          type="button"
          aria-label={increaseLabel}
          disabled={value >= 600}
          onClick={() => onChange(clamp(value + 5))}
          className="h-8 w-8 rounded-(--r-sm) bg-s3 text-[13px] font-semibold text-on pressable disabled:opacity-40"
        >
          +5
        </Button>
      </div>
      <SegmentedControl
        className="w-full"
        aria-label={tr("{0}预设", title)}
        activeIndex={PRESETS.indexOf(value as typeof PRESETS[number])}
      >
        {PRESETS.map((secs) => (
          <Button
            key={secs}
            type="button"
            aria-pressed={value === secs}
            onClick={() => onChange(secs)}
          >
            {secs === 0 ? tr("关") : tr("{0}秒", secs)}
          </Button>
        ))}
      </SegmentedControl>
    </div>
  );
}

/** Settings-only custom intro/outro skip controls. */
export default function SkipIntroOutroSetting() {
  const { skipIntroSecs, setSkipIntroSecs, skipOutroSecs, setSkipOutroSecs } = useStore();
  return (
    <>
      <SkipSecondsRow
        title={tr("跳过片头")}
        subtitle={skipIntroSecs > 0
          ? tr("开播自动跳过前 {0} 秒；续播或短片时不生效", skipIntroSecs)
          : tr("开播自动跳过片头；0 秒为关闭")}
        value={skipIntroSecs}
        decreaseLabel={tr("减少跳过片头秒数")}
        increaseLabel={tr("增加跳过片头秒数")}
        onChange={setSkipIntroSecs}
      />
      <SkipSecondsRow
        title={tr("跳过片尾")}
        subtitle={skipOutroSecs > 0
          ? tr("距结尾剩余 {0} 秒自动切下一集；无下一集时不中断", skipOutroSecs)
          : tr("距结尾自动切下一集；0 秒为关闭")}
        value={skipOutroSecs}
        decreaseLabel={tr("减少跳过片尾秒数")}
        increaseLabel={tr("增加跳过片尾秒数")}
        onChange={setSkipOutroSecs}
      />
    </>
  );
}
