#!/usr/bin/env node
/**
 * 仅在 HarmonyOS CI 构建 job 中临时切换 Tauri OpenHarmony 依赖与能力配置。
 *
 * 为什么不直接写死在主线 Cargo.toml：
 *   Windows / macOS / Linux / Android / iOS 均使用官方 crates.io Tauri 2 稳定版及 Cargo.lock；
 *   OpenHarmony 目标（aarch64-unknown-linux-ohos）目前依赖社区 feat-openharmony 分支（Tauri 2.10.3），
 *   且不支持 `core:app:allow-exit` 能力项。此脚本仅在 CI 的 harmonyos job 工作目录临时改写，
 *   保持主线零分叉且不影响其余平台构建。
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const lockPath = path.join(root, "src-tauri", "Cargo.lock");
const capPath = path.join(root, "src-tauri", "capabilities", "default.json");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");

function replaceRequired(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`[patch-ohos] 未匹配到预期段落：${label}`);
  }
  return text.replace(pattern, replacement);
}

let cargo = fs.readFileSync(cargoPath, "utf8");
if (!cargo.includes('git = "https://github.com/richerfu/tauri"')) {
  cargo = replaceRequired(
    cargo,
    /^tauri-build\s*=\s*\{[^}\n]*\}/m,
    'tauri-build = { git = "https://github.com/richerfu/tauri", branch = "feat-openharmony", features = [] }',
    "tauri-build",
  );
  cargo = replaceRequired(
    cargo,
    /^tauri\s*=\s*\{[^}\n]*\}/m,
    'tauri = { git = "https://github.com/richerfu/tauri", branch = "feat-openharmony", features = [] }',
    "tauri",
  );
  cargo = replaceRequired(
    cargo,
    /^tauri-plugin-opener\s*=\s*[^\n]+/m,
    'tauri-plugin-opener = { git = "https://github.com/richerfu/plugins-workspace", branch = "feat-openharmony" }',
    "tauri-plugin-opener",
  );
  cargo = replaceRequired(
    cargo,
    /^tauri-plugin-clipboard-manager\s*=\s*[^\n]+/m,
    'tauri-plugin-clipboard-manager = { git = "https://github.com/richerfu/plugins-workspace", branch = "feat-openharmony" }',
    "tauri-plugin-clipboard-manager",
  );
}

// Cargo 解析锁文件时会求值全部 target 依赖；桌面端 deep-link / single-instance 依赖 crates.io tauri ^2.12，
// 与 OpenHarmony 分支的 tauri v2.10.3 触发 native links = "Tauri" 冲突，且 OHOS 构建不编译该段。
cargo = cargo.replace(
  /\n?\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios", target_env = "ohos"\)\)\)'\.dependencies\][\s\S]*?(?=\n\[)/,
  "",
);

if (!cargo.includes('[target.\'cfg(target_env = "ohos")\'.dependencies]')) {
  const ohosDeps = `[target.'cfg(target_env = "ohos")'.dependencies]
napi-ohos = "1.2"
napi-derive-ohos = "1.2"
ohos-accessibility-binding = "=0.2.0"
ohos-arkui-binding = "=0.6.2"
ohos-arkui-input-binding = "=0.2.0"
ohos-image-native-binding = "=0.0.8"
ohos-ime-binding = "=0.4.0"
ohos-pasteboard-binding = "=0.0.8"
ohos-udmf-binding = "=0.0.8"
ohos-web-binding = "=0.3.2"
ohos-window-manager-binding = "=0.1.2"
ohos-xcomponent-binding = "=0.6.1"
openharmony-ability = { git = "https://github.com/harmony-contrib/openharmony-ability", branch = "codex/complete-platform-capabilities" }

[profile.release]`;
  cargo = replaceRequired(cargo, /^\[profile\.release\]/m, ohosDeps, "[profile.release]");
}
fs.writeFileSync(cargoPath, cargo);

const cap = JSON.parse(fs.readFileSync(capPath, "utf8"));
if (Array.isArray(cap.permissions)) {
  cap.permissions = cap.permissions.filter((p) => p !== "core:app:allow-exit");
  fs.writeFileSync(capPath, JSON.stringify(cap, null, 2) + "\n");
}

const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
if (conf.plugins && typeof conf.plugins === "object" && "deep-link" in conf.plugins) {
  delete conf.plugins["deep-link"];
  if (Object.keys(conf.plugins).length === 0) delete conf.plugins;
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");
}

if (fs.existsSync(lockPath)) {
  fs.rmSync(lockPath);
}

console.log("[patch-ohos] 已切换 Cargo.toml / capabilities / tauri.conf.json 至 OpenHarmony 构建配置");
