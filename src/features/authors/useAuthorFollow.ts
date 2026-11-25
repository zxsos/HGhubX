import { useCallback, useRef, useState } from "react";
import { useStore } from "../../shared/model/store";
import { tr } from "../../shared/i18n";
import type { AuthorItem } from "./authorDirectory";

const FOLLOW_TOAST_SLOT = "playback-hint";

/** Follow/unfollow an author from either the video player or the author directory. */
export function useAuthorFollow() {
  const { user, follows, setFollowing, toggleFollowLocal, actionPending, toast } = useStore();
  const [busyId, setBusyId] = useState<number | null>(null);
  const busy = useRef<number | null>(null);

  const toggleFollow = useCallback((author: AuthorItem) => {
    if (busy.current !== null) return;
    const on = !follows.includes(author.id);
    if (!user) {
      const next = toggleFollowLocal(author.id);
      toast(next ? tr("已关注 {0}", author.name) : tr("已取消关注 {0}", author.name), next ? "ok" : "info", FOLLOW_TOAST_SLOT);
      return;
    }
    if (actionPending(`follow:${author.id}`)) return;
    busy.current = author.id;
    setBusyId(author.id);
    void (async () => {
      try {
        await setFollowing(author.id, on);
        toast(on ? tr("已关注 {0}", author.name) : tr("已取消关注 {0}", author.name), on ? "ok" : "info", FOLLOW_TOAST_SLOT);
      } catch (error) {
        toast(error instanceof Error ? error.message : tr("关注失败，请重试"), "info", FOLLOW_TOAST_SLOT);
      } finally {
        if (busy.current === author.id) busy.current = null;
        setBusyId(null);
      }
    })();
  }, [user, follows, setFollowing, toggleFollowLocal, actionPending, toast]);

  return { busyId, toggleFollow };
}
