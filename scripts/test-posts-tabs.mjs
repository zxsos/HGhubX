import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/posts-tabs/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real PostsPage in Chromium with mocked Tauri IPC and touch input",
  checks: [],
  errors: [],
};
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/local/bin/chromium"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await context.addInitScript(installFixture, {
    theme: "dark",
    titles: Array.from({ length: 12 }, (_, i) => `Alpha ${i + 1}`),
  });
  await context.addInitScript(() => {
    const categories = [
      { id: 9002, intro: "", name: "Category A", route: "category-a", sort: 1 },
      { id: 9003, intro: "", name: "Category B", route: "category-b", sort: 2 },
    ];
    const posts = (prefix) => Array.from({ length: 12 }, (_, i) => ({
      id: 9000 + i,
      title: `${prefix} ${i + 1}`,
      cover: "",
      tags: ["general"],
      hot: 12000 + i * 100,
      like_count: 120,
      collect_count: 80,
      comment_count: 12,
    }));
    const paged = (prefix) => ({
      items: posts(prefix),
      pagination: { page: 1, pages: 39, size: 20, total: 468 },
    });
    const state = { calls: [] };
    window.__POSTS_TABS_TEST__ = state;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      state.calls.push({ command, args });
      if (command === "api_post_categories") return { items: categories };
      if (command === "api_posts") return paged("全部");
      if (command === "api_post_category") {
        return paged(args.route === "category-a" ? "Alpha" : "Beta");
      }
      return original(command, args);
    };
  });

  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  const cdp = await context.newCDPSession(page);
  const swipe = async (dx, dy = 0) => {
    const box = await page.locator("[data-posts-scroll]").boundingBox();
    assert.ok(box, "posts scroll container is visible");
    const x = box.x + box.width - 30;
    const y = box.y + Math.min(180, box.height * 0.2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(420);
  };
  const activeTab = () => page.locator(".ios-subpage-header [aria-pressed=\"true\"]").innerText();
  const calls = () => page.evaluate(() => window.__POSTS_TABS_TEST__.calls);

  await page.goto(new URL("/tests/posts-tabs.html", origin).href, { waitUntil: "networkidle" });
  await page.locator("[data-posts-scroll]").waitFor();
  await page.getByRole("button", { name: "Category A", exact: true }).waitFor();
  await page.waitForTimeout(420);

  assert.deepEqual(
    await page.locator("button.ios-filter-pill").allTextContents(),
    ["Category A", "Category B"],
    "only the real source categories are rendered",
  );
  assert.equal(await page.getByText("全部", { exact: true }).count(), 0, "the all tab is removed");
  assert.equal(await activeTab(), "Category A", "first source category is selected by default");
  report.checks.push("no all tab; first source category is the default");

  const initialCalls = await calls();
  assert.ok(
    initialCalls.some(call => call.command === "api_post_category" && call.args.route === "category-a"),
    "the initial request uses the first category",
  );
  assert.equal(
    initialCalls.some(call => call.command === "api_posts"),
    false,
    "the all-posts endpoint is not requested",
  );
  assert.match(await page.locator(".ios-media-grid").innerText(), /Alpha 1/);
  report.checks.push("initial request is api_post_category(category-a), not api_posts");

  await swipe(-150);
  await page.waitForFunction(() => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === "Category B");
  assert.equal(await activeTab(), "Category B", "swipe left selects the second tab");
  assert.match(await page.locator(".ios-media-grid").innerText(), /Beta 1/);
  report.checks.push("swipe left selects the second category and loads its feed");

  await swipe(-150);
  assert.equal(await activeTab(), "Category B", "last tab does not wrap");
  await swipe(150);
  await page.waitForFunction(() => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === "Category A");
  assert.equal(await activeTab(), "Category A", "swipe right returns to the first tab");
  report.checks.push("swipe tabs forward/back without wrapping");

  await swipe(6, 150);
  assert.equal(await activeTab(), "Category A", "vertical swipe does not switch tabs");
  report.checks.push("vertical scroll is ignored by the tab gesture");

  await page.getByRole("button", { name: "Category B", exact: true }).click();
  await page.waitForTimeout(420);
  assert.equal(await activeTab(), "Category B", "clicking a tab selects it");
  await page.getByRole("button", { name: "Category B", exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await activeTab(), "Category B", "clicking the active tab does not clear selection");
  report.checks.push("tab clicks cannot clear the selection back to all");

  await page.screenshot({ path: fileURLToPath(new URL("posts-tabs.png", output)), animations: "disabled" });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: posts-tabs (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
