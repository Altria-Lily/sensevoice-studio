const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  selectedFile: null,
  activeJob: null,
  pollTimer: null,
  media: null,
  activeSegmentId: null,
  toastTimer: null,
  config: null,
  view: "landing",
  uploadXhr: null,
  pollEpoch: 0,
  historyTimer: null,
  dirty: false,
  dirtyVersion: 0,
  saving: false,
  reader: null,
  followPaused: false,
  segmentById: new Map(),
  dirtySegments: new Set(),
  playbackSegments: [],
  filteredSegments: [],
  searchTimer: null,
  resultEpoch: 0,
  resultController: null,
  processingTimer: null,
  progressSnapshot: null,
  subtitles: null,
  subtitleSource: "transcript",
  subtitleFilename: "",
  subtitleReadEpoch: 0,
  subtitleLoading: false,
  pageWidth: 1240,
  pageWidthFrame: null,
  pageWidthDragging: false,
};

const speakerColors = ["#28745d", "#c05f3f", "#6a5eaa", "#b4871f", "#3576a8", "#a44f78"];
const stateLabels = {
  uploading: "上传中",
  completed: "已完成",
  failed: "失败",
  queued: "排队中",
  preparing: "提取音频",
  loading: "加载模型",
  transcribing: "识别中",
  finalizing: "生成结果",
};

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toast(message, type = "success") {
  const element = $("#toast");
  clearTimeout(state.toastTimer);
  element.textContent = message;
  element.className = `toast show ${type === "error" ? "error" : ""}`;
  state.toastTimer = setTimeout(() => { element.className = "toast"; }, 2800);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = await response.json();
      message = typeof body.detail === "string" ? body.detail : message;
    } catch (_) { /* response was not JSON */ }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showView(name) {
  closeSpeakerSettings();
  setPageWidthPanel(false);
  state.view = name;
  document.body.dataset.view = name;
  clearInterval(state.processingTimer);
  if (name === "progress") state.processingTimer = setInterval(updateProcessingClocks, 1000);
  clearTimeout(state.historyTimer);
  $("#landingView").hidden = name !== "landing";
  $("#progressView").hidden = name !== "progress";
  $("#resultView").hidden = name !== "result";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formError(message = "") {
  $("#formError").textContent = message;
  $("#formError").hidden = !message;
}

function rememberSettings() {
  const preferences = {
    language: $("#languageSelect").value,
    identifySpeakers: $("#speakerToggle").checked,
    speakerCount: $("#speakerNumber").value,
    batchSize: $("#batchSizeSelect").value,
    useItn: $("#itnToggle").checked,
    playbackSpeed: $("#playbackSpeed").value,
    autoFollow: $("#autoFollow").checked,
    textSize: $("#textSize").value,
    focusVideo: $("#focusVideo").getAttribute("aria-pressed") === "true",
    pageWidth: state.pageWidth,
  };
  try { localStorage.setItem("sensevoice.settings.v2", JSON.stringify(preferences)); }
  catch (_) { /* Private browsing may disable storage; the current settings still work. */ }
}

function restoreSettings(reset = false) {
  let preferences = {};
  try { if (!reset) preferences = JSON.parse(localStorage.getItem("sensevoice.settings.v2") || "{}") || {}; }
  catch (_) { /* Ignore old or damaged preferences. */ }
  const setSelect = (id, value, fallback) => {
    const select = $(id);
    select.value = value ?? fallback;
    if (select.selectedIndex < 0) select.value = fallback;
  };
  setSelect("#languageSelect", preferences.language, "auto");
  setSelect("#batchSizeSelect", preferences.batchSize, "");
  setSelect("#playbackSpeed", preferences.playbackSpeed, "1");
  setSelect("#textSize", preferences.textSize, "15");
  document.documentElement.style.setProperty("--transcript-text-size", $("#textSize").value + "px");
  setVideoFocus(preferences.focusVideo === true);
  setPageWidth(preferences.pageWidth ?? 1240);
  $("#speakerToggle").checked = preferences.identifySpeakers !== false;
  $("#itnToggle").checked = preferences.useItn !== false;
  $("#autoFollow").checked = preferences.autoFollow !== false;
  const count = Number(preferences.speakerCount);
  $("#speakerNumber").value = Number.isInteger(count) && count >= 1 && count <= 20 ? count : "";
  $("#speakerNumber").disabled = !$("#speakerToggle").checked;
  if (state.media) state.media.playbackRate = Number($("#playbackSpeed").value);
  if (reset) { rememberSettings(); toast("已恢复默认设置"); }
}

function updatePageWidthUI() {
  const available = Math.max(1, document.documentElement.clientWidth - (innerWidth <= 760 ? 28 : 48));
  const maximum = Math.min(1920, available);
  const width = Math.round(Math.min(state.pageWidth, maximum));
  const range = $("#pageWidth");
  range.min = String(Math.min(960, maximum));
  range.max = String(maximum);
  range.value = String(width);
  range.disabled = available <= 960;
  range.setAttribute("aria-valuetext", width + " 像素");
  $("#pageWidthValue").textContent = width + " px";
  $("#pageWidthHint").textContent = range.disabled
    ? "窄窗口自动适应；放大窗口后可拖动调整。"
    : "仅调整校对页，首页宽度不变。";
}

function setPageWidth(value) {
  const width = Number(value);
  state.pageWidth = Number.isFinite(width) && width >= 960 && width <= 1920 ? Math.round(width) : 1240;
  document.documentElement.style.setProperty("--result-page-width", state.pageWidth + "px");
  updatePageWidthUI();
  // The reader's ResizeObserver measures only mounted rows and retains its anchor.
  // Do not rebuild the transcript or fetch media during a layout adjustment.
}

function positionPageWidthPanel() {
  const panel = $("#pageWidthPanel");
  if (panel.hidden) return;
  const button = $("#pageWidthButton").getBoundingClientRect();
  const width = Math.min(304, document.documentElement.clientWidth - 28);
  panel.style.width = width + "px";
  panel.style.left = Math.max(14, Math.min(button.right - width, document.documentElement.clientWidth - width - 14)) + "px";
  panel.style.top = Math.max(8, Math.min(button.bottom + 8, innerHeight - panel.offsetHeight - 8)) + "px";
}

function setPageWidthPanel(open, restoreFocus = false) {
  $("#pageWidthPanel").hidden = !open;
  $("#pageWidthButton").setAttribute("aria-expanded", String(open));
  if (open) {
    updatePageWidthUI();
    // Keep the slider under the pointer while its parent page changes width.
    positionPageWidthPanel();
  } else if (restoreFocus) $("#pageWidthButton").focus({ preventScroll: true });
}

function updateSpeakerSaveStatus(message = "") {
  const status = $("#speakerSaveStatus");
  status.textContent = message || (state.saving ? "正在保存本页修改，请稍候…"
    : state.dirty ? "有未保存的修改。完成设置会保留草稿，请保存后再导出。"
      : "关闭窗口会保留本页草稿，不会自动保存。");
  status.classList.toggle("unsaved", Boolean(message) || state.dirty);
}

function openSpeakerSettings() {
  if (!state.activeJob?.transcript || $("#speakerDialog").open) return;
  setPageWidthPanel(false);
  $("#exportPopover").hidden = true;
  updateSpeakerSaveStatus();
  $("#speakerDialog").showModal();
  document.body.classList.add("speaker-settings-open");
}

function closeSpeakerSettings() {
  if ($("#speakerDialog").open) $("#speakerDialog").close();
  document.body.classList.remove("speaker-settings-open");
}

async function loadSettings() {
  try {
    state.config = await api("/api/settings");
    $("#storageNote").textContent = "本机保存：" + state.config.storage_dir
      + " · 剩余 " + formatBytes(state.config.free_disk_bytes)
      + "。提取音轨也需要额外空间。";
    $("#batchSizeSelect").options[0].textContent = "服务器默认 · " + state.config.defaults.batch_size_s + " 秒";
    if (state.selectedFile) selectFile(state.selectedFile);
    else resetFile();
  } catch (error) {
    formError("无法读取上传限制，请确认本机服务已启动并刷新页面：" + error.message);
    $("#startButton").disabled = true;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(seconds, withMillis = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const base = `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return withMillis ? `${base}.${String(Math.floor((safe % 1) * 1000)).padStart(3, "0")}` : base;
}

function relativeDate(value) {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

async function checkHealth() {
  const status = $("#engineStatus");
  try {
    const health = await api("/api/health");
    if (health.status === "ok") {
      status.className = "engine-status ready";
      status.lastElementChild.textContent = `${health.model.device.toUpperCase()} · 引擎就绪`;
      status.title = `FunASR ${health.funasr.version} · ${health.model.name}`;
    } else {
      status.className = "engine-status warning";
      status.lastElementChild.textContent = "需要安装依赖";
      status.title = health.ffmpeg.error || "请先运行 install.ps1";
    }
  } catch (error) {
    status.className = "engine-status warning";
    status.lastElementChild.textContent = "服务异常";
    status.title = error.message;
  }
}

function selectFile(file) {
  if (!file) return;
  formError();
  const supported = /\.(mp4|mkv|mov|avi|webm|m4v|mpeg|mpg|mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i;
  let error = !supported.test(file.name) ? "不支持此格式，请选择视频或音频文件。" : "";
  if (!file.size) error = "不能上传空文件，请重新选择。";
  if (state.config && file.size > state.config.max_upload_bytes) {
    error = "文件为 " + formatBytes(file.size) + "，超过 " + formatBytes(state.config.max_upload_bytes) + " 上传限制。";
  }
  if (error) { resetFile(); formError(error); return; }
  state.selectedFile = file;
  $("#fileInput").files = (() => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    return transfer.files;
  })();
  $("#dropZone").classList.add("has-file");
  $("#dropTitle").textContent = "文件已准备好";
  $("#dropHint").textContent = "点击可重新选择";
  $("#filePill").textContent = `${file.name} · ${formatBytes(file.size)}`;
  $("#filePill").hidden = false;
  $("#startButton").disabled = !state.config;
}

function resetFile() {
  state.selectedFile = null;
  $("#fileInput").value = "";
  $("#dropZone").classList.remove("has-file");
  $("#dropTitle").textContent = "将音视频拖到这里";
  $("#dropHint").textContent = "或点击选择文件 · 最大 " + (state.config ? formatBytes(state.config.max_upload_bytes) : "10 GB");
  $("#filePill").hidden = true;
  $("#startButton").disabled = true;
}

async function submitJob(event) {
  event.preventDefault();
  if (!state.selectedFile || !state.config || state.uploadXhr) return;
  if (!$("#uploadForm").reportValidity()) return;
  formError();
  rememberSettings();
  const file = state.selectedFile;
  const button = $("#startButton");
  button.disabled = true;
  const params = new URLSearchParams({
    filename: file.name,
    language: $("#languageSelect").value,
    identify_speakers: String($("#speakerToggle").checked),
    use_itn: String($("#itnToggle").checked),
  });
  if ($("#speakerToggle").checked && $("#speakerNumber").value) params.set("speaker_count", $("#speakerNumber").value);
  if ($("#batchSizeSelect").value) params.set("batch_size_s", $("#batchSizeSelect").value);
  stopPolling();
  state.activeJob = null;
  showView("progress");
  setProgressPhase("upload");
  $("#progressFilename").textContent = file.name;
  $("#progressStage").textContent = "正在将文件上传到本机服务";
  $("#progressHelp").textContent = "上传期间请勿关闭或刷新页面";
  $("#progressLocation").textContent = "目标：" + location.origin + " → " + state.config.storage_dir;
  $("#uploadDetails").textContent = "0 KB / " + formatBytes(file.size) + " · 正在连接";
  setProgressValue(0, "上传 0%");
  $("#cancelUpload").disabled = false;
  const startedAt = performance.now();
  try {
    const job = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.uploadXhr = xhr;
      xhr.open("POST", "/api/jobs/upload?" + params.toString());
      xhr.responseType = "json";
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (progress) => {
        const loaded = Math.min(progress.loaded, file.size);
        const percent = loaded / file.size * 100;
        const speed = loaded / Math.max(0.001, (performance.now() - startedAt) / 1000);
        const remaining = speed > 0 ? Math.ceil((file.size - loaded) / speed) : null;
        setProgressValue(percent, "上传 " + percent.toFixed(1) + "%");
        $("#uploadDetails").textContent = formatBytes(loaded) + " / " + formatBytes(file.size)
          + " · " + formatBytes(speed) + "/秒"
          + (remaining === null ? "" : " · 预计剩余 " + formatTime(remaining));
        if (loaded >= file.size) {
          $("#progressStage").textContent = "文件已发送，等待本机服务确认保存…";
          $("#cancelUpload").disabled = true;
        }
      };
      xhr.onload = () => {
        if (xhr.status === 202 && xhr.response?.id) resolve(xhr.response);
        else reject(new Error(typeof xhr.response?.detail === "string" ? xhr.response.detail : "上传失败（" + xhr.status + "）"));
      };
      xhr.onerror = () => reject(new Error("上传连接中断，请确认本机服务仍在运行后重试。"));
      xhr.onabort = () => reject(Object.assign(new Error("上传已取消，未完成的文件将自动清理。"), { code: "UPLOAD_ABORTED" }));
      xhr.send(file);
    });
    state.uploadXhr = null;
    state.activeJob = job;
    setJobAddress(job.id);
    resetFile();
    showProgress(job);
    pollJob(job.id);
  } catch (error) {
    state.uploadXhr = null;
    if (error.code === "UPLOAD_ABORTED") {
      goHome();
      formError(error.message);
    } else showFailure(error.message, file.name);
  } finally {
    state.uploadXhr = null;
    button.disabled = !state.selectedFile || !state.config;
  }
}

function setJobAddress(jobId) {
  history.replaceState(null, "", location.pathname + location.search + (jobId ? "#job=" + encodeURIComponent(jobId) : ""));
}

function setProgressPhase(phase) {
  $("#progressView").dataset.phase = phase;
  $("#progressEyebrow").textContent = phase === "upload" ? "LOCAL UPLOAD" : phase === "failed" ? "TASK FAILED" : "PROCESSING";
  $$(".progress-steps li").forEach((step) => step.classList.toggle("current", step.dataset.step === phase));
  $("#cancelUpload").hidden = phase !== "upload";
  $("#leaveProgress").hidden = phase === "upload";
  $("#firstRunNote").hidden = true;
  $("#processingDetails").hidden = phase === "upload" || !state.activeJob;
  $("#progressTrack").classList.remove("indeterminate");
  $("#progressTrack").setAttribute("aria-label", phase === "upload" ? "上传进度" : "处理阶段进度");
}

function setProgressValue(value, label) {
  const percent = Math.max(0, Math.min(100, value || 0));
  $("#progressBar").style.width = percent + "%";
  $("#progressTrack").setAttribute("aria-valuenow", String(Math.round(percent)));
  $("#progressPercent").textContent = label;
}

function showFailure(message, filename) {
  stopPolling();
  showView("progress");
  setProgressPhase("failed");
  $("#progressFilename").textContent = filename || "处理失败";
  $("#progressStage").textContent = message;
  $("#progressHelp").textContent = "可返回列表重新选择文件并重试";
  $("#uploadDetails").textContent = "";
  $("#progressLocation").textContent = "";
  if (state.activeJob) renderProcessingDetails(state.activeJob);
}

function showProgress(job) {
  showView("progress");
  setProgressPhase("process");
  $("#progressFilename").textContent = job.filename;
  $("#progressHelp").textContent = "上传已完成，可返回任务列表";
  $("#uploadDetails").textContent = "下方分别显示音轨提取、模型加载和语音识别。识别统计按已完成片段更新，剩余时间仅为估算。";
  $("#progressLocation").textContent = "完成后会自动打开文字页，也可在“最近任务”点击“查看文本”。请保持本机服务运行。";
  if (job.state === "uploading") {
    $("#progressHelp").textContent = "请保持原上传页面打开";
    $("#uploadDetails").textContent = "文件仍在上传，请回到发起上传的页面查看字节进度。接收完成后会开始识别。";
  }
  updateProgress(job);
}

function updateProgress(job) {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  $("#progressStage").textContent = job.stage || stateLabels[job.state] || "正在处理";
  $("#progressBar").style.width = `${progress}%`;
  setProgressValue(progress, "处理阶段 " + progress + "%");
  $("#firstRunNote").hidden = !(job.state === "loading" && /首次|下载|模型/.test(job.stage || ""));
  renderProcessingDetails(job);
}

function progressRatio(detail) {
  if (detail?.state === "completed") return 100;
  return detail?.total > 0 ? Math.max(0, Math.min(100, detail.current / detail.total * 100)) : null;
}

function updateProcessingClocks() {
  const job = state.activeJob;
  if (!job || state.view !== "progress") return;
  const started = Date.parse(job.started_at);
  $("#processingClock").textContent = Number.isFinite(started)
    ? "总处理耗时 " + formatTime(((Date.parse(job.finished_at) || Date.now()) - started) / 1000)
    : "等待任务开始";
  $$(".live-stage-time").forEach((element) => {
    const start = Date.parse(element.dataset.started);
    if (Number.isFinite(start)) element.textContent = "已用 " + formatTime((Date.now() - start) / 1000);
  });
}

function renderProcessingDetails(job) {
  const details = job.progress_details || {};
  const snapshot = job.id + JSON.stringify(details);
  $("#processingDetails").hidden = false;
  if (snapshot !== state.progressSnapshot) {
    state.progressSnapshot = snapshot;
    const cards = $("#stageCards");
    cards.replaceChildren();
    for (const [phase, title] of [["extract", "1 · 提取音轨"], ["models", "2 · 加载模型"], ["recognize", "3 · 语音转文字"]]) {
      const item = details[phase];
      const card = document.createElement("section");
      card.className = "stage-card";
      const status = item?.state || "waiting";
      const ratio = progressRatio(item);
      const statusLabel = { waiting: "等待中", running: "处理中", completed: "已完成", failed: "失败" }[status] || status;
      let amount = "等待前一环节完成";
      if (item) {
        if (phase === "extract") amount = "已输出音轨 " + formatTime(item.current / 1000) + (item.total ? " / 媒体总时长 " + formatTime(item.total / 1000) : " · 总时长暂不可得");
        else if (phase === "models") amount = "已加载 " + item.current + " / " + item.total + " 个模型";
        else amount = item.total == null ? "语音区间检测完成后统计总片段数" : "已处理 " + item.current + " / " + item.total + " 个语音片段";
      }
      const running = status === "running";
      card.innerHTML = '<div class="stage-card-head"><strong>' + title + '</strong><span class="stage-status ' + status + '">' + statusLabel + '</span></div>'
        + '<p class="stage-amount">' + escapeAttribute(amount) + '</p>'
        + '<div class="stage-track' + (running && ratio == null ? " indeterminate" : "") + '"><span style="width:' + (ratio ?? 0) + '%"></span></div>'
        + (item ? '<p class="stage-note">' + escapeAttribute(item.label) + '</p><div class="stage-timing"><span class="' + (running ? "live-stage-time" : "") + '" data-started="' + escapeAttribute(item.started_at) + '">已用 ' + formatTime(item.elapsed_s) + '</span>'
          + '<span>' + (item.eta_s != null && running ? "本阶段预计剩余约 " + formatTime(item.eta_s) + "（估算）" : running ? "等待下一批实际反馈" : "") + '</span></div>' : "");
      if (phase === "models" && item?.models) {
        const list = document.createElement("ul");
        list.className = "model-progress-list";
        for (const model of item.models) {
          const row = document.createElement("li");
          row.innerHTML = '<span>' + escapeAttribute(model.name) + '</span><span class="' + (model.state === "running" ? "live-stage-time" : "") + '" data-started="' + escapeAttribute(model.started_at || "") + '">'
            + (model.state === "completed" ? "就绪 · " + formatTime(model.elapsed_s) : model.state === "running" ? "加载中" : model.state === "failed" ? "失败" : "等待") + '</span>';
          list.append(row);
        }
        card.append(list);
      }
      if (phase === "recognize" && item?.total_ms) {
        const note = document.createElement("p");
        note.className = "stage-note";
        note.textContent = "累计处理音频片段 " + formatTime(item.processed_ms / 1000) + " / " + formatTime(item.total_ms / 1000)
          + "。片段可能按长度排序，不表示视频开头已连续转写到这个时间。";
        card.append(note);
      }
      cards.append(card);
    }
  }
  const active = details.recognize || details.models || details.extract;
  if (active) {
    const ratio = progressRatio(active);
    const label = active.phase === "models" ? "模型 " + active.current + " / " + active.total
      : ratio == null ? "正在统计处理量" : (active.phase === "extract" ? "音轨提取 " : "语音片段 ") + ratio.toFixed(1) + "%";
    setProgressValue(ratio || 0, job.state === "finalizing" ? "正在保存文字结果" : label);
    $("#progressTrack").classList.toggle("indeterminate", ratio == null && active.state === "running");
    if (ratio == null) $("#progressTrack").removeAttribute("aria-valuenow");
  }
  updateProcessingClocks();
}

function stopPolling() {
  state.pollEpoch += 1;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function pollJob(jobId) {
  stopPolling();
  const epoch = state.pollEpoch;
  const tick = async () => {
    try {
      const job = await api("/api/jobs/" + jobId + "?include_transcript=false");
      if (epoch !== state.pollEpoch || state.view !== "progress") return;
      state.activeJob = job;
      updateProgress(job);
      if (job.state === "completed") { await openJob(jobId); return; }
      if (job.state === "failed") { showFailure(job.error || "处理失败", job.filename); return; }
      state.pollTimer = setTimeout(tick, 1200);
    } catch (error) {
      if (epoch !== state.pollEpoch || state.view !== "progress") return;
      $("#progressStage").textContent = "连接暂时中断，正在重试：" + error.message;
      state.pollTimer = setTimeout(tick, 2500);
    }
  };
  await tick();
}

async function loadHistory() {
  clearTimeout(state.historyTimer);
  try {
    const data = await api("/api/jobs?limit=100");
    const grid = $("#historyGrid");
    grid.replaceChildren();
    $("#emptyHistory").hidden = data.jobs.length !== 0;
    for (const job of data.jobs) {
      const card = document.createElement("article");
      const running = !["completed", "failed"].includes(job.state);
      card.className = "history-item";
      card.innerHTML = `
        <div class="history-top">
          <span class="history-type">${/\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(job.filename) ? "▶" : "⌁"}</span>
          <span class="job-state ${job.state === "failed" ? "failed" : running ? "running" : ""}">${stateLabels[job.state] || job.state}</span>
        </div>
        <h3 title="${escapeAttribute(job.filename)}">${escapeAttribute(job.filename)}</h3>
        <p>${relativeDate(job.created_at)} · ${job.identify_speakers ? "说话人识别" : "单一说话人"}</p>
        ${running ? `<div class="history-progress"><span style="width:${job.progress}%"></span></div>` : ""}`;
      const open = () => openJob(job.id);
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.className = "secondary-button compact";
      viewButton.textContent = job.state === "completed" ? "查看文本 →" : job.state === "failed" ? "查看失败原因" : "查看进度";
      viewButton.addEventListener("click", open);
      actions.append(viewButton);
      if (job.state === "completed") {
        const download = document.createElement("a");
        download.textContent = "下载 TXT";
        download.href = "/api/jobs/" + job.id + "/export/txt";
        download.download = "";
        actions.append(download);
      }
      card.append(actions);
      card.addEventListener("click", (event) => { if (!event.target.closest("button, a")) open(); });
      grid.append(card);
    }
    if (state.view === "landing" && data.jobs.some((job) => !["completed", "failed"].includes(job.state))) {
      state.historyTimer = setTimeout(loadHistory, 5000);
    }
  } catch (error) {
    toast(`无法读取历史任务：${error.message}`, "error");
  }
}

function cancelResultLoad() {
  state.resultEpoch += 1;
  state.resultController?.abort();
  state.resultController = null;
  $("#resultLoading").hidden = true;
}

async function openJob(jobId) {
  cancelResultLoad();
  stopPolling();
  const epoch = state.resultEpoch;
  const controller = new AbortController();
  state.resultController = controller;
  $("#resultLoading").hidden = false;
  try {
    const job = await api("/api/jobs/" + jobId, { signal: controller.signal });
    if (epoch !== state.resultEpoch) return;
    state.activeJob = job;
    setJobAddress(job.id);
    if (job.state === "completed") renderResult(job);
    else if (job.state === "failed") { setProgressValue(job.progress, "处理未完成"); showFailure(job.error || "该任务处理失败", job.filename); }
    else {
      showProgress(job);
      pollJob(job.id);
    }
  } catch (error) {
    if (epoch === state.resultEpoch && error.name !== "AbortError") toast(error.message, "error");
  } finally {
    if (epoch === state.resultEpoch) { $("#resultLoading").hidden = true; state.resultController = null; }
  }
}

function speakerIndex(speaker) {
  const speakers = Object.keys(state.activeJob?.transcript?.speaker_names || {});
  const index = speakers.indexOf(speaker);
  return index < 0 ? 0 : index;
}

function speakerColor(speaker) {
  return speakerColors[speakerIndex(speaker) % speakerColors.length];
}

function displaySpeaker(speaker) {
  return state.activeJob.transcript.speaker_names[speaker] || speaker;
}

function renderResult(job) {
  stopPolling();
  releaseMedia();
  state.activeJob = job;
  state.activeSegmentId = null;
  state.reader.clear();
  state.followPaused = false;
  state.dirtySegments.clear();
  indexSegments();
  showView("result");
  setJobAddress(job.id);
  markSaved();
  $("#resultPath").textContent = job.result_files?.txt || job.result_files?.json || "data/jobs/" + job.id + "/result.json";
  $("#resultFilename").textContent = job.filename;
  $("#resultFilename").title = job.filename;
  const transcript = job.transcript;
  const duration = transcript.duration || 0;
  const speakerTotal = Object.keys(transcript.speaker_names).length;
  $("#resultStats").innerHTML = `
    <div class="stat"><strong>${formatTime(duration)}</strong><span>总时长</span></div>
    <div class="stat"><strong>${speakerTotal}</strong><span>说话人</span></div>
    <div class="stat"><strong>${transcript.segments.length}</strong><span>片段</span></div>`;
  renderMedia(job);
  renderSpeakers();
  setupExportLinks();
  $("#searchInput").value = "";
  $("#matchCount").hidden = true;
  $("#emptySearch").hidden = true;
  switchTranscriptView("timeline");
  renderTimeline({ reset: true });
  updateFollowUI();
}

function indexSegments() {
  const segments = state.activeJob.transcript.segments;
  state.segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  state.playbackSegments = [...segments].sort((a, b) => a.start - b.start);
}

function releaseMedia() {
  cancelSubtitleImport();
  state.subtitles?.attach(null);
  const media = state.media;
  state.media = null;
  if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
}

function renderMedia(job) {
  const mount = $("#mediaMount");
  mount.replaceChildren();
  const isVideo = /\.(mp4|mkv|mov|avi|webm|m4v|mpeg|mpg)$/i.test(job.filename);
  $("#mediaLabel").textContent = isVideo ? "视频预览" : "音频预览";
  $("#mediaResolution").textContent = "";
  $("#mediaPlaceholder").hidden = !isVideo;
  $("#fullscreenVideo").hidden = !isVideo || !document.fullscreenEnabled;
  $("#focusVideo").hidden = !isVideo;
  const media = document.createElement(isVideo ? "video" : "audio");
  media.controls = true;
  media.preload = "none";
  media.src = `/api/jobs/${job.id}/media`;
  if (isVideo) media.playsInline = true;
  media.addEventListener("loadeddata", () => {
    if (state.media !== media) return;
    $("#mediaPlaceholder").hidden = true;
    $("#mediaResolution").textContent = isVideo ? media.videoWidth + " × " + media.videoHeight : "";
  });
  let fallbackUsed = false;
  media.addEventListener("error", () => {
    if (state.media !== media || state.activeJob?.id !== job.id) return;
    if (fallbackUsed) return;
    fallbackUsed = true;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `/api/jobs/${job.id}/audio`;
    mount.replaceChildren(audio);
    $("#mediaPlaceholder").hidden = true;
    $("#mediaLabel").textContent = "音轨预览";
    $("#mediaResolution").textContent = "";
    $("#fullscreenVideo").hidden = true;
    $("#focusVideo").hidden = true;
    bindMedia(audio);
    toast("浏览器无法播放原视频，已切换到音轨");
  });
  mount.append(media);
  bindMedia(media);
}

function bindMedia(media) {
  state.media = media;
  cancelSubtitleImport();
  state.subtitleSource = "transcript";
  state.subtitleFilename = "";
  $("#subtitlePanel").hidden = true;
  $("#subtitleButton").setAttribute("aria-expanded", "false");
  $("#subtitleSpeaker").checked = true;
  $("#subtitleOffset").value = "0";
  subtitleMessage();
  state.subtitles.attach(media);
  if (media.tagName === "VIDEO") setTranscriptSubtitles();
  media.playbackRate = Number($("#playbackSpeed").value);
  media.addEventListener("timeupdate", syncActiveSegment);
  media.addEventListener("seeked", syncActiveSegment);
}

function subtitleMessage(message = "", error = false) {
  $("#subtitleMessage").textContent = message;
  $("#subtitleMessage").hidden = !message;
  $("#subtitleMessage").classList.toggle("error", error);
}

function cancelSubtitleImport() {
  state.subtitleReadEpoch += 1;
  state.subtitleLoading = false;
  $("#importSubtitles").disabled = false;
}

function updateSubtitleUI() {
  const player = state.subtitles;
  const available = Boolean(player?.media);
  $("#subtitleButton").hidden = !available;
  $("#subtitleButton").classList.toggle("enabled", Boolean(player?.enabled));
  $("#subtitleEnabled").checked = Boolean(player?.enabled);
  $("#subtitleSpeaker").disabled = state.subtitleSource !== "transcript";
  $("#subtitleStatus").textContent = (player?.enabled ? "已开启" : "已关闭") + " · " + (player?.items.length || 0) + " 条";
  $("#subtitleSource").textContent = state.subtitleLoading ? "正在读取本机字幕…" : state.subtitleSource === "external"
    ? "当前来源：" + state.subtitleFilename + "（仅本次预览）" : "当前来源：本次转写 · 预览包含未保存的校对";
  if (!available) {
    $("#subtitlePanel").hidden = true;
    $("#subtitleButton").setAttribute("aria-expanded", "false");
  }
}

function setTranscriptSubtitles() {
  if (!state.activeJob?.transcript) return;
  state.subtitleSource = "transcript";
  state.subtitleFilename = "";
  state.subtitles.setSource(state.activeJob.transcript.segments, (item) => {
    return ($("#subtitleSpeaker").checked ? "[" + displaySpeaker(item.speaker) + "] " : "") + item.text;
  });
}

async function importSubtitles(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !state.subtitles.media) return;
  const epoch = ++state.subtitleReadEpoch;
  state.subtitleLoading = true;
  $("#importSubtitles").disabled = true;
  subtitleMessage();
  updateSubtitleUI();
  try {
    if (!/\.(srt|vtt)$/i.test(file.name)) throw new Error("请选择 .srt 或 .vtt 字幕文件。");
    if (file.size > MAX_SUBTITLE_BYTES) throw new Error("外挂字幕文件最大 5 MB；视频上传仍支持 10 GB。");
    const buffer = await file.arrayBuffer();
    if (epoch !== state.subtitleReadEpoch) return;
    const result = parseSubtitleText(decodeSubtitleBytes(buffer));
    state.subtitleSource = "external";
    state.subtitleFilename = file.name;
    state.subtitles.setOffset(0);
    $("#subtitleOffset").value = "0";
    state.subtitles.setSource(result.cues);
    state.subtitles.setEnabled(true);
    subtitleMessage("已在浏览器载入 " + result.cues.length + " 条字幕。" + (result.skipped ? "已跳过 " + result.skipped + " 个无效字幕块。" : ""));
  } catch (error) {
    if (epoch === state.subtitleReadEpoch) subtitleMessage("未替换当前字幕：" + error.message, true);
  } finally {
    if (epoch === state.subtitleReadEpoch) {
      state.subtitleLoading = false;
      $("#importSubtitles").disabled = false;
      updateSubtitleUI();
    }
  }
}

function setVideoFocus(enabled) {
  $(".workspace-grid").classList.toggle("video-focus", enabled);
  $("#focusVideo").setAttribute("aria-pressed", String(enabled));
  $("#focusVideo").textContent = enabled ? "恢复双栏" : "专注视频";
  state.reader?.schedule();
}

function updateFollowUI() {
  const paused = state.followPaused && $("#autoFollow").checked;
  $("#jumpToPlaying").classList.toggle("paused", paused);
  $("#jumpToPlaying").textContent = paused ? "↩ 回到播放位置" : "◎ 定位播放";
  $("#scrollHint").textContent = paused ? "自由阅读中 · 自动跟随已暂停" : "下滑连续阅读 · 文字可直接编辑";
}

function pauseFollowing() {
  state.reader?.cancelJump();
  if (!state.followPaused) { state.followPaused = true; updateFollowUI(); }
}

function jumpToPlaying() {
  state.followPaused = false;
  updateFollowUI();
  if (!state.activeJob?.transcript) return;
  let segment = state.segmentById.get(state.activeSegmentId);
  if (!segment) {
    const current = state.media?.currentTime || 0;
    segment = state.playbackSegments.find((item) => item.end > current) || state.playbackSegments.at(-1);
  }
  if (!segment) return;
  let index = state.filteredSegments.findIndex((item) => item.id === segment.id);
  if (index < 0) {
    clearTimeout(state.searchTimer);
    $("#searchInput").value = "";
    renderTimeline({ reset: true });
    index = state.filteredSegments.findIndex((item) => item.id === segment.id);
  }
  state.reader.scrollToIndex(index);
}

function renderSpeakers() {
  const speakers = Object.entries(state.activeJob.transcript.speaker_names);
  $("#speakerCount").textContent = `${speakers.length} 位`;
  $("#speakerButtonCount").textContent = String(speakers.length);
  $("#emptySpeakers").hidden = speakers.length > 0;
  const list = $("#speakerList");
  list.replaceChildren();
  speakers.forEach(([speaker, name], index) => {
    const row = document.createElement("label");
    row.className = "speaker-row";
    row.style.setProperty("--speaker-color", speakerColors[index % speakerColors.length]);
    row.innerHTML = `<span class="speaker-avatar">${index + 1}</span><input data-speaker="${escapeAttribute(speaker)}" value="${escapeAttribute(name)}" maxlength="80" aria-label="${escapeAttribute(speaker)} 的名称">`;
    list.append(row);
  });
}

function resizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(44, textarea.scrollHeight)}px`;
}

function resizeVisibleTextareas() {
  const textareas = $$(".segment-text").filter((element) => element.offsetParent !== null);
  // Group layout writes and reads: avoid one full-page reflow per textarea.
  textareas.forEach((element) => { element.style.height = "auto"; });
  const heights = textareas.map((element) => Math.max(44, Math.min(360, element.scrollHeight)));
  textareas.forEach((element, index) => { element.style.height = heights[index] + "px"; });
}

function renderTimeline({ reset = false } = {}) {
  const transcript = state.activeJob.transcript;
  const query = $("#searchInput").value.trim().toLocaleLowerCase();
  state.filteredSegments = query ? transcript.segments.filter((segment) => segment.text.toLocaleLowerCase().includes(query)) : transcript.segments;
  const total = state.filteredSegments.length;
  $("#matchCount").hidden = !query;
  $("#matchCount").textContent = total + " 条";
  $("#emptySearch").hidden = total > 0;
  $("#emptySearch").textContent = query ? "没有找到匹配内容，试试其他关键词" : "此音视频没有识别到可阅读的文字";
  state.reader.setItems(state.filteredSegments, { reset });
}

function createSegmentRow(segment) {
    const speakers = Object.keys(state.activeJob.transcript.speaker_names);
    const row = document.createElement("article");
    row.className = "segment";
    row.classList.toggle("active", segment.id === state.activeSegmentId);
    row.dataset.id = segment.id;
    row.dataset.start = segment.start;
    row.dataset.end = segment.end;
    row.style.setProperty("--speaker-color", speakerColor(segment.speaker));

    const timeColumn = document.createElement("div");
    timeColumn.className = "segment-time";
    const timeButton = document.createElement("button");
    timeButton.className = "time-button";
    timeButton.type = "button";
    timeButton.textContent = formatTime(segment.start, true);
    timeButton.addEventListener("click", () => seekTo(segment.start));
    const duration = document.createElement("span");
    duration.className = "segment-duration";
    duration.textContent = `${Math.max(0, segment.end - segment.start).toFixed(1)} 秒`;
    timeColumn.append(timeButton, duration);

    const content = document.createElement("div");
    const head = document.createElement("div");
    head.className = "segment-head";
    const select = document.createElement("select");
    select.className = "speaker-select";
    select.dataset.segmentSpeaker = segment.id;
    select.setAttribute("aria-label", `片段 ${segment.id + 1} 的说话人`);
    speakers.forEach((speaker) => {
      const option = document.createElement("option");
      option.value = speaker;
      option.textContent = displaySpeaker(speaker);
      option.selected = segment.speaker === speaker;
      select.append(option);
    });
    select.addEventListener("change", () => {
      row.style.setProperty("--speaker-color", speakerColor(select.value));
    });
    const metadata = document.createElement("span");
    metadata.className = "segment-meta";
    metadata.textContent = [segment.language, segment.emotion, segment.event].filter(Boolean).join(" · ");
    head.append(select, metadata);

    const textarea = document.createElement("textarea");
    textarea.className = "segment-text";
    textarea.maxLength = 20000;
    textarea.dataset.segmentText = segment.id;
    textarea.value = segment.text;
    textarea.setAttribute("aria-label", `片段 ${segment.id + 1} 文本`);
    textarea.addEventListener("input", () => resizeTextarea(textarea));
    content.append(head, textarea);
    row.append(timeColumn, content);
    return row;
}

function seekTo(seconds) {
  if (!state.media) return;
  state.followPaused = false;
  updateFollowUI();
  const media = state.media;
  if (!media.readyState) {
    media.addEventListener("loadedmetadata", () => {
      if (media === state.media) media.currentTime = Math.max(0, seconds);
    }, { once: true });
    media.load();
  } else media.currentTime = Math.max(0, seconds);
  media.play().catch(() => {});
}

function syncActiveSegment() {
  if (!state.media || !state.activeJob?.transcript) return;
  const current = state.media.currentTime;
  const segments = state.playbackSegments;
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (segments[mid].start <= current) lo = mid + 1; else hi = mid; }
  const candidate = segments[lo - 1];
  const segment = candidate && current < candidate.end ? candidate : null;
  if (!segment) {
    state.activeSegmentId = null;
    $$(".segment.active").forEach((element) => element.classList.remove("active"));
    return;
  }
  if (segment.id === state.activeSegmentId) return;
  state.activeSegmentId = segment.id;
  if ($("#autoFollow").checked && !state.followPaused && !$("#timelinePane").hidden
    && !document.activeElement?.matches(".segment-text, .speaker-select")) {
    const index = state.filteredSegments.findIndex((item) => item.id === segment.id);
    if (index >= 0 && !state.reader.isVisible(index)) state.reader.scrollToIndex(index);
  }
  $$(".segment.active").forEach((element) => element.classList.remove("active"));
  const row = $(`.segment[data-id="${segment.id}"]`);
  if (row) {
    row.classList.add("active");
  }
  $("#nowPlaying").textContent = `${displaySpeaker(segment.speaker)}：${segment.text}`;
}

function searchTimeline(event) {
  clearTimeout(state.searchTimer);
  pauseFollowing();
  if (event?.type === "input") state.searchTimer = setTimeout(() => renderTimeline({ reset: true }), 150);
  else renderTimeline({ reset: true });
}

async function saveChanges() {
  if (!state.activeJob?.transcript || state.saving) return false;
  state.saving = true;
  const version = state.dirtyVersion;
  const button = $("#saveButton");
  button.disabled = true;
  $("#saveSpeakerSettings").disabled = true;
  updateSpeakerSaveStatus();
  const speakerNames = {};
  Object.assign(speakerNames, state.activeJob.transcript.speaker_names);
  const segments = [...state.dirtySegments].map((id) => {
    const segment = state.segmentById.get(id);
    return { id, text: segment.text, speaker: segment.speaker };
  });
  let saveError = "";
  try {
    const transcript = await api(`/api/jobs/${state.activeJob.id}/result`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker_names: speakerNames, segments }),
    });
    if (version === state.dirtyVersion) {
      state.activeJob.transcript = transcript;
      state.dirtySegments.clear();
      indexSegments();
      if (state.subtitleSource === "transcript") setTranscriptSubtitles();
      markSaved();
      renderSpeakers();
      renderTimeline();
    }
    if (!$("#fullTextPane").hidden) refreshFullText();
    toast(state.dirty ? "已保存本次提交，新增草稿仍需保存" : "修改已保存");
    return !state.dirty;
  } catch (error) {
    toast(error.message, "error");
    saveError = "保存失败：" + error.message + "。草稿已保留，请重试。";
    return false;
  } finally {
    state.saving = false;
    button.disabled = false;
    $("#saveSpeakerSettings").disabled = false;
    updateSpeakerSaveStatus(saveError);
  }
}

function editedLines() {
  return state.activeJob.transcript.segments.map((segment) => {
    return "[" + formatTime(segment.start) + "] " + displaySpeaker(segment.speaker) + "：" + segment.text;
  });
}

function refreshFullText() {
  if (state.activeJob?.transcript) $("#fullText").value = editedLines().join("\n\n");
}

function switchTranscriptView(view) {
  const timeline = view === "timeline";
  $("#timelinePane").hidden = !timeline;
  $("#fullTextPane").hidden = timeline;
  $("#timelineTab").setAttribute("aria-selected", String(timeline));
  $("#fullTextTab").setAttribute("aria-selected", String(!timeline));
  $("#timelineTab").tabIndex = timeline ? 0 : -1;
  $("#fullTextTab").tabIndex = timeline ? -1 : 0;
  if (!timeline) refreshFullText();
  else state.reader?.schedule();
}

function markDirty() {
  state.dirty = true;
  state.dirtyVersion += 1;
  $("#editStatus").textContent = "有未保存的修改，请点击“保存修改”后再下载";
  $("#editStatus").classList.add("unsaved");
  updateSpeakerSaveStatus();
  if (state.subtitleSource === "transcript") state.subtitles?.refresh(true);
  if (!$("#fullTextPane").hidden) refreshFullText();
}

function markSaved() {
  state.dirty = false;
  $("#editStatus").textContent = "结果已保存到本机";
  $("#editStatus").classList.remove("unsaved");
  updateSpeakerSaveStatus();
}

async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(editedLines().join("\n"));
    toast("全文已复制");
  } catch (_) {
    toast("浏览器未允许访问剪贴板", "error");
  }
}

function setupExportLinks() {
  $$('[data-format]', $("#resultView")).forEach((link) => {
    link.href = `/api/jobs/${state.activeJob.id}/export/${link.dataset.format}`;
    link.download = "";
  });
}

function goHome() {
  if (state.uploadXhr) { toast("上传仍在进行；要中断请先点击“取消上传”。", "error"); return; }
  if (state.saving) { toast("正在保存，请稍候"); return; }
  if (state.dirty && !window.confirm("有未保存的文字修改，确定返回任务列表并放弃这些修改吗？")) return;
  state.dirty = false;
  state.dirtySegments.clear();
  cancelResultLoad();
  clearTimeout(state.searchTimer);
  state.reader.clear();
  state.filteredSegments = [];
  stopPolling();
  releaseMedia();
  state.activeJob = null;
  setJobAddress(null);
  showView("landing");
  loadHistory();
}

function bindEvents() {
  state.subtitles = new SubtitlePlayer(updateSubtitleUI);
  state.reader = new VirtualTimeline({
    viewport: $("#timelineScroll"), list: $("#timeline"), createRow: createSegmentRow,
    onRender: resizeVisibleTextareas,
    onRangeChange: ({ first, last, total, progress, atEnd }) => {
      $("#pageInfo").textContent = first + "–" + last + " / " + total + " 段";
      $("#scrollEnd").textContent = total ? (atEnd ? "已到末尾" : "↓ 下滑继续") : "";
      $("#readingProgress").style.width = progress * 100 + "%";
    },
  });
  const timelineScroll = $("#timelineScroll");
  ["wheel", "touchstart"].forEach((event) => timelineScroll.addEventListener(event, pauseFollowing, { passive: true }));
  timelineScroll.addEventListener("pointerdown", (event) => { if (event.target === timelineScroll) pauseFollowing(); });
  timelineScroll.addEventListener("keydown", (event) => {
    if (event.target === timelineScroll && ["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "].includes(event.key)) pauseFollowing();
  });
  $("#fileInput").addEventListener("change", (event) => selectFile(event.target.files[0]));
  const dropZone = $("#dropZone");
  ["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }));
  dropZone.addEventListener("drop", (event) => selectFile(event.dataTransfer.files[0]));
  $("#uploadForm").addEventListener("submit", submitJob);
  $("#brandButton").addEventListener("click", goHome);
  $("#backButton").addEventListener("click", goHome);
  $("#leaveProgress").addEventListener("click", goHome);
  $("#refreshHistory").addEventListener("click", loadHistory);
  $("#saveButton").addEventListener("click", saveChanges);
  $("#speakerSettingsButton").addEventListener("click", openSpeakerSettings);
  $("#closeSpeakerSettings").addEventListener("click", closeSpeakerSettings);
  $("#finishSpeakerSettings").addEventListener("click", closeSpeakerSettings);
  $("#saveSpeakerSettings").addEventListener("click", async () => {
    if (await saveChanges()) closeSpeakerSettings();
  });
  $("#speakerDialog").addEventListener("close", () => {
    if (!$("#speakerDialog").open) document.body.classList.remove("speaker-settings-open");
  });
  $("#speakerDialog").addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeSpeakerSettings();
  });
  $("#pageWidthButton").addEventListener("click", () => {
    $("#exportPopover").hidden = true;
    setPageWidthPanel($("#pageWidthPanel").hidden);
  });
  $("#pageWidth").addEventListener("input", (event) => {
    const width = event.target.value;
    cancelAnimationFrame(state.pageWidthFrame);
    state.pageWidthFrame = requestAnimationFrame(() => { state.pageWidthFrame = null; setPageWidth(width); });
  });
  $("#pageWidth").addEventListener("change", (event) => {
    cancelAnimationFrame(state.pageWidthFrame);
    state.pageWidthFrame = null;
    setPageWidth(event.target.value);
    rememberSettings();
  });
  $("#pageWidth").addEventListener("pointerdown", () => { state.pageWidthDragging = true; });
  ["pointerup", "pointercancel", "blur"].forEach((name) => window.addEventListener(name, () => { state.pageWidthDragging = false; }));
  $("#resetPageWidth").addEventListener("click", () => {
    cancelAnimationFrame(state.pageWidthFrame);
    state.pageWidthFrame = null;
    setPageWidth(1240);
    rememberSettings();
  });
  window.addEventListener("resize", () => { updatePageWidthUI(); positionPageWidthPanel(); });
  window.addEventListener("scroll", () => {
    if (!state.pageWidthDragging) positionPageWidthPanel();
  }, { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#pageWidthPanel").hidden) { event.preventDefault(); setPageWidthPanel(false, true); }
  });
  $("#copyButton").addEventListener("click", copyTranscript);
  $("#cancelReading").addEventListener("click", cancelResultLoad);
  $("#subtitleButton").addEventListener("click", () => {
    const open = $("#subtitlePanel").hidden;
    $("#subtitlePanel").hidden = !open;
    $("#subtitleButton").setAttribute("aria-expanded", String(open));
    if (open) state.subtitles.setEnabled(true);
  });
  $("#subtitleEnabled").addEventListener("change", (event) => state.subtitles.setEnabled(event.target.checked));
  $("#subtitleSpeaker").addEventListener("change", () => state.subtitles.refresh(true));
  $("#subtitleOffset").addEventListener("change", (event) => {
    try { state.subtitles.setOffset(Number(event.target.value)); subtitleMessage(); }
    catch (error) { event.target.value = state.subtitles.offset; subtitleMessage(error.message, true); }
  });
  $("#useTranscriptSubtitles").addEventListener("click", () => {
    cancelSubtitleImport();
    setTranscriptSubtitles();
    state.subtitles.setOffset(0);
    $("#subtitleOffset").value = "0";
    state.subtitles.setEnabled(true);
    subtitleMessage();
  });
  $("#importSubtitles").addEventListener("click", () => $("#subtitleFile").click());
  $("#subtitleFile").addEventListener("change", importSubtitles);
  $("#jumpToPlaying").addEventListener("click", jumpToPlaying);
  $("#textSize").addEventListener("change", () => {
    document.documentElement.style.setProperty("--transcript-text-size", $("#textSize").value + "px");
    state.reader.refreshLayout();
    rememberSettings();
  });
  $("#focusVideo").addEventListener("click", () => {
    setVideoFocus($("#focusVideo").getAttribute("aria-pressed") !== "true");
    requestAnimationFrame(() => $(".media-heading").scrollIntoView({ block: "start", behavior: "instant" }));
    rememberSettings();
  });
  $("#fullscreenVideo").addEventListener("click", async () => {
    try { await state.media?.requestFullscreen(); }
    catch (_) { toast("无法进入全屏，可点击“专注视频”放大预览", "error"); }
  });
  $("#cancelUpload").addEventListener("click", () => state.uploadXhr?.abort());
  $("#resetSettings").addEventListener("click", () => restoreSettings(true));
  ["#languageSelect", "#speakerToggle", "#speakerNumber", "#batchSizeSelect", "#itnToggle", "#playbackSpeed", "#autoFollow"].forEach((id) => {
    $(id).addEventListener("change", () => {
      $("#speakerNumber").disabled = !$("#speakerToggle").checked;
      if (state.media) state.media.playbackRate = Number($("#playbackSpeed").value);
      if (id === "#autoFollow") { state.followPaused = false; updateFollowUI(); }
      rememberSettings();
    });
  });
  $("#timelineTab").addEventListener("click", () => switchTranscriptView("timeline"));
  $("#fullTextTab").addEventListener("click", () => switchTranscriptView("full"));
  $(".transcript-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const timeline = event.key === "Home" || (event.key !== "End" && event.target.id !== "timelineTab");
    switchTranscriptView(timeline ? "timeline" : "full");
    $(timeline ? "#timelineTab" : "#fullTextTab").focus();
  });
  $("#resultView").addEventListener("input", (event) => {
    const input = event.target;
    if (!state.activeJob?.transcript) return;
    if (input.matches("[data-speaker]")) {
      state.activeJob.transcript.speaker_names[input.dataset.speaker] = input.value;
      $$(".speaker-select option").forEach((option) => {
        if (option.value === input.dataset.speaker) option.textContent = input.value || input.dataset.speaker;
      });
      markDirty();
    } else if (input.matches("[data-segment-text], [data-segment-speaker]")) {
      const id = Number(input.dataset.segmentText ?? input.dataset.segmentSpeaker);
      const segment = state.segmentById.get(id);
      if (!segment) return;
      if (input.dataset.segmentText !== undefined) segment.text = input.value;
      else segment.speaker = input.value;
      state.dirtySegments.add(id);
      markDirty();
    }
  });
  $$("[data-format]", $("#resultView")).forEach((link) => link.addEventListener("click", (event) => {
    if (state.dirty || state.saving) { event.preventDefault(); toast("请先保存修改，再下载最新文字。", "error"); }
  }));
  $("#searchInput").addEventListener("input", searchTimeline);
  $("#exportButton").addEventListener("click", (event) => {
    event.stopPropagation();
    setPageWidthPanel(false);
    $("#exportPopover").hidden = !$("#exportPopover").hidden;
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".export-menu")) $("#exportPopover").hidden = true;
    if (!event.target.closest(".layout-menu")) setPageWidthPanel(false);
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.uploadXhr || state.dirty || state.saving) { event.preventDefault(); event.returnValue = ""; }
  });
}

async function init() {
  bindEvents();
  restoreSettings();
  resetFile();
  const match = location.hash.match(/^#job=([a-f0-9]{32})$/);
  // A cold GPU/health check must not delay opening existing text.
  await Promise.all([match ? openJob(match[1]) : Promise.resolve(), checkHealth(), loadHistory(), loadSettings()]);
}

init();
