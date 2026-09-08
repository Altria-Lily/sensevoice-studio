// Read-only result-page benchmark. No media, text, or names are changed.
const { chromium } = require("playwright");

async function main() {
  const baseURL = process.argv[2] || "http://127.0.0.1:8001";
  const jobId = process.argv[3];
  if (!jobId) throw new Error("Pass a completed job ID");
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu"] });
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const apiStart = performance.now();
    const response = await context.request.get("/api/jobs/" + jobId);
    const job = await response.json();
    const apiMs = performance.now() - apiStart;
    await page.goto("/");
    const card = page.locator(".history-item").filter({ hasText: job.filename });
    await card.getByRole("button", { name: "查看文本 →" }).waitFor();
    await page.evaluate(() => {
      window.__longTasks = [];
      window.__taskObserver = new PerformanceObserver((list) => {
        window.__longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      window.__taskObserver.observe({ type: "longtask" });
    });
    const begin = performance.now();
    await card.getByRole("button", { name: "查看文本 →" }).click();
    await page.locator("#resultView").waitFor({ state: "visible" });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const openMs = performance.now() - begin;
    const metrics = await page.evaluate(() => ({
      renderedRows: document.querySelectorAll(".segment").length,
      domNodes: document.querySelectorAll("*").length,
      longestTaskMs: Math.max(0, ...window.__longTasks),
      blockingTimeMs: window.__longTasks.reduce((sum, value) => sum + value, 0),
    }));
    console.log(JSON.stringify({
      jobId, segments: job.transcript?.segments?.length, apiMs: Math.round(apiMs),
      clickToReadyMs: Math.round(openMs), ...metrics,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
