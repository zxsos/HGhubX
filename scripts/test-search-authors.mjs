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
  vite = await createServer({
    root,
    optimizeDeps: { entries: ["tests/search-nav-reset.html"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false },
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
  page.on("pageerror", error => { throw error; });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/search-nav-reset.html", origin).href, { waitUntil: "domcontentloaded" });
  await page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "搜索" }).click();

  const region = page.getByRole("region", { name: "热门作者" });
  await region.getByRole("button", { name: "全部作者 ›" }).waitFor({ timeout: 8000 });
  const topChips = region.locator("button[data-author-id]");
  await topChips.first().waitFor();
  assert.equal(await topChips.count(), 7, "search page shows the first seven of the top fourteen authors");
  assert.ok((await topChips.first().innerText()).includes("都市阿城"), "top author follows follower-count order");
  assert.ok(!(await topChips.first().innerText()).includes("万"), "search author chips hide follower counts");
  assert.equal(await region.getByRole("button", { name: "全部作者 ›" }).count(), 1, "all-authors link is present");
  assert.equal(await region.getByRole("button", { name: "换一批" }).count(), 1, "the next batch button is present");
  assert.equal(await region.getByRole("button", { name: "刷新作者" }).count(), 1, "the hot-authors refresh button is always available");

  await region.evaluate(element => element.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(output, "search-hot-authors.png"), animations: "disabled" });
  await region.getByRole("button", { name: "换一批" }).click();
  await page.waitForTimeout(120);
  assert.equal(await topChips.count(), 7, "the next batch still shows seven authors");
  assert.ok((await topChips.first().innerText()).includes("奇幻阿泽"), "the next batch starts at the eighth author");
  await page.screenshot({ path: join(output, "search-hot-authors-batch2.png"), animations: "disabled" });

  const directoryCalls = await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__());
  await region.getByRole("button", { name: "全部作者 ›" }).click();
  await page.getByRole("heading", { name: "作者", exact: true }).waitFor();
  const authorsPage = page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "作者", exact: true }) });
  const allChips = authorsPage.locator("button[data-author-id]");
  await allChips.first().waitFor();
  assert.equal(await allChips.count(), 35, "all-authors page shows every author found in the complete feed");
  assert.equal(await authorsPage.locator("[data-author-total]").getAttribute("data-author-total"), "35", "the header reports all thirty-five authors");
  assert.ok((await allChips.first().innerText()).includes("150万"), "author chips show the follower count");
  assert.ok((await allChips.nth(1).innerText()).includes("147.5万"), "authors stay ordered by follower count");
  const board = authorsPage.locator("[data-followed-board]");
  await board.waitFor();
  assert.equal(await board.getByRole("button", { name: /都市阿城/ }).count(), 0, "empty followed board is still visible");
  assert.ok((await board.innerText()).includes("共 0 位"), "empty followed board reports zero");
  assert.ok((await board.innerText()).includes("长按下方作者可关注"), "empty followed board keeps the follow hint");
  await page.screenshot({ path: join(output, "all-authors.png"), animations: "disabled" });

  const first = allChips.first();
  const box = await first.boundingBox();
  assert(box, "author chip needs a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(await board.getByRole("button", { name: /都市阿城/ }).count(), 1, "long press follows the author and adds the chip to the followed board");
  assert.ok((await board.innerText()).includes("共 1 位"), "followed count updates");
  assert.ok((await board.innerText()).includes("长按作者可关注或取消关注"), "followed board shows the follow/unfollow hint");
  assert.ok(!(await board.locator(".tag-pin-pill").innerText()).includes("150万"), "followed chips keep only the author name");
  const followedChip = authorsPage.locator('button[data-author-id="100"]').last();
  assert.equal(await followedChip.getAttribute("data-following"), "true", "author chip reflects the followed state");
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(output, "all-authors-followed.png"), animations: "disabled" });

  const boardChip = board.locator('button[data-author-id="100"]');
  const boardBox = await boardChip.boundingBox();
  assert(boardBox, "followed chip needs a bounding box");
  await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(await board.getByRole("button", { name: /都市阿城/ }).count(), 0, "long press again unfollows the author and removes the chip");
  assert.ok((await board.innerText()).includes("共 0 位"), "empty followed board stays visible after unfollowing");
  assert.ok((await board.innerText()).includes("长按下方作者可关注"), "empty followed board restores the follow hint");

  assert.equal(await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__()), directoryCalls, "opening the authors page reuses the cached directory");
  await authorsPage.getByRole("button", { name: "刷新作者" }).click();
  await page.waitForTimeout(5000);
  const refreshedCalls = await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__());
  assert.ok(refreshedCalls >= directoryCalls + 19 + 35, "the authors page refresh reloads every feed page and every follower stat");

  const beforeBack = await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__());
  await authorsPage.getByRole("button", { name: "返回" }).click();
  await region.waitFor();
  assert.equal(await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__()), beforeBack, "returning to search does not trigger a request");
  assert.equal(await region.getByRole("button", { name: "刷新作者" }).count(), 1, "the hot-authors refresh button remains after returning");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "搜索" }).click();
  const reloadedRegion = page.getByRole("region", { name: "热门作者" });
  await reloadedRegion.getByRole("button", { name: "全部作者 ›" }).waitFor({ timeout: 8000 });
  await reloadedRegion.locator("button[data-author-id]").first().waitFor();
  assert.equal(await page.evaluate(() => window.__AUTHOR_DIRECTORY_CALLS__()), 0, "the cached directory survives a reload without a request");
  assert.ok((await reloadedRegion.locator("button[data-author-id]").first().innerText()).includes("都市阿城"), "the cached order stays by follower count");

  console.log("PASS: search-authors (20 checks)");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
