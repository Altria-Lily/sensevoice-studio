// Local-only SRT/WebVTT parsing and native video captions. Imported styles,
// links and markup are never inserted into the page or fetched from a server.
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_SUBTITLE_CUES = 50000;

function subtitleTimestamp(value) {
  const match = String(value).match(/^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, "0")) / 1000;
}

function plainSubtitleText(value) {
  return value
    .replace(/<\/?(?:b|i|u|ruby|rt|font)(?:\s[^>]*)?>|<\/?c(?:\.[^\s<>]+)*>|<\/?(?:v|lang)(?:\s[^>]*)?>|<\d{2,}:[\d:.]+>/gi, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (whole, entity) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "\u200e", rlm: "\u200f" };
      if (entity[0] !== "#") return named[entity.toLowerCase()] || whole;
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }).trim();
}

function parseSubtitleText(text) {
  const blocks = String(text).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").trim().split(/\n[\t ]*\n/);
  const cues = [];
  let skipped = 0;
  for (const block of blocks) {
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:[\t \n]|$)/.test(block)) continue;
    const lines = block.split("\n");
    const timingIndex = lines[0]?.includes("-->") ? 0 : lines[1]?.includes("-->") ? 1 : -1;
    if (timingIndex < 0) { if (block.trim()) skipped += 1; continue; }
    const timing = lines[timingIndex].trim().match(/^(\S+)\s+-->\s+(\S+)(?:[\t ].*)?$/);
    const start = timing ? subtitleTimestamp(timing[1]) : NaN;
    const end = timing ? subtitleTimestamp(timing[2]) : NaN;
    const content = plainSubtitleText(lines.slice(timingIndex + 1).join("\n"));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !content) { skipped += 1; continue; }
    cues.push({ id: cues.length, start, end, text: content });
    if (cues.length > MAX_SUBTITLE_CUES) throw new Error("字幕超过 50,000 条，请先拆分文件。");
  }
  if (!cues.length) throw new Error("没有找到有效字幕，请检查 SRT / VTT 的时间码和文件编码。");
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { cues, skipped };
}

function decodeSubtitleBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > MAX_SUBTITLE_BYTES) throw new Error("外挂字幕文件最大 5 MB；视频上传仍支持 10 GB。");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (_) {
    try { return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
    catch (_) { throw new Error("无法识别字幕编码，请另存为 UTF-8 后导入。"); }
  }
}

function escapeSubtitleCue(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class SubtitlePlayer {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.media = null;
    this.track = null;
    this.items = [];
    this.prefixEnds = [];
    this.cues = new Map();
    this.enabled = false;
    this.offset = 0;
    this.center = NaN;
    this.textFor = (item) => item.text;
    this.onTime = () => this.refresh();
    this.onSeek = () => this.refresh(true);
    this.onTrackChange = () => {
      if (!this.track) return;
      const enabled = this.track.mode === "showing";
      if (enabled !== this.enabled) { this.enabled = enabled; this.refresh(true); this.onChange(); }
    };
  }

  attach(media) {
    if (this.media) {
      this.media.removeEventListener("timeupdate", this.onTime);
      ["seeking", "seeked", "loadedmetadata"].forEach((name) => this.media.removeEventListener(name, this.onSeek));
      this.media.textTracks.removeEventListener("change", this.onTrackChange);
    }
    this.clearCues();
    if (this.track) this.track.mode = "disabled";
    this.media = media?.tagName === "VIDEO" ? media : null;
    this.track = null;
    this.items = [];
    this.prefixEnds = [];
    this.enabled = false;
    this.offset = 0;
    this.center = NaN;
    if (this.media) {
      this.track = this.media.addTextTrack("subtitles", "外挂字幕", "zh");
      this.track.mode = "disabled";
      this.media.addEventListener("timeupdate", this.onTime);
      ["seeking", "seeked", "loadedmetadata"].forEach((name) => this.media.addEventListener(name, this.onSeek));
      this.media.textTracks.addEventListener("change", this.onTrackChange);
    }
    this.onChange();
  }

  clearCues() {
    if (this.track) for (const cue of this.cues.values()) this.track.removeCue(cue);
    this.cues.clear();
  }

  setSource(items, textFor = (item) => item.text) {
    this.clearCues();
    this.items = items.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
      .slice().sort((a, b) => a.start - b.start || a.end - b.end);
    let end = -Infinity;
    this.prefixEnds = this.items.map((item) => (end = Math.max(end, item.end)));
    this.textFor = textFor;
    this.center = NaN;
    this.refresh(true);
    this.onChange();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled && this.track);
    if (this.track) this.track.mode = this.enabled ? "showing" : "disabled";
    this.refresh(true);
    this.onChange();
  }

  setOffset(seconds) {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 3600) throw new Error("字幕偏移需在 -3600 到 3600 秒之间。");
    this.offset = seconds;
    this.center = NaN;
    this.refresh(true);
  }

  refresh(force = false) {
    if (!this.enabled || !this.track || !this.media) return;
    const current = this.media.currentTime - this.offset;
    if (!force && Number.isFinite(this.center) && Math.abs(current - this.center) < 20) return;
    this.center = current;
    const start = current - 45;
    const end = current + 90;
    let lo = 0;
    let hi = this.items.length;
    // Prefix maximum end-times retain long/overlapping cues when seeking.
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.prefixEnds[mid] <= start) lo = mid + 1; else hi = mid; }
    const wanted = new Map();
    for (let i = lo; i < this.items.length && this.items[i].start <= end; i += 1) {
      const item = this.items[i];
      if (item.end > start && item.end + this.offset > 0) wanted.set(i, item);
    }
    for (const [index, cue] of this.cues) {
      const item = wanted.get(index);
      if (!item || cue.startTime !== Math.max(0, item.start + this.offset) || cue.endTime !== item.end + this.offset) {
        this.track.removeCue(cue);
        this.cues.delete(index);
      }
    }
    // Only nearby cues enter the native track. Fullscreen uses the same track;
    // captions don't scan or render the entire transcript on every video frame.
    for (const [index, item] of wanted) {
      const text = escapeSubtitleCue(this.textFor(item));
      let cue = this.cues.get(index);
      if (!cue) {
        cue = new VTTCue(Math.max(0, item.start + this.offset), item.end + this.offset, text);
        cue.id = String(item.id);
        cue.align = "center";
        cue.size = 92;
        // Keep captions above the native play/seek controls, including paused
        // videos and the transition out of fullscreen. Native line snapping
        // can still stack simultaneous/overlapping cues without covering them.
        cue.line = -4;
        this.track.addCue(cue);
        this.cues.set(index, cue);
      } else if (cue.text !== text) cue.text = text;
    }
  }
}

if (typeof module !== "undefined") module.exports = {
  MAX_SUBTITLE_BYTES, subtitleTimestamp, parseSubtitleText, decodeSubtitleBytes, escapeSubtitleCue, SubtitlePlayer,
};
