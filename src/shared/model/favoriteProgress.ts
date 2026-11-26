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

/** Episodes still unwatched from the recorded position, regardless of finish state. */
export function unwatchedEpisodeCount(
  detail: Detail,
  progress: WatchProgress | undefined,
): number {
  const latest = detailEpisodeCount(detail);
  if (latest <= 0) return 0;
  return Math.max(0, latest - (progress?.ep ?? 0));
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

export type FavoriteWatchFilter = "all" | "watching" | "watched";
export type FavoriteSeriesFilter = "all" | "ongoing" | "finished";
export type FavoriteWatchState = "watching" | "watched";

export function favoriteWatchState(
  detail: Detail,
  progress: WatchProgress | undefined,
): FavoriteWatchState | null {
  const latest = detailEpisodeCount(detail);
  if (latest <= 0) return null;
  return unwatchedEpisodeCount(detail, progress) > 0 ? "watching" : "watched";
}

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

/**
 * Keep the server/local favorite order for the unfiltered list, which is the
 * order items were added. Detail filters need every detail loaded: unknown
 * entries are omitted rather than guessed, and matching entries sort by the
 * latest update time. Watch state and release state are independent filters;
 * they intersect rather than replace each other.
 */
export function filterFavoriteVideoIds(
  ids: number[],
  videoCache: Record<number, Detail>,
  watchFilter: FavoriteWatchFilter,
  seriesFilter: FavoriteSeriesFilter,
  watchState?: (id: number, detail: Detail) => FavoriteWatchState | null,
): number[] {
  if (watchFilter === "all" && seriesFilter === "all") return ids;
  const origIndex = new Map<number, number>(ids.map((id, i) => [id, i]));
  const matches = ids.filter(id => {
    const detail = videoCache[id];
    if (!detail) return false;
    const seriesMatches = seriesFilter === "all"
      || (seriesFilter === "finished" ? detail.is_finished : !detail.is_finished);
    if (!seriesMatches) return false;
    if (watchFilter === "all") return true;
    return watchState?.(id, detail) === watchFilter;
  });
  return matches.sort((a, b) => {
    const diffTs = detailUpdatedTimestamp(videoCache[b]) - detailUpdatedTimestamp(videoCache[a]);
    if (diffTs !== 0) return diffTs;
    return origIndex.get(a)! - origIndex.get(b)!;
  });
}
