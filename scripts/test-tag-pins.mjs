import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/tag-pins/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real TagsPage in Chromium with mocked Tauri IPC", checks: [], errors: [] };
const tagGroups = [
  { name: "题材", tags: [
    { id: 1, name: "都市", slug: "city", hot_score: 286000 },
    { id: 2, name: "悬疑", slug: "suspense", hot_score: 188000 },
    { id: 3, name: "甜宠", slug: "sweet", hot_score: 96000 },
  ] },
  { name: "人物", tags: [
    { id: 4, name: "大男主", slug: "male-lead" },
    { id: 5, name: "年下", slug: "younger" },
  ] },
];
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["甲", "乙", "丙"], tagGroups });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  await page.goto(new URL("/tests/tag-pins.html", origin).href, { waitUntil: "networkidle" });
  const board = page.locator("[data-pin-board]");
  await board.waitFor();
  assert.equal(await board.getByText("长按下方标签可置顶").count(), 1);
  assert.equal(await board.locator("[data-tag-name]").count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL("tag-pins-empty.png", output)), animations: "disabled" });
  report.checks.push("tags page opens a discoverable empty pin board");

  await page.locator('[data-tag-name="悬疑"]').click();
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), []);
  report.checks.push("a normal tap does not pin a tag");

  const target = page.locator('[data-tag-name="都市"]');
  const box = await target.boundingBox();
  assert(box, "tag chip must have a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(140);
  assert.equal(await target.getAttribute("data-pressing"), "true");
  await page.waitForTimeout(620);
  await page.mouse.up();
  await board.locator('[data-tag-name="都市"]').waitFor();
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), ["都市"]);
  assert.equal(await page.locator('[data-tag-name="都市"][data-pinned="true"]').count(), 2, "pinned tag should appear on the board and remain marked in its group");
  const boardChip = board.locator('[data-tag-name="都市"][data-pin-surface="board"]');
  const groupChip = page.locator('[data-tag-name="都市"][data-pin-surface="group"]');
  assert.equal(await boardChip.count(), 1, "pinned board chip should be marked as the board surface");
  assert.equal(await groupChip.count(), 1, "pinned group chip should be marked as the group surface");
  assert.equal(await page.locator('.tag-pin-mark').count(), 0, "pinned chips should not render a trailing pin icon");
  assert.notEqual(await boardChip.evaluate(el => getComputedStyle(el).borderColor), await groupChip.evaluate(el => getComputedStyle(el).borderColor), "board chip should not use the pinned outline");
  report.checks.push("long-press pins a tag without opening the tag feed");
  report.checks.push("board chip removes the pin mark and outlined highlight while group chip keeps the outline");

  await page.screenshot({ path: fileURLToPath(new URL("tag-pins-pinned.png", output)), animations: "disabled" });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("[data-pin-board]").locator('[data-tag-name="都市"]').waitFor();
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), ["都市"]);
  report.checks.push("pinned tags persist across reloads");

  const pinnedTarget = page.locator("[data-pin-board]").locator('[data-tag-name="都市"]');
  const pinnedBox = await pinnedTarget.boundingBox();
  assert(pinnedBox, "pinned chip must have a bounding box");
  await page.mouse.move(pinnedBox.x + pinnedBox.width / 2, pinnedBox.y + pinnedBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.getByText("长按下方标签可置顶").waitFor();
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), []);
  report.checks.push("long-press again unpins the tag");

  const moved = page.locator('[data-tag-name="悬疑"]');
  const movedBox = await moved.boundingBox();
  assert(movedBox, "second tag chip must have a bounding box");
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedBox.x + movedBox.width / 2 + 24, movedBox.y + movedBox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), []);
  report.checks.push("dragging across a tag cancels the hold");

  const detail = await context.newPage();
  detail.on("pageerror", error => report.errors.push(error.message));
  await detail.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await detail.goto(new URL("/tests/tag-pin-detail.html?tag=都市", origin).href, { waitUntil: "networkidle" });
  const pinButton = detail.getByRole("button", { name: "置顶此标签" });
  await pinButton.waitFor();
  assert.equal(await detail.getByRole("button", { name: "搜索短剧" }).count(), 0, "tag result header must replace search with pin");
  const titleBox = await detail.getByRole("heading", { name: "都市" }).boundingBox();
  const pinBox = await pinButton.boundingBox();
  const tagIconBox = await detail.locator(".ios-subpage-bar > span.w-9").first().boundingBox();
  assert(titleBox && pinBox && tagIconBox, "tag title, header icon and pin button need bounding boxes");
  assert(Math.abs((tagIconBox.y + tagIconBox.height / 2) - (pinBox.y + pinBox.height / 2)) < 6, "pin must be vertically centered with the header tag icon");
  assert(pinBox.x > titleBox.x + titleBox.width, "pin must occupy the trailing header slot, not sit beside the title");
  report.checks.push("tag result page exposes a trailing pin centered with the header tag icon instead of search");

  const pinIcon = pinButton.locator("svg");
  const unpinnedLook = await pinButton.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  assert(["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(await pinIcon.evaluate(el => getComputedStyle(el).transform)), "unpinned header pin should stay diagonal");
  await detail.screenshot({ path: fileURLToPath(new URL("tag-page-pin-unpinned.png", output)), animations: "disabled" });

  await pinButton.click();
  await detail.getByRole("button", { name: "取消置顶此标签" }).waitFor();
  await detail.waitForTimeout(250);
  const pinnedLook = await pinButton.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  const pinnedTransform = await pinIcon.evaluate(el => getComputedStyle(el).transform);
  assert(pinnedTransform.includes("-0.707107"), "pinned header pin should rotate to point down");
  assert.deepEqual(pinnedLook, unpinnedLook, "pinned state should only change the pin orientation");
  report.checks.push("header pin keeps the circular accent treatment and rotates to point down when pinned");
  assert.deepEqual(await detail.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), ["都市"]);
  await detail.screenshot({ path: fileURLToPath(new URL("tag-page-pin.png", output)), animations: "disabled" });
  report.checks.push("pinning from a direct tag page persists the tag");

  await detail.getByRole("button", { name: "取消置顶此标签" }).click();
  assert.deepEqual(await detail.evaluate(() => (JSON.parse(localStorage.getItem("hghubx_content_preferences_v1") || "{}").pinnedTags || [])), []);
  report.checks.push("pinning again from the tag page unpins it");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: tag-pins (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}
