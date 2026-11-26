import { Toggle } from "../../shared/ui/ui";
import { ISpark } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { useStore } from "../../shared/model/store";

/** Single production switch for the AI drama detail preset. */
export function PictureEnhanceSetting({ className = "" }: { className?: string }) {
  const {
    enhanceMode, setEnhanceMode,
    setSrTestDetailGain, setSrTestPortraitContrast, setSrTestDeblock, setSrTestGrain, setSrTestFaceMask,
  } = useStore();
  const on = enhanceMode === "detail";

  const setOn = (next: boolean) => {
    if (next) {
      setEnhanceMode("detail");
      setSrTestDetailGain(1.5);
      setSrTestPortraitContrast(0.3);
      setSrTestDeblock(0.2);
      setSrTestGrain(0.03);
      setSrTestFaceMask(1);
      return;
    }
    setEnhanceMode("off");
  };

  return <div className={`ios-settings-row ${className}`}>
    <span className="ios-setting-icon"><ISpark size={16} /></span>
    <div className="flex-1 min-w-0">
      <div className="text-[14px] text-on">{tr("画面增强")}</div>
      <div className="text-[12px] text-mut">{tr("AI 补充人物纹理和细节，更清晰也更耗电")}</div>
    </div>
    <Toggle desktop on={on} onChange={setOn} label={tr("画面增强")} />
  </div>;
}
