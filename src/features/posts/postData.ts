import { formatTimestamp } from "../../shared/lib/time";

export type PostHotSource = {
  hot?: number | null;
  counts?: { hot?: number | null } | null;
} | null | undefined;

export type PostTimeSource = {
  publish_time?: string | number | null;
  created_at?: string | number | null;
  published_at?: string | number | null;
  updated_at?: string | number | null;
  time?: string | number | null;
} | null | undefined;

/** 详情接口有时把 hot 置空，只把实际热度放在 counts.hot。 */
export function postHot(post: PostHotSource): number {
  return post?.hot ?? post?.counts?.hot ?? 0;
}

/** 依次格式化帖子发布时间，兼容秒/毫秒时间戳与 UTC ISO 字符串，跳过 0 / 1970 占位值。 */
export function formatPostTime(post: PostTimeSource): string {
  if (!post) return "";
  for (const candidate of [post.publish_time, post.created_at, post.published_at, post.updated_at, post.time]) {
    const formatted = formatTimestamp(candidate);
    if (formatted) return formatted;
  }
  return "";
}
