import { useEffect, useRef, type RefObject } from "react";
import { blocksEdgeSwipeBack } from "../../lib/back";

/** 左缘返回热区宽度；useTabSwipe 在该热区内起手时让出手势。 */
export const EDGE_BACK_ZONE_PX = 36;
/** 挂在启用了左缘返回的层上，供页内横滑判断是否需要让出起手。 */
export const EDGE_BACK_ATTR = "data-edge-back-active";
const LOCK_DISTANCE_PX = 8;
const COMMIT_MIN_PX = 96;
const FLICK_MIN_PX = 40;
const FLICK_VELOCITY = 0.45; // px/ms

function isBlockedTarget(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== root) {
    if (
      node.tagName === "INPUT"
      || node.tagName === "TEXTAREA"
      || node.tagName === "SELECT"
      || node.isContentEditable
      || node.hasAttribute("data-no-edge-back")
      || node.hasAttribute("data-horizontal-scroll")
    ) {
      return true;
    }
    if (node.scrollWidth > node.clientWidth + 2 && node.scrollLeft > 0) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** 移动端子页左缘右滑跟手返回（覆盖鸿蒙分屏/自由窗、iOS/iPadOS 与 Android）。 */
export function useEdgeSwipeBack(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onBack?: () => void,
) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    el.setAttribute(EDGE_BACK_ATTR, "");

    let active = false;
    let locked = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let width = 1;
    let resetTimer = 0;
    let revealed: HTMLElement | null = null;

    const clearStyle = () => {
      window.clearTimeout(resetTimer);
      resetTimer = 0;
      el.style.transition = "";
      el.style.transform = "";
      el.style.boxShadow = "";
      if (revealed) {
        revealed.removeAttribute("data-edge-reveal");
        revealed = null;
      }
    };

    const detachTracking = () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || blocksEdgeSwipeBack()) return;
      const touch = e.touches[0];
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || touch.clientX - rect.left > EDGE_BACK_ZONE_PX) return;
      if (isBlockedTarget(e.target, el)) return;
      clearStyle();
      active = true;
      locked = false;
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = startX;
      lastT = e.timeStamp || performance.now();
      velocity = 0;
      width = rect.width;
      // Only attach non-passive touchmove while tracking a genuine left-edge swipe
      // so normal vertical scrolling across the page stays 100% compositor-driven.
      el.addEventListener("touchmove", onMove, { passive: false });
      el.addEventListener("touchend", onEnd, { passive: true });
      el.addEventListener("touchcancel", onEnd, { passive: true });
    };

    const onMove = (e: TouchEvent) => {
      if (!active || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!locked) {
        if (Math.hypot(dx, dy) < LOCK_DISTANCE_PX) return;
        if (dx <= 0 || dx < Math.abs(dy) * 1.35) {
          active = false;
          detachTracking();
          return;
        }
        locked = true;
        const prev = el.previousElementSibling;
        if (prev instanceof HTMLElement && prev.classList.contains("ios-layer-hidden")) {
          revealed = prev;
          revealed.setAttribute("data-edge-reveal", "");
        }
      }
      if (e.cancelable) e.preventDefault();
      const now = e.timeStamp || performance.now();
      const dt = now - lastT;
      if (dt > 0) {
        const instant = (touch.clientX - lastX) / dt;
        velocity = velocity * 0.65 + instant * 0.35;
      }
      lastX = touch.clientX;
      lastT = now;
      const clamped = Math.max(0, Math.min(width, dx));
      el.style.transition = "none";
      el.style.transform = `translate3d(${clamped}px, 0, 0)`;
      el.style.boxShadow = "-12px 0 32px rgba(0, 0, 0, .28)";
    };

    const onEnd = (e: TouchEvent) => {
      detachTracking();
      if (!active) return;
      const wasLocked = locked;
      active = false;
      locked = false;
      if (!wasLocked) return;
      const dx = Math.max(0, (e.changedTouches[0]?.clientX ?? lastX) - startX);
      const threshold = Math.min(COMMIT_MIN_PX, width * 0.28);
      const shouldCommit = e.type === "touchend" && (dx >= threshold || (dx >= FLICK_MIN_PX && velocity >= FLICK_VELOCITY));
      if (shouldCommit) {
        clearStyle();
        onBackRef.current?.();
        return;
      }
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        clearStyle();
        return;
      }
      el.style.transition = "transform 180ms cubic-bezier(.2, .8, .2, 1)";
      el.style.transform = "translate3d(0, 0, 0)";
      resetTimer = window.setTimeout(clearStyle, 200);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    return () => {
      detachTracking();
      clearStyle();
      el.removeAttribute(EDGE_BACK_ATTR);
      el.removeEventListener("touchstart", onStart);
    };
  }, [ref, enabled]);
}
