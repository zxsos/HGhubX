import { useSyncExternalStore } from "react";
import { isMobile } from "../api/api";
import { readStorage, STORAGE_KEYS } from "../storage/storage";

export type HapticLevel = "off" | "light" | "medium" | "strong";
export type HapticKind = "tap" | "tick" | "medium" | "heavy";

export const HAPTIC_LEVELS: readonly HapticLevel[] = ["off", "light", "medium", "strong"];

const PROFILES: Record<Exclude<HapticLevel, "off">, Record<HapticKind, readonly [number, number]>> = {
  light: { tap: [8, 52], tick: [6, 40], medium: [12, 78], heavy: [16, 96] },
  medium: { tap: [12, 128], tick: [9, 105], medium: [18, 170], heavy: [22, 200] },
  strong: { tap: [18, 220], tick: [13, 185], medium: [26, 255], heavy: [32, 255] },
};

const BUTTON_SELECTOR =
  'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), [role="switch"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"]), [role="tab"]:not([aria-disabled="true"]), summary';
const SKIP_SELECTOR = ".ios-overlay-backdrop, [data-no-haptic], [data-card]";
const SCROLL_SKIP_SELECTOR = "[data-no-haptic], .snap-mandatory";
const MOVEMENT_SLOP_PX = 10;
const SCROLL_TICK_STEP_PX = 72;
const SCROLL_TICK_MIN_MS = 65;
const SCROLL_IDLE_RESET_MS = 220;
const SCROLL_JUMP_LIMIT_PX = 450;
const SCROLL_TOUCH_WINDOW_MS = 2400;

declare global {
  interface Window {
    __HG_HAPTIC__?: { vibrate?: (durationMs: number, amplitude: number) => void };
  }
}

function readLevel(): HapticLevel {
  const saved = readStorage(STORAGE_KEYS.haptic);
  if (saved === "off" || saved === "light" || saved === "medium" || saved === "strong") return saved;
  return "medium";
}

let currentLevel: HapticLevel = readLevel();
const listeners = new Set<() => void>();
let lastHapticAt = 0;

function emit() {
  listeners.forEach((fn) => fn());
}

export function getHapticLevel(): HapticLevel {
  return currentLevel;
}

export function setHapticLevel(level: HapticLevel): void {
  if (!HAPTIC_LEVELS.includes(level)) return;
  currentLevel = level;
  try {
    localStorage.setItem(STORAGE_KEYS.haptic, level);
  } catch { /* storage can be unavailable */ }
  emit();
}

export function useHapticLevel(): HapticLevel {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    () => currentLevel,
    () => currentLevel,
  );
}

/** Fire a mobile haptic pulse scaled by the user's configured intensity level. */
export function triggerHaptic(kind: HapticKind = "tap", overrideLevel?: HapticLevel): void {
  if (!isMobile) return;
  const level = overrideLevel ?? currentLevel;
  if (level === "off") return;
  const now = Date.now();
  if (!overrideLevel && now - lastHapticAt < 28) return;
  lastHapticAt = now;
  const [ms, amp] = PROFILES[level][kind];
  try {
    const bridge = typeof window !== "undefined" ? window.__HG_HAPTIC__ : undefined;
    if (bridge && typeof bridge.vibrate === "function") {
      bridge.vibrate(ms, amp);
      return;
    }
    navigator.vibrate?.(ms);
  } catch { /* ignore */ }
}

/** Attach passive capture listeners for completed mobile button taps and scroll detent ticks. */
export function initMobileHaptics(): () => void {
  if (!isMobile || typeof document === "undefined") return () => {};
  let pending: { control: Element; pointerId: number; x: number; y: number } | null = null;
  let touchActive = false;
  let lastUserTouchAt = 0;
  const scrollStates = new WeakMap<Element, { x: number; y: number; accum: number; lastAt: number; lastTickAt: number }>();

  const controlAt = (target: EventTarget | null): Element | null => {
    if (!(target instanceof Element)) return null;
    const control = target.closest(BUTTON_SELECTOR);
    return control && !control.closest(SKIP_SELECTOR) ? control : null;
  };
  const onDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") lastUserTouchAt = Date.now();
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (currentLevel === "off") return;
    const control = controlAt(event.target);
    if (!control) return;
    /* Defer tap pulse until pointerup so a scroll starting on a button uses scroll ticks instead of tap. */
    pending = { control, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") lastUserTouchAt = Date.now();
    if (!pending || event.pointerId !== pending.pointerId) return;
    if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVEMENT_SLOP_PX) pending = null;
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") lastUserTouchAt = Date.now();
    if (!pending || event.pointerId !== pending.pointerId) return;
    const withinSlop = Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= MOVEMENT_SLOP_PX;
    const sameControl = controlAt(event.target) === pending.control;
    pending = null;
    if (!withinSlop || !sameControl || currentLevel === "off") return;
    triggerHaptic("tap");
  };
  const onCancel = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") lastUserTouchAt = Date.now();
    if (pending && event.pointerId === pending.pointerId) pending = null;
  };
  const onTouchActivity = (event: TouchEvent) => {
    touchActive = event.touches.length > 0;
    lastUserTouchAt = Date.now();
  };
  const onScroll = (event: Event) => {
    if (currentLevel === "off") return;
    const rawTarget = event.target;
    const scrollEl = rawTarget === document || rawTarget === document.documentElement || rawTarget === document.body
      ? (document.scrollingElement ?? document.documentElement)
      : rawTarget instanceof Element ? rawTarget : null;
    if (!scrollEl || scrollEl.closest(SCROLL_SKIP_SELECTOR)) return;
    const now = Date.now();
    const x = scrollEl.scrollLeft;
    const y = scrollEl.scrollTop;
    const state = scrollStates.get(scrollEl);
    if (!state) {
      scrollStates.set(scrollEl, { x, y, accum: 0, lastAt: now, lastTickAt: 0 });
      return;
    }
    const step = Math.hypot(x - state.x, y - state.y);
    state.x = x;
    state.y = y;
    if (!touchActive && now - lastUserTouchAt > SCROLL_TOUCH_WINDOW_MS) {
      state.accum = 0;
      state.lastAt = now;
      return;
    }
    if (step < 0.5 || step > SCROLL_JUMP_LIMIT_PX) {
      state.accum = 0;
      state.lastAt = now;
      return;
    }
    if (now - state.lastAt > SCROLL_IDLE_RESET_MS) state.accum = 0;
    state.lastAt = now;
    state.accum += step;
    if (state.accum >= SCROLL_TICK_STEP_PX) {
      state.accum %= SCROLL_TICK_STEP_PX;
      if (now - state.lastTickAt >= SCROLL_TICK_MIN_MS) {
        state.lastTickAt = now;
        triggerHaptic("tick");
      }
    }
  };

  document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  document.addEventListener("pointermove", onMove, { capture: true, passive: true });
  document.addEventListener("pointerup", onUp, { capture: true, passive: true });
  document.addEventListener("pointercancel", onCancel, { capture: true, passive: true });
  document.addEventListener("touchstart", onTouchActivity, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchActivity, { capture: true, passive: true });
  document.addEventListener("touchend", onTouchActivity, { capture: true, passive: true });
  document.addEventListener("touchcancel", onTouchActivity, { capture: true, passive: true });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onCancel, true);
    document.removeEventListener("touchstart", onTouchActivity, true);
    document.removeEventListener("touchmove", onTouchActivity, true);
    document.removeEventListener("touchend", onTouchActivity, true);
    document.removeEventListener("touchcancel", onTouchActivity, true);
    document.removeEventListener("scroll", onScroll, true);
  };
}
