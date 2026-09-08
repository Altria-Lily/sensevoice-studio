// Optional end-to-end browser check. Requires Playwright and Microsoft Edge.
// Run against an already started local service:
// node tests/test_ui.cjs http://127.0.0.1:8001
// This creates one clearly named example job using the bundled public model sample.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

async function main() {
  const baseURL = process.argv[2] || "http://127.0.0.1:8001";
  const output = path.resolve(".tmp");
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const config = await (await context.request.get("/api/settings")).json();
    assert.equal(config.max_upload_bytes, 10_737_418_240);
    await page.goto("/");
    await page.locator("#dropHint").filter({ hasText: "10.00 GB" }).waitFor();
    console.log("PASS: live settings report 10 GB; landing page initialized");

    await page.evaluate(() => selectFile({ name: "oversized.mp4", size: 10 * 1024 ** 3 + 1 }));
    assert.match(await page.locator("#formError").textContent(), /超过/);
    assert.equal(await page.locator("#startButton").isDisabled(), true);
    console.log("PASS: frontend rejects a file over the 10 GB boundary before sending");

    await page.locator(".advanced-settings summary").click();
    await page.locator("#languageSelect").selectOption("zh");
    await page.locator("#speakerNumber").fill("1");
    await page.locator("#batchSizeSelect").selectOption("15");
    await page.locator("#itnToggle").uncheck();
    await page.reload();
    await page.locator("#dropHint").filter({ hasText: "10.00 GB" }).waitFor();
    await page.locator(".advanced-settings summary").click();
    assert.equal(await page.locator("#speakerNumber").inputValue(), "1");
    assert.equal(await page.locator("#batchSizeSelect").inputValue(), "15");
    assert.equal(await page.locator("#itnToggle").isChecked(), false);
    await page.screenshot({ path: path.join(output, "ui-settings-v2.png"), fullPage: true });
    console.log("PASS: recognition settings survive a page reload");

    const initialIds = new Set((await (await context.request.get("/api/jobs?limit=100")).json()).jobs.map((job) => job.id));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 20, downloadThroughput: 10_000_000, uploadThroughput: 8192,
    });
    await page.locator("#fileInput").setInputFiles({
      name: "ui-cancel-test.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024 * 1024, 1),
    });
    await page.locator("#startButton").click();
    await page.waitForFunction(() => {
      const value = Number(document.querySelector("#progressTrack").getAttribute("aria-valuenow"));
      return value > 0 && value < 100;
    }, null, { timeout: 20000 });
    assert.match(await page.locator("#uploadDetails").textContent(), /\/秒/);
    await page.screenshot({ path: path.join(output, "ui-upload-v2.png"), fullPage: true });
    console.log("PASS: throttled upload shows nonzero byte progress and speed");
    await page.locator("#cancelUpload").click();
    await page.locator("#landingView").waitFor({ state: "visible" });
    assert.match(await page.locator("#formError").textContent(), /取消/);
    let remaining = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      remaining = (await (await context.request.get("/api/jobs?limit=100")).json()).jobs.filter((job) => !initialIds.has(job.id));
      if (!remaining.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(remaining.length, 0, "cancelled upload must not leave a job behind");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    console.log("PASS: cancelling upload cleans the incomplete job");

    const sample = path.resolve("data/models/modelscope/models/iic--SenseVoiceSmall/snapshots/master/example/zh.mp3");
    await page.locator("#fileInput").setInputFiles({
      name: "功能验收示例-中文.mp3", mimeType: "audio/mpeg", buffer: fs.readFileSync(sample),
    });
    const uploaded = page.waitForResponse((response) => response.url().includes("/api/jobs/upload?") && response.request().method() === "POST");
    await page.locator("#startButton").click();
    const uploadedResponse = await uploaded;
    assert.equal(uploadedResponse.status(), 202);
    const created = await uploadedResponse.json();
    assert.equal(created.batch_size_s, 15);
    assert.equal(created.speaker_count, 1);
    assert.equal(created.use_itn, false);
    console.log("RUNNING: real SenseVoice sample transcription, job=" + created.id);
    await page.locator("#resultView").waitFor({ state: "visible", timeout: 240000 });
    const job = await (await context.request.get("/api/jobs/" + created.id)).json();
    assert.equal(job.state, "completed", job.error);
    assert.ok(job.transcript.segments.length);
    assert.ok(job.transcript.segments[0].end_ms > job.transcript.segments[0].start_ms);
    assert.ok(fs.existsSync(job.result_files.txt));
    await page.locator(".time-button").first().click();
    await page.waitForFunction(() => document.querySelector("#mediaMount audio, #mediaMount video").readyState > 0);
    await page.locator("#mediaMount audio, #mediaMount video").evaluate((media) => media.pause());
    await page.locator("#fullTextTab").click();
    assert.ok((await page.locator("#fullText").inputValue()).includes(job.transcript.segments[0].text));
    assert.equal(await page.locator("#resultPath").textContent(), job.result_files.txt);
    await page.locator("#playbackSpeed").selectOption("1.5");
    assert.equal(await page.locator("#mediaMount audio, #mediaMount video").evaluate((media) => media.playbackRate), 1.5);
    console.log("PASS: real transcription opens results automatically; full text and disk location are visible");

    await page.locator("#timelineTab").click();
    const originalText = await page.locator(".segment-text").first().inputValue();
    const originalName = await page.locator("[data-speaker]").first().inputValue();
    await page.locator(".segment-text").first().fill("测试校对文字：你好。");
    await page.locator("#speakerSettingsButton").click();
    await page.locator("[data-speaker]").first().fill("测试说话人");
    await page.locator("#finishSpeakerSettings").click();
    await page.locator("#downloadTxt").click();
    assert.match(await page.locator("#toast").textContent(), /先保存/);
    const saved = page.waitForResponse((response) => response.url().endsWith("/result") && response.request().method() === "PATCH");
    await page.locator("#saveButton").click();
    assert.equal((await saved).status(), 200);
    await page.locator("#editStatus").filter({ hasText: "结果已保存" }).waitFor();
    const txt = await context.request.get("/api/jobs/" + created.id + "/export/txt");
    assert.match(await txt.text(), /测试说话人：测试校对文字：你好。/);
    assert.match(fs.readFileSync(job.result_files.txt, "utf8"), /测试校对文字/);
    console.log("PASS: editing updates both downloaded TXT and the local TXT file");

    // Leave the public example in its original form for the user to inspect.
    await page.locator(".segment-text").first().fill(originalText);
    await page.locator("#speakerSettingsButton").click();
    await page.locator("[data-speaker]").first().fill(originalName);
    await page.locator("#finishSpeakerSettings").click();
    const restored = page.waitForResponse((response) => response.url().endsWith("/result") && response.request().method() === "PATCH");
    await page.locator("#saveButton").click();
    assert.equal((await restored).status(), 200);
    await page.locator("#editStatus").filter({ hasText: "结果已保存" }).waitFor();
    await page.locator("#fullTextTab").click();
    await page.screenshot({ path: path.join(output, "ui-result-v2.png"), fullPage: true });
    await page.reload();
    await page.locator("#resultView").waitFor({ state: "visible" });
    await page.locator("#backButton").click();
    const exampleCard = page.locator(".history-item").filter({ hasText: "功能验收示例-中文.mp3" }).first();
    await exampleCard.getByRole("button", { name: "查看文本 →" }).click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    console.log("PASS: refresh restores the result; history offers an explicit View Text button");

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(output, "ui-mobile-v2.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log("PASS: mobile layout has no horizontal overflow; no uncaught browser errors");
    console.log("EXAMPLE_RESULT=" + job.result_files.txt);
    if (process.env.CLEAN_UI_SAMPLE === "1") {
      assert.equal((await context.request.delete("/api/jobs/" + created.id)).status(), 204);
      console.log("Removed only this run's generated UI sample");
    }
    console.log("ALL UI CHECKS PASSED");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
