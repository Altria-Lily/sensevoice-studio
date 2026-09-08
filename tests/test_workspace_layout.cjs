// Layout and dialog regression: all job reads/writes are synthetic and local.
// CAPTURE_LAYOUT=1 saves desktop, popover, dialog and mobile screenshots in .tmp.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const baseURL = process.argv[2] || "http://127.0.0.1:8001";
  const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const names = ["主持人", "产品经理", "设计师", "开发负责人", "测试负责人", "参会者六", "参会者七", "参会者八", "参会者九", "参会者十", "参会者十一", "参会者十二", "参会者十三", "参会者十四", "参会者十五", "参会者十六"];
  const job = { id, filename: "产品讨论会 · 页面布局验收.mp4", state: "completed", has_result: true,
    created_at: new Date().toISOString(), identify_speakers: true, progress: 100,
    transcript: { duration: 36000, speaker_names: Object.fromEntries(names.map((name, index) => ["SPK" + index, name])),
      segments: Array.from({ length: 12000 }, (_, index) => ({ id: index, start: index * 3, end: index * 3 + 2,
        start_ms: index * 3000, end_ms: index * 3000 + 2000, speaker: "SPK" + index % 16,
        text: "讨论片段 " + index + "：调整布局，让视频预览和文字校对更加清晰。" + (index % 4 === 0 ? "长段落换行时也应保持连续阅读的位置。".repeat(5) : "") })),
    },
  };
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const errors = [];
    let jobRequests = 0;
    let mediaRequests = 0;
    let saveMode = "ok";
    let pendingSave;
    let lastPatch;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/health", (route) => route.fulfill({ json: { status: "ok", ffmpeg: {}, model: { device: "local", name: "UI fixture" }, funasr: { version: "test" } } }));
    await page.route("**/api/jobs?*", (route) => route.fulfill({ json: { jobs: [job] } }));
    await page.route("**/api/jobs/" + id, (route) => { jobRequests += 1; return route.fulfill({ json: job }); });
    await page.route("**/api/jobs/" + id + "/media", (route) => { mediaRequests += 1; return route.abort(); });
    await page.route("**/api/jobs/" + id + "/result", async (route) => {
      lastPatch = route.request().postDataJSON();
      if (saveMode === "fail") return route.fulfill({ status: 503, json: { detail: "模拟保存失败" } });
      if (saveMode === "delayed") await new Promise((resolve) => { pendingSave = resolve; });
      Object.assign(job.transcript.speaker_names, lastPatch.speaker_names);
      for (const segment of lastPatch.segments) Object.assign(job.transcript.segments[segment.id], segment);
      return route.fulfill({ json: job.transcript });
    });
    const settle = async () => { for (let i = 0; i < 3; i += 1) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve))); };
    const width = async (selector = "main") => Math.round((await page.locator(selector).boundingBox()).width);
    const anchor = () => page.evaluate(() => {
      const bounds = document.querySelector("#timelineScroll").getBoundingClientRect();
      return Number([...document.querySelectorAll(".segment")].find((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > bounds.top + 1 && box.top < bounds.bottom;
      })?.dataset.id);
    });
    const noOverlap = () => page.locator("#timelineScroll").evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect();
      const rows = [...viewport.querySelectorAll(".segment")].map((row) => row.getBoundingClientRect())
        .filter((row) => row.bottom > bounds.top && row.top < bounds.bottom).sort((a, b) => a.top - b.top);
      return rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom - 1);
    });
    const screenshot = async (name) => {
      if (process.env.CAPTURE_LAYOUT !== "1") return;
      console.log("CAPTURE=" + name);
      await page.screenshot({ path: ".tmp/layout-" + name + ".jpg", type: "jpeg", quality: 70 });
    };
    await page.goto("/");
    await page.locator(".history-item button").waitFor();
    const homeWidth = await width();
    assert.equal(homeWidth, 1240);
    await page.locator(".history-item button").click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    await settle();
    assert.equal(await width(), homeWidth);
    assert.equal(await width(".topbar"), homeWidth);
    assert.equal(await page.locator("#speakerDialog").isVisible(), false);
    assert.equal(await page.locator(".media-column [data-speaker]").count(), 0);
    assert.equal(await page.locator("#speakerButtonCount").textContent(), "16");
    await screenshot("desktop-default");
    console.log("PASS: result and homepage default to the same 1240 px width; speaker list is hidden behind a button");

    await page.locator('[data-segment-text="0"]').fill("调整布局之前的草稿");
    await page.locator("#timelineScroll").focus();
    await page.locator("#timelineScroll").evaluate((element) => { element.scrollTop = element.scrollHeight * 0.37; });
    await settle();
    const before = await anchor();
    await page.locator("#pageWidthButton").click();
    await screenshot("width-control");
    await page.evaluate(() => {
      window.layoutLongTasks = [];
      new PerformanceObserver((list) => window.layoutLongTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
    });
    const bounds = await page.locator("#pageWidth").boundingBox();
    const control = await page.locator("#pageWidth").evaluate((element) => ({ min: Number(element.min), max: Number(element.max), value: Number(element.value) }));
    const thumbX = bounds.x + 8 + (bounds.width - 16) * (control.value - control.min) / (control.max - control.min);
    await page.mouse.move(thumbX, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 8, bounds.y + bounds.height / 2, { steps: 35 });
    await page.mouse.up();
    await settle();
    assert.ok(await width() > 1750);
    assert.equal(await width(), await width(".topbar"));
    assert.equal(Math.round((await page.locator("#pageWidth").boundingBox()).x), Math.round(bounds.x), "slider must not move under the pointer");
    assert.ok(Math.abs(await anchor() - before) <= 1, "dragging should preserve the first visible segment");
    assert.ok(await page.locator(".segment").count() <= 81);
    assert.equal(await noOverlap(), true);
    const chosenWidth = await width();
    await page.locator("#pageWidth").focus();
    await page.keyboard.press("Home");
    await settle();
    assert.equal(await width(), 960);
    assert.ok(Math.abs(await anchor() - before) <= 1);
    assert.equal(await noOverlap(), true);
    await page.keyboard.press("End");
    await settle();
    assert.equal(await width(), chosenWidth);
    const longestTask = Math.round(await page.evaluate(() => Math.max(0, ...window.layoutLongTasks)));
    assert.ok(longestTask < 1000, "dragging must not freeze for a second");
    assert.equal(jobRequests, 1, "width changes must not refetch transcript data");
    assert.equal(mediaRequests, 0, "width changes must not download the video");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#pageWidthPanel").isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "pageWidthButton");
    await page.locator("#fullTextTab").click();
    assert.ok((await page.locator("#fullText").inputValue()).includes("调整布局之前的草稿"));
    await page.locator("#pageWidthButton").click();
    await page.locator("#pageWidth").focus();
    await page.keyboard.press("Home");
    await settle();
    await page.keyboard.press("Escape");
    await page.locator("#timelineTab").click();
    await settle();
    assert.ok(Math.abs(await anchor() - before) <= 1, "resize from full-text view must retain the hidden timeline anchor");
    assert.equal(await noOverlap(), true);
    await page.locator("#pageWidthButton").click();
    await page.locator("#pageWidth").focus();
    await page.keyboard.press("End");
    await settle();
    await page.keyboard.press("Escape");
    console.log("PASS: real pointer drag, fixed slider position, keyboard bounds, anchored reading, bounded rows; longest task " + longestTask + " ms");

    await page.locator("#speakerSettingsButton").click();
    assert.equal(await page.evaluate(() => document.activeElement.id), "closeSpeakerSettings");
    for (let i = 0; i < 22; i += 1) {
      await page.keyboard.press("Tab");
      // Native dialogs may let Tab reach browser chrome (activeElement = body),
      // but none of the inert background application's controls may receive it.
      assert.equal(await page.evaluate(() => document.activeElement === document.body || document.querySelector("#speakerDialog").contains(document.activeElement)), true, "dialog must not focus background controls");
    }
    await page.locator('[data-speaker="SPK0"]').fill("主持人 · 已校对");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#speakerDialog").isVisible(), false);
    assert.equal(await page.evaluate(() => document.body.classList.contains("speaker-settings-open")), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "speakerSettingsButton");
    await page.locator("#speakerSettingsButton").click();
    assert.equal(await page.locator('[data-speaker="SPK0"]').inputValue(), "主持人 · 已校对");
    await screenshot("speaker-dialog");
    saveMode = "fail";
    await page.locator("#saveSpeakerSettings").click();
    await page.locator("#speakerSaveStatus").filter({ hasText: "保存失败" }).waitFor();
    assert.equal(await page.locator("#speakerDialog").isVisible(), true);
    assert.equal(await page.locator('[data-speaker="SPK0"]').inputValue(), "主持人 · 已校对");
    saveMode = "delayed";
    await page.locator("#saveSpeakerSettings").click();
    await page.waitForFunction(() => document.querySelector("#saveSpeakerSettings").disabled);
    assert.equal(await page.locator("#saveButton").isDisabled(), true);
    await page.locator('[data-speaker="SPK0"]').fill("保存过程中继续改名");
    assert.ok(pendingSave);
    pendingSave();
    await page.waitForFunction(() => !document.querySelector("#saveSpeakerSettings").disabled);
    assert.equal(await page.locator("#speakerDialog").isVisible(), true);
    assert.match(await page.locator("#speakerSaveStatus").textContent(), /未保存/);
    assert.equal(await page.locator('[data-speaker="SPK0"]').inputValue(), "保存过程中继续改名");
    saveMode = "ok";
    await page.locator("#saveSpeakerSettings").click();
    await page.locator("#speakerDialog").waitFor({ state: "hidden" });
    assert.equal(job.transcript.speaker_names.SPK0, "保存过程中继续改名");
    assert.equal(job.transcript.segments[0].text, "调整布局之前的草稿");
    assert.equal(await page.locator("#editStatus").getAttribute("class"), "");
    await page.locator("#speakerSettingsButton").click();
    await page.mouse.click(3, 3);
    await page.locator("#speakerDialog").waitFor({ state: "hidden" });
    console.log("PASS: modal focus, Esc/backdrop close, unsaved names, failure/retry, edits during save, and saving all drafts");

    await page.reload();
    await page.locator("#resultView").waitFor({ state: "visible" });
    assert.equal(await width(), chosenWidth, "custom width must persist on reload");
    await page.locator("#backButton").click();
    assert.equal(await width(), homeWidth, "custom result width must not change the homepage");
    await page.locator(".history-item button").click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    assert.equal(await width(), chosenWidth);
    await page.locator("#pageWidthButton").click();
    await page.locator("#resetPageWidth").click();
    assert.equal(await width(), homeWidth);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle();
    assert.equal(await width(), homeWidth);
    await screenshot("desktop-1440");
    for (const viewportWidth of [390, 320]) {
      await page.setViewportSize({ width: viewportWidth, height: 844 });
      await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("#pageWidthButton").click();
      assert.equal(await page.locator("#pageWidth").isDisabled(), true);
      const popover = await page.locator("#pageWidthPanel").boundingBox();
      assert.ok(popover.x >= 0 && popover.x + popover.width <= viewportWidth);
      await page.keyboard.press("Escape");
      await page.locator("#speakerSettingsButton").click();
      const dialog = await page.locator("#speakerDialog").boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= viewportWidth && dialog.height < 844);
      await page.locator('[data-speaker="SPK15"]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('[data-speaker="SPK15"]').isVisible(), true);
      assert.equal(await page.locator("#speakerList").evaluate((element) => element.scrollHeight > element.clientHeight), true);
      await screenshot("mobile-dialog-" + viewportWidth);
      await page.locator("#finishSpeakerSettings").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await settle();
    assert.equal(await width(), homeWidth, "mobile adaptation must not overwrite the desktop preference");
    assert.deepEqual(errors, []);
    console.log("PASS: remembered width, untouched homepage, reset to 1240 px, mobile controls, scrollable speaker dialog and no browser errors");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
