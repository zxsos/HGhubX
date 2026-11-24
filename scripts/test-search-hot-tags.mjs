import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let vite, browser;

try {
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
  await context.addInitScript(installFixture, { theme: "light", titles: ["示例短剧"] });
  const initialHot = [
    "都市", "古风", "奇幻", "现代", "职场", "逆袭",
    "校园", "绿帽", "熟女", "母子", "乱伦", "系统",
    "仙侠", "后宫", "大男主",
  ];
  const updatedHot = ["武侠", "悬疑", "脑洞"];
  await context.addInitScript(({ initialHot, updatedHot }) => {
    const orig = window.__TAURI_INTERNALS__.invoke;
    let callCount = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "api_tags") {
        return {
          categories: [{
            name: "全量目录",
            tags: [
              { id: 99, name: "非热门高分标签A", slug: "non-hot-a", is_hot: true, hot_score: 999999 },
              { id: 98, name: "非热门高分标签B", slug: "non-hot-b", is_hot: true, hot_score: 888888 },
            ],
          }],
        };
      }
      if (command === "api_hot_tags") {
        callCount += 1;
        const list = callCount === 1 ? initialHot : updatedHot;
        return { items: list.map((name, i) => ({ name, slug: `slug-${i}` })) };
      }
      return orig(command, args);
    };
  }, { initialHot, updatedHot });

  const page = await context.newPage();
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/search-nav-reset.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "搜索" }).click();
  const region = page.getByRole("region", { name: "热门题材" });
  await region.getByRole("button", { name: "都市" }).waitFor({ timeout: 8000 });

  const getChips = () => region.locator("button.ios-filter-pill").allTextContents();
  assert.deepEqual(await getChips(), initialHot.slice(0, 12), "first batch matches upstream hot tag order");

  await region.getByRole("button", { name: "换一批" }).click();
  const batch2 = await getChips();
  assert.deepEqual(batch2, initialHot.slice(12), "second batch stays within official hot tags only");
  assert.ok(!batch2.some(tag => tag.includes("非热门")), "catalog-only tags never leak into hot tags");

  await page.evaluate(() => {
    localStorage.setItem("hghubx_content_preferences_v1", JSON.stringify({ blockedTags: ["古风"], hideUntagged: false, paused: false }));
    window.dispatchEvent(new StorageEvent("storage", { key: "hghubx_content_preferences_v1" }));
  });
  await region.getByRole("button", { name: "换一批" }).click();
  const afterBlock = await getChips();
  assert.ok(!afterBlock.includes("古风"), "blocked tag is hidden from hot tags");
  assert.deepEqual(afterBlock, initialHot.filter(t => t !== "古风").slice(0, 12), "blocking preserves upstream order");

  await region.getByRole("button", { name: "刷新题材" }).click();
  await region.getByRole("button", { name: "武侠" }).waitFor({ timeout: 5000 });
  assert.deepEqual(await getChips(), updatedHot, "refresh picks up updated official hot tags");
  assert.equal(await region.getByRole("button", { name: "换一批" }).count(), 0, "batch button hides when <= 12 tags");

  console.log("PASS: search-hot-tags (4 checks)");
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}
