import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Leaving immersive fullscreen from any path (hardware back, Esc, page cover) must restore
    orientation only when fullscreen had programmatically rotated a portrait viewport, while
    playback keepAlive runs whenever the player remains active. */
export function useFsOrientation(
  fs: boolean,
  isDesktop: boolean,
  keepAlive: () => void,
  active = true,
  restoreOrientationRef?: RefObject<boolean>,
) {
  const wasFs = useRef(false);
  useEffect(() => {
    const entered = wasFs.current;
    wasFs.current = fs;
    if (!entered || fs || isDesktop) return;
    if (active) keepAlive();
    const shouldRestore = restoreOrientationRef ? restoreOrientationRef.current : true;
    if (restoreOrientationRef) restoreOrientationRef.current = false;
    if (!shouldRestore) return;
    try { void invoke("set_orientation", { landscape: false }); } catch { /* ignore */ }
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [fs, isDesktop, keepAlive, active, restoreOrientationRef]);
}
