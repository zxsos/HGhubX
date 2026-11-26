import { Button, SegmentedControl } from "../../shared/ui/ios/controls";
import { ISpark } from "../../shared/ui/icons";
import { N_, tr } from "../../shared/i18n";
import { useStore, type EnhanceMode, type SuperResolutionTestDeblock, type SuperResolutionTestDetailGain, type SuperResolutionTestFaceMask, type SuperResolutionTestGrain, type SuperResolutionTestPortraitContrast, type SuperResolutionTestScale } from "../../shared/model/store";

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

const DETAIL_GAINS: { value: SuperResolutionTestDetailGain; label: string }[] = [
  { value: 1, label: "1.0×" },
  { value: 1.5, label: "1.5×" },
  { value: 2, label: "2.0×" },
];

const PORTRAIT_CONTRASTS: { value: SuperResolutionTestPortraitContrast; label: string }[] = [
  { value: 0, label: "0" },
  { value: 0.2, label: "0.2" },
  { value: 0.3, label: "0.3" },
  { value: 0.4, label: "0.4" },
];

const DEBLOCK_LEVELS: { value: SuperResolutionTestDeblock; label: string }[] = [
  { value: 0, label: "0" },
  { value: 0.2, label: "0.2" },
  { value: 0.4, label: "0.4" },
];

const GRAIN_LEVELS: { value: SuperResolutionTestGrain; label: string }[] = [
  { value: 0, label: "0" },
  { value: 0.03, label: "0.03" },
  { value: 0.06, label: "0.06" },
];

const FACE_MASKS: { value: SuperResolutionTestFaceMask; label: string }[] = [
  { value: 0, label: "0" },
  { value: 0.5, label: "0.5" },
  { value: 1, label: "1" },
];

/** Shared four-way picture-enhancement control for Settings and the player's More sheet. */
export function PlaybackEnhancementSetting({ className = "" }: { className?: string }) {
  const {
    enhanceMode, setEnhanceMode, srTestScale, setSrTestScale,
    srTestDetailGain, setSrTestDetailGain, srTestPortraitContrast, setSrTestPortraitContrast,
    srTestDeblock, setSrTestDeblock, srTestGrain, setSrTestGrain, srTestFaceMask, setSrTestFaceMask,
  } = useStore();
  const active = Math.max(0, MODES.findIndex(mode => mode.value === enhanceMode));
  const summary = MODES[active].summary;
  const scaleActive = Math.max(0, TEST_SCALES.findIndex(scale => scale.value === srTestScale));
  const detailGainActive = Math.max(0, DETAIL_GAINS.findIndex(gain => gain.value === srTestDetailGain));
  const portraitContrastActive = Math.max(0, PORTRAIT_CONTRASTS.findIndex(contrast => contrast.value === srTestPortraitContrast));
  const deblockActive = Math.max(0, DEBLOCK_LEVELS.findIndex(level => level.value === srTestDeblock));
  const grainActive = Math.max(0, GRAIN_LEVELS.findIndex(level => level.value === srTestGrain));
  const faceMaskActive = Math.max(0, FACE_MASKS.findIndex(level => level.value === srTestFaceMask));
  const applyAiPreset = () => {
    setEnhanceMode("detail");
    setSrTestDetailGain(1.5);
    setSrTestPortraitContrast(0.3);
    setSrTestDeblock(0.2);
    setSrTestGrain(0.03);
    setSrTestFaceMask(1);
  };

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
      <div className="text-[11px] text-mut mt-1">{tr("按住看原画会自动暂停，松手保持暂停，方便同帧对比")}</div>
      {enhanceMode === "detail" && <div className="w-full pt-2" data-sr-detail-gain>
        <Button className="w-full" onClick={applyAiPreset} data-sr-ai-preset>{tr("AI 短剧预设（仅测试包）")}</Button>
        <div className="text-[11px] text-mut mt-1">{tr("一次应用：细节 1.5×、人像 0.3、去块 0.2、颗粒 0.03、软掩膜开")}</div>
        <div className="text-[12px] text-mut mb-1 mt-2">{tr("细节强度（仅测试包）")}</div>
        <SegmentedControl className="w-full" aria-label={tr("细节强度（仅测试包）")} activeIndex={detailGainActive}>
          {DETAIL_GAINS.map(gain => <Button key={gain.value} aria-pressed={srTestDetailGain === gain.value}
            onClick={() => setSrTestDetailGain(gain.value)}>{gain.label}</Button>)}
        </SegmentedControl>
        <div className="text-[11px] text-mut mt-1">{tr("越高人物纹理越强，也更容易出现噪点和硬边")}</div>
        <div className="text-[12px] text-mut mb-1 mt-2">{tr("人像对比（仅测试包）")}</div>
        <SegmentedControl className="w-full" aria-label={tr("人像对比（仅测试包）")} activeIndex={portraitContrastActive}>
          {PORTRAIT_CONTRASTS.map(contrast => <Button key={contrast.value} aria-pressed={srTestPortraitContrast === contrast.value}
            onClick={() => setSrTestPortraitContrast(contrast.value)}>{contrast.label}</Button>)}
        </SegmentedControl>
        <div className="text-[11px] text-mut mt-1">{tr("只加皮肤和眼窝的中频对比，越高越硬")}</div>
        <div className="text-[12px] text-mut mb-1 mt-2">{tr("去块（仅测试包）")}</div>
        <SegmentedControl className="w-full" aria-label={tr("去块（仅测试包）")} activeIndex={deblockActive}>
          {DEBLOCK_LEVELS.map(level => <Button key={level.value} aria-pressed={srTestDeblock === level.value}
            onClick={() => setSrTestDeblock(level.value)}>{level.label}</Button>)}
        </SegmentedControl>
        <div className="text-[11px] text-mut mt-1">{tr("先清掉 720p 压缩块，再去放大；太强会磨平发丝")}</div>
        <div className="text-[12px] text-mut mb-1 mt-2">{tr("颗粒（仅测试包）")}</div>
        <SegmentedControl className="w-full" aria-label={tr("颗粒（仅测试包）")} activeIndex={grainActive}>
          {GRAIN_LEVELS.map(level => <Button key={level.value} aria-pressed={srTestGrain === level.value}
            onClick={() => setSrTestGrain(level.value)}>{level.label}</Button>)}
        </SegmentedControl>
        <div className="text-[11px] text-mut mt-1">{tr("给过于光滑的 AI 皮肤补一点噪声，只在中间调生效")}</div>
        <div className="text-[12px] text-mut mb-1 mt-2">{tr("面部软掩膜（仅测试包）")}</div>
        <SegmentedControl className="w-full" aria-label={tr("面部软掩膜（仅测试包）")} activeIndex={faceMaskActive}>
          {FACE_MASKS.map(level => <Button key={level.value} aria-pressed={srTestFaceMask === level.value}
            onClick={() => setSrTestFaceMask(level.value)}>{level.label}</Button>)}
        </SegmentedControl>
        <div className="text-[11px] text-mut mt-1">{tr("越大越只对肤色/中间调生效，减少背景和字幕被锐化")}</div>
      </div>}
    </div>}
  </div>;
}
