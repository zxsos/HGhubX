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

/** Attach one click listener so only completed activations vibrate; scroll and drag never synthesize a click. */
export function initMobileHaptics(): () => void {
  if (!isMobile || typeof document === "undefined") return () => {};
  const controlAt = (target: EventTarget | null): Element | null => {
    if (!(target instanceof Element)) return null;
    const control = target.closest(BUTTON_SELECTOR);
    return control && !control.closest(SKIP_SELECTOR) ? control : null;
  };
  const onClick = (event: MouseEvent) => {
    if (currentLevel === "off") return;
    if (!controlAt(event.target)) return;
    triggerHaptic("tap");
  };
  /* Bubble phase: handlers that suppress a drag's synthetic click (tab bar, tab swipe)
     stop propagation before it reaches document, so only real taps vibrate. */
  document.addEventListener("click", onClick, { passive: true });
  return () => document.removeEventListener("click", onClick);
}
