import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { EDGE_BACK_ATTR, EDGE_BACK_ZONE_PX } from "./useEdgeSwipeBack";

const SWIPE_DISTANCE = 56;
const AXIS_LOCK_DISTANCE = 10;
const AXIS_RATIO = 1.35;
const CLICK_SUPPRESS_MS = 360;

type TabSwipeOptions<T extends HTMLElement> = {
  rootRef: RefObject<T | null>;
  tabIndex: number;
  tabCount: number;
  onTabChange: (index: number) => void;
  ignoreSelector?: string;
};

/**
 * Horizontal tab navigation for a scrollable page section.
 * Touch events are listened to natively because a vertical scroll cancels
 * Pointer Events; mouse and pen input still use Pointer Events.
 */
export function useTabSwipe<T extends HTMLElement>({
  rootRef,
  tabIndex,
  tabCount,
  onTabChange,
  ignoreSelector = "input, textarea, select, [role=dialog], [data-tab-swipe-ignore]",
}: TabSwipeOptions<T>) {
  const current = useRef({ tabIndex, tabCount, onTabChange, ignoreSelector });
  current.current = { tabIndex, tabCount, onTabChange, ignoreSelector };
  const pointerStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const touchStart = useRef<{ x: number; y: number; lastX: number; lastY: number; axis: "x" | "y" | null } | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);

  const clearClickSuppression = () => {
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = undefined;
    suppressClick.current = false;
  };

  const armClickSuppression = () => {
    window.clearTimeout(suppressTimer.current);
    suppressClick.current = true;
    suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, CLICK_SUPPRESS_MS);
  };

  const commit = (startX: number, startY: number, endX: number, endY: number, axis: "x" | "y" | null = null) => {
    if (axis === "y") return;
    const dx = endX - startX;
    const dy = endY - startY;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO) return;
    const next = dx < 0 ? current.current.tabIndex + 1 : current.current.tabIndex - 1;
    if (next < 0 || next >= current.current.tabCount) return;
    armClickSuppression();
    current.current.onTabChange(next);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const canStart = (target: EventTarget | null) => target instanceof Element &&
      !target.closest(current.current.ignoreSelector);

    const detachMove = () => {
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", finish);
      root.removeEventListener("touchcancel", cancel);
    };

    const begin = (event: TouchEvent) => {
      // A new user touch is a deliberate interaction, never the trailing synthetic click of a previous swipe.
      clearClickSuppression();
      if (current.current.tabCount <= 1 || event.touches.length !== 1) { touchStart.current = null; return; }
      const touch = event.touches[0];
      if (!canStart(event.target)) { touchStart.current = null; return; }
      // 起手落在子页左缘返回热区时让给 useEdgeSwipeBack，避免返回与切换分类同时触发。
      const edgeHost = root.closest(`[${EDGE_BACK_ATTR}]`);
      if (edgeHost && touch.clientX - edgeHost.getBoundingClientRect().left <= EDGE_BACK_ZONE_PX) { touchStart.current = null; return; }
      touchStart.current = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, axis: null };
      root.addEventListener("touchmove", move, { passive: false });
      root.addEventListener("touchend", finish, { passive: true });
      root.addEventListener("touchcancel", cancel, { passive: true });
    };
    const move = (event: TouchEvent) => {
      const gesture = touchStart.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.axis && (Math.abs(dx) >= AXIS_LOCK_DISTANCE || Math.abs(dy) >= AXIS_LOCK_DISTANCE)) {
        if (Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) gesture.axis = "x";
        else if (Math.abs(dy) > Math.abs(dx)) {
          gesture.axis = "y";
          detachMove();
          return;
        }
      }
      /* Claim a clearly horizontal gesture so the browser cannot turn it into a
         click on the card underneath. Vertical scrolling is left untouched. */
      if (gesture.axis === "x" && event.cancelable) event.preventDefault();
    };
    const finish = (event: TouchEvent) => {
      detachMove();
      const gesture = touchStart.current;
      touchStart.current = null;
      if (!gesture) return;
      const touch = event.changedTouches[0];
      commit(gesture.x, gesture.y, touch?.clientX ?? gesture.lastX, touch?.clientY ?? gesture.lastY, gesture.axis);
    };
    const cancel = () => {
      detachMove();
      touchStart.current = null;
    };

    root.addEventListener("touchstart", begin, { passive: true });
    return () => {
      detachMove();
      root.removeEventListener("touchstart", begin);
    };
  }, [rootRef]);

  useEffect(() => () => window.clearTimeout(suppressTimer.current), []);

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    clearClickSuppression();
    if (current.current.tabCount <= 1 || event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    if (!(event.target instanceof Element) || event.target.closest(current.current.ignoreSelector)) return;
    pointerStart.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  };
  const onPointerUp = (event: ReactPointerEvent<T>) => {
    const gesture = pointerStart.current;
    pointerStart.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    commit(gesture.x, gesture.y, event.clientX, event.clientY);
  };
  const onClickCapture = (event: ReactMouseEvent<T>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    onPointerDown,
    onPointerUp,
    onPointerCancel: () => { pointerStart.current = null; },
    onClickCapture,
  };
}
