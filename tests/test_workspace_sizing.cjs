const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chooseWorkspaceWidth } = require('../app/static/workspace-layout.js');
const defaults = { available: 1872, viewportHeight: 1080, workspaceTop: 284, chromeHeight: 210, video: true, focused: false, manual: null };
test('automatic width targets matching natural video/card height', () => {
  const width = chooseWorkspaceWidth(defaults);
  const height = ((width - 22) * 1.22 / 2.22 - 2) * 9 / 16 + defaults.chromeHeight;
  assert.ok(Math.abs(height - (1080 - 284 - 24)) < 1);
  assert.ok(width > 1240 && width <= 1872);
});
test('automatic width fits short windows and cannot exceed the viewport or 1920px', () => {
  assert.equal(chooseWorkspaceWidth({ ...defaults, available: 1392 }), 1392);
  assert.equal(chooseWorkspaceWidth({ ...defaults, available: 3000, viewportHeight: 1600 }), 1920);
  const short = chooseWorkspaceWidth({ ...defaults, viewportHeight: 600 });
  assert.ok(short >= 960 && short < chooseWorkspaceWidth(defaults));
});
test('manual widths are clamped without changing the requested preference', () => {
  assert.equal(chooseWorkspaceWidth({ ...defaults, manual: 1500 }), 1500);
  assert.equal(chooseWorkspaceWidth({ ...defaults, manual: 3000 }), 1872);
  assert.equal(chooseWorkspaceWidth({ ...defaults, manual: 500 }), 960);
  assert.equal(chooseWorkspaceWidth({ ...defaults, available: 292, manual: 1500 }), 292);
});
test('audio and focused video have sensible independent defaults', () => {
  assert.equal(chooseWorkspaceWidth({ ...defaults, video: false }), 1240);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true }), 1384);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, manual: 1400 }), 1400);
});
test('focused video width follows aspect ratio, safe reader width and viewport bounds', () => {
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, aspect: 4 / 3 }), 1039);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, aspect: 9 / 16 }), 640);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, aspect: 3 }), 1872);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, available: 292 }), 292);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, aspect: NaN }), 1384);
  assert.equal(chooseWorkspaceWidth({ ...defaults, focused: true, aspect: 0 }), 1384);
});
