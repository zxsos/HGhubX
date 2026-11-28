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
