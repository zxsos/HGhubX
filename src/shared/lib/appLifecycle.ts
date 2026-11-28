import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "../api/api";

declare global {
  interface Window {
    __HG_ANDROID__?: { moveToBackground?: () => boolean };
  }
}

/**
 * Exit the app or, on Android, move the task to background.
 *
 * Calling `plugin:app|exit` on Android invokes `Activity.finishAffinity()`. If the user
 * reopens the app before Android finishes destroying the previous `MainActivity`, the old
 * instance's delayed `onDestroy()` terminates tao's event loop and executes
 * `std::process::exit(0)`, killing the freshly launched foreground Activity.
 */
export function exitApp(): Promise<void> {
  if (isAndroid && typeof window !== "undefined") {
    const moveToBackground = window.__HG_ANDROID__?.moveToBackground;
    if (typeof moveToBackground === "function") {
      try {
        if (moveToBackground() !== false) return Promise.resolve();
      } catch { /* fall through to Tauri exit */ }
    }
  }
  return invoke("plugin:app|exit", { code: 0 }).then(() => undefined);
}
