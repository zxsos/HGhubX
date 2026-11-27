import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PlayInfo } from "../../shared/api/types";

type PlayGuard = { allowed: boolean; id: number; permissionKey: string; playKey: string };

/** 当前集拿到首帧后预取下一集播放地址，避免与当前起播争抢网络。 */
export function useNextEpisodeUrlPrefetch(opts: {
  active: boolean;
  curId: number;
  curEp: number;
  episodesLength: number;
  kind: "video" | "post";
  allowed: boolean;
  playingKey: string;
  playKey: string;
  accountScope: string;
  permissionKey: string;
  hasNextUrl: boolean;
  playGuard: MutableRefObject<PlayGuard>;
  requestPlay: (id: number, ep: number) => Promise<PlayInfo>;
  setPlayUrls: Dispatch<SetStateAction<Record<string, string>>>;
  setHevcUrls: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const {
    active, curId, curEp, episodesLength, kind, allowed, playingKey, playKey,
    accountScope, permissionKey, hasNextUrl, playGuard, requestPlay, setPlayUrls, setHevcUrls,
  } = opts;

  useEffect(() => {
    if (!active || !curId || kind !== "video" || !allowed || playingKey !== playKey || episodesLength === 0) return;
    const nextEpisode = curEp + 1;
    if (nextEpisode > episodesLength || hasNextUrl) return;
    let alive = true;
    const key = `${accountScope}:${curId}:${nextEpisode}`;
    requestPlay(curId, nextEpisode)
      .then((info) => {
        if (!alive || !playGuard.current.allowed || playGuard.current.permissionKey !== permissionKey) return;
        const h = info?.streams?.hevc || info?.video_url_hevc || "";
        const u = info?.streams?.main || info?.video_url || h;
        if (u) setPlayUrls((m) => ({ ...m, [key]: u }));
        if (h) setHevcUrls((m) => ({ ...m, [key]: h }));
      })
      .catch(() => { /* 预热失败不影响当前播放 */ });
    return () => { alive = false; };
  }, [
    active, curId, curEp, episodesLength, kind, allowed, playingKey, playKey,
    accountScope, permissionKey, hasNextUrl, playGuard, requestPlay, setPlayUrls, setHevcUrls,
  ]);
}
