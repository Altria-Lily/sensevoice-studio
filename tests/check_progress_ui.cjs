// Test-only progress replay; never submits or edits a real backend task.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  const id = "cccccccccccccccccccccccccccccccc";
  const started = new Date(Date.now() - 30000).toISOString();
  const job = {
    id, filename: "进度界面回归 · 模拟反馈.mp4", state: "transcribing", progress: 60,
    stage: "语音片段识别中", started_at: started, has_result: false,
    progress_details: {
      extract: { phase: "extract", state: "completed", current: 96000, total: 96000, unit: "ms", label: "音轨提取完成", elapsed_s: 1.5, started_at: started },
      models: {
        phase: "models", state: "completed", current: 4, total: 4, elapsed_s: 15, started_at: started, label: "全部模型已就绪",
        models: ["SenseVoice · 语音识别", "FSMN-VAD · 语音分段", "标点模型", "CAM++ · 说话人"].map((name) => ({ name, state: "completed", elapsed_s: 2.5 })),
      },
      recognize: {
        phase: "recognize", state: "running", substage: "asr", label: "语音片段识别中",
        current: 4, total: 8, unit: "segments", processed_ms: 48000, total_ms: 96000,
        elapsed_s: 10, started_at: started, eta_s: 20,
      },
    },
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1180 }, deviceScaleFactor: 0.8 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/jobs/" + id + "**", (route) => route.fulfill({ json: job }));
    await page.goto((process.argv[2] || "http://127.0.0.1:8001") + "/#job=" + id);
    await page.locator("#progressView").waitFor({ state: "visible" });
    assert.equal(await page.locator(".stage-card").count(), 3);
    assert.equal(await page.locator(".model-progress-list li").count(), 4);
    assert.match(await page.locator("#stageCards").textContent(), /已处理 4 \/ 8 个语音片段/);
    assert.match(await page.locator("#progressPercent").textContent(), /50.0%/);
    assert.match(await page.locator("#stageCards").textContent(), /本阶段预计剩余约/);
    const clock = await page.locator("#processingClock").textContent();
    await page.waitForFunction((old) => document.querySelector("#processingClock").textContent !== old, clock);
    assert.match(await page.locator("#progressPercent").textContent(), /50.0%/);
    await page.screenshot({ path: ".tmp/ui-detailed-progress-v3.png", fullPage: true });
    if (process.env.CAPTURE_PROGRESS === "1") {
      console.log("SCREENSHOT_BASE64=" + (await page.screenshot({ type: "jpeg", quality: 60, fullPage: true })).toString("base64"));
    }
    job.progress_details.recognize.total = null;
    job.progress_details.recognize.total_ms = null;
    job.progress_details.recognize.current = 0;
    job.progress_details.recognize.substage = "vad";
    job.progress_details.recognize.eta_s = null;
    await page.waitForFunction(() => document.querySelector("#progressTrack").classList.contains("indeterminate"));
    assert.equal(await page.locator("#progressTrack").getAttribute("aria-valuenow"), null);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator("#leaveProgress").click();
    await page.locator("#landingView").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    console.log("PASS: stage cards, individual models, elapsed clock, stable actual percentage, unknown totals and mobile layout");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
