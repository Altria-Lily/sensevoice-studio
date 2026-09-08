// Browser regression with a synthetic 12,000-segment response.
// All writes are intercepted in memory: no real user result is edited.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const baseURL = process.argv[2] || "http://127.0.0.1:8001";
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const count = 12000;
  const job = {
    id, filename: "产品讨论会 · 转写校对示例.mp4", state: "completed", progress: 100,
    has_result: true, language: "zh", identify_speakers: true,
    transcript: {
      speaker_names: { SPK0: "说话人甲", SPK1: "说话人乙" }, duration: count * 3,
      duration_ms: count * 3000, text: "", segments: Array.from({ length: count }, (_, index) => ({
        id: index, start: index * 3, end: index * 3 + 2,
        start_ms: index * 3000, end_ms: index * 3000 + 2000,
        text: "测试片段 " + index + "：用于验证连续阅读与滚动校对。" + (index % 13 === 0 ? "不同长度的发言也应平稳衔接，搜索和导出包含全部文字。".repeat(4) : ""), speaker: "SPK" + (index % 2),
      })),
    },
  };
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/jobs/" + id, (route) => route.fulfill({ json: job }));
    let mediaRequests = 0;
    await page.route("**/api/jobs/" + id + "/media", (route) => { mediaRequests += 1; return route.abort(); });
    let patch = null;
    await page.route("**/api/jobs/" + id + "/result", async (route) => {
      patch = route.request().postDataJSON();
      Object.assign(job.transcript.speaker_names, patch.speaker_names);
      for (const change of patch.segments) Object.assign(job.transcript.segments[change.id], change);
      await route.fulfill({ json: job.transcript });
    });
    // Cold model health is intentionally delayed. Existing text must not wait.
    await page.route("**/api/health", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({ json: { status: "setup_required", ffmpeg: {}, model: {} } });
    });
    const started = performance.now();
    await page.goto("/#job=" + id);
    await page.locator("#resultView").waitFor({ state: "visible" });
    const openMs = Math.round(performance.now() - started);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const visibleId = () => page.evaluate(() => {
      const bounds = document.querySelector("#timelineScroll").getBoundingClientRect();
      const row = [...document.querySelectorAll(".segment")].find((item) => {
        const box = item.getBoundingClientRect();
        return box.top >= bounds.top - 1 && box.top < bounds.bottom;
      });
      return Number(row?.dataset.id);
    });
    const scrollTo = async (fraction) => {
      await page.locator("#timelineScroll").evaluate((element, value) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * value; }, fraction);
      await settle();
      await settle();
    };
    await settle();
    assert.ok(await page.locator(".segment").count() <= 80);
    assert.ok(openMs < 2000, "result should not wait for slow health checks");
    assert.equal(mediaRequests, 0, "opening text must not preload a multi-GB video");
    const player = await page.locator("#mediaMount video").boundingBox();
    assert.ok(player.width > 650 && player.height > 365, JSON.stringify(player));
    assert.equal(Math.round((await page.locator("main").boundingBox()).width), 1240);
    assert.equal(await page.locator("[data-page-step], #pageNumber").count(), 0);
    console.log("PASS: 12,000 segments open in " + openMs + " ms, bounded rows, video " + Math.round(player.width) + " × " + Math.round(player.height));

    await page.locator('[data-segment-text="0"]').fill("第一页修改保留");
    const scrollBounds = await page.locator("#timelineScroll").boundingBox();
    await page.mouse.move(scrollBounds.x + 3, scrollBounds.y + 80);
    await page.mouse.wheel(0, 2400);
    await page.waitForFunction(() => document.querySelector("#timelineScroll").scrollTop > 1500);
    await settle();
    assert.match(await page.locator("#scrollHint").textContent(), /暂停/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.segmentText), "0", "scrolling must not destroy a focused editor");
    const editedId = await visibleId();
    assert.ok(editedId > 0);
    await page.locator('[data-segment-text="' + editedId + '"]').fill("第二页修改保留");
    await page.locator("#speakerSettingsButton").click();
    await page.locator('[data-speaker="SPK0"]').fill("统一新名称");
    await page.locator("#finishSpeakerSettings").click();
    await page.locator("#fullTextTab").click();
    const full = await page.locator("#fullText").inputValue();
    assert.ok(full.includes("第一页修改保留"));
    assert.ok(full.includes("第二页修改保留"));
    assert.ok(full.includes("测试片段 11999"));
    assert.ok(full.includes("统一新名称"));
    await page.locator("#timelineTab").click();
    await page.locator("#searchInput").fill("测试片段 11999");
    await page.waitForFunction(() => document.querySelector("#matchCount").textContent === "1 条");
    assert.equal(await page.locator(".segment").count(), 1);
    await page.locator(".segment-text").fill("末页搜索修改保留");
    await page.locator("#searchInput").fill("");
    await page.waitForFunction(() => document.querySelector('[data-segment-text="0"]'));
    assert.equal(await page.locator('[data-segment-text="0"]').inputValue(), "第一页修改保留");
    await page.locator("#timelineScroll").focus();
    for (const fraction of [0.25, 0.75, 0.1, 1]) {
      await scrollTo(fraction);
      assert.ok(await page.locator(".segment").count() <= 81, "DOM stays bounded during scrollbar jumps");
    }
    await page.locator('[data-segment-text="11999"]').waitFor();
    assert.equal(await page.locator('[data-segment-text="11999"]').inputValue(), "末页搜索修改保留");
    assert.match(await page.locator("#scrollEnd").textContent(), /末尾/);
    const beforeSave = await visibleId();
    const saved = page.waitForResponse((response) => response.url().endsWith("/" + id + "/result"));
    await page.locator("#saveButton").click();
    assert.equal((await saved).status(), 200);
    await page.locator("#editStatus").filter({ hasText: "结果已保存" }).waitFor();
    assert.deepEqual(patch.segments.map((item) => item.id).sort((a, b) => a - b), [0, editedId, 11999]);
    assert.equal(job.transcript.segments[0].text, "第一页修改保留");
    assert.equal(job.transcript.segments[editedId].text, "第二页修改保留");
    assert.equal(job.transcript.segments[11999].text, "末页搜索修改保留");
    await settle();
    assert.ok(Math.abs(await visibleId() - beforeSave) <= 1, "saving preserves the reading position");
    await page.locator("#fullTextTab").click();
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => !document.querySelector("#saveButton").disabled);
    await page.locator("#timelineTab").click();
    await settle();
    assert.ok(Math.abs(await visibleId() - beforeSave) <= 1, "saving from full-text view must preserve the hidden timeline position");
    console.log("PASS: wheel paging, focused editor, drafts, full-text search, bottom/top jumps and bounded DOM");

    await page.locator("#jumpToPlaying").click();
    await settle();
    assert.equal(await page.locator("#timelineScroll").evaluate((element) => element.scrollTop), 0);
    // Feed playback events without fetching a fake 10-hour media file.
    const playAt = (index) => page.locator("#mediaMount video").evaluate((media, segmentIndex) => {
      Object.defineProperty(media, "currentTime", { configurable: true, value: segmentIndex * 3 + 0.5 });
      media.dispatchEvent(new Event("timeupdate"));
    }, index);
    await playAt(6500);
    await settle();
    assert.equal(await page.locator('.segment.active').getAttribute("data-id"), "6500");
    assert.ok(Math.abs(await visibleId() - 6500) <= 4, "playback locates a far-away virtual row");
    await page.locator("#timelineScroll").dispatchEvent("wheel", { deltaY: 1 });
    const pausedAt = await page.locator("#timelineScroll").evaluate((element) => element.scrollTop);
    await playAt(7000);
    await settle();
    assert.equal(await page.locator("#timelineScroll").evaluate((element) => element.scrollTop), pausedAt, "manual reading must not be pulled away by playback");
    await page.locator("#jumpToPlaying").click();
    await settle();
    assert.ok(Math.abs(await visibleId() - 7000) <= 4);
    await playAt(0);
    await settle();
    await page.locator("#mediaMount video").evaluate((media) => { delete media.currentTime; });
    console.log("PASS: playback seeks across virtual windows, manual scrolling suspends follow, and resume locates playback");
    await page.locator("#timelineScroll").focus();
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector("#timelineScroll").scrollTop > 100);
    await settle();
    await page.locator("#textSize").selectOption("19");
    await settle();
    assert.equal(await page.locator(".segment-text").first().evaluate((element) => getComputedStyle(element).fontSize), "19px");
    await page.locator("#focusVideo").click();
    await settle();
    assert.ok((await page.locator("#mediaMount video").boundingBox()).width > player.width * 1.5);
    await page.locator("#focusVideo").click();
    await page.locator("#textSize").selectOption("15");
    await scrollTo(0);
    if (await page.locator("#fullscreenVideo").isVisible()) {
      await page.locator("#fullscreenVideo").click();
      await page.waitForFunction(() => document.fullscreenElement?.tagName === "VIDEO");
      await page.evaluate(() => document.exitFullscreen());
    }
    await page.locator("#searchInput").fill("完全不存在的关键词");
    await page.locator("#emptySearch").waitFor({ state: "visible" });
    assert.equal(await page.locator(".segment").count(), 0);
    await page.locator("#searchInput").fill("");
    await page.waitForFunction(() => document.querySelector('[data-segment-text="0"]'));
    console.log("PASS: save preserves position, keyboard scrolling, font sizes, wide preview, fullscreen and empty search");

    await page.setViewportSize({ width: 390, height: 844 });
    await settle();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await scrollTo(0.5);
    assert.ok(await page.locator(".segment").count() <= 81);
    const overlap = await page.locator("#timelineScroll").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      const rows = [...viewport.querySelectorAll(".segment")].map((row) => row.getBoundingClientRect()).filter((row) => row.bottom > bounds.top && row.top < bounds.bottom).sort((a, b) => a.top - b.top);
      return rows.some((row, i) => i > 0 && row.top < rows[i - 1].bottom - 1);
    });
    assert.equal(overlap, false, "variable-height rows must not overlap after resize");
    if (process.env.CAPTURE_READER === "1") {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator("#jumpToPlaying").click();
      await settle();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await settle();
      console.log("SCREENSHOT_BASE64=" + (await page.screenshot({ type: "jpeg", quality: 65 })).toString("base64"));
    }
    assert.deepEqual(errors, []);
    console.log("PASS: mobile width, measured variable-height rows and no browser errors");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
