const { test } = require("node:test");
const assert = require("node:assert/strict");
const { subtitleTimestamp, parseSubtitleText, decodeSubtitleBytes, escapeSubtitleCue, SubtitlePlayer, MAX_SUBTITLE_BYTES } = require("../app/static/subtitles.js");

test("SRT/VTT times, fractional milliseconds and invalid times", () => {
  assert.equal(subtitleTimestamp("01:02:03,456"), 3723.456);
  assert.equal(subtitleTimestamp("02:03.4"), 123.4);
  for (const value of ["00:60:00.000", "00:00:60,000", "-1:00.000", "abc"]) assert.ok(Number.isNaN(subtitleTimestamp(value)));
});

test("BOM, CRLF, multiline SRT, unsorted and overlapping cues", () => {
  const result = parseSubtitleText("\ufeff1\r\n00:00:02,000 --> 00:00:05,000\r\n你好\r\n第二行\r\n\r\n2\r\n00:00:01,000 --> 00:00:04,000\r\n<i>重叠字幕</i>\r\n");
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues[0].start, 1);
  assert.equal(result.cues[1].text, "你好\n第二行");
  assert.equal(result.cues[0].text, "重叠字幕");
});

test("VTT identifiers/settings, voice tags and non-executable text", () => {
  const result = parseSubtitleText("WEBVTT\n\nNOTE comment\nignored\n\nSTYLE\n::cue {color: red}\n\nREGION\nid:r1\n\ncue-id\n00:01.000 --> 00:04.000 align:start position:20%\n<v 发言人><b>你好</b> &amp; <c.red>世界</c></v>\n<00:02.000>继续\n\n00:05.000 --> 00:06.000\n<img src=x onerror=alert(1)>\n");
  assert.equal(result.cues.length, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.cues[0].text, "你好 & 世界\n继续");
  assert.equal(escapeSubtitleCue(result.cues[1].text), "&lt;img src=x onerror=alert(1)&gt;");
});

test("malformed/empty cues are reported without hiding valid ones", () => {
  const result = parseSubtitleText("1\n00:00:03,000 --> 00:00:01,000\n错误\n\n2\n00:00:01,000 --> 00:00:02,000\n正确\n");
  assert.equal(result.skipped, 1);
  assert.equal(result.cues[0].text, "正确");
  assert.throws(() => parseSubtitleText("WEBVTT\n\n"), /没有找到/);
  assert.throws(() => parseSubtitleText("not a subtitle"), /没有找到/);
});

test("UTF-8, BOM UTF-16, GB18030 and byte limit", () => {
  assert.equal(decodeSubtitleBytes(Buffer.from("你好")), "你好");
  assert.equal(decodeSubtitleBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("你好", "utf16le")])), "你好");
  assert.equal(decodeSubtitleBytes(Buffer.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])), "你好");
  assert.equal(decodeSubtitleBytes(Buffer.from("c4e3bac3", "hex")), "你好");
  assert.throws(() => decodeSubtitleBytes(new Uint8Array(MAX_SUBTITLE_BYTES + 1)), /5 MB/);
});

class FakeCue {
  constructor(startTime, endTime, text) { Object.assign(this, { startTime, endTime, text }); }
}
class FakeTrack {
  constructor() { this.cues = []; this.mode = "disabled"; }
  addCue(cue) { this.cues.push(cue); }
  removeCue(cue) { const index = this.cues.indexOf(cue); assert.ok(index >= 0); this.cues.splice(index, 1); }
}
class FakeVideo extends EventTarget {
  constructor() { super(); this.tagName = "VIDEO"; this.currentTime = 0; this.textTracks = new EventTarget(); this.tracks = []; }
  addTextTrack() { const track = new FakeTrack(); this.tracks.push(track); return track; }
}
global.VTTCue = FakeCue;

test("12,000 cues are windowed, seekable and don't preload while disabled", () => {
  const video = new FakeVideo();
  const player = new SubtitlePlayer();
  player.attach(video);
  const items = Array.from({ length: 12000 }, (_, id) => ({ id, start: id * 3, end: id * 3 + 2, text: "字幕 " + id }));
  player.setSource(items);
  assert.equal(player.track.cues.length, 0);
  player.setEnabled(true);
  assert.ok(player.track.cues.length < 100);
  video.currentTime = 6500 * 3;
  video.dispatchEvent(new Event("seeking"));
  assert.ok(player.track.cues.length < 100);
  assert.ok(player.track.cues.some((cue) => cue.text === "字幕 6500"));
  assert.ok(!player.track.cues.some((cue) => cue.text === "字幕 0"));
  for (let i = 0; i < 20; i += 1) { player.setEnabled(false); player.setEnabled(true); }
  assert.equal(video.tracks.length, 1);
  player.attach(null);
  assert.equal(video.tracks[0].cues.length, 0);
  assert.equal(video.tracks[0].mode, "disabled");
});

test("long overlaps, draft text, positive/negative offset and clipping", () => {
  const video = new FakeVideo();
  const player = new SubtitlePlayer();
  player.attach(video);
  const items = [
    { id: 0, start: 0, end: 1000, text: "长字幕" },
    { id: 1, start: 0, end: 1, text: "前句" },
    { id: 2, start: 0.5, end: 3, text: "当前句" },
    { id: 3, start: 499, end: 502, text: "后句" },
  ];
  let speaker = "甲";
  player.setSource(items, (item) => speaker + ": " + item.text);
  player.setEnabled(true);
  speaker = "乙";
  items[2].text = "校对文字";
  player.refresh(true);
  assert.ok(player.track.cues.some((cue) => cue.text === "乙: 校对文字"));
  player.setOffset(2);
  assert.ok(player.track.cues.some((cue) => cue.id === "2" && cue.startTime === 2.5));
  player.setOffset(-1);
  assert.ok(!player.track.cues.some((cue) => cue.id === "1"));
  assert.ok(player.track.cues.some((cue) => cue.id === "2" && cue.startTime === 0 && cue.endTime === 2));
  assert.throws(() => player.setOffset(3601), /3600/);
  assert.throws(() => player.setOffset(NaN), /3600/);
  video.currentTime = 500;
  video.dispatchEvent(new Event("seeking"));
  assert.ok(player.track.cues.some((cue) => cue.id === "0"));
  assert.ok(player.track.cues.some((cue) => cue.id === "3"));
});
