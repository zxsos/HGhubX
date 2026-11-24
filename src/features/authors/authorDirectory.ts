import { api } from "../../shared/api/api";
import type { UserProfile, VideoCard } from "../../shared/api/types";

export type AuthorItem = { id: number; name: string; followers: number; avatar?: string };

const CACHE_TTL_MS = 5 * 60_000;
const FALLBACK_PAGES = 6;
const FALLBACK_PAGE_SIZE = 50;
let cache: { epoch: number; at: number; promise: Promise<AuthorItem[]> } | null = null;

const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};
export const asAuthor = (value: unknown): AuthorItem | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<UserProfile> & { name?: unknown; followers?: unknown; counts?: Record<string, unknown> };
  const id = positiveId(item.id);
  const name = typeof item.nickname === "string" ? item.nickname.trim()
    : typeof item.name === "string" ? item.name.trim()
      : typeof item.username === "string" ? item.username.trim() : "";
  if (!id || !name) return null;
  const followers = Number(item.followers ?? item.counts?.followers);
  return { id, name, avatar: typeof item.avatar === "string" ? item.avatar : undefined, followers: Number.isFinite(followers) && followers > 0 ? Math.floor(followers) : 0 };
};
const sortAuthors = (items: AuthorItem[]) => items.sort((a, b) => b.followers - a.followers || a.name.localeCompare(b.name, "zh-CN"));
const merge = (target: Map<number, AuthorItem>, items: AuthorItem[]) => {
  for (const item of items) {
    const previous = target.get(item.id);
    if (!previous || item.followers > previous.followers) target.set(item.id, item);
  }
};

async function fromUserDirectory(): Promise<AuthorItem[]> {
  const result = new Map<number, AuthorItem>();
  let page = 1;
  let pages = 1;
  do {
    const response = await api.popularAuthors(page);
    const items = Array.isArray(response?.items) ? response.items.map(asAuthor).filter((item): item is AuthorItem => !!item) : [];
    merge(result, items);
    pages = Math.min(Number(response?.pagination?.pages) || 1, 5);
    page += 1;
  } while (page <= pages && result.size < 200);
  return [...result.values()];
}

async function fromVideoFeed(): Promise<AuthorItem[]> {
  const result = new Map<number, AuthorItem>();
  for (let page = 1; page <= FALLBACK_PAGES; page += 1) {
    const response = await api.feed(page, FALLBACK_PAGE_SIZE);
    const cards = Array.isArray(response?.items) ? response.items : [];
    const authors: AuthorItem[] = [];
    for (const card of cards as VideoCard[]) {
      const author = card.author;
      const id = positiveId(author?.id);
      const name = typeof author?.name === "string" ? author.name.trim() : "";
      if (!id || !name) continue;
      const followers = Number(author?.followers);
      authors.push({ id, name, avatar: author?.avatar, followers: Number.isFinite(followers) && followers > 0 ? Math.floor(followers) : 0 });
    }
    merge(result, authors);
  }
  return [...result.values()];
}

async function load(): Promise<AuthorItem[]> {
  const found = new Map<number, AuthorItem>();
  try {
    merge(found, await fromUserDirectory());
  } catch { /* Fall back to the public feed when the directory route is unavailable. */ }
  if (found.size < 12) {
    try { merge(found, await fromVideoFeed()); } catch { /* Keep whatever the directory returned. */ }
  }
  return sortAuthors([...found.values()]);
}

/** Load the author directory once per line and reuse it across search and the all-authors page. */
export function loadAuthors(epoch: number, force = false): Promise<AuthorItem[]> {
  if (!force && cache && cache.epoch === epoch && Date.now() - cache.at < CACHE_TTL_MS) return cache.promise;
  const promise = load();
  cache = { epoch, at: Date.now(), promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}
