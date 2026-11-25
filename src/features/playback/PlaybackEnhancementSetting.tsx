import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { ISpark } from "../../shared/ui/icons";
import { N_, tr } from "../../shared/i18n";
import { useStore, type EnhanceMode, type SuperResolutionTestScale } from "../../shared/model/store";

type ModeCopy = { value: EnhanceMode; label: string; summary: string };

const MODES: ModeCopy[] = [
  { value: "off", label: N_("原画"), summary: N_("原画：保持原始画面，最省电。") },
  { value: "fsr", label: N_("流畅"), summary: N_("流畅：轻量放大，画面更平滑，开销低。") },
  { value: "cas", label: N_("锐化"), summary: N_("锐化：只让边缘更利落，不增加新细节。") },
  { value: "detail", label: N_("细节"), summary: N_("细节：AI 补充纹理，画质最好，可能掉帧、发热。") },
];

const TEST_SCALES: { value: SuperResolutionTestScale; label: string }[] = [
  { value: "auto", label: N_("自动") },
  { value: "1x", label: "1x" },
  { value: "2x", label: "2x" },
];

/** Shared four-way picture-enhancement control for Settings and the player's More sheet. */
export function PlaybackEnhancementSetting({ className = "" }: { className?: string }) {
  const { enhanceMode, setEnhanceMode, srTestScale, setSrTestScale } = useStore();
  const active = Math.max(0, MODES.findIndex(mode => mode.value === enhanceMode));
  const summary = MODES[active].summary;
  const scaleActive = Math.max(0, TEST_SCALES.findIndex(scale => scale.value === srTestScale));

  return <div className={`ios-settings-row flex-wrap gap-y-2 ${className}`}>
    <span className="ios-setting-icon"><ISpark size={16} /></span>
    <div className="flex-1 min-w-0">
      <div className="text-[14px] text-on">{tr("画面增强（实验）")}</div>
      <div className="text-[12px] text-mut">{tr(summary)}</div>
    </div>
    <SegmentedControl className="w-full" aria-label={tr("画面增强（实验）")} activeIndex={active}>
      {MODES.map(mode => <Button key={mode.value} aria-pressed={enhanceMode === mode.value} aria-label={tr(mode.label)}
        onClick={() => setEnhanceMode(mode.value)}>{tr(mode.label)}</Button>)}
    </SegmentedControl>
    {enhanceMode !== "off" && <div className="w-full pt-1" data-sr-test-controls>
      <div className="text-[12px] text-mut mb-1">{tr("测试缩放（仅测试包）")}</div>
      <SegmentedControl className="w-full" aria-label={tr("测试缩放（仅测试包）")} activeIndex={scaleActive}>
        {TEST_SCALES.map(scale => <Button key={scale.value} aria-pressed={srTestScale === scale.value}
          onClick={() => setSrTestScale(scale.value)}>{tr(scale.label)}</Button>)}
      </SegmentedControl>
      <div className="text-[11px] text-mut mt-1">{tr("1x 保持源分辨率；2x 会渲染到源分辨率的 2 倍，可能很慢")}</div>
    </div>}
  </div>;
}
