import { fmtTime } from "../api/api";
import type { Detail } from "../api/types";
import type { WatchProgress } from "./store";
import { tr } from "../i18n";

export function detailEpisodeCount(detail: Pick<Detail, "episode_count" | "episodes"> | null | undefined): number {
  if (!detail) return 0;
  const fromList = Array.isArray(detail.episodes)
    ? detail.episodes.reduce((max, ep) => Math.max(max, Number(ep.ep_num) || 0), detail.episodes.length)
    : 0;
  return Math.max(0, Number(detail.episode_count) || 0, fromList);
}

export function isEpisodeFinished(progress: WatchProgress | undefined): boolean {
  return !!progress && progress.dur > 0 && progress.t >= Math.max(1, progress.dur - 3);
}

export function resolveResumeTarget(
  detail: Detail | undefined,
  progress: WatchProgress | undefined,
): { startEp?: number; startTime?: number } {
  if (!progress) return {};
  if (isEpisodeFinished(progress)) {
    const latest = detailEpisodeCount(detail);
    const nextFromList = detail?.episodes
      ?.map(ep => Number(ep.ep_num) || 0)
      .filter(ep => ep > progress.ep)
      .sort((a, b) => a - b)[0];
    const nextEp = nextFromList ?? (latest > progress.ep ? progress.ep + 1 : undefined);
    if (nextEp && nextEp > progress.ep) {
      return { startEp: nextEp, startTime: 0 };
    }
    return { startEp: progress.ep, startTime: 0 };
  }
  return {
    startEp: progress.ep,
    startTime: progress.t >= 1 ? progress.t : undefined,
  };
}

export function formatWatchProgress(
  progress: WatchProgress | undefined,
  latestCount: number,
  isFinished: boolean,
): string | undefined {
  if (!progress) return undefined;
  if (isEpisodeFinished(progress)) {
    if (isFinished && latestCount > 0 && progress.ep >= latestCount) {
      return tr("已看完 · 全 {0} 集", latestCount);
    }
    return tr("已看完第 {0} 集", progress.ep);
  }
  return progress.t >= 1 ? tr("第 {0} 集 · {1}", progress.ep, fmtTime(progress.t)) : tr("第 {0} 集", progress.ep);
}

export function unwatchedNewEpisodes(
  detail: Detail,
  progress: WatchProgress | undefined,
  knownCount: number | undefined,
): number {
  const latest = detailEpisodeCount(detail);
  if (latest <= 0) return 0;
  const watchedEp = progress?.ep ?? 0;
  if (watchedEp >= latest) return 0;
  if (knownCount !== undefined && knownCount > 0) {
    return Math.max(0, latest - Math.max(knownCount, watchedEp));
  }
  if (progress && !detail.is_finished && (isEpisodeFinished(progress) || progress.t === 0)) {
    return Math.max(0, latest - watchedEp);
  }
  return 0;
}

export type FavoriteSortMode = "added" | "updated" | "status";
export type FavoriteStatusOrder = "finished" | "ongoing";

function parseTimestampMs(raw?: string | number): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw !== "string") return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed) ? trimmed.replace(" ", "T") : trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function detailUpdatedTimestamp(detail: Detail | undefined): number {
  if (!detail) return 0;
  return parseTimestampMs(detail.updated_at) || parseTimestampMs(detail.last_ep_at) || parseTimestampMs(detail.created_at);
}

function detailLatestEpisodeOrder(detail: Detail | undefined): number {
  if (!detail?.tracking_episodes) return detail?.id ?? 0;
  let maxId = 0;
  for (const row of Object.values(detail.tracking_episodes)) {
    const num = Number(row?.video_id);
    if (Number.isSafeInteger(num) && num > maxId) maxId = num;
  }
  return maxId > 0 ? maxId : (detail.id ?? 0);
}

/** Sort favorite video IDs by updated recency or completion status; keeps uncached tails in original order. */
export function sortFavoriteVideoIds(
  ids: number[],
  videoCache: Record<number, Detail>,
  history: WatchProgress[],
  favEpCounts: Record<number, number>,
  mode: FavoriteSortMode,
  statusOrder: FavoriteStatusOrder,
): number[] {
  if (mode === "added" || ids.length < 2) return ids;
  const origIndex = new Map<number, number>(ids.map((id, i) => [id, i]));
  const progressById = new Map<number, WatchProgress>(history.map(h => [h.id, h]));
  return [...ids].sort((a, b) => {
    const da = videoCache[a];
    const db = videoCache[b];
    if (!da || !db) {
      if (!da && !db) return origIndex.get(a)! - origIndex.get(b)!;
      return da ? -1 : 1;
    }
    const newA = unwatchedNewEpisodes(da, progressById.get(a), favEpCounts[a]);
    const newB = unwatchedNewEpisodes(db, progressById.get(b), favEpCounts[b]);
    if (mode === "status") {
      const bucket = (d: Detail) => (statusOrder === "finished" ? (d.is_finished ? 0 : 1) : (d.is_finished ? 1 : 0));
      const diffBucket = bucket(da) - bucket(db);
      if (diffBucket !== 0) return diffBucket;
      if (!da.is_finished && !db.is_finished && (newA > 0) !== (newB > 0)) return newB > 0 ? 1 : -1;
    } else if ((newA > 0) !== (newB > 0)) {
      return newB > 0 ? 1 : -1;
    }
    const diffTs = detailUpdatedTimestamp(db) - detailUpdatedTimestamp(da);
    if (diffTs !== 0) return diffTs;
    if (mode === "updated" && newA !== newB) return newB - newA;
    const diffEp = detailLatestEpisodeOrder(db) - detailLatestEpisodeOrder(da);
    if (diffEp !== 0) return diffEp;
    return origIndex.get(a)! - origIndex.get(b)!;
  });
}
