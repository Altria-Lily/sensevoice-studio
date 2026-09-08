// Layout and dialog regression: all job reads/writes are synthetic and local.
// CAPTURE_LAYOUT=1 saves equal-height desktop, edge-drag, dialog and mobile screenshots in .tmp.
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
    await page.addInitScript(() => {
      if (!localStorage.getItem('layout.fixture.seeded')) {
        localStorage.setItem('sensevoice.settings.v2', JSON.stringify({ pageWidth: 960, playbackSpeed: '1.5' }));
        localStorage.setItem('layout.fixture.seeded', 'true');
      }
    });
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
    const settle = async () => { for (let i = 0; i < 6; i += 1) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve))); };
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
      await page.screenshot({ path: ".tmp/frame-layout-" + name + ".jpg", type: "jpeg", quality: 70 });
    };
    const edge = (side = 'right') => page.locator('[data-resize-edge="' + side + '"]');
    const sameHeight = async () => {
      await page.waitForFunction(() => {
        const left = document.querySelector('.media-card').getBoundingClientRect();
        const right = document.querySelector('.transcript-panel').getBoundingClientRect();
        return Math.abs(left.height - right.height) < 1 && Math.abs(left.top - right.top) < 1;
      });
      const video = await page.locator('video').boundingBox();
      assert.ok(Math.abs(video.width / video.height - 16 / 9) < 0.01, 'video must retain its aspect ratio');
    };
    const dragEdge = async (side, delta) => {
      const box = await edge(side).boundingBox();
      const y = Math.min(950, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, y, { steps: 24 });
      await page.mouse.up();
      await settle();
    };
    await page.goto("/");
    await page.locator(".history-item button").waitFor();
    const homeWidth = await width();
    assert.equal(homeWidth, 1240);
    await page.locator(".history-item button").click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    await settle();
    const automaticWidth = await width();
    assert.ok(automaticWidth > homeWidth && automaticWidth <= 1872);
    assert.equal(await width(".topbar"), automaticWidth);
    await sameHeight();
    assert.equal(await page.locator('#playbackSpeed').inputValue(), '1.5', 'unrelated preferences survive the layout migration');
    assert.equal(await page.locator('#pageWidthButton, #pageWidthPanel, #pageWidth').count(), 0);
    assert.equal(await page.locator('.result-actions #speakerSettingsButton').count(), 0);
    assert.equal(await page.locator('.transcript-heading #speakerSettingsButton').count(), 1);
    assert.equal(await page.locator("#speakerDialog").isVisible(), false);
    assert.equal(await page.locator(".media-column [data-speaker]").count(), 0);
    assert.equal(await page.locator("#speakerButtonCount").textContent(), "16");
    await screenshot("desktop-default");
    console.log("PASS: automatic equal-height cards at " + automaticWidth + " px, native video aspect, no width button and speaker settings inside the text panel");

    await page.locator('[data-segment-text="0"]').fill("调整布局之前的草稿");
    await page.locator("#timelineScroll").focus();
    await page.locator("#timelineScroll").evaluate((element) => { element.scrollTop = element.scrollHeight * 0.37; });
    await settle();
    const before = await anchor();
    await page.evaluate(() => {
      window.layoutLongTasks = [];
      new PerformanceObserver((list) => window.layoutLongTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
    });
    await dragEdge('right', -160);
    assert.ok(Math.abs(await width() - (automaticWidth - 320)) <= 2);
    await sameHeight();
    const rightDraggedWidth = await width();
    await dragEdge('left', -60);
    assert.ok(Math.abs(await width() - (rightDraggedWidth + 120)) <= 2);
    assert.equal(await width(), await width(".topbar"));
    await sameHeight();
    await screenshot('edge-drag');
    assert.ok(Math.abs(await anchor() - before) <= 1, "dragging should preserve the first visible segment");
    assert.ok(await page.locator(".segment").count() <= 81);
    assert.equal(await noOverlap(), true);
    await edge().focus();
    await page.keyboard.press("Home");
    await settle();
    assert.equal(await width(), 960);
    await sameHeight();
    assert.ok(Math.abs(await anchor() - before) <= 1);
    assert.equal(await noOverlap(), true);
    await page.keyboard.press("End");
    await settle();
    assert.equal(await width(), Number(await edge().getAttribute('aria-valuemax')));
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await settle();
    const chosenWidth = await width();
    assert.equal(chosenWidth, Number(await edge().getAttribute('aria-valuemax')) - 160, 'rapid repeated keys must accumulate');
    const cancelBounds = await edge().boundingBox();
    await page.mouse.move(cancelBounds.x + 8, cancelBounds.y + 100);
    await page.mouse.down();
    await page.mouse.move(cancelBounds.x - 92, cancelBounds.y + 100, { steps: 12 });
    await settle();
    assert.ok(await width() < chosenWidth);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await settle();
    assert.equal(await width(), chosenWidth, 'Esc must cancel an in-progress resize');
    assert.equal(await page.evaluate(() => document.body.classList.contains('workspace-resizing')), false);
    const longestTask = Math.round(await page.evaluate(() => Math.max(0, ...window.layoutLongTasks)));
    assert.ok(longestTask < 1000, "dragging must not freeze for a second");
    assert.equal(jobRequests, 1, "width changes must not refetch transcript data");
    assert.equal(mediaRequests, 0, "width changes must not download the video");
    await page.locator("#fullTextTab").click();
    assert.ok((await page.locator("#fullText").inputValue()).includes("调整布局之前的草稿"));
    await edge().focus();
    await page.keyboard.press("Home");
    await settle();
    await page.locator("#timelineTab").click();
    await settle();
    assert.ok(Math.abs(await anchor() - before) <= 1, "resize from full-text view must retain the hidden timeline anchor");
    assert.equal(await noOverlap(), true);
    await edge().focus();
    await page.keyboard.press("End");
    await settle();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await settle();
    assert.equal(await width(), chosenWidth);
    await sameHeight();
    await page.locator('#subtitleButton').click();
    await settle();
    await sameHeight();
    assert.equal(await width(), chosenWidth, 'subtitle settings must not change the chosen width');
    await page.locator('#subtitleButton').click();
    await page.locator('#focusVideo').click();
    await settle();
    assert.equal(await page.locator('#workspaceGrid').getAttribute('data-equal-height'), 'false');
    const focusedDefault = await width();
    assert.equal(focusedDefault, 1384, 'focus starts fitted to the video, not the saved dual-column width');
    assert.notEqual(focusedDefault, chosenWidth);
    const fittedVideo = await page.locator('video').boundingBox();
    assert.ok(Math.abs(fittedVideo.width / fittedVideo.height - 16 / 9) < 0.001, 'focus must not add side bars');
    await dragEdge('right', 120);
    const widerVideo = await page.locator('video').boundingBox();
    assert.ok(widerVideo.width > fittedVideo.width + 200 && widerVideo.height > fittedVideo.height + 100);
    assert.ok(Math.abs(widerVideo.width / widerVideo.height - 16 / 9) < 0.001, 'manual focus width must retain video proportions');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sensevoice.settings.v2')).workspaceWidth), chosenWidth);
    await edge().dblclick();
    await settle();
    assert.equal(await width(), focusedDefault);
    await dragEdge('left', 40);
    await page.locator('#focusVideo').click();
    await settle();
    assert.equal(await width(), chosenWidth, 'leaving focus restores the dual-column width');
    await page.locator('#focusVideo').click();
    await settle();
    assert.equal(await width(), focusedDefault, 'every focus entry starts fitted to the video');
    assert.equal(jobRequests, 1);
    assert.equal(mediaRequests, 0, 'focus must not preload or refetch a large video');
    await page.locator('#focusVideo').click();
    await settle();
    await sameHeight();
    console.log("PASS: both edges, pointer capture, keyboard bounds, Esc cancellation, full text, subtitles, focus mode and anchored rows; longest task " + longestTask + " ms");

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
    await settle();
    assert.equal(await width(), chosenWidth, "custom width must persist on reload");
    await page.locator("#backButton").click();
    assert.equal(await width(), homeWidth, "custom result width must not change the homepage");
    await page.locator(".history-item button").click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    await settle();
    assert.equal(await width(), chosenWidth);
    await edge().dblclick();
    await settle();
    assert.equal(await width(), automaticWidth);
    assert.equal(await page.locator('#workspaceShell').getAttribute('data-width-mode'), 'auto');
    await sameHeight();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle();
    assert.ok(await width() > homeWidth && await width() <= 1392);
    await sameHeight();
    await screenshot("desktop-1440");
    for (const viewportWidth of [390, 320]) {
      await page.setViewportSize({ width: viewportWidth, height: 844 });
      await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await edge().isVisible(), false);
      assert.equal(await page.locator('#workspaceGrid').getAttribute('data-equal-height'), 'false');
      await page.locator("#speakerSettingsButton").click();
      const dialog = await page.locator("#speakerDialog").boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= viewportWidth && dialog.height < 844);
      await page.locator('[data-speaker="SPK15"]').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('[data-speaker="SPK15"]').isVisible(), true);
      assert.equal(await page.locator("#speakerList").evaluate((element) => element.scrollHeight > element.clientHeight), true);
      await screenshot("mobile-dialog-" + viewportWidth);
      await page.locator("#finishSpeakerSettings").click();
      await screenshot('mobile-' + viewportWidth);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await settle();
    assert.equal(await width(), automaticWidth, "mobile adaptation must not overwrite the desktop preference");
    await sameHeight();
    await page.locator('#focusVideo').click();
    await settle();
    // A local canvas stream supplies genuine video metadata and visible edge markers.
    // This never accesses the camera, downloads media, or touches user files.
    const setVideoFrame = async (frameWidth, frameHeight) => {
      await page.locator('video').evaluate(async (media, [w, h]) => {
        media.srcObject?.getTracks().forEach((track) => track.stop());
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#174f3f'); gradient.addColorStop(1, '#397f99');
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#c5f06a'; ctx.fillRect(0, 0, 12, h);
        ctx.fillStyle = '#e5ad73'; ctx.fillRect(w - 12, 0, 12, h);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
        ctx.font = Math.round(Math.min(w, h) / 13) + 'px sans-serif';
        ctx.fillText(w + ' × ' + h, w / 2, h / 2);
        media.srcObject = canvas.captureStream(1);
        media.muted = true;
        await media.play();
        media.pause();
      }, [frameWidth, frameHeight]);
      await settle();
      await page.waitForFunction(([w, h]) => {
        const media = document.querySelector('video');
        return media.videoWidth === w && media.videoHeight === h;
      }, [frameWidth, frameHeight]);
    };
    const assertFittedFrame = async (frameWidth, frameHeight) => {
      const videoBox = await page.locator('video').boundingBox();
      const mountBox = await page.locator('#mediaMount').boundingBox();
      assert.ok(Math.abs(videoBox.width / videoBox.height - frameWidth / frameHeight) < 0.001);
      assert.ok(Math.abs(videoBox.width - mountBox.width) < 1 && Math.abs(videoBox.height - mountBox.height) < 1,
        'the video must fill its container without padding or cropping');
    };
    for (const [w, h] of [[1280, 720], [1280, 960], [2560, 1080], [720, 1280]]) {
      await setVideoFrame(w, h);
      assert.equal(await width(), Math.round(Math.max(640, Math.min(1872, 1080 * 0.72 * w / h + 2))));
      await assertFittedFrame(w, h);
      await screenshot('focus-' + w + 'x' + h);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await settle();
    await assertFittedFrame(720, 1280);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('focus-portrait-mobile');
    await setVideoFrame(1280, 720);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await settle();
    await assertFittedFrame(1280, 720);
    await page.locator('#fullscreenVideo').click();
    await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO');
    await page.evaluate(() => document.exitFullscreen());
    await settle();
    assert.equal(await width(), 1384, 'native fullscreen must not overwrite fitted focus width');
    await assertFittedFrame(1280, 720);
    await page.locator('video').evaluate((media) => media.srcObject?.getTracks().forEach((track) => track.stop()));
    await dragEdge('right', 100);
    assert.notEqual(await width(), 1384);
    await page.locator('#backButton').click();
    await page.locator('.history-item button').click();
    await page.locator('#resultView').waitFor({ state: 'visible' });
    await settle();
    assert.equal(await page.locator('#focusVideo').getAttribute('aria-pressed'), 'true');
    assert.equal(await width(), 1384, 'opening a result again starts with fitted focus width');
    await dragEdge('left', 40);
    await page.reload();
    await page.locator('#resultView').waitFor({ state: 'visible' });
    await settle();
    assert.equal(await width(), 1384, 'a saved focus mode must not restore a temporary focus width');
    await page.locator('#focusVideo').click();
    await settle();
    assert.equal(await width(), automaticWidth);
    await sameHeight();
    assert.deepEqual(errors, []);
    console.log("PASS: remembered width, untouched homepage, double-click reset, mobile stacking, scrollable speaker dialog and no browser errors");
    console.log('PASS: focus defaults, isolated manual widths, real 16:9/4:3/ultrawide/portrait video metadata, mobile and fullscreen return without layout bars');
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
