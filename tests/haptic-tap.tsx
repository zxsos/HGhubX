import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, SegmentedControl } from "../src/shared/ui/ios/controls";
import { IUserF } from "../src/shared/ui/icons";
import { AuthorChip } from "../src/features/authors/AuthorChip";
import { initMobileHaptics } from "../src/shared/lib/haptics";
import "../src/index.css";

(window as Window & { __HAPTIC_TEST__?: { calls: number[] } }).__HAPTIC_TEST__ = { calls: [] };
window.__HG_HAPTIC__ = {
  vibrate(durationMs: number) {
    (window as Window & { __HAPTIC_TEST__?: { calls: number[] } }).__HAPTIC_TEST__!.calls.push(durationMs);
  },
};

function Harness() {
  const [tab, setTab] = useState(0);
  useEffect(() => initMobileHaptics(), []);
  return <>
    <div data-test-scroll className="h-[300px] overflow-y-auto bg-bg p-4 flex flex-col gap-3">
      {Array.from({ length: 12 }, (_, index) => <Button key={index} className="h-14 shrink-0 rounded-(--r-ctl) bg-s2 text-on">{`Tap ${index + 1}`}</Button>)}
    </div>
    <div className="p-4 flex items-center gap-3">
      <Button aria-label="打开排行榜" className="w-12 h-12 rounded-(--r-ctl) bg-primary text-on-primary"><IUserF size={18} /></Button>
      <SegmentedControl activeIndex={tab} aria-label="我的内容">
        <Button onClick={() => setTab(0)}>我的收藏</Button>
        <Button onClick={() => setTab(1)}>观看历史</Button>
      </SegmentedControl>
      <AuthorChip author={{ id: 7, name: "Hold Author", followers: 0 }} followed={false}
        onOpen={() => {}} onToggleFollow={() => {}} />
    </div>
  </>;
}

createRoot(document.querySelector("#root")!).render(<Harness />);
