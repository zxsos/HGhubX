import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../test-results/followed-authors", import.meta.url));
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
  await context.addInitScript(installFixture, { theme: "dark", titles: ["示例短剧"], follows: [100] });
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
  await region.getByRole("button", { name: "全部作者 ›" }).click();
  const authorsPage = page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "作者", exact: true }) });
  const board = authorsPage.locator("[data-followed-board]");
  await board.waitFor();
  assert.equal(await board.getByRole("button", { name: /都市阿城/ }).count(), 1, "followed author appears on the authors page");
  assert.ok((await board.innerText()).includes("共 1 位"), "followed count is shown");
  assert.ok((await board.innerText()).includes("长按作者可关注或取消关注"), "follow hint sits under the followed board");
  const authorList = authorsPage.locator("[data-author-list]");
  assert.ok(!(await authorList.innerText()).includes("长按作者可关注或取消关注"), "follow hint is not under the all-authors section");
  await page.screenshot({ path: join(output, "authors-followed.png"), animations: "disabled" });
  console.log("PASS: followed-authors (3 checks)");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
