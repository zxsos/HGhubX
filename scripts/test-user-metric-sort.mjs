import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/user-metric-sort/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real UserPage in Chromium with mocked Tauri IPC",
  checks: [],
  errors: [],
};
const titles = ["甲", "乙", "丙"];
const metrics = [
  { hot: 3000, like_count: 10, collect_count: 200, score: 6 },
  { hot: 9000, like_count: 90, collect_count: 40, score: 8 },
  { hot: 5000, like_count: 50, collect_count: 150, score: 9 },
];
const expected = {
  点赞数: ["乙", "丙", "甲"],
  收藏数: ["甲", "丙", "乙"],
  播放数: ["乙", "丙", "甲"],
  评分: ["丙", "乙", "甲"],
  默认排序: ["甲", "乙", "丙"],
};
const expectedAsc = {
  点赞数: ["甲", "丙", "乙"],
  收藏数: ["乙", "丙", "甲"],
  播放数: ["甲", "丙", "乙"],
  评分: ["甲", "乙", "丙"],
};
let vite, browser;

try {
  vite = await createServer({
    root,
    optimizeDeps: { entries: ["tests/user-metric-sort.html"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
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
  await context.addInitScript(installFixture, { theme: "dark", titles, metrics, metricPages: 2, metricPageSize: 2, finished: [true, false, true] });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  const cardTitles = () => page.locator(".ios-media-grid .ios-poster-title").allInnerTexts();
  const waitOrder = async values => {
    await page.waitForFunction(expected => {
      const actual = [...document.querySelectorAll(".ios-media-grid .ios-poster-title")].map(node => node.textContent);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, values);
    assert.deepEqual(await cardTitles(), values);
  };
  const openSortMenu = async () => {
    const menu = page.getByRole("menu", { name: "排序方式" });
    if (await menu.count()) return;
    await page.locator("[data-video-sort-trigger]").click();
    await menu.waitFor();
  };
  const selectSort = async label => {
    await openSortMenu();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await waitOrder(expected[label]);
    assert.match(await page.locator("[data-video-sort-trigger]").innerText(), new RegExp(label));
  };
  const resetSort = async () => {
    await openSortMenu();
    await page.getByRole("menuitemradio", { name: "默认排序", exact: true }).click();
    await waitOrder(expected.默认排序);
    assert.equal((await page.locator("[data-video-sort-trigger]").innerText()).trim(), "");
    assert.equal(await page.getByRole("menu").count(), 0);
  };

  await page.goto(new URL("/tests/user-metric-sort.html", origin).href, { waitUntil: "domcontentloaded" });
  await page.locator("[data-video-sort-trigger]").waitFor();
  await waitOrder(expected.默认排序);
  assert.match(await page.locator("[data-work-status-trigger]").innerText(), /作品\s*3/u);
  await page.screenshot({ path: fileURLToPath(new URL("user-default.png", output)), animations: "disabled" });
  await page.locator("[data-video-sort-trigger]").click();
  await page.getByRole("menu", { name: "排序方式" }).waitFor();
  assert.equal(await page.getByRole("menuitemradio", { name: "默认排序", exact: true }).count(), 1);
  assert.equal(await page.locator('[role="menuitemradio"][data-sort-direction="desc"]').count(), 4);
  await page.screenshot({ path: fileURLToPath(new URL("user-menu.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  for (const label of ["点赞数", "收藏数", "播放数", "评分"]) {
    await selectSort(label);
  }
  await openSortMenu();
  await page.getByRole("menuitemradio", { name: "评分", exact: true }).click();
  await waitOrder(expectedAsc.评分);
  assert.equal(await page.locator("[data-video-sort-trigger]").getAttribute("data-sort-direction"), "asc");
  await page.screenshot({ path: fileURLToPath(new URL("user-score-asc.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  await resetSort();
  report.checks.push("user page: the sorter sits on the works heading row; all four metrics reorder the author works and toggle direction");

  await page.locator("[data-work-status-trigger]").click();
  await page.locator('[data-work-status-option="finished"]').click();
  await waitOrder(["甲", "丙"]);
  assert.match(await page.locator("[data-work-status-trigger]").innerText(), /已完结 2/);
  await openSortMenu();
  await page.getByRole("menuitemradio", { name: "点赞数", exact: true }).click();
  await waitOrder(["丙", "甲"]);
  await page.screenshot({ path: fileURLToPath(new URL("user-finished-like.png", output)), animations: "disabled" });
  await page.locator("[data-work-status-trigger]").click();
  await page.getByRole("menu", { name: "作品状态筛选" }).waitFor();
  assert.equal(await page.getByRole("menuitemradio", { name: "连载中 1", exact: true }).count(), 1);
  assert.equal(await page.getByRole("menuitemradio", { name: "已完结 2", exact: true }).count(), 1);
  await page.screenshot({ path: fileURLToPath(new URL("user-status-menu.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.locator("[data-work-status-trigger]").click();
  await page.locator('[data-work-status-option="ongoing"]').click();
  await waitOrder(["乙"]);
  assert.match(await page.locator("[data-video-sort-trigger]").innerText(), /点赞数/);
  report.checks.push("user page: status filter combines with the existing metric sort and uses the loaded works");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: user-metric-sort (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
