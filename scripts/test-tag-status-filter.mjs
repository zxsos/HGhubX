import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/tag-status-filter/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real TagPage in Chromium with mocked Tauri IPC",
  checks: [],
  errors: [],
};
const titles = ["甲", "乙", "丙"];
const metrics = [
  { hot: 3000, like_count: 10, collect_count: 200, score: 6 },
  { hot: 9000, like_count: 90, collect_count: 40, score: 8 },
  { hot: 5000, like_count: 50, collect_count: 150, score: 9 },
];
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false }, optimizeDeps: { entries: ["tests/tag-metric-sort.html"] } });
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
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles, metrics, metricPages: 2, metricPageSize: 2 });
  await context.addInitScript(() => {
    const internals = window.__TAURI_INTERNALS__;
    const baseInvoke = internals.invoke;
    window.__TAG_STATUS_CALLS__ = 0;
    internals.invoke = async (command, args = {}) => {
      if (command === "api_tag_videos" && args.size === 100 && args.page === 1) window.__TAG_STATUS_CALLS__ += 1;
      const result = await baseInvoke(command, args);
      if (command === "api_tag_videos" && Array.isArray(result?.items)) {
        result.items = result.items.map((item, index) => ({ ...item, is_finished: index !== 1 }));
      }
      return result;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  const trigger = () => page.locator("[data-tag-status-trigger]");
  const sortTrigger = () => page.locator("[data-video-sort-trigger]");
  const cardTitles = () => page.locator(".ios-media-grid .ios-poster-title").allInnerTexts();
  const waitOrder = async values => {
    await page.waitForFunction(expected => {
      const actual = [...document.querySelectorAll(".ios-media-grid .ios-poster-title")].map(node => node.textContent);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, values);
    assert.deepEqual(await cardTitles(), values);
  };
  const openStatus = async () => {
    if (await page.getByRole("menu", { name: "连载状态" }).count()) return;
    await trigger().click();
    await page.getByRole("menu", { name: "连载状态" }).waitFor();
  };
  const selectStatus = async value => {
    await openStatus();
    await page.locator(`[data-tag-status-option="${value}"]`).click();
  };
  const selectSort = async label => {
    if (!(await page.getByRole("menu", { name: "排序方式" }).count())) {
      await sortTrigger().click();
      await page.getByRole("menu", { name: "排序方式" }).waitFor();
    }
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  };
  const calls = () => page.evaluate(() => window.__TAG_STATUS_CALLS__);

  await page.goto(new URL("/tests/tag-metric-sort.html?tag=悬疑", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-media-grid").waitFor();
  await waitOrder(titles);
  assert.equal(await calls(), 0);
  await selectSort("点赞数");
  await waitOrder(["乙", "丙", "甲"]);
  assert.equal(await calls(), 1);
  await openStatus();
  assert.deepEqual(await page.locator('[role="menuitemradio"]').allInnerTexts(), ["全部\n3", "连载中\n1", "已完结\n2"]);
  await page.screenshot({ path: fileURLToPath(new URL("tag-status-menu.png", output)), animations: "disabled" });
  report.checks.push("tag page: clicking 短剧 N opens 全部 / 连载中 / 已完结 with full-result counts");

  await selectStatus("finished");
  await waitOrder(["丙", "甲"]);
  assert.match(await trigger().innerText(), /已完结\s*2/);
  assert.match(await sortTrigger().innerText(), /点赞数/);
  assert.equal(await calls(), 1);
  await page.screenshot({ path: fileURLToPath(new URL("tag-status-finished-like.png", output)), animations: "disabled" });
  report.checks.push("tag page: 已完结 + 点赞数 combine; status survives sorting and only one full fetch is made");

  await selectStatus("ongoing");
  await waitOrder(["乙"]);
  assert.match(await trigger().innerText(), /连载中\s*1/);
  assert.match(await sortTrigger().innerText(), /点赞数/);
  assert.equal(await calls(), 1);
  await selectSort("默认排序");
  await waitOrder(["乙"]);
  assert.match(await trigger().innerText(), /连载中\s*1/);
  assert.equal((await sortTrigger().innerText()).trim(), "");
  await page.screenshot({ path: fileURLToPath(new URL("tag-status-ongoing-default.png", output)), animations: "disabled" });
  report.checks.push("tag page: sorting survives status changes; resetting sort keeps the active status");

  await selectStatus("all");
  await waitOrder(titles);
  await selectSort("默认排序");
  await waitOrder(titles);
  assert.equal((await trigger().innerText()).trim(), "短剧\n3");
  await openStatus();
  assert.deepEqual(await page.locator('[role="menuitemradio"]').allInnerTexts(), ["全部\n3", "连载中\n1", "已完结\n2"]);
  await page.screenshot({ path: fileURLToPath(new URL("tag-status-default-menu.png", output)), animations: "disabled" });
  await selectStatus("finished");
  await waitOrder(["甲", "丙"]);
  assert.equal((await sortTrigger().innerText()).trim(), "");
  await selectSort("评分");
  await waitOrder(["丙", "甲"]);
  assert.match(await trigger().innerText(), /已完结\s*2/);
  assert.match(await sortTrigger().innerText(), /评分/);
  assert.equal(await calls(), 1);
  report.checks.push("tag page: selecting status first keeps the default sort; selecting a metric afterwards keeps the status");

  // Keyboard path mirrors the sort menu: ArrowDown opens, Escape closes to trigger.
  await trigger().focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menu", { name: "连载状态" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "连载状态" }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-tag-status-trigger")), true);
  report.checks.push("tag status menu: ArrowDown opens; Escape closes and returns focus");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: tag-status-filter (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
