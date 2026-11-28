import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";

/** Keep asynchronous autoplay and error recovery subject to the latest page activity. */
export function usePlaybackActivity(
  videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  { active, autoPlay, src, trace }: { active: boolean; autoPlay: boolean; src: string; trace: (event: string, data?: Record<string, unknown>) => void },
) {
  const [docHidden, setDocHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const effectiveActive = active && !docHidden;
  const latest = useRef({ active: effectiveActive, propActive: active, trace });
  latest.current = { active: effectiveActive, propActive: active, trace };
  const wanted = useRef(autoPlay);
  const mounted = useRef(true);
  const previous = useRef(effectiveActive);
  const suspendedByHidden = useRef(false);
  useLayoutEffect(() => { wanted.current = autoPlay; }, [src, autoPlay]);

  const inPip = (v: HTMLVideoElement | null) => typeof document !== "undefined" && !!v && document.pictureInPictureElement === v;

  const suspend = useCallback((source?: string, syncWantedFromElement = true) => {
    const v = videoRef.current;
    if (!v || inPip(v)) return false;
    if (syncWantedFromElement && v.readyState >= 2) wanted.current = !v.paused;
    v.pause();
    const hls = hlsRef.current;
    // Let an in-flight manifest finish, but stop fragment loading for hidden pages.
    if (hls?.levels.length) hls.stopLoad();
    latest.current.trace("page.suspended", source ? { play_wanted: wanted.current, source } : { play_wanted: wanted.current });
    return true;
  }, [videoRef, hlsRef]);

  const play = useCallback((source: string, automatic = false) => {
    const v = videoRef.current;
    if (!v) return;
    if (!mounted.current || (!latest.current.active && !inPip(v)) || (automatic && !wanted.current)) {
      latest.current.trace("play.blocked", { source, inactive: !latest.current.active, play_wanted: wanted.current });
      return;
    }
    wanted.current = true;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) {
      const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
      hls.startLoad(target);
    }
    latest.current.trace("play.request", { source });
    v.play().then(() => {
      // The page may have changed while play() was pending.
      if (!mounted.current || (!latest.current.active && !inPip(v))) v.pause();
    }).catch(e => latest.current.trace("play.rejected", { source, error_name: e?.name }));
  }, [videoRef, hlsRef]);

  const resume = useCallback((source: string) => {
    const v = videoRef.current;
    if (!v) return;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) {
      const target = v.currentTime > 0 ? v.currentTime : (hls.config.startPosition >= 0 ? hls.config.startPosition : -1);
      hls.startLoad(target);
    }
    if (wanted.current && (hls?.levels.length || v.readyState > 0)) play(source, true);
  }, [play, videoRef, hlsRef]);

  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    latest.current.trace("pause.request", { source });
    videoRef.current?.pause();
  }, [videoRef]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      const hidden = document.hidden;
      if (hidden) {
        latest.current.active = false;
        if (previous.current) {
          previous.current = false;
          // Pause and halt HLS segment downloads synchronously before the OS freezes WebView JS.
          // Do not overwrite wanted from v.paused here because mobile WebView may have already
          // paused the media element natively right before dispatching visibilitychange.
          if (suspend("page_hidden", false)) suspendedByHidden.current = true;
        }
        setDocHidden(true);
        return;
      }
      const nextActive = latest.current.propActive;
      latest.current.active = nextActive;
      if (suspendedByHidden.current) {
        suspendedByHidden.current = false;
        if (nextActive) {
          previous.current = true;
          resume("page_visible");
        }
      }
      setDocHidden(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [suspend, resume]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    mounted.current = true;
    if (!effectiveActive) {
      if (suspendedByHidden.current) {
        suspendedByHidden.current = false;
        previous.current = false;
        return;
      }
      // Keep Picture-in-Picture playing across tab/page navigation until PiP exits.
      if (inPip(v)) {
        previous.current = effectiveActive;
        return;
      }
      // Include pauses made through native/PiP controls, which bypass our buttons.
      suspend(undefined, !docHidden);
    } else if (!previous.current) {
      resume("page_active");
    }
    previous.current = effectiveActive;
  }, [effectiveActive, docHidden, suspend, resume, videoRef]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      if (latest.current.active || inPip(v)) return;
      latest.current.trace("play.blocked", { source: "media_event", inactive: true });
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    const onLeavePip = () => {
      if (latest.current.active) return;
      wanted.current = !v.paused;
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current, source: "pip_exit" });
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    v.addEventListener("leavepictureinpicture", onLeavePip);
    return () => {
      mounted.current = false;
      v.removeEventListener("play", guard);
      v.removeEventListener("playing", guard);
      v.removeEventListener("leavepictureinpicture", onLeavePip);
      v.pause();
    };
  }, [videoRef, hlsRef]);

  return {
    active: effectiveActive,
    play,
    pause,
    setPlayWanted: (on: boolean) => { wanted.current = on; },
    isActive: () => mounted.current && (latest.current.active || inPip(videoRef.current)),
    isPlayWanted: () => wanted.current,
  };
}
