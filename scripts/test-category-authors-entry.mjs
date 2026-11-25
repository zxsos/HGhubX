import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/category-authors-entry/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real Category page in Chromium with mocked Tauri IPC",
  checks: [],
  errors: [],
};
let vite, browser;

try {
  vite = await createServer({
    root,
    optimizeDeps: { entries: ["tests/search-nav-reset.html"] },
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
    viewport: { width: 430, height: 932 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["示例短剧"] });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  await page.goto(new URL("/tests/search-nav-reset.html", origin).href, { waitUntil: "domcontentloaded" });
  await page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "分类" }).click();
  const categories = page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "分类", exact: true }) });
  await categories.getByRole("button", { name: "作者", exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await categories.getByRole("button", { name: "标签", exact: true }).count(), 1, "tags entry remains available");
  assert.equal(await categories.getByRole("button", { name: "作者", exact: true }).count(), 1, "authors entry sits beside tags");
  await page.screenshot({ path: join(fileURLToPath(output), "category-entries.png"), animations: "disabled" });
  report.checks.push("category page: the last shortcut cell is split into half tags and half authors");

  await categories.getByRole("button", { name: "作者", exact: true }).click();
  await page.getByRole("heading", { name: "作者", exact: true }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: join(fileURLToPath(output), "category-authors-page.png"), animations: "disabled" });
  report.checks.push("category page: the authors half opens the authors directory");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: category-authors-entry (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
