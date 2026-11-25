import { useEffect, useMemo, useState } from "react";
import { api } from "../../shared/api/api";
import type { TagGroup } from "../../shared/api/types";

const TAG_COUNT_TTL_MS = 10 * 60 * 1000;
const PROBE_CONCURRENCY = 5;

type CacheEntry = { count: number; expiresAt: number };
type TagCountCache = { epoch: number; entries: Map<string, CacheEntry> };

let countCache: TagCountCache = { epoch: -1, entries: new Map() };

function ensureEpochCache(lineEpoch: number): Map<string, CacheEntry> {
  if (countCache.epoch !== lineEpoch) {
    countCache = { epoch: lineEpoch, entries: new Map() };
  }
  return countCache.entries;
}

export function clearTagVideoCountCache(lineEpoch?: number): void {
  if (lineEpoch === undefined || countCache.epoch === lineEpoch) {
    countCache = { epoch: lineEpoch ?? -1, entries: new Map() };
  }
}

/**
 * Filter out tags confirmed to have 0 videos on the All-Tags page (#271).
 * Unknown / failed probes stay visible so transient network errors never hide valid tags.
 */
export function useNonEmptyTags(groups: TagGroup[], lineEpoch: number, refreshNonce: number): TagGroup[] {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!groups.length) return undefined;
    const entries = ensureEpochCache(lineEpoch);
    const now = Date.now();
    const queue: string[] = [];
    const seen = new Set<string>();

    for (const group of groups) {
      for (const tag of group.tags ?? []) {
        if (!tag.name || seen.has(tag.name)) continue;
        seen.add(tag.name);
        if (typeof tag.video_count === "number" && Number.isFinite(tag.video_count) && tag.video_count >= 0) {
          continue;
        }
        const cached = entries.get(tag.name);
        if (cached && cached.expiresAt > now) continue;
        queue.push(tag.name);
      }
    }

    if (!queue.length) return undefined;

    let cancelled = false;
    let cursor = 0;
    let pendingFlush = false;

    const flush = () => {
      if (cancelled || pendingFlush) return;
      pendingFlush = true;
      queueMicrotask(() => {
        pendingFlush = false;
        if (!cancelled) setVersion((v) => v + 1);
      });
    };

    const worker = async () => {
      while (!cancelled) {
        const index = cursor++;
        if (index >= queue.length) return;
        const name = queue[index];
        try {
          const res = await api.tagVideos(name, 1, 1);
          if (cancelled || countCache.epoch !== lineEpoch) return;
          const rawTotal = res?.pagination?.total;
          const itemCount = Array.isArray(res?.items) ? res.items.length : 0;
          if (typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0) {
            const count = Math.max(rawTotal, itemCount);
            entries.set(name, { count, expiresAt: Date.now() + TAG_COUNT_TTL_MS });
            if (count === 0) flush();
          } else if (itemCount > 0) {
            entries.set(name, { count: itemCount, expiresAt: Date.now() + TAG_COUNT_TTL_MS });
          }
        } catch {
          /* Unknown is not empty: keep the tag visible when probing fails. */
        }
      }
    };

    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, () => worker());
    void Promise.all(workers).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [groups, lineEpoch, refreshNonce]);

  return useMemo(() => {
    const now = Date.now();
    const entries = countCache.epoch === lineEpoch ? countCache.entries : null;
    const filtered: TagGroup[] = [];
    for (const group of groups) {
      const visibleTags = (group.tags ?? []).filter((tag) => {
        if (typeof tag.video_count === "number" && Number.isFinite(tag.video_count) && tag.video_count >= 0) {
          return tag.video_count > 0;
        }
        if (!entries) return true;
        const cached = entries.get(tag.name);
        if (!cached || cached.expiresAt <= now) return true;
        return cached.count > 0;
      });
      if (visibleTags.length > 0) {
        filtered.push({ ...group, tags: visibleTags });
      }
    }
    return filtered;
    // `version` triggers recomputation when in-memory probe cache updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, lineEpoch, version]);
}
