import { api } from "../../shared/api/api";
import type { VideoCard } from "../../shared/api/types";

export type AuthorItem = {
  id: number;
  name: string;
  followers: number;
  followersKnown?: boolean;
  avatar?: string;
};
export type AuthorDirectory = { items: AuthorItem[]; total: number };

export const MAX_FOLLOWED_AUTHORS = 24;

const STORAGE_KEY = "hghubx_authors_cache_v1";
const FEED_PAGE_SIZE = 100;
const MAX_FEED_PAGES = 60;
const FOLLOWER_LOOKUP_LIMIT = 100;
const FOLLOWER_LOOKUP_CONCURRENCY = 6;

let cache: { epoch: number; promise: Promise<AuthorDirectory> } | null = null;
let cachedDirectory: AuthorDirectory | null = null;
const listeners = new Set<(directory: AuthorDirectory) => void>();

const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

const countValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)(万|亿)?$/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale = match[2] === "亿" ? 100_000_000 : match[2] === "万" ? 10_000 : 1;
  return Math.floor(base * scale);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? value as Record<string, unknown> : null;

export const asAuthor = (value: unknown): AuthorItem | null => {
  const item = asRecord(value);
  if (!item) return null;
  const counts = asRecord(item.counts);
  const id = positiveId(item.id ?? item.user_id);
  const name = [item.nickname, item.name, item.username]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    ?.trim() ?? "";
  if (!id || !name) return null;
  const followers = countValue(
    item.followers ?? item.follower_count ?? item.followers_count ?? item.fans ?? item.fans_count
      ?? counts?.followers ?? counts?.follower_count ?? counts?.followers_count ?? counts?.fans,
  );
  return {
    id,
    name,
    avatar: typeof item.avatar === "string" ? item.avatar : undefined,
    followers: followers ?? 0,
    followersKnown: followers !== null,
  };
};

const merge = (target: Map<number, AuthorItem>, items: AuthorItem[]) => {
  for (const item of items) {
    const previous = target.get(item.id);
    if (!previous
      || (item.followersKnown && !previous.followersKnown)
      || (item.followersKnown === previous.followersKnown && item.followers > previous.followers)) {
      target.set(item.id, item);
    }
  }
};

const sortAuthors = (items: AuthorItem[]) => {
  const known = items.filter(item => item.followersKnown).length;
  // Without follower data, keep the directory's own order: the API already sorted by followers.
  if (!known) return items;
  return items.slice().sort((a, b) => {
    if (a.followersKnown && b.followersKnown) {
      return b.followers - a.followers || a.name.localeCompare(b.name, "zh-CN");
    }
    if (a.followersKnown) return -1;
    if (b.followersKnown) return 1;
    return 0;
  });
};

const pageNumber = (value: unknown): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const pageCount = (pagination: Record<string, unknown> | null): number =>
  pageNumber(pagination?.pages ?? pagination?.total_pages ?? pagination?.page_count ?? pagination?.last_page);

/**
 * The public API has no author collection route; build the directory from the
 * full video feed. The feed exposes at most 100 cards per page and its
 * pagination is authoritative, so walk it to the last page instead of stopping
 * after a fixed number of pages.
 */
async function fromVideoFeed(): Promise<AuthorItem[]> {
  const result = new Map<number, AuthorItem>();
  for (let page = 1; page <= MAX_FEED_PAGES; page += 1) {
    const response = await api.feed(page, FEED_PAGE_SIZE);
    const cards = Array.isArray(response?.items) ? response.items : [];
    if (!cards.length) break;
    merge(result, (cards as VideoCard[])
      .map(card => asAuthor(card.author))
      .filter((item): item is AuthorItem => !!item));
    const pages = pageCount(asRecord(response?.pagination) ?? asRecord((response as unknown as Record<string, unknown>).meta));
    if (pages && page >= pages) break;
  }
  return [...result.values()];
}

async function enrichFollowers(items: AuthorItem[]): Promise<AuthorItem[]> {
  const missing = items.filter(item => !item.followersKnown).slice(0, FOLLOWER_LOOKUP_LIMIT);
  if (!missing.length) return items;
  const found = new Map<number, number>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const author = missing[cursor++];
      try {
        const stats = await api.userStats(author.id);
        const followers = countValue(stats?.followers);
        if (followers !== null) found.set(author.id, followers);
      } catch { /* Keep the directory order when a stats lookup fails. */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FOLLOWER_LOOKUP_CONCURRENCY, missing.length) }, worker));
  return items.map(item => {
    const followers = found.get(item.id);
    return followers === undefined ? item : { ...item, followers, followersKnown: true };
  });
}

const readStored = (epoch: number): AuthorDirectory | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as
      { epoch?: unknown; total?: unknown; items?: unknown } | null;
    if (!stored || stored.epoch !== epoch || !Array.isArray(stored.items)) return null;
    const items = stored.items.map(asAuthor).filter((item): item is AuthorItem => !!item);
    if (!items.length) return null;
    return { items: sortAuthors(items), total: Math.max(pageNumber(stored.total), items.length) };
  } catch {
    return null;
  }
};

const writeStored = (epoch: number, directory: AuthorDirectory) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ epoch, ...directory })); } catch { /* Storage may be unavailable. */ }
};

const publish = (directory: AuthorDirectory) => {
  cachedDirectory = directory;
  listeners.forEach(listener => listener(directory));
};

export function subscribeAuthors(listener: (directory: AuthorDirectory) => void) {
  listeners.add(listener);
  if (cachedDirectory) listener(cachedDirectory);
  return () => { listeners.delete(listener); };
}

async function load(epoch: number): Promise<AuthorDirectory> {
  const items = await fromVideoFeed();
  if (!items.length) throw new Error("作者目录加载失败，请重试");
  const enriched = sortAuthors(await enrichFollowers(items));
  const directory = { items: enriched, total: enriched.length };
  writeStored(epoch, directory);
  publish(directory);
  return directory;
}

/**
 * Load the author directory once per line and reuse it across search and the
 * all-authors page. Only an explicit refresh bypasses the cache.
 */
export function loadAuthors(epoch: number, force = false): Promise<AuthorDirectory> {
  if (!force && cache?.epoch === epoch) return cache.promise;
  if (!force) {
    const stored = readStored(epoch);
    if (stored) {
      cachedDirectory = stored;
      cache = { epoch, promise: Promise.resolve(stored) };
      return cache.promise;
    }
  }
  const promise = load(epoch);
  cache = { epoch, promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}
