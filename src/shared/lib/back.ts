import { useSyncExternalStore } from "react";
import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 全局返回拦截：面板等临时层优先消费，未消费则走导航栈。 */
type Handler = () => boolean;
export type RegisterStartupBack = (handler: () => void) => () => void;

let handler: Handler | null = null;
const overlays: { handle: Handler; isActive?: () => boolean }[] = [];

// The launch overlay owns back while it covers an already-mounted App: back skips
// the reveal (LaunchAnimation's own listener) and must not navigate beneath it.
// Reference-counted so StrictMode's mount→cleanup→mount keeps the gate held;
// each release closure is idempotent.
let startupHolds = 0;
const consumerListeners = new Set<() => void>();
const notifyConsumers = () => { consumerListeners.forEach((fn) => fn()); };

export function hasActiveBackConsumer(): boolean {
  return startupHolds > 0 || overlays.length > 0 || handler !== null;
}

/** 左缘跟手返回专用：忽略声明自己当前不活跃的临时层（如被上层子页 `inert` 遮住的页内搜索）。 */
export function blocksEdgeSwipeBack(): boolean {
  return startupHolds > 0 || handler !== null || overlays.some((o) => {
    try { return o.isActive ? o.isActive() : true; } catch { return true; }
  });
}

function subscribeBackConsumers(listener: () => void) {
  consumerListeners.add(listener);
  return () => { consumerListeners.delete(listener); };
}

export function useHasBackConsumer(): boolean {
  return useSyncExternalStore(subscribeBackConsumers, hasActiveBackConsumer, () => false);
}

export function holdBackForStartup(): () => void {
  startupHolds += 1;
  notifyConsumers();
  let released = false;
  return () => {
    if (!released) {
      released = true;
      startupHolds = Math.max(0, startupHolds - 1);
      notifyConsumers();
    }
  };
}

/** Dialogs can nest; dismiss the newest overlay before a player panel or page.
 *  `isActive` only affects edge-swipe back; hardware back still asks every overlay via its handler. */
export function registerOverlayBack(h: Handler, isActive?: () => boolean) {
  const entry = { handle: h, isActive };
  overlays.push(entry);
  notifyConsumers();
  return () => {
    const index = overlays.indexOf(entry);
    if (index !== -1) {
      overlays.splice(index, 1);
      notifyConsumers();
    }
  };
}

export function setBackHandler(h: Handler | null) {
  handler = h;
  notifyConsumers();
}

/** 返回 true 表示已被消费（不再退栈） */
export function runBack(): boolean {
  // Startup gate: consume without touching overlays or the page handler, so the
  // App mounted behind the launch overlay stays put until the reveal is done.
  if (startupHolds > 0) return true;
  // A handler can synchronously unregister itself. Snapshot registrations to avoid
  // calling another handler twice or dismissing an overlay opened during this event.
  for (const entry of [...overlays].reverse()) {
    if (!overlays.includes(entry)) continue;
    try {
      if (entry.handle()) return true;
    } catch {
      // A failed dialog close must not navigate away from the page beneath it.
      return true;
    }
  }
  try { return handler ? handler() : false; } catch { return false; }
}

/** 统一订阅系统硬件/手势返回事件（Android `app:back-button` 与 HarmonyOS `hg:ohos-back`）。 */
export function subscribeNativeBack(platform: string, onBack: () => void): () => void {
  let disposed = false;
  if (platform === "android") {
    let handle: { unregister: () => Promise<void> } | null = null;
    addPluginListener("app", "back-button", onBack)
      .then((l) => { if (disposed) l.unregister().catch(() => {}); else handle = l; })
      .catch(() => { /* 非安卓宿主忽略 */ });
    return () => { disposed = true; handle?.unregister().catch(() => {}); };
  }
  if (platform === "harmony") {
    let unlisten: (() => void) | null = null;
    listen("hg:ohos-back", onBack)
      .then((fn) => { if (disposed) fn(); else unlisten = fn; })
      .catch(() => { /* 非鸿蒙宿主忽略 */ });
    return () => { disposed = true; unlisten?.(); };
  }
  return () => {};
}

/** 同步鸿蒙原生 `onBackPress` 是否拦截：存在可消费返回状态时置 true，首页根层级置 false 交回系统。 */
export function syncOhosBackIntercept(platform: string, enabled: boolean): void {
  if (platform !== "harmony") return;
  invoke("set_back_intercept", { enabled }).catch(() => {});
}
