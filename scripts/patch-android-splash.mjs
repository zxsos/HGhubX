#!/usr/bin/env node
/**
 * 给生成的 Android 工程补上「启动窗口背景色」，消除启动时的背景闪烁。
 *
 * 为什么需要：
 *   Tauri 的 Android 模板主题继承 `Theme.MaterialComponents.DayNight.NoActionBar`，
 *   它的 `android:windowBackground` 是 Material 灰底（暗色 #303030 / 亮色 #FAFAFA）。
 *   而启动动画的背景是深色品牌色 #071218（见 src/styles/launch.css 的 --launch-bg），
 *   于是点开应用会先闪一下灰/白，再跳进启动动画。
 *
 *   这里把窗口首帧背景固定成品牌色，与 index.html 首帧、launch.css 三层对齐。
 *   启动画面本身固定深色，不随系统 DayNight 切换。
 *
 * 用法：
 *   node scripts/patch-android-splash.mjs
 *   （tauri.conf.json 的 beforeBuildCommand 已自动调用，一般不用手动跑）
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");

if (!existsSync(res)) {
  console.log("[splash] Android 跳过：gen/android 还没生成（先跑 tauri android init）");
  process.exit(0);
}

// 与 src/styles/launch.css 的 --launch-bg、index.html 首帧背景一致
const BRAND = "#071218";
const THEME = "Theme.hghubx";
const valuesDir = join(res, "values");
const colorsPath = join(valuesDir, "colors.xml");
const pending = new Map();
let themeCount = 0;

function fail(path, message) {
  throw new Error(`[splash] Android XML 结构变化：${path}：${message}`);
}

// Match only this app's simple Tauri resources. Mask comments with spaces so
// offsets still refer to the original XML and commented examples stay intact.
function matches(xml, pattern) {
  const active = xml.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
  return [...active.matchAll(pattern)];
}

function setValue(xml, match, value, path) {
  const start = match.index + match[1].length;
  const end = start + match[2].length;
  const old = xml.slice(start, end);
  if (old.includes("<")) fail(path, "目标值不再是简单文本");
  const updated = old.replace(/^(\s*)[\s\S]*?(\s*)$/, (_, before, after) => `${before}${value}${after}`);
  return xml.slice(0, start) + updated + xml.slice(end);
}

// Qualified styles replace the whole default style; patch every existing copy.
const directories = readdirSync(res, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^values(?:-.+)?$/.test(entry.name))
  .map((entry) => entry.name).sort();
if (!directories.includes("values")) fail(valuesDir, "缺少默认 values 目录");

for (const directory of directories) {
  let directoryThemes = 0;
  let directoryColors = 0;
  const dir = join(res, directory);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".xml"))
    .map((entry) => join(dir, entry.name)).sort();
  for (const path of files) {
    const original = readFileSync(path, "utf8");
    let xml = original;
    const themeOpenings = matches(xml, /<style\b[^>]*\sname\s*=\s*["']Theme\.hghubx["'][^>]*>/g);
    const themes = matches(xml, /(<style\b[^>]*\sname\s*=\s*["']Theme\.hghubx["'][^>]*>)([\s\S]*?)(<\/style\s*>)/g);
    if (themes.length !== themeOpenings.length) fail(path, `${THEME} 缺少结束标签`);
    directoryThemes += themes.length;
    if (directoryThemes > 1) fail(path, `${directory} 重复定义 ${THEME}`);
    if (themes.length) {
      const theme = themes[0];
      if (/\/\s*>$/.test(theme[1]) || /<\/?style\b/.test(theme[2])) fail(path, `${THEME} 结构变化`);
      const start = theme.index + theme[1].length;
      const end = start + theme[2].length;
      const body = xml.slice(start, end);
      const backgrounds = matches(body, /(<item\b[^>]*\sname\s*=\s*["']android:windowBackground["'][^>]*>)([^<]*)(<\/item\s*>)/g);
      const backgroundOpenings = matches(body, /<item\b[^>]*\sname\s*=\s*["']android:windowBackground["'][^>]*>/g);
      if (backgrounds.length !== backgroundOpenings.length) fail(path, "windowBackground 结构变化");
      if (backgrounds.length > 1) fail(path, `${THEME} 重复定义 windowBackground`);
      let updated;
      if (backgrounds.length) {
        updated = setValue(body, backgrounds[0], "@color/launch_background", path);
      } else {
        const marker = "<!-- Customize your theme here. -->";
        if (!body.includes(marker)) fail(path, `${THEME} 缺少模板插入标记`);
        updated = body.replace(marker, `${marker}\n        <item name="android:windowBackground">@color/launch_background</item>`);
      }
      xml = xml.slice(0, start) + updated + xml.slice(end);
    }

    // Refresh existing qualified colors too, so they cannot override BRAND.
    const colorOpenings = matches(xml, /<color\b[^>]*\sname\s*=\s*["']launch_background["'][^>]*>/g);
    const colors = matches(xml, /(<color\b[^>]*\sname\s*=\s*["']launch_background["'][^>]*>)([^<]*)(<\/color\s*>)/g);
    if (colors.length !== colorOpenings.length) fail(path, "launch_background 结构变化");
    directoryColors += colors.length;
    if (directoryColors > 1) fail(path, `${directory} 重复定义 launch_background`);
    if (colors.length) xml = setValue(xml, colors[0], BRAND, path);
    if (xml !== original) pending.set(path, xml);
  }
  if (directory === "values") {
    if (directoryThemes !== 1) fail(valuesDir, `预期一个默认主题 ${THEME}，找到 ${directoryThemes} 个`);
    if (!directoryColors) {
      let xml = pending.get(colorsPath) ?? (existsSync(colorsPath)
        ? readFileSync(colorsPath, "utf8") : "<resources>\n</resources>\n");
      const ends = matches(xml, /<\/resources\s*>/g);
      if (ends.length !== 1) fail(colorsPath, "缺少唯一的 resources 结束标签");
      const end = ends[0].index;
      xml = xml.slice(0, end) + `    <color name="launch_background">${BRAND}</color>\n` + xml.slice(end);
      pending.set(colorsPath, xml);
    }
  }
  themeCount += directoryThemes;
}

// Parse all targets before writing, so a changed template never leaves only one
// of the day/night variants patched.
for (const [path, xml] of pending) writeFileSync(path, xml);
console.log(`[splash] Android ${themeCount} 个主题背景已对齐 → ${BRAND}（更新 ${pending.size} 个文件）`);

// Also register hghubx://import deep-link & CAMERA permission in AndroidManifest.xml (idempotent, standard edition only).
const manifestPath = join(root, "src-tauri", "gen", "android", "app", "src", "main", "AndroidManifest.xml");
if (existsSync(manifestPath)) {
  const manifestRaw = readFileSync(manifestPath, "utf8");
  let updatedManifest = manifestRaw;
  if (!/android:scheme\s*=\s*["']hghubx["']/.test(updatedManifest)) {
    const deepLinkFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="hghubx" android:host="import" />
            </intent-filter>`;
    updatedManifest = updatedManifest.replace(/(<\/activity\s*>)/, `${deepLinkFilter}\n        $1`);
  }
  if (!/android\.permission\.CAMERA/.test(updatedManifest)) {
    updatedManifest = updatedManifest.replace(
      /(<application\b)/,
      `    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    $1`,
    );
  }
  if (!/android\.permission\.VIBRATE/.test(updatedManifest)) {
    updatedManifest = updatedManifest.replace(
      /(<application\b)/,
      `    <uses-permission android:name="android.permission.VIBRATE" />\n    $1`,
    );
  }
  if (updatedManifest !== manifestRaw) {
    writeFileSync(manifestPath, updatedManifest);
    console.log("[splash] Android 已注册 hghubx://import 深链、相机与震动权限");
  }
}

// Ensure Android FileProvider exposes cacheDir/exports and filesDir/exports for direct log sharing.
const filePathsXml = join(res, "xml", "file_paths.xml");
if (existsSync(filePathsXml)) {
  const originalPaths = readFileSync(filePathsXml, "utf8");
  let updatedPaths = originalPaths;
  if (!updatedPaths.includes('name="hg_cache_exports"')) {
    updatedPaths = updatedPaths.replace(
      /<\/paths\s*>/,
      '    <cache-path name="hg_cache_exports" path="exports/" />\n    <files-path name="hg_files_exports" path="exports/" />\n    <external-cache-path name="hg_ext_cache_exports" path="exports/" />\n</paths>',
    );
  } else if (!updatedPaths.includes('name="hg_ext_cache_exports"')) {
    updatedPaths = updatedPaths.replace(
      /<\/paths\s*>/,
      '    <external-cache-path name="hg_ext_cache_exports" path="exports/" />\n</paths>',
    );
  }
  if (updatedPaths !== originalPaths) {
    writeFileSync(filePathsXml, updatedPaths);
    console.log("[splash] Android FileProvider 已放行 exports/ 日志分享目录");
  }
}

// Standard edition (com.hghubx.app): keep edge-to-edge video while exposing
// native system-bar, cutout and keyboard insets as CSS variables, plus hghubx:// deep links.
// Old WebViews (e.g. Chromium 66 car headunits) lack CSS env(safe-area-inset-*)
// and report zero cutout despite persistent status/dock bars (#138).
const appActivityPath = join(root, "src-tauri", "gen", "android", "app", "src", "main", "java", "com", "hghubx", "app", "MainActivity.kt");
if (existsSync(appActivityPath)) {
  const templateActivity = `package com.hghubx.app
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}`;
  const patchedActivity = `package com.hghubx.app

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  private var barsStyle = ""
  private var imeBottom = 0
  private var webViewHooked = false
  @Volatile private var pendingDeepLink: String? = null

  private fun dirBytes(file: File?, depth: Int = 0): Long {
    if (file == null || depth > 8) return 0L
    val list = file.listFiles() ?: return if (file.isFile) file.length() else 0L
    var total = 0L
    for (child in list) {
      if (child.isDirectory) total += dirBytes(child, depth + 1)
      else if (child.isFile) total += child.length()
    }
    return total
  }

  private inner class CacheBridge(private val webView: WebView) {
    @JavascriptInterface
    fun clearWebCache(): Long {
      return try {
        val root = cacheDir
        val before = dirBytes(root)
        val latch = CountDownLatch(1)
        webView.post {
          try {
            webView.clearCache(true)
          } finally {
            latch.countDown()
          }
        }
        latch.await(3, TimeUnit.SECONDS)
        try { Thread.sleep(180) } catch (_: InterruptedException) {}
        val after = dirBytes(root)
        (before - after).coerceAtLeast(0L)
      } catch (_: Throwable) {
        -1L
      }
    }
  }

  private class HapticBridge(private val context: Context) {
    @Suppress("DEPRECATION")
    @JavascriptInterface
    fun vibrate(durationMs: Int, amplitude: Int) {
      try {
        val ms = durationMs.coerceIn(1, 80).toLong()
        val amp = amplitude.coerceIn(1, 255)
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
          vm?.defaultVibrator
        } else {
          context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        } ?: return
        if (!vibrator.hasVibrator()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          val effAmp = if (vibrator.hasAmplitudeControl()) amp else VibrationEffect.DEFAULT_AMPLITUDE
          vibrator.vibrate(VibrationEffect.createOneShot(ms, effAmp))
        } else {
          vibrator.vibrate(ms)
        }
      } catch (_: Throwable) {}
    }
  }

  private inner class AppBridge {
    @JavascriptInterface
    fun moveToBackground(): Boolean {
      if (isFinishing || isDestroyed) return false
      runOnUiThread {
        try {
          if (!isFinishing && !isDestroyed) moveTaskToBack(true)
        } catch (_: Throwable) {}
      }
      return true
    }

    @JavascriptInterface
    fun shareFile(filePath: String, title: String): String {
      if (isFinishing || isDestroyed) return "err:activity_unavailable"
      return try {
        val file = File(filePath).canonicalFile
        val allowedRoots = listOfNotNull(cacheDir, filesDir, externalCacheDir).map { it.canonicalPath }
        if (!file.exists() || !file.isFile || allowedRoots.none { file.path.startsWith("$it/") }) {
          android.util.Log.e("HGhubXShare", "shareFile rejected path=$filePath canonical=\${file.path}")
          return "err:file_not_allowed"
        }
        val uri = FileProvider.getUriForFile(this@MainActivity, "\${packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = "text/plain"
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_SUBJECT, title)
          clipData = ClipData.newRawUri(title, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, title).apply {
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runOnUiThread {
          try {
            if (!isFinishing && !isDestroyed) startActivity(chooser)
          } catch (e: Throwable) {
            android.util.Log.e("HGhubXShare", "startActivity chooser failed", e)
          }
        }
        "ok"
      } catch (e: Throwable) {
        android.util.Log.e("HGhubXShare", "shareFile failed", e)
        "err:" + (e.message ?: e.javaClass.simpleName)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    try {
      webView.addJavascriptInterface(HapticBridge(applicationContext), "__HG_HAPTIC__")
      webView.addJavascriptInterface(CacheBridge(webView), "__HG_CACHE__")
      webView.addJavascriptInterface(AppBridge(), "__HG_ANDROID__")
    } catch (_: Throwable) {}
  }

  private fun findWebView(view: View?): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        findWebView(view.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  private fun captureDeepLink(intent: Intent?) {
    val raw = intent?.dataString ?: return
    if (raw.startsWith("hghubx://", ignoreCase = true)) {
      pendingDeepLink = raw
      findViewById<View>(android.R.id.content)?.let { deliverDeepLink(it) }
    }
  }

  private fun deliverDeepLink(content: View) {
    val link = pendingDeepLink ?: return
    val wv = findWebView(content) ?: return
    val quoted = JSONObject.quote(link)
    val js = "(function(){window.__HG_DEEP_LINK__=" + quoted +
      ";window.dispatchEvent(new CustomEvent('hg:deep-link',{detail:" + quoted + "}));})();"
    wv.evaluateJavascript(js, null)
    for (delay in longArrayOf(350L, 1200L)) {
      wv.postDelayed({
        val cur = pendingDeepLink ?: return@postDelayed
        val q = JSONObject.quote(cur)
        wv.evaluateJavascript("(function(){if(window.__HG_DEEP_LINK_HANDLED__===" + q + ")return;window.__HG_DEEP_LINK__=" + q + ";window.dispatchEvent(new CustomEvent('hg:deep-link',{detail:" + q + "}));})();", null)
      }, delay)
    }
  }

  private fun keyboardOverlap(webView: WebView): Int {
    if (imeBottom == 0 || webView.height == 0) return 0
    val keyboardTop = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      windowManager.currentWindowMetrics.bounds.bottom - imeBottom
    } else {
      Rect().also { webView.getWindowVisibleDisplayFrame(it) }.bottom
    }
    // Count only the part still covered if Android already resized the WebView.
    val position = IntArray(2)
    webView.getLocationOnScreen(position)
    val overlap = (position[1] + webView.height - keyboardTop).coerceIn(0, webView.height)
    return (overlap / webView.resources.displayMetrics.density.coerceAtLeast(1f)).roundToInt()
  }

  private fun pushInsets(content: View) {
    if (barsStyle.isEmpty()) return
    val wv = findWebView(content) ?: return
    val keyboard = keyboardOverlap(wv)
    val keyboardStyle = if (keyboard > 0) "s.setProperty('--native-ime-overlap','\${keyboard}px');"
      else "s.removeProperty('--native-ime-overlap');"
    val script = "(function(){var s=document.documentElement&&document.documentElement.style;if(!s)return;" +
      barsStyle + keyboardStyle + "})();"
    wv.evaluateJavascript(script, null)
    deliverDeepLink(content)
    if (!webViewHooked) {
      webViewHooked = true
      try {
        wv.addJavascriptInterface(HapticBridge(applicationContext), "__HG_HAPTIC__")
        wv.addJavascriptInterface(CacheBridge(wv), "__HG_CACHE__")
        wv.addJavascriptInterface(AppBridge(), "__HG_ANDROID__")
      } catch (_: Throwable) {}
      for (delay in longArrayOf(150L, 600L, 1500L)) {
        wv.postDelayed({ pushInsets(content) }, delay)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureDeepLink(intent)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    captureDeepLink(intent)
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density.coerceAtLeast(1f)
      val top = (bars.top / density).roundToInt()
      val right = (bars.right / density).roundToInt()
      val bottom = (bars.bottom / density).roundToInt()
      val left = (bars.left / density).roundToInt()
      imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      barsStyle =
        "s.setProperty('--native-sat','\${top}px');" +
          "s.setProperty('--native-sar','\${right}px');" +
          "s.setProperty('--native-sab','\${bottom}px');" +
          "s.setProperty('--native-sal','\${left}px');"
      pushInsets(content)
      insets
    }
    content.viewTreeObserver.addOnGlobalLayoutListener {
      if (!webViewHooked || imeBottom > 0) pushInsets(content)
    }
    ViewCompat.requestApplyInsets(content)
  }
}
`;
  const normalize = (text) => text.trim().replace(/\s+/g, " ");
  const currentActivity = readFileSync(appActivityPath, "utf8");
  const normalized = normalize(currentActivity);
  // Also accept projects already generated with previous versions of this bridge.
  const previousPatchedHashes = new Set([
    "52a0435284e8cd76196b4e73ab2f8394f041675f7736af31e6c083aae4e72c31",
    "fd5f83e7377db5344964105d5a5eeaf332c598080ac1820c07e596c65b9f60e4",
    "875364ca6c68491074b33fb2eb1f222432d312c432a90972e949d0f0b2a76a92",
    "9abb4b0208333437310900b1fc5b1bf19d83db44d77dcdd14ae0158f2b9b4ff0",
    "ca8bce745da3ba68b20fefb4519dff510c5e5ec80e10d5c70cf607726bc7e893",
    "deb0f904aed65bd476c348675374934b650b06804a2f46a802f6b01554df78ec",
    "1de92db074a5045a9edeb0e8ad7f452d4ba473f460c4f05e6f251737c74f4a46",
  ]);
  if (![templateActivity, patchedActivity].some((expected) => normalize(expected) === normalized) &&
      !previousPatchedHashes.has(createHash("sha256").update(normalized).digest("hex"))) {
    fail(appActivityPath, "MainActivity 与已知 Tauri 模板不同，请审阅原生改动后更新补丁");
  }
  if (normalized !== normalize(patchedActivity)) {
    writeFileSync(appActivityPath, patchedActivity);
  }
  console.log("[splash] Android 标准版系统栏、软键盘安全区与深链桥接已写入 MainActivity.kt");
}

// Release size optimization (shared by standard & TV Android builds): keep rules for Tauri/JS bridges,
// strip unused AndroidX locales, enable R8 resource shrinking, compress native .so in APK, and exclude license metadata.
const androidAppDir = join(root, "src-tauri", "gen", "android", "app");
const gradlePath = join(androidAppDir, "build.gradle.kts");
if (existsSync(gradlePath)) {
  const proguardPath = join(androidAppDir, "proguard-hghubx.pro");
  const proguardRules = `-keep class com.hghubx.** { *; }
-keep class app.tauri.** { *; }
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
`;
  if (!existsSync(proguardPath) || readFileSync(proguardPath, "utf8") !== proguardRules) {
    writeFileSync(proguardPath, proguardRules);
  }

  const gradleRaw = readFileSync(gradlePath, "utf8");
  let gradleNext = gradleRaw;
  if (!gradleNext.includes("// hghubx-size-opt")) {
    if (!/\bresourceConfigurations\b/.test(gradleNext)) {
      const dcMatch = gradleNext.match(/\bdefaultConfig\s*\{/);
      if (!dcMatch) fail(gradlePath, "缺少 defaultConfig 块");
      const insertAt = dcMatch.index + dcMatch[0].length;
      gradleNext =
        gradleNext.slice(0, insertAt) +
        '\n        resourceConfigurations += listOf("zh", "zh-rCN", "zh-rTW", "zh-rHK", "en")' +
        gradleNext.slice(insertAt);
    }
    if (!/\bisShrinkResources\b/.test(gradleNext)) {
      const relMatch = gradleNext.match(/getByName\("release"\)\s*\{[\s\S]*?isMinifyEnabled\s*=\s*true/);
      if (!relMatch) fail(gradlePath, "缺少 release isMinifyEnabled 配置");
      const insertAt = relMatch.index + relMatch[0].length;
      gradleNext =
        gradleNext.slice(0, insertAt) +
        "\n            isShrinkResources = true" +
        gradleNext.slice(insertAt);
    }
    if (!/^\s{4}packaging\s*\{/m.test(gradleNext)) {
      const androidMatch = gradleNext.match(/(?:^|\n)android\s*\{/);
      if (!androidMatch) fail(gradlePath, "缺少 android { 块");
      let idx = androidMatch.index + androidMatch[0].length;
      let depth = 1;
      let closeIdx = -1;
      let quote = "";
      while (idx < gradleNext.length) {
        const ch = gradleNext[idx];
        const nextCh = gradleNext[idx + 1] || "";
        if (!quote && ch === "/" && nextCh === "/") {
          const nl = gradleNext.indexOf("\n", idx);
          idx = nl === -1 ? gradleNext.length : nl + 1;
          continue;
        }
        if (!quote && ch === "/" && nextCh === "*") {
          const end = gradleNext.indexOf("*/", idx + 2);
          idx = end === -1 ? gradleNext.length : end + 2;
          continue;
        }
        if (quote) {
          if (ch === "\\") { idx += 2; continue; }
          if (ch === quote) quote = "";
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) { closeIdx = idx; break; }
          }
        }
        idx += 1;
      }
      if (closeIdx === -1) fail(gradlePath, "android { 块未正常闭合");
      const packagingBlock = `    // hghubx-size-opt
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
        resources {
            excludes += listOf(
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/*.kotlin_module",
                "META-INF/*.version",
                "DebugProbesKt.bin"
            )
        }
    }
`;
      gradleNext = gradleNext.slice(0, closeIdx) + packagingBlock + gradleNext.slice(closeIdx);
    }
    if (gradleNext !== gradleRaw) {
      writeFileSync(gradlePath, gradleNext);
    }
  }
  console.log("[splash] Android 构建体积优化（R8 资源裁剪 / 语言筛选 / .so 压缩 / ProGuard keep）已写入 build.gradle.kts");
}
