import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "test-results", "comments-autoload");
const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 700 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir(output, { recursive: true });
  await page.goto(new URL("/tests/comments-autoload.html", vite.resolvedUrls.local[0]).href, { waitUntil: "networkidle" });

  const scroll = page.getByTestId("comments-scroll");
  await scroll.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-item"]').length === 20);
  assert.equal(await page.getByText("查看更多", { exact: true }).count(), 0, "manual load-more button must be removed");
  assert.deepEqual(await page.evaluate(() => window.commentsAutoloadProbe.calls()), [1]);
  const initial = await scroll.evaluate(el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(initial.scrollHeight > initial.clientHeight, "first page should overflow so the list is scrollable");
  await page.screenshot({ path: path.join(output, "comments-page-1.png") });
  console.log("✓ first page renders without a manual 查看更多 button");

  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-item"]').length === 40);
  await page.waitForFunction(() => document.querySelector('[data-testid="comments-scroll"]')?.getAttribute("aria-busy") === "false");
  assert.deepEqual(await page.evaluate(() => window.commentsAutoloadProbe.calls()), [1, 2]);
  console.log("✓ scrolling to the bottom auto-loads page 2");

  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="comment-item"]').length === 60);
  await page.waitForFunction(() => document.querySelector('[data-testid="comments-scroll"]')?.getAttribute("aria-busy") === "false");
  await page.getByText("— 到底啦 —", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.commentsAutoloadProbe.calls()), [1, 2, 3]);
  assert.equal(await page.getByText("查看更多", { exact: true }).count(), 0);
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.screenshot({ path: path.join(output, "comments-page-3.png") });
  console.log("✓ scrolling again auto-loads page 3 and reaches the end");

  assert.deepEqual(errors, []);
  console.log("PASS comments-autoload: 3 pages loaded by scrolling only");
} finally {
  await browser?.close();
  await vite.close();
}
