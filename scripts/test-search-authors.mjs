import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../test-results/search-authors", import.meta.url));
let vite, browser;

try {
  await mkdir(output, { recursive: true });
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
    viewport: { width: 430, height: 932 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["示例短剧"] });
  const page = await context.newPage();
  page.on("pageerror", error => { throw error; });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/search-nav-reset.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "搜索" }).click();

  const region = page.getByRole("region", { name: "热门作者" });
  await region.getByRole("button", { name: "全部作者 ›" }).waitFor({ timeout: 8000 });
  const topChips = region.locator("button[data-author-id]");
  assert.equal(await topChips.count(), 12, "search page shows the top 12 authors");
  assert.ok((await topChips.first().innerText()).includes("都市阿城"), "top author follows follower-count order");
  assert.equal(await region.getByRole("button", { name: "全部作者 ›" }).count(), 1, "all-authors link is present");

  await region.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "search-hot-authors.png"), animations: "disabled" });

  await region.getByRole("button", { name: "全部作者 ›" }).click();
  await page.getByRole("heading", { name: "作者", exact: true }).waitFor();
  const authorsPage = page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "作者", exact: true }) });
  const allChips = authorsPage.locator("button[data-author-id]");
  await allChips.first().waitFor();
  assert.equal(await allChips.count(), 16, "all-authors page shows the full directory");

  const first = allChips.first();
  const box = await first.boundingBox();
  assert(box, "author chip needs a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const board = authorsPage.locator("[data-followed-board]");
  await board.waitFor();
  assert.equal(await board.getByRole("button", { name: /都市阿城/ }).count(), 1, "long press follows the author and adds the followed board");
  assert.ok((await board.innerText()).includes("共 1 位"), "followed count updates");
  const followedChip = authorsPage.locator('button[data-author-id="100"]').last();
  assert.equal(await followedChip.getAttribute("data-following"), "true", "author chip reflects the followed state");
  await page.screenshot({ path: join(output, "all-authors-followed.png"), animations: "disabled" });

  const boardChip = board.locator('button[data-author-id="100"]');
  const boardBox = await boardChip.boundingBox();
  assert(boardBox, "followed chip needs a bounding box");
  await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(await board.count(), 0, "long press again unfollows the author and removes the board");

  console.log("PASS: search-authors (9 checks)");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
