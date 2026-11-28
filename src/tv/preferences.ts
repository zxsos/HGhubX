import { useSyncExternalStore } from "react";
type PlaybackPreferences = { rate: number; quality: "main" | "hevc"; autoplayNext: boolean; skipIntroSecs: number; skipOutroSecs: number };
const KEY = "hghubx_tv_playback_v1";
const LEGACY_KEY = "hghubx-tv-playback-v1";
function clampSkipSecs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(600, Math.round(n)) : 0;
}
function read(): PlaybackPreferences {
  try {
    let raw = localStorage.getItem(KEY);
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        raw = legacy;
        try {
          localStorage.setItem(KEY, legacy);
          if (localStorage.getItem(KEY) === legacy) localStorage.removeItem(LEGACY_KEY);
        } catch { /* retain legacy on write failure */ }
      }
    } else {
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
    }
    const value = JSON.parse(raw || "{}");
    return {
      rate: [0.75, 1, 1.25, 1.5, 2].includes(value.rate) ? value.rate : 1,
      quality: value.quality === "main" ? "main" : "hevc",
      autoplayNext: value.autoplayNext !== false,
      skipIntroSecs: clampSkipSecs(value.skipIntroSecs),
      skipOutroSecs: clampSkipSecs(value.skipOutroSecs),
    };
  }
  catch { return { rate: 1, quality: "hevc", autoplayNext: true, skipIntroSecs: 0, skipOutroSecs: 0 }; }
}
let state = read();
const listeners = new Set<() => void>();
export function setPlaybackPreferences(value: Partial<PlaybackPreferences>) {
  const next = { ...state, ...value };
  next.skipIntroSecs = clampSkipSecs(next.skipIntroSecs);
  next.skipOutroSecs = clampSkipSecs(next.skipOutroSecs);
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } finally { listeners.forEach(fn => fn()); }
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const usePlaybackPreferences = () => useSyncExternalStore(subscribe, () => state);
