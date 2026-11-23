import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/favorite-filter/", import.meta.url);
await mkdir(output, { recursive: true });
const rows = [
  [1, "更新一", false, "2026-11-23T10:00:00Z"], [2, "完结二", true, "2026-11-22T10:00:00Z"],
  [3, "更新三", false, "2026-11-21T10:00:00Z"], [4, "完结四", true, "2026-11-20T10:00:00Z"],
  [5, "更新五", false, "2026-11-19T10:00:00Z"], [6, "完结六", true, "2026-11-18T10:00:00Z"],
].map(([id, title, is_finished, updated_at]) => ({
  id, title, is_finished, updated_at, cover: `https://fixture.invalid/poster/${id}`, tags: ["都市", "剧情"], score: 8.1,
  episode_count: id === 2 ? 10 : 12, total_episodes: id === 2 ? 10 : 12, hot: 1000, counts: { collect: 1, comment: 1, hot: 1, like: 1 },
  author: { id: 1, name: "作者" }, description: "fixture", episodes: [],
}));
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  for (const candidate of ["/opt/browser/chrome", "/usr/local/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    if (!executablePath && await access(candidate).then(() => true, () => false)) executablePath = candidate;
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36" });
  await context.addInitScript(installFixture, { theme: "dark", titles: rows.map(r => r.title) });
  await context.addInitScript(() => {
    const raw = JSON.parse(localStorage.getItem("hghubx_app_v1") || "{}");
    raw.favEpCounts = { 1: 10, 3: 12, 5: 12 };
    raw.history = [
      { id: 1, ep: 3, t: 55, dur: 180, at: 1 }, { id: 2, ep: 2, t: 10, dur: 180, at: 2 },
      { id: 3, ep: 12, t: 180, dur: 180, at: 3 }, { id: 4, ep: 12, t: 180, dur: 180, at: 4 },
      { id: 5, ep: 12, t: 180, dur: 180, at: 5 }, { id: 6, ep: 12, t: 180, dur: 180, at: 6 },
    ];
    localStorage.setItem("hghubx_app_v1", JSON.stringify(raw));
  });
  await context.addInitScript((details) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) =>
      command === "api_video" && details.find(row => row.id === args.id) || invoke(command, args);
  }, rows);
  const page = await context.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  await page.goto(new URL("/tests/ui-feedback.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page-body").waitFor();
  const status = page.locator('[aria-label="收藏状态筛选"] button');
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 6);
  await page.waitForFunction(() => document.querySelector('[aria-label="收藏状态筛选"] button')?.textContent === "未看 2")
    .catch(async () => { console.log("status texts:", await status.allInnerTexts()); throw new Error("counts did not settle"); });
  assert.deepEqual(await status.allInnerTexts(), ["未看 2", "连载 3", "完结 3"]);
  assert.equal(await page.locator('[aria-label="收藏内容类型"] button').first().innerText(), "短剧 6");
  const footer = page.locator('[role="status"]').filter({ hasText: "已显示" }).last();
  assert.equal(await footer.innerText(), "已显示 6 / 6 项本机记录");
  assert.equal(await page.locator(".ios-poster-badge.is-update").count(), 0, "all view never shows the blue unwatched badge");
  const [catBox, uwBox, onBox, finBox] = await Promise.all([
    page.locator('[aria-label="收藏内容类型"] button').first().boundingBox(), status.nth(0).boundingBox(), status.nth(1).boundingBox(), status.nth(2).boundingBox()]);
  assert.ok(catBox && uwBox && onBox && finBox && Math.abs(catBox.y - uwBox.y) <= 1 && Math.abs(catBox.height - uwBox.height) <= 1);
  assert.ok(finBox.x + finBox.width <= 390 - 16, "three counted filters stay inside the page");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-default.png", output)), animations: "disabled" });
  await status.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 2);
  assert.equal(await footer.innerText(), "已显示 2 / 2 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-title").allInnerTexts(), ["更新一", "完结二"]);
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["未看 9 集", "未看 8 集"]);
  await page.screenshot({ path: fileURLToPath(new URL("favorite-unwatched.png", output)), animations: "disabled" });
  await status.nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 3);
  assert.equal(await footer.innerText(), "已显示 3 / 3 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-title").allInnerTexts(), ["更新一", "更新三", "更新五"]);
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["更新至 12 集", "更新至 12 集", "更新至 12 集"]);
  await page.screenshot({ path: fileURLToPath(new URL("favorite-ongoing.png", output)), animations: "disabled" });
  await status.nth(2).click();
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 3);
  assert.equal(await footer.innerText(), "已显示 3 / 3 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["全 10 集", "全 12 集", "全 12 集"]);
  await page.screenshot({ path: fileURLToPath(new URL("favorite-finished.png", output)), animations: "disabled" });
  console.log("PASS: category counts and footer totals stay consistent");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await vite?.close();
}
