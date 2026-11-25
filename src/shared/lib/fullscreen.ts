import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "../api/api";

type WebkitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function getFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  return document.fullscreenElement ?? (document as WebkitFullscreenDocument).webkitFullscreenElement ?? null;
}

export async function requestElementFullscreen(element: HTMLElement): Promise<void> {
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  const webkitRequest = (element as WebkitFullscreenElement).webkitRequestFullscreen;
  if (typeof webkitRequest === "function") {
    await webkitRequest.call(element);
    return;
  }
  throw new Error("Fullscreen API unavailable");
}

export async function exitDocumentFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  if (typeof document.exitFullscreen === "function") {
    await document.exitFullscreen();
    return;
  }
  const webkitExit = (document as WebkitFullscreenDocument).webkitExitFullscreen;
  if (typeof webkitExit === "function") {
    await webkitExit.call(document);
  }
}

export function onFullscreenChange(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);
  return () => {
    document.removeEventListener("fullscreenchange", listener);
    document.removeEventListener("webkitfullscreenchange", listener);
  };
}

export function setTauriWindowFullscreen(fullscreen: boolean): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  try {
    void getCurrentWindow().setFullscreen(fullscreen).catch(() => {});
  } catch {
    /* Detached or non-window test contexts ignore window fullscreen. */
  }
}

/**
 * Windows WebView2 borderless windows frequently black-screen 16:9 landscape
 * videos under HTML5 Element Fullscreen due to DirectComposition MPO hardware
 * overlay promotion (#270). Prefer native Tauri window fullscreen instead.
 */
export function preferTauriWindowFullscreen(): boolean {
  return platform === "windows" && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
