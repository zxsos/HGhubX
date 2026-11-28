import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/channel-swipe/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real ChannelPage in Chromium with mocked Tauri IPC and touch input", checks: [], errors: [] };
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
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["城市与晚风", "重逢在夏日以后", "星河旅人"] });
  await context.addInitScript(() => {
    const namedChannel = {
      id: "named",
      label: "命名排序",
      icon: "clock",
      sorts: [
        { key: "latest", name: "更新更新" },
        { key: "hot_window", name: "当前热播", default: true },
        { key: "random", name: "精选推荐" },
      ],
    };
    const calls = [];
    window.__sortCalls = calls;
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "api_category") calls.push(args.sort);
      if (command === "source_state") {
        const state = await original(command, args);
        const channels = state.sources[0].catalog.channels;
        if (!channels.some(channel => channel.id === namedChannel.id)) channels.push(namedChannel);
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
  const cdp = await context.newCDPSession(page);
  const swipe = async (dx, dy = 0) => {
    const box = await page.locator(".ios-page > .scroll-y").boundingBox();
    assert.ok(box);
    const x = box.x + box.width - 26;
    const y = box.y + Math.min(220, box.height * 0.28);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(140);
  };
  const activeTab = () => page.locator(".ios-subpage-header [aria-pressed=\"true\"]").innerText();

  const cases = [
    ["featured", ["最近更新", "当前热播", "精选推荐"]],
    ["archive", ["最近更新", "当前热播", "精选推荐"]],
    ["special", ["全部专题", "热门专题", "最新专题"]],
  ];
  for (const [cate, tabs] of cases) {
    await page.goto(new URL(`/tests/channel-swipe.html?cate=${cate}`, origin).href, { waitUntil: "networkidle" });
    await page.locator(".ios-page > .scroll-y").waitFor();
    await page.getByRole("button", { name: tabs[0], exact: true }).waitFor();
    await page.waitForTimeout(420);
    assert.equal(await activeTab(), tabs[0], `${cate}: initial tab`);

    await swipe(-128);
    await page.waitForFunction(expected => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === expected, tabs[1]);
    assert.equal(await activeTab(), tabs[1], `${cate}: swipe left to second tab`);
    await swipe(-128);
    await page.waitForFunction(expected => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === expected, tabs[2]);
    assert.equal(await activeTab(), tabs[2], `${cate}: swipe left to third tab`);

    await swipe(-128);
    await page.waitForTimeout(140);
    assert.equal(await activeTab(), tabs[2], `${cate}: last tab does not wrap`);

    await swipe(128);
    await page.waitForFunction(expected => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === expected, tabs[1]);
    assert.equal(await activeTab(), tabs[1], `${cate}: swipe right to previous tab`);

    await swipe(6, 120);
    await page.waitForTimeout(140);
    assert.equal(await activeTab(), tabs[1], `${cate}: vertical swipe does not switch tabs`);
    report.checks.push(`${cate}: swipe tabs forward/back without wrap; vertical scroll is ignored`);
  }

  await page.goto(new URL("/tests/channel-swipe.html?cate=named", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page > .scroll-y").waitFor();
  const namedTabs = page.locator(".ios-subpage-header .ios-filter-pill");
  await namedTabs.first().waitFor();
  const namedLabels = (await namedTabs.allTextContents()).filter(Boolean);
  assert.deepEqual(namedLabels, ["更新更新", "当前热播", "精选推荐"], "tab labels and order match source sorts");
  assert.equal(await activeTab(), "当前热播", "sort marked default:true is selected instead of the first tab");
  const firstCalls = await page.evaluate(() => window.__sortCalls);
  assert.ok(firstCalls.includes("hot_window"), "default tab sends the source key, not its label");
  await page.getByRole("button", { name: "精选推荐", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".ios-subpage-header [aria-pressed=\"true\"]")?.textContent === "精选推荐");
  const nextCalls = await page.evaluate(() => window.__sortCalls);
  assert.ok(nextCalls.includes("random"), "named tab sends its key");
  report.checks.push("named sort labels/order come from the source; default:true selects the middle tab; requests keep source keys");

  await page.screenshot({ path: fileURLToPath(new URL("channel-swipe.png", output)), animations: "disabled" });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: channel-swipe (${report.checks.length} categories)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
