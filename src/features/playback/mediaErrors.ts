import { isIos, isLinux } from "../../shared/api/api";
import { formatErrorWithCode } from "../../shared/api/errorFormat";
import { tr } from "../../shared/i18n";

export function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 2:
      return formatErrorWithCode(tr("网络错误，视频加载失败，请检查网络后重试"), "MEDIA_NET");
    case 3:
      return formatErrorWithCode(tr("视频解码失败，请重试"), "MEDIA_DECODE");
    case 4:
      return formatErrorWithCode(
        isLinux
          ? tr("当前系统缺少 H.264/AAC 解码器，请安装 gstreamer1.0-libav 和 gstreamer1.0-plugins-bad 后重试")
          : isIos
            ? tr("视频资源加载失败或格式不受支持，请重试")
            : tr("当前视频格式不受支持"),
        "MEDIA_UNSUPPORTED",
      );
    default:
      return formatErrorWithCode(tr("视频加载失败，请重试"), "MEDIA_ERR");
  }
}

export function hlsErrorMessage(type: string, code?: number): string {
  if (type === "networkError") {
    if (code === 403 || code === 451) {
      return formatErrorWithCode(tr("视频源拒绝访问，可能存在地区或防盗链限制，请切换网络或视频源"), `HTTP_${code}`);
    }
    if (code === 404 || code === 410) {
      return formatErrorWithCode(tr("视频资源不存在或已失效，请切换剧集或视频源"), `HTTP_${code}`);
    }
    return formatErrorWithCode(tr("视频网络加载失败，请检查线路或重试"), "MEDIA_NET");
  }
  if (type === "mediaError") return formatErrorWithCode(tr("视频解码异常，请重试"), "MEDIA_DECODE");
  return formatErrorWithCode(tr("视频暂时无法播放，请重试"), "MEDIA_ERR");
}
