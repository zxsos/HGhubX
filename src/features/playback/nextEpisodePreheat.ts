import { useEffect, useRef } from "react";
import { LOCAL } from "../../shared/api/api";
import { playbackSource } from "./mediaTransport";
import type { PlaybackClock } from "./playbackClock";

/** Lead window before episode end to warm the next episode's HLS playlist, key, init map, and first segment. */
export const PREHEAT_LEAD_SECONDS = 18;
const MAX_ATTEMPTED_KEYS = 24;

export function shouldPreheatNext(time: number, duration: number): boolean {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || time <= 0) return false;
  const remaining = duration - time;
  if (remaining <= 0) return false;
  return remaining <= Math.min(PREHEAT_LEAD_SECONDS, duration * 0.5);
}

function isAllowedLocalMediaUrl(candidate: string, localOrigin: string): boolean {
  return candidate.startsWith(`${localOrigin}/seg?`) || candidate.startsWith(`${localOrigin}/hls?`);
}

function extractQuotedUri(line: string): string | null {
  const match = /\bURI="([^"]+)"/i.exec(line);
  return match?.[1]?.trim() || null;
}

export function extractHlsPreheatTargets(
  playlistText: string,
  localOrigin: string = LOCAL,
): { variantUrl?: string; assetUrls: string[] } {
  const lines = playlistText.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith("#EXTM3U")) return { assetUrls: [] };

  let sawStreamInf = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      sawStreamInf = true;
      continue;
    }
    if (sawStreamInf && !line.startsWith("#")) {
      return isAllowedLocalMediaUrl(line, localOrigin) ? { variantUrl: line, assetUrls: [] } : { assetUrls: [] };
    }
  }

  const assets: string[] = [];
  const pushUnique = (candidate: string | null) => {
    if (candidate && isAllowedLocalMediaUrl(candidate, localOrigin) && !assets.includes(candidate)) {
      assets.push(candidate);
    }
  };

  let gotKey = false;
  let gotMap = false;
  let gotSeg = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:")) {
      if (!gotKey && !/\bMETHOD=NONE\b/i.test(line)) {
        pushUnique(extractQuotedUri(line));
        gotKey = true;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      if (!gotMap) {
        pushUnique(extractQuotedUri(line));
        gotMap = true;
      }
      continue;
    }
    if (!line.startsWith("#") && !gotSeg) {
      pushUnique(line);
      gotSeg = true;
      break;
    }
  }
  return { assetUrls: assets };
}

/**
 * Best-effort warm-up of the next episode's HLS playlist, AES key, init map, and first segment
 * through the local Rust media proxy cache (`PL_CACHE` / `KEY_CACHE` / `SEG_CACHE`).
 * Never fetches non-local URLs and skips direct `/seg` MP4 pass-through sources.
 */
export async function preheatHlsStart(rawUrl: string, signal: AbortSignal): Promise<boolean> {
  if (!rawUrl || signal.aborted) return false;
  const source = playbackSource(rawUrl, true);
  if (!source.route.startsWith("/hls") || !source.url.startsWith(`${LOCAL}/`)) return false;

  try {
    const playlistResp = await fetch(source.url, { signal });
    if (!playlistResp.ok || signal.aborted) return false;
    const text = await playlistResp.text();
    if (signal.aborted) return false;

    let { variantUrl, assetUrls } = extractHlsPreheatTargets(text, LOCAL);
    if (variantUrl) {
      const variantResp = await fetch(variantUrl, { signal });
      if (!variantResp.ok || signal.aborted) return false;
      const variantText = await variantResp.text();
      if (signal.aborted) return false;
      assetUrls = extractHlsPreheatTargets(variantText, LOCAL).assetUrls;
    }

    for (const assetUrl of assetUrls) {
      if (signal.aborted) return false;
      const resp = await fetch(assetUrl, { signal });
      if (!resp.ok || signal.aborted) return false;
      await resp.arrayBuffer();
    }
    return assetUrls.length > 0;
  } catch {
    return false;
  }
}

export function rememberAttemptedKey(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  if (set.size >= MAX_ATTEMPTED_KEYS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
  return true;
}

export function useNextEpisodePreheat(opts: {
  enabled: boolean;
  clock: PlaybackClock;
  duration: number;
  nextUrl: string;
  scopeKey: string;
}) {
  const { enabled, clock, duration, nextUrl, scopeKey } = opts;
  const attemptedRef = useRef(new Set<string>());
  const flightRef = useRef<{ key: string; controller: AbortController } | null>(null);

  useEffect(() => {
    const cancelFlight = () => {
      if (flightRef.current) {
        flightRef.current.controller.abort();
        flightRef.current = null;
      }
    };
    if (!enabled || !nextUrl || duration <= 0) {
      cancelFlight();
      return;
    }

    const key = `${scopeKey}|${nextUrl}`;
    const check = () => {
      if (document.hidden || !shouldPreheatNext(clock.getSnapshot(), duration)) return;
      if (flightRef.current?.key === key || attemptedRef.current.has(key)) return;
      cancelFlight();
      const controller = new AbortController();
      flightRef.current = { key, controller };
      void preheatHlsStart(nextUrl, controller.signal).finally(() => {
        if (flightRef.current?.controller === controller) flightRef.current = null;
        if (!controller.signal.aborted) rememberAttemptedKey(attemptedRef.current, key);
      });
    };

    check();
    const unsub = clock.subscribe(check);
    return () => {
      unsub();
      if (flightRef.current?.key === key) cancelFlight();
    };
  }, [enabled, clock, duration, nextUrl, scopeKey]);
}
