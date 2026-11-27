import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/haptic-tap/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real mobile haptics listener in Chromium with touch input",
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
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  const cdp = await context.newCDPSession(page);
  const calls = () => page.evaluate(() => window.__HAPTIC_TEST__?.calls.length ?? -1);
  const lastCall = () => page.evaluate(() => window.__HAPTIC_TEST__?.calls.at(-1) ?? 0);
  const touch = async (startX, startY, endX, endY, steps = 8) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: startY, id: 1 }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: startX + (endX - startX) * step / steps, y: startY + (endY - startY) * step / steps, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
  };
  const hold = async (x, y, ms = 700) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
  };

  await page.goto(new URL("/tests/haptic-tap.html", origin).href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Tap 1", exact: true }).waitFor();
  await page.waitForTimeout(250);

  const first = page.getByRole("button", { name: "Tap 1", exact: true });
  const scrollButton = page.getByRole("button", { name: "Tap 3", exact: true });
  const box = await scrollButton.boundingBox();
  assert.ok(box, "scroll gesture can start on a button");
  await touch(box.x + box.width / 2, box.y + box.height / 2, box.x + box.width / 2, box.y - 140);
  assert.equal(await calls(), 0, "a scroll gesture starting on a button does not vibrate");
  report.checks.push("scroll gesture stays silent");

  await page.locator("[data-test-scroll]").evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(150);
  const tapBox = await first.boundingBox();
  assert.ok(tapBox);
  await touch(tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2, tapBox.x + tapBox.width / 2, tapBox.y + tapBox.height / 2, 1);
  assert.equal(await calls(), 1, "a completed tap vibrates once");
  report.checks.push("completed tap vibrates once");

  for (const name of ["打开排行榜", "观看历史"]) {
    const target = page.getByRole("button", { name, exact: true });
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    assert.ok(targetBox, `${name} needs a bounding box`);
    const before = await calls();
    await touch(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, 1);
    assert.equal((await calls()) - before, 1, `${name} tap vibrates once`);
    report.checks.push(`${name} tap vibrates once`);
  }

  const holdButton = page.getByRole("button", { name: /Hold Author/ });
  await holdButton.scrollIntoViewIfNeeded();
  const holdBox = await holdButton.boundingBox();
  assert.ok(holdBox, "author chip needs a bounding box");
  const beforeHold = await calls();
  await hold(holdBox.x + holdBox.width / 2, holdBox.y + holdBox.height / 2);
  assert.equal((await calls()) - beforeHold, 1, "long-press author vibrates once, not twice");
  assert.equal(await lastCall(), 18, "long-press author uses the medium pulse");
  report.checks.push("long-press author vibrates once");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: haptic-tap (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
