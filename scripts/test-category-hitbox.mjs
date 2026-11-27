import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/category-hitbox/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real Category page in Chromium with mocked Tauri IPC and pointer input",
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
    titles: ["Alpha", "Beta", "Gamma", "Delta"],
  });
  await context.addInitScript(() => {
    const channels = [
      { id: "category-a", label: "Category A", icon: "film", sorts: ["latest", "hot_window"] },
      { id: "category-b", label: "Category B", icon: "spark", sorts: ["latest", "hot_window"] },
      { id: "category-c", label: "Category C", icon: "award", sorts: ["latest", "hot_window"] },
      { id: "category-d", label: "Category D", icon: "clock", sorts: ["latest", "hot_window"] },
    ];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "source_state") {
        const state = await original(command, args);
        state.sources[0].catalog.channels = channels;
        return state;
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
  await page.goto(new URL("/tests/category-hitbox.html", origin).href, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Category A", exact: true }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);

  const section = page.locator('section[aria-label="Category A"]');
  const heading = page.getByRole("heading", { name: "Category A", exact: true });
  const header = section.locator("div").first();
  const buttons = header.getByRole("button");
  assert.equal(await buttons.count(), 1, "each section header exposes exactly one actionable control");
  assert.ok((await buttons.getAttribute("aria-label"))?.includes("Category A"), "the only control is the all link");
  const stack = () => page.locator("[data-test-stack]").getAttribute("data-test-stack");

  const box = await header.boundingBox();
  assert.ok(box, "section header is visible");
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.waitForTimeout(300);
  assert.equal(await stack(), "", "clicking the header row does not navigate");
  report.checks.push("section header is inert");

  await heading.click();
  await page.waitForTimeout(300);
  assert.equal(await stack(), "", "clicking the section title does not navigate");
  report.checks.push("section title is inert");

  await buttons.click();
  await page.waitForTimeout(300);
  assert.equal(await stack(), "channel", "clicking the all link opens the channel page");
  report.checks.push("all link opens the channel page");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: category-hitbox (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
