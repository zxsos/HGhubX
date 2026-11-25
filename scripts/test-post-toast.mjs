import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/post-toast/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real PostDetail/AppProvider with mocked Tauri IPC", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/post-toast.html", origin).href, { waitUntil: "networkidle" });
  await page.getByText("示例帖子").waitFor();
  const actions = page.locator("button[aria-pressed]");
  assert.equal(await actions.count(), 2, "post detail must expose like and favorite actions");
  await actions.nth(0).click();
  await page.waitForFunction(() => document.querySelector(".a-toast")?.textContent?.includes("已加入喜欢"));
  await actions.nth(1).click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator(".a-toast").count(), 1, "post like and favorite must share one toast slot");
  assert.equal((await page.locator(".a-toast").innerText()).trim(), "已收藏", "the latest post action must replace the previous toast");
  report.checks.push("post like and favorite share one toast slot");
  await page.screenshot({ path: fileURLToPath(new URL("post-action-toast.png", output)), animations: "disabled" });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: post-toast (${report.checks.length} check)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
}
