import { useSyncExternalStore } from "react";

export type PinnedAuthor = { id: number; name: string; followers: number };

export const AUTHOR_PINS_KEY = "hghubx_author_pins_v1";
export const AUTHOR_TOAST_SLOT = "playback-hint";
export const MAX_PINNED_AUTHORS = 24;

const normalizeName = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
const normalizePin = (value: unknown): PinnedAuthor | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PinnedAuthor>;
  const id = Number(item.id);
  const name = normalizeName(item.name);
  if (!Number.isSafeInteger(id) || id <= 0 || !name) return null;
  const followers = Number(item.followers);
  return { id, name, followers: Number.isFinite(followers) && followers > 0 ? Math.floor(followers) : 0 };
};
function readPins(): PinnedAuthor[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTHOR_PINS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const seen = new Set<number>();
    const result: PinnedAuthor[] = [];
    for (const value of raw) {
      const pin = normalizePin(value);
      if (!pin || seen.has(pin.id)) continue;
      seen.add(pin.id); result.push(pin);
      if (result.length >= MAX_PINNED_AUTHORS) break;
    }
    return result;
  } catch { return []; }
}

let pins = readPins();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const same = (a: PinnedAuthor[], b: PinnedAuthor[]) => JSON.stringify(a) === JSON.stringify(b);
function persist(next: PinnedAuthor[]) {
  if (same(pins, next)) return;
  pins = next;
  try { localStorage.setItem(AUTHOR_PINS_KEY, JSON.stringify(next)); } catch { /* keep in-memory pins */ }
  emit();
}
function onStorage(event: StorageEvent) {
  if (event.key !== AUTHOR_PINS_KEY && event.key !== null) return;
  const next = readPins();
  if (same(pins, next)) return;
  pins = next; emit();
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
const getSnapshot = () => pins;
const actions = {
  togglePinnedAuthor(author: PinnedAuthor) {
    const pin = normalizePin(author);
    if (!pin) return;
    const exists = pins.some(item => item.id === pin.id);
    persist(exists
      ? pins.filter(item => item.id !== pin.id)
      : [pin, ...pins].slice(0, MAX_PINNED_AUTHORS));
  },
  isAuthorPinned(id: number) { return pins.some(item => item.id === id); },
};
export function useAuthorPins() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { pinnedAuthors: current, ...actions };
}
