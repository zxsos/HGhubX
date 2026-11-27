import { api } from "../../shared/api/api";
import type { TagGroup, TagItem } from "../../shared/api/types";
import { STORAGE_KEYS } from "../../shared/storage/storage";

const PROBE_CONCURRENCY = 6;
const UNIMPLEMENTED_RE = /未实现|unimplemented|not implemented/i;

type StoredRead =
  | { status: "hit"; categories: TagGroup[] }
  | { status: "miss" }
  | { status: "corrupt" };

let memoryPromise: { key: string; promise: Promise<TagGroup[]> } | null = null;
let memoryEntry: { key: string; categories: TagGroup[] } | null = null;
let latestRequestId = 0;

function isValidTagItem(value: unknown): value is TagItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "number"
    && Number.isFinite(item.id)
    && typeof item.name === "string"
    && item.name.trim().length > 0;
}

function normalizeTagGroups(raw: unknown): TagGroup[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TagGroup[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const group = entry as Record<string, unknown>;
    if (typeof group.name !== "string" || !Array.isArray(group.tags)) return null;
    const tags = group.tags.filter(isValidTagItem);
    if (tags.length > 0) out.push({ name: group.name, tags });
  }
  return out;
}

function readStored(cacheKey: string): StoredRead {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.tagsCache);
    if (raw === null) return { status: "miss" };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "corrupt" };
    const record = parsed as Record<string, unknown>;
    if (typeof record.key !== "string" || !Array.isArray(record.categories)) return { status: "corrupt" };
    const categories = normalizeTagGroups(record.categories);
    if (!categories) return { status: "corrupt" };
    if (record.key !== cacheKey) return { status: "miss" };
    return { status: "hit", categories };
  } catch {
    return { status: "corrupt" };
  }
}

function writeStored(cacheKey: string, categories: TagGroup[]): void {
  try {
    /* 若本地已存有不可解析内容，按规范保留原值不覆盖 */
    if (readStored(cacheKey).status === "corrupt") return;
    localStorage.setItem(STORAGE_KEYS.tagsCache, JSON.stringify({ key: cacheKey, categories }));
  } catch {
    /* 存储不可用或配额不足时保留内存结果 */
  }
}

function extractTotal(res: { items?: unknown[]; pagination?: { total?: number } } | null | undefined): number {
  const itemsLen = Array.isArray(res?.items) ? res.items.length : 0;
  const total = res?.pagination?.total;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    return Math.max(Math.floor(total), itemsLen);
  }
  return itemsLen;
}

function isUnimplemented(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return UNIMPLEMENTED_RE.test(message);
}

async function fetchRawTagGroups(fallbackLabel: string): Promise<TagGroup[]> {
  try {
    const data = await api.tags();
    return data?.categories ?? [];
  } catch (error) {
    if (isUnimplemented(error)) {
      const hot = await api.hotTags();
      return hot?.items?.length
        ? [{
            name: fallbackLabel,
            tags: hot.items.map((item, idx) => ({ id: idx + 1, name: item.name, slug: item.slug })),
          }]
        : [];
    }
    throw error;
  }
}

async function filterNonEmptyGroups(
  groups: TagGroup[],
  postsEnabled: boolean,
  requestId: number,
): Promise<{ categories: TagGroup[]; complete: boolean }> {
  const uniqueTags = new Map<string, TagItem>();
  for (const group of groups) {
    for (const tag of group.tags ?? []) {
      if (!uniqueTags.has(tag.name)) uniqueTags.set(tag.name, tag);
    }
  }

  const keepMap = new Map<string, boolean>();
  const toProbe: TagItem[] = [];
  for (const [name, tag] of uniqueTags.entries()) {
    const knownCount = typeof tag.video_count === "number" && Number.isFinite(tag.video_count) && tag.video_count >= 0
      ? tag.video_count
      : null;
    if (knownCount !== null && knownCount > 0) {
      keepMap.set(name, true);
    } else if (knownCount === 0 && !postsEnabled) {
      keepMap.set(name, false);
    } else {
      toProbe.push(tag);
    }
  }

  let complete = true;
  let tagVideosUnsupported = false;
  let postTagUnsupported = false;
  let cursor = 0;

  const probeOne = async (tag: TagItem): Promise<void> => {
    const knownZeroVideo = typeof tag.video_count === "number" && Number.isFinite(tag.video_count) && tag.video_count === 0;
    let videoCount: number | null = knownZeroVideo ? 0 : null;

    if (videoCount === null) {
      if (tagVideosUnsupported) {
        keepMap.set(tag.name, true);
        complete = false;
        return;
      }
      try {
        const res = await api.tagVideos(tag.name, 1, 1);
        videoCount = extractTotal(res);
      } catch (error) {
        if (isUnimplemented(error)) tagVideosUnsupported = true;
        // 未知不是空：探测失败保留该标签，并标记本轮扫描不完整。
        keepMap.set(tag.name, true);
        complete = false;
        return;
      }
    }

    if (videoCount > 0) {
      keepMap.set(tag.name, true);
      return;
    }

    if (!postsEnabled) {
      keepMap.set(tag.name, false);
      return;
    }

    if (postTagUnsupported) {
      keepMap.set(tag.name, true);
      complete = false;
      return;
    }

    try {
      const postRes = await api.postTag(tag.name, 1, 1);
      keepMap.set(tag.name, extractTotal(postRes) > 0);
    } catch (error) {
      if (isUnimplemented(error)) postTagUnsupported = true;
      keepMap.set(tag.name, true);
      complete = false;
    }
  };

  const worker = async () => {
    while (true) {
      if (requestId !== latestRequestId) return;
      const idx = cursor++;
      if (idx >= toProbe.length) return;
      await probeOne(toProbe[idx]);
    }
  };

  if (toProbe.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, toProbe.length) }, () => worker()),
    );
  }

  const categories: TagGroup[] = [];
  for (const group of groups) {
    const visibleTags = (group.tags ?? []).filter((tag) => keepMap.get(tag.name) !== false);
    if (visibleTags.length > 0) {
      categories.push({ ...group, tags: visibleTags });
    }
  }
  return { categories, complete };
}

/** Synchronously read an already-verified tag directory from memory or localStorage. */
export function peekTagDirectory(cacheKey: string): TagGroup[] | null {
  if (memoryEntry?.key === cacheKey) return memoryEntry.categories;
  const stored = readStored(cacheKey);
  if (stored.status === "hit") {
    memoryEntry = { key: cacheKey, categories: stored.categories };
    return stored.categories;
  }
  return null;
}

/**
 * Load and filter the tag directory once per source/line scope, caching the
 * non-empty result in localStorage (mirroring authorDirectory). Only an
 * explicit refresh bypasses the cache and re-probes every tag.
 */
export function loadTagDirectory(
  cacheKey: string,
  options: { force?: boolean; postsEnabled: boolean; fallbackLabel: string },
): Promise<TagGroup[]> {
  const force = Boolean(options.force);
  if (!force) {
    if (memoryEntry?.key === cacheKey) return Promise.resolve(memoryEntry.categories);
    if (memoryPromise?.key === cacheKey) return memoryPromise.promise;
    const stored = readStored(cacheKey);
    if (stored.status === "hit") {
      memoryEntry = { key: cacheKey, categories: stored.categories };
      return Promise.resolve(stored.categories);
    }
  }

  const requestId = ++latestRequestId;
  const promise = (async () => {
    const rawGroups = await fetchRawTagGroups(options.fallbackLabel);
    if (requestId !== latestRequestId) return rawGroups;
    const { categories, complete } = await filterNonEmptyGroups(rawGroups, options.postsEnabled, requestId);
    if (requestId === latestRequestId) {
      memoryEntry = { key: cacheKey, categories };
      if (complete) writeStored(cacheKey, categories);
    }
    return categories;
  })();

  memoryPromise = { key: cacheKey, promise };
  promise.finally(() => {
    if (memoryPromise?.promise === promise) memoryPromise = null;
  });
  return promise;
}
