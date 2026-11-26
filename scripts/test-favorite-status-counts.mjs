import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/favorite-combined/", import.meta.url);
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
    window.__fixtureDetails = details;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) =>
      command === "api_video" && details.find(row => row.id === args.id) || invoke(command, args);
  }, rows);
  const page = await context.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  await page.goto(new URL("/tests/ui-feedback.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page-body").waitFor();

  const filterButton = page.locator("[data-favorite-filter-trigger]");
  const filterMenu = page.getByRole("menu", { name: "收藏筛选" });
  const filterSummary = page.locator("[data-favorite-filter-summary]");
  const shortTotal = page.locator("[data-favorite-short-total]");
  const postsButton = page.getByRole("button", { name: /帖子/ });
  const posterTitles = page.locator(".ios-poster-title");
  const posterBadges = page.locator(".ios-poster-badge");
  const footer = page.locator('[role="status"]').filter({ hasText: "已显示" }).last();
  const normalize = async locator => (await locator.innerText()).replace(/\s+/g, " ").trim();
  const waitCards = count => page.waitForFunction(n => document.querySelectorAll(".ios-poster-title").length === n, count);
  const openFilter = async () => {
    if (!(await filterMenu.count())) await filterButton.click();
    await filterMenu.waitFor();
  };
  const closeFilter = async () => {
    await page.getByRole("button", { name: "完成" }).click();
    await filterMenu.waitFor({ state: "detached" });
  };
  const filterOption = (axis, value) => page.locator(`[data-favorite-${axis}-filter-option="${value}"]`);
  const resetAll = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("hg:profile-reset")));
    await waitCards(6);
  };

  await waitCards(6);
  assert.equal(await normalize(shortTotal), "6");
  assert.equal(await filterButton.getAttribute("aria-label"), "收藏筛选");
  assert.equal(await filterSummary.count(), 0);
  assert.equal(await footer.innerText(), "已显示 6 / 6 项本机记录");
  const postBoxBefore = await postsButton.boundingBox();
  await page.screenshot({ path: fileURLToPath(new URL("01-default.png", output)), animations: "disabled" });

  await openFilter();
  assert.equal(await normalize(filterOption("watch", "all")), "不限 6");
  assert.equal(await normalize(filterOption("watch", "watching")), "在追剧 2");
  assert.equal(await normalize(filterOption("watch", "watched")), "已看完 4");
  assert.equal(await normalize(filterOption("series", "all")), "不限 6");
  assert.equal(await normalize(filterOption("series", "ongoing")), "连载中 3");
  assert.equal(await normalize(filterOption("series", "finished")), "已完结 3");
  await page.screenshot({ path: fileURLToPath(new URL("02-menu-default.png", output)), animations: "disabled" });

  await filterOption("series", "ongoing").click();
  await waitCards(3);
  assert.equal(await normalize(shortTotal), "6");
  assert.equal(await normalize(filterSummary), "筛选 1");
  assert.match(await filterButton.getAttribute("aria-label"), /连载中 3/);
  await page.screenshot({ path: fileURLToPath(new URL("03-series-ongoing.png", output)), animations: "disabled" });

  await filterOption("watch", "watching").click();
  await waitCards(1);
  assert.deepEqual(await posterTitles.allInnerTexts(), ["更新一"]);
  assert.deepEqual(await posterBadges.allInnerTexts(), ["未看 9 集"]);
  assert.equal(await normalize(filterSummary), "筛选 2");
  assert.match(await filterButton.getAttribute("aria-label"), /在追剧 1 · 连载中 1/);
  assert.equal(await normalize(filterOption("watch", "all")), "不限 3");
  assert.equal(await normalize(filterOption("series", "all")), "不限 2");
  await page.screenshot({ path: fileURLToPath(new URL("04-menu-intersection.png", output)), animations: "disabled" });

  await closeFilter();
  const postBoxAfter = await postsButton.boundingBox();
  assert.ok(postBoxBefore && postBoxAfter && Math.abs(postBoxBefore.x - postBoxAfter.x) <= 1,
    "Combined filters must not push the posts tab to the right");
  assert.equal(await normalize(filterSummary), "筛选 2");
  await page.screenshot({ path: fileURLToPath(new URL("05-active-closed.png", output)), animations: "disabled" });

  // Each axis can be cleared independently from the section header.
  await openFilter();
  await filterOption("watch", "all").click();
  await waitCards(3);
  assert.equal(await normalize(filterSummary), "筛选 1");
  await filterOption("series", "all").click();
  await waitCards(6);
  assert.equal(await filterSummary.count(), 0);
  await closeFilter();

  // The page reset clears both axes, while the menu reset is per-axis.
  await openFilter();
  await filterOption("watch", "watched").click();
  await waitCards(4);
  await filterOption("series", "finished").click();
  await waitCards(2);
  assert.deepEqual(await posterTitles.allInnerTexts(), ["完结四", "完结六"]);
  assert.deepEqual(await posterBadges.allInnerTexts(), ["全 12 集", "全 12 集"]);
  assert.equal(await normalize(filterSummary), "筛选 2");
  await closeFilter();
  await page.screenshot({ path: fileURLToPath(new URL("06-watched-finished.png", output)), animations: "disabled" });

  // Re-tapping 我的 resets content type and both filters.
  await resetAll();
  await page.getByRole("button", { name: /帖子/ }).click();
  await page.getByRole("button", { name: /短剧/ }).click();
  await waitCards(6);
  assert.equal(await filterButton.count(), 1);

  // A new episode moves a completed title back into watching.
  await resetAll();
  await openFilter();
  assert.equal(await normalize(filterOption("watch", "watching")), "在追剧 2");
  assert.equal(await normalize(filterOption("watch", "watched")), "已看完 4");
  await page.evaluate(async () => {
    const detail = window.__fixtureDetails.find(item => item.id === 3);
    detail.episode_count = 13;
    detail.total_episodes = 13;
    window.dispatchEvent(new CustomEvent("hg:line-changed"));
  });
  await page.waitForTimeout(300);
  if (await filterMenu.count()) await closeFilter();
  await openFilter();
  assert.equal(await normalize(filterOption("watch", "watching")), "在追剧 3");
  assert.equal(await normalize(filterOption("watch", "watched")), "已看完 3");
  await page.keyboard.press("Escape");
  await filterMenu.waitFor({ state: "detached" });

  console.log("PASS: combined watch and release filters stay independent, intersect, and follow new episodes");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await vite?.close();
}
