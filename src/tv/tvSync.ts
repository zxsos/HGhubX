import { api, type TvSyncEnvelope } from "../shared/api/api";
import { mergeContentPreferences } from "../shared/model/contentPreferences";
import { setAutoLine } from "../shared/network/autoLine";
import { mergeSyncedLibrary } from "./library";
import { setPlaybackPreferences } from "./preferences";

export async function applyTvSyncEnvelope(env: TvSyncEnvelope): Promise<string> {
  const { sync, source } = env;
  const parts: string[] = [];
  if (source) {
    parts.push(`${source.name} v${source.version}`);
  }

  const hasLib = Boolean(sync.favs?.length || sync.postFavs?.length || sync.history?.length);
  if (hasLib) {
    const lib = await mergeSyncedLibrary({
      favs: sync.favs,
      postFavs: sync.postFavs,
      history: sync.history,
    }, source?.id);
    if (lib.favs > 0) parts.push(`${lib.favs} 部收藏`);
    if (lib.postFavs > 0) parts.push(`${lib.postFavs} 条帖子收藏`);
    if (lib.history > 0) parts.push(`${lib.history} 条记录`);
  }

  let prefsApplied = false;
  if (sync.contentPreferences) {
    mergeContentPreferences(sync.contentPreferences);
    prefsApplied = true;
  }
  if (typeof sync.preferHevc === "boolean") {
    try {
      setPlaybackPreferences({ quality: sync.preferHevc ? "hevc" : "main" });
      prefsApplied = true;
    } catch { /* keep playback responsive on storage failure */ }
  }
  if (typeof sync.autoLine === "boolean") {
    await setAutoLine(sync.autoLine).catch(() => {});
    if (!sync.autoLine && sync.lineBase) {
      await api.lineSet(sync.lineBase).catch(() => {});
    }
    prefsApplied = true;
  } else if (sync.lineBase) {
    await api.lineSet(sync.lineBase).catch(() => {});
    prefsApplied = true;
  }

  if (prefsApplied) parts.push("偏好设置");
  return parts.length ? `已同步：${parts.join(" · ")}` : "已接收同步";
}
