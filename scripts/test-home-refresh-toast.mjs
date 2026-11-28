import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

// 底栏「首页」连点会派发 hg:home-refresh；每次都刷新，但提示只能保留一张。
const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/home-refresh-toast/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App shell in Chromium with mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true, hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["首页甲", "首页乙", "首页丙"] });
  await context.addInitScript(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__FEED_CALLS__ = 0;
    const cards = ["首页甲", "首页乙", "首页丙"].map((title, index) => ({
      id: index + 1,
      title,
      cover: "",
      tags: ["都市", "剧情"],
      score: 8.5,
      episode_count: 12,
      total_episodes: 12,
      hot: 1000,
      like_count: 10,
      collect_count: 5,
      comment_count: 1,
      is_finished: true,
      is_original: 0,
      description: "首页刷新回归示例",
      author: { id: 1, name: "示例作者" },
    }));
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "api_feed") {
        window.__FEED_CALLS__ += 1;
        return { items: cards, pagination: { page: args.page || 1, pages: 1, size: 30, total: cards.length } };
      }
      return invoke(command, args);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/profile-nav-reset.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".hg-tabbar").waitFor();
  const homeNav = page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "首页" });
  await page.waitForFunction(() => window.__FEED_CALLS__ > 0);

  const initialCalls = await page.evaluate(() => window.__FEED_CALLS__);
  for (let i = 0; i < 3; i++) {
    const before = await page.evaluate(() => window.__FEED_CALLS__);
    await homeNav.click();
    await page.waitForFunction(calls => window.__FEED_CALLS__ > calls, before);
    await page.waitForFunction(() => document.querySelectorAll(".a-toast").length > 0);
    await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length > 0);
  const result = await page.evaluate(() => ({
    calls: window.__FEED_CALLS__,
    toasts: [...document.querySelectorAll(".a-toast")].map(el => el.textContent?.trim() ?? ""),
  }));
  assert.ok(result.calls >= initialCalls + 3, `三连点应各触发一次刷新：initial=${initialCalls} actual=${result.calls}`);
  assert.equal(result.toasts.length, 1, `三连点只应保留一张提示：${JSON.stringify(result.toasts)}`);
  assert.equal(result.toasts[0], "已换一批推荐");
  await page.screenshot({ path: fileURLToPath(new URL("home-refresh-toast.png", output)), animations: "disabled" });
  report.checks.push("three home tab taps keep one refresh toast");
  report.result = { initialCalls, ...result };
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: home-refresh-toast (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
