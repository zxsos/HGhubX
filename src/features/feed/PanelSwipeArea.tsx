import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FeedPanel } from "./useFeedViewport";

const TAB_SWIPE_DISTANCE = 56;
const CLOSE_SWIPE_DISTANCE = 72;
const AXIS_LOCK_DISTANCE = 10;
const AXIS_RATIO = 1.35;
const CLICK_SUPPRESS_MS = 360;

type PanelTab = "detail" | "episodes";

/** Finds a horizontally scrollable ancestor so carousels keep their own swipe. */
function findHorizontalScroller(target: Element, boundary: HTMLElement): HTMLElement | null {
  let node: Element | null = target;
  while (node && node !== boundary.parentElement) {
    if (node instanceof HTMLElement) {
      const overflow = getComputedStyle(node).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Finds the nearest vertical scroller that owns the gesture. */
function findVerticalScroller(target: Element, boundary: HTMLElement): HTMLElement | null {
  let node: Element | null = target;
  while (node && node !== boundary.parentElement) {
    if (node instanceof HTMLElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Maps viewport deltas into panel-local coordinates when mounted inside a 90deg clockwise `.fs-landscape` stage. */
function toPanelDelta(rawDx: number, rawDy: number, rotated: boolean): { dx: number; dy: number } {
  return rotated ? { dx: rawDy, dy: -rawDx } : { dx: rawDx, dy: rawDy };
}

/**
 * Swipe navigation for the mobile detail/episodes sheet (and rotated landscape drawer).
 * Horizontal swipes switch tabs, while a downward pull closes the bottom sheet only
 * when the current content is already at the top. Horizontal carousels and
 * vertical lists keep their native gestures.
 */
export function PanelSwipeArea({ panel, onChange, rotated = false, allowPullDownClose = true, className = "", children }: {
  panel: PanelTab;
  onChange: (panel: FeedPanel) => void;
  rotated?: boolean;
  allowPullDownClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number; pointerId: number; atTop: boolean; isRotated: boolean } | null>(null);
  const touchStart = useRef<{
    x: number; y: number; atTop: boolean; isRotated: boolean;
    lastX: number; lastY: number; axis: "x" | "y" | null;
  } | null>(null);
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

  useEffect(() => () => window.clearTimeout(suppressTimer.current), []);

  const canStart = (target: Element, area: HTMLElement) => {
    if (target.closest("input, textarea, select, [data-panel-swipe-ignore]")) return null;
    if (findHorizontalScroller(target, area)) return null;
    const scroller = findVerticalScroller(target, area);
    const isRotated = rotated || Boolean(area.closest(".fs-landscape"));
    return { atTop: !scroller || scroller.scrollTop <= 1, isRotated };
  };

  const commit = (
    x: number, y: number, endX: number, endY: number,
    atTop: boolean, isRotated: boolean, axis: "x" | "y" | null = null,
  ) => {
    const { dx, dy } = toPanelDelta(endX - x, endY - y, isRotated);
    if (axis !== "y" && Math.abs(dx) >= TAB_SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) {
      const next: PanelTab = dx < 0 ? "episodes" : "detail";
      if (next !== panel) {
        armClickSuppression();
        onChange(next);
      }
      return;
    }
    if (allowPullDownClose && axis !== "x" && atTop && dy >= CLOSE_SWIPE_DISTANCE && dy > Math.abs(dx) * AXIS_RATIO) {
      armClickSuppression();
      onChange(null);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearClickSuppression();
    if (e.pointerType === "touch" || !e.isPrimary || e.button !== 0) return;
    const start = canStart(e.target as Element, e.currentTarget);
    if (!start) return;
    pointerStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, atTop: start.atTop, isRotated: start.isRotated };
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = pointerStart.current;
    pointerStart.current = null;
    if (!gesture || gesture.pointerId !== e.pointerId) return;
    commit(gesture.x, gesture.y, e.clientX, e.clientY, gesture.atTop, gesture.isRotated);
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    /* Touch events use native listeners because Pointer Events are cancelled once the browser
       takes over native scrolling; mouse and pen input still uses the Pointer Events above. */
    const begin = (event: TouchEvent) => {
      clearClickSuppression();
      if (event.touches.length !== 1) { touchStart.current = null; return; }
      const touch = event.touches[0];
      const start = canStart(event.target as Element, area);
      if (!start) { touchStart.current = null; return; }
      touchStart.current = {
        x: touch.clientX, y: touch.clientY,
        atTop: start.atTop, isRotated: start.isRotated,
        lastX: touch.clientX, lastY: touch.clientY,
        axis: null,
      };
    };
    const move = (event: TouchEvent) => {
      const gesture = touchStart.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      const { dx, dy } = toPanelDelta(touch.clientX - gesture.x, touch.clientY - gesture.y, gesture.isRotated);
      if (!gesture.axis && (Math.abs(dx) >= AXIS_LOCK_DISTANCE || Math.abs(dy) >= AXIS_LOCK_DISTANCE)) {
        if (Math.abs(dx) > Math.abs(dy) * AXIS_RATIO) gesture.axis = "x";
        else if (Math.abs(dy) > Math.abs(dx)) gesture.axis = "y";
      }
      if (gesture.axis === "x") {
        /* Claim clearly horizontal tab swipes so native vertical scroll cannot steal or cancel them. */
        if (event.cancelable) event.preventDefault();
        return;
      }
      /* Stop native pull/overscroll only when a downward swipe at the top should close a bottom sheet. */
      if (allowPullDownClose && gesture.atTop && dy > 8 && dy > Math.abs(dx) * AXIS_RATIO) {
        if (event.cancelable) event.preventDefault();
      }
    };
    const finish = (event: TouchEvent) => {
      const gesture = touchStart.current;
      touchStart.current = null;
      if (!gesture) return;
      const touch = event.changedTouches[0];
      commit(
        gesture.x, gesture.y,
        touch?.clientX ?? gesture.lastX, touch?.clientY ?? gesture.lastY,
        gesture.atTop, gesture.isRotated, gesture.axis,
      );
    };
    const cancel = () => {
      touchStart.current = null;
    };
    area.addEventListener("touchstart", begin, { passive: true });
    area.addEventListener("touchmove", move, { passive: false });
    area.addEventListener("touchend", finish, { passive: true });
    area.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      area.removeEventListener("touchstart", begin);
      area.removeEventListener("touchmove", move);
      area.removeEventListener("touchend", finish);
      area.removeEventListener("touchcancel", cancel);
    };
  }, [panel, onChange, rotated, allowPullDownClose]);

  return <div
    ref={areaRef}
    className={`video-details-sheet-body flex-1 min-h-0 flex flex-col ${className}`}
    onPointerDown={onPointerDown}
    onPointerUp={onPointerUp}
    onPointerCancel={() => { pointerStart.current = null; }}
    onClickCapture={onClickCapture}
  >{children}</div>;
}
