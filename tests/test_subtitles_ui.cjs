// In-memory job and intercepted PATCH; the video is a previously generated
// public example. No user transcript or video is edited/uploaded by this test.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

async function main() {
  const baseURL = process.argv[2] || "http://127.0.0.1:8001";
  const mediaFile = process.env.SUBTITLE_TEST_VIDEO || path.resolve("data/jobs/392c608a2c4c44d1bc84efaa91c0a702/source.mp4");
  const mediaBytes = fs.readFileSync(mediaFile);
  const id = "dddddddddddddddddddddddddddddddd";
  const job = {
    id, filename: "外挂字幕验收 · 本地视频.mp4", state: "completed", progress: 100, has_result: true,
    transcript: { duration: 36000, speaker_names: { SPK0: "发言人甲", SPK1: "发言人乙" },
      segments: Array.from({ length: 12000 }, (_, index) => ({ id: index, start: index * 3, end: index * 3 + 2.5,
        start_ms: index * 3000, end_ms: index * 3000 + 2500, text: index === 0 ? "原始转写字幕" : "转写字幕 " + index, speaker: "SPK" + (index % 2) })),
    },
  };
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const mutations = [];
    const outsideRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.url());
      if (!request.url().startsWith(baseURL)) outsideRequests.push(request.url());
    });
    await page.route("**/api/jobs/" + id, (route) => route.fulfill({ json: job }));
    let mediaRequests = 0;
    await page.route("**/api/jobs/" + id + "/media", (route) => {
      mediaRequests += 1;
      // Native seeking requires the same byte-range contract as FileResponse.
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), mediaBytes.length - 1) : mediaBytes.length - 1;
      const body = mediaBytes.subarray(start, end + 1);
      return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4", body,
        headers: { "Accept-Ranges": "bytes", "Content-Length": String(body.length),
          ...(range ? { "Content-Range": "bytes " + start + "-" + end + "/" + mediaBytes.length } : {}) },
      });
    });
    await page.route("**/api/jobs/" + id + "/result", async (route) => {
      const patch = route.request().postDataJSON();
      Object.assign(job.transcript.speaker_names, patch.speaker_names);
      for (const change of patch.segments) Object.assign(job.transcript.segments[change.id], change);
      await route.fulfill({ json: job.transcript });
    });
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cues = () => page.locator("video").evaluate((media) => [...media.textTracks[0].cues].map((cue) => ({ id: cue.id, start: cue.startTime, end: cue.endTime, text: cue.text })));
    const activeText = () => page.locator("video").evaluate((media) => [...(media.textTracks[0].activeCues || [])].map((cue) => cue.getCueAsHTML().textContent).join("\n"));
    const seek = async (seconds) => {
      await page.locator("video").evaluate((media, time) => { media.pause(); media.currentTime = time; }, seconds);
      try {
        await page.waitForFunction((time) => { const media = document.querySelector("video"); return media.readyState >= 2 && !media.seeking && Math.abs(media.currentTime - time) < 0.1; }, seconds, { timeout: 10000 });
      } catch (error) {
        console.log("SEEK_DIAGNOSTIC=" + JSON.stringify(await page.locator("video").evaluate((media) => ({ currentTime: media.currentTime, readyState: media.readyState, seeking: media.seeking, duration: media.duration, networkState: media.networkState, seekable: Array.from({ length: media.seekable.length }, (_, i) => [media.seekable.start(i), media.seekable.end(i)]), error: media.error?.message }))));
        throw error;
      }
      await settle();
    };
    await page.goto("/#job=" + id);
    await page.locator("#resultView").waitFor({ state: "visible" });
    assert.equal(mediaRequests, 0);
    await page.locator("#subtitleButton").click();
    assert.equal(await page.locator("#subtitleEnabled").isChecked(), true);
    assert.equal(mediaRequests, 0, "enabling captions must not download the video");
    assert.ok((await cues()).length < 100);
    await page.locator("video").evaluate((media) => {
      Object.defineProperty(media, "currentTime", { configurable: true, value: 19500 });
      media.dispatchEvent(new Event("seeking"));
    });
    assert.ok((await cues()).some((cue) => cue.id === "6500"));
    assert.ok((await cues()).length < 100);
    await page.locator("video").evaluate((media) => { delete media.currentTime; media.dispatchEvent(new Event("seeked")); });
    console.log("PASS: caption button, lazy video, 12,000 source cues and bounded native captions after far seek");

    await page.locator("video").evaluate(async (media) => { media.muted = true; await media.play(); media.pause(); });
    await seek(1);
    assert.equal(await activeText(), "[发言人甲] 原始转写字幕");
    await page.locator('[data-segment-text="0"]').fill("校对后的文字：你好，世界。");
    await page.locator("#speakerSettingsButton").click();
    await page.locator('[data-speaker="SPK0"]').fill("校对发言人");
    assert.equal(await activeText(), "[校对发言人] 校对后的文字：你好，世界。");
    await page.locator("#finishSpeakerSettings").click();
    await page.locator("#subtitleSpeaker").uncheck();
    assert.equal(await activeText(), "校对后的文字：你好，世界。");
    await page.locator("#subtitleOffset").fill("2");
    await page.locator("#subtitleOffset").blur();
    await settle();
    assert.equal(await activeText(), "");
    await seek(3.5);
    assert.equal(await activeText(), "校对后的文字：你好，世界。");
    await page.locator("#subtitleOffset").fill("-1");
    await page.locator("#subtitleOffset").blur();
    await seek(0.5);
    assert.equal(await activeText(), "校对后的文字：你好，世界。");
    await page.locator("#subtitleOffset").fill("5000");
    await page.locator("#subtitleOffset").blur();
    assert.match(await page.locator("#subtitleMessage").textContent(), /3600/);
    const saved = page.waitForResponse((response) => response.url().endsWith("/" + id + "/result"));
    await page.locator("#saveButton").click();
    assert.equal((await saved).status(), 200);
    await page.locator("#editStatus").filter({ hasText: "结果已保存" }).waitFor();
    assert.equal(await activeText(), "校对后的文字：你好，世界。");
    console.log("PASS: real video cue timing, draft text, speaker rename/toggle, offsets and saved transcript rebinding");

    const beforeImport = mutations.length;
    const srt = "1\n00:00:00,000 --> 00:00:04,000\n[外部字幕] 你好，世界\n第二行字幕\n\n2\n00:00:05,000 --> 00:00:08,000\n另一句\n";
    await page.locator("#subtitleFile").setInputFiles({ name: "示例外挂.srt", mimeType: "application/x-subrip", buffer: Buffer.from(srt) });
    await page.locator("#subtitleSource").filter({ hasText: "示例外挂.srt" }).waitFor();
    assert.equal(await page.locator("#subtitleOffset").inputValue(), "0");
    assert.equal(await page.locator("#subtitleSpeaker").isDisabled(), true);
    await seek(1);
    assert.equal(await activeText(), "[外部字幕] 你好，世界\n第二行字幕");
    assert.equal(job.transcript.segments[0].text, "校对后的文字：你好，世界。");
    assert.equal(mutations.length, beforeImport, "subtitle import is entirely local");
    await page.locator("#subtitleFile").setInputFiles({ name: "broken.srt", mimeType: "text/plain", buffer: Buffer.from("invalid") });
    await page.locator("#subtitleMessage").filter({ hasText: "未替换" }).waitFor();
    assert.match(await page.locator("#subtitleSource").textContent(), /示例外挂.srt/);
    assert.equal(await activeText(), "[外部字幕] 你好，世界\n第二行字幕");
    await page.locator("#subtitleFile").setInputFiles({ name: "large.srt", mimeType: "text/plain", buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 65) });
    await page.locator("#subtitleMessage").filter({ hasText: "5 MB" }).waitFor();
    assert.match(await page.locator("#subtitleSource").textContent(), /示例外挂.srt/);

    const gb = Buffer.concat([Buffer.from("1\n00:00:00,000 --> 00:00:04,000\n"), Buffer.from("c4e3bac3", "hex")]);
    await page.locator("#subtitleFile").setInputFiles({ name: "国标编码.srt", mimeType: "text/plain", buffer: gb });
    await page.locator("#subtitleSource").filter({ hasText: "国标编码" }).waitFor();
    assert.equal(await activeText(), "你好");
    const vtt = "WEBVTT\n\nSTYLE\n::cue { color: red; }\n\ncue-id\n00:00.000 --> 00:04.000 align:start\n<b>外挂字幕已开启</b>\n全屏也可显示 · 仅在本机读取\n\n00:05.000 --> 00:08.000\n<img src=https://example.invalid/a onerror=alert(1)>\n";
    await page.locator("#subtitleFile").setInputFiles({ name: "本地字幕.vtt", mimeType: "text/vtt", buffer: Buffer.from(vtt) });
    await page.locator("#subtitleSource").filter({ hasText: "本地字幕.vtt" }).waitFor();
    await seek(6);
    assert.match(await activeText(), /<img src=/);
    assert.deepEqual(outsideRequests, []);
    await seek(1);
    await page.locator("#fullscreenVideo").click();
    await page.waitForFunction(() => document.fullscreenElement?.tagName === "VIDEO");
    assert.match(await activeText(), /外挂字幕已开启/);
    if (process.env.CAPTURE_SUBTITLES === "1") console.log("FULLSCREEN_BASE64=" + (await page.screenshot({ type: "jpeg", quality: 65 })).toString("base64"));
    await page.evaluate(() => document.exitFullscreen());
    await settle();
    await page.locator("#subtitleEnabled").uncheck();
    assert.equal(await page.locator("video").evaluate((media) => media.textTracks[0].mode), "disabled");
    await page.locator("#subtitleEnabled").check();
    assert.equal(await page.locator("video").evaluate((media) => media.textTracks[0].mode), "showing");
    assert.equal(mutations.length, beforeImport);
    console.log("PASS: local SRT/VTT, GB18030, error preservation, 5 MB limit, inert markup, fullscreen and captions on/off");

    if (process.env.CAPTURE_SUBTITLES === "1") {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await settle();
      console.log("SCREENSHOT_BASE64=" + (await page.screenshot({ type: "jpeg", quality: 65, fullPage: true })).toString("base64"));
    }
    await page.locator("#useTranscriptSubtitles").click();
    assert.match(await page.locator("#subtitleSource").textContent(), /本次转写/);
    assert.equal(await activeText(), "校对后的文字：你好，世界。");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await settle();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.locator("#backButton").click();
    assert.equal(await page.locator("#landingView").isVisible(), true);
    assert.equal(await page.locator("#subtitleButton").isVisible(), false);
    await page.goto("/#job=" + id);
    await page.reload();
    await page.locator("#resultView").waitFor({ state: "visible" });
    assert.equal(await page.locator("#subtitleEnabled").isChecked(), false);
    assert.match(await page.locator("#subtitleSource").textContent(), /本次转写/);
    assert.deepEqual(errors, []);
    console.log("PASS: restore ASR subtitles, narrow layout, release and reload, no browser errors");
  } finally { await browser.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
