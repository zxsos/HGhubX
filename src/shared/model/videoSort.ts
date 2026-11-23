import type { VideoCard } from "../api/types";

/** Metric order for channel and tag video lists. */
export type VideoSortMetric = "default" | "like_count" | "collect_count" | "hot" | "score";

export const VIDEO_SORT_METRICS = ["like_count", "collect_count", "hot", "score"] as const;

export function isVideoSortMetric(value: string): value is VideoSortMetric {
  return value === "default" || (VIDEO_SORT_METRICS as readonly string[]).includes(value);
}

export function videoSortLabel(metric: VideoSortMetric, tr: (key: string) => string): string {
  switch (metric) {
    case "like_count": return tr("点赞数");
    case "collect_count": return tr("收藏数");
    case "hot": return tr("播放数");
    case "score": return tr("评分");
    default: return tr("默认排序");
  }
}

/**
 * Stable descending sort by a public metric. Pages are fetched in source order
 * first, so equal metrics keep the upstream order.
 */
export function sortVideosByMetric(videos: VideoCard[], metric: VideoSortMetric): VideoCard[] {
  if (metric === "default") return videos;
  const key = metric;
  return videos
    .map((video, index) => ({ video, index }))
    .sort((a, b) => {
      const diff = (Number(b.video[key]) || 0) - (Number(a.video[key]) || 0);
      return diff || a.index - b.index;
    })
    .map(item => item.video);
}
