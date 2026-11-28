# HGhubX TV tv-v3.1.2

HGhubX TV 3.1.2 正式版（`com.hghubx.tv`）：修复安卓 TV 端退出重开闪退与后台拉流问题，同步标准版 3.1.2 的统一错误代号层与视频加载提速（DNS 并发竞速与 Rust 媒体代理层 HLS 后台并发预取）。

## 修复
1. **安卓 TV 端返回退出后重新打开闪退**：根页面双击返回或启动 PIN 退出时改为调用原生 `moveTaskToBack(true)` 退回后台，避免延迟进程退出误杀重开实例。
2. **切入后台继续拉取 HLS 分片**：页面不可见时同步暂停播放并停止 HLS 拉流，回到前台后按原播放意图恢复。

## 新增与优化
1. **视频加载与起播提速**：底层客户端构建支持同主机 single-flight 与 900ms 系统 DNS / 阿里 DoH 并发竞速，Rust 媒体代理层新增 HLS 加密 Key、初始化片段与前序/后续 2 片后台并发预取，提升遥控切集与续播流畅度。
2. **统一错误代号层与历史同步自动重试**：网络、视频源脚本与播放器错误统一展示为带语义代号的可读中文提示，不再暴露原始请求 URL 或内部脚本调用栈；「观看历史」同步纳入只读瞬态超时重试。

## 安装与兼容提示
- Android TV 按 ABI 分包提供 `HGhubX-TV_3.1.2_arm64.apk`、`HGhubX-TV_3.1.2_arm.apk`、`HGhubX-TV_3.1.2_x86_64.apk`（`com.hghubx.tv`，`versionCode=3001002`）。
- 沿用既有签名证书与版本序列，支持从 `tv-v3.0.0` / `tv-v3.1.1` 直接覆盖安装并保留已导入视频源、本机片库、观看记录、启动 PIN 与偏好设置。

## 验证
- 本地完成 `VITE_APP_EDITION=tv pnpm build`、`node scripts/test-tv-remote.mjs`（14/14）、`check-version-sync`（`3.1.2` / `versionCode=3001002`）、`check-i18n`（947 条）、`check-doc-links`、`check-size-budgets`、`check-shell-purity`，以及安卓退后台/后台停流与统一错误代号层回归验证；GitHub Actions `TV CI` 与 `TV Release` 工作流执行全套遥控器验收与全 ABI 签名构建发布。
