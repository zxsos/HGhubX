import { Toggle } from "../../shared/ui/ui";
import { SegmentedControl, Button } from "../../shared/ui/ios/controls";
import { ISpark } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { ENHANCE_STRENGTHS, useStore, type EnhanceStrength } from "../../shared/model/store";

/** Production switch plus the three strength presets for the AI detail path. */
export function PictureEnhanceSetting({ className = "" }: { className?: string }) {
  const { enhanceMode, setEnhanceMode, enhanceStrength, setEnhanceStrength } = useStore();
  const on = enhanceMode === "detail";
  const labels: Record<EnhanceStrength, string> = {
    standard: tr("标准"),
    strong: tr("强"),
    extreme: tr("极强"),
  };

  return <div className={`ios-settings-row flex-wrap ${className}`}>
    <span className="ios-setting-icon"><ISpark size={16} /></span>
    <div className="flex-1 min-w-0">
      <div className="text-[14px] text-on">{tr("画面增强")}</div>
      <div className="text-[12px] text-mut">{tr("AI 补充人物纹理和细节；强度越高越清晰，也更耗电")}</div>
    </div>
    <Toggle desktop on={on} onChange={(next) => setEnhanceMode(next ? "detail" : "off")} label={tr("画面增强")} />
    {on && <div className="basis-full w-full">
      <div className="mb-1.5 text-[12px] text-mut">{tr("增强强度")}</div>
      <SegmentedControl className="w-full" aria-label={tr("增强强度")} activeIndex={ENHANCE_STRENGTHS.indexOf(enhanceStrength)}>
        {ENHANCE_STRENGTHS.map((strength) => (
          <Button key={strength} type="button" aria-pressed={enhanceStrength === strength}
            onClick={() => setEnhanceStrength(strength)}>
            {labels[strength]}
          </Button>
        ))}
      </SegmentedControl>
    </div>}
  </div>;
}
