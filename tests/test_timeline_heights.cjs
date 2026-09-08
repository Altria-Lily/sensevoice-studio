const assert = require("node:assert/strict");
const { TimelineHeights } = require("../app/static/virtual-timeline.js");

const values = Array.from({ length: 12000 }, (_, i) => 100 + (i % 7) * 23.5);
const heights = new TimelineHeights(values);
let sum = 0;
for (let i = 0; i < values.length; i += 1) {
  assert.equal(heights.prefix(i), sum);
  assert.equal(heights.indexAt(sum), i);
  assert.equal(heights.indexAt(sum + values[i] - 0.5), i);
  sum += values[i];
}
assert.equal(heights.total, sum);
assert.equal(heights.indexAt(sum + 100), values.length - 1);
assert.equal(heights.indexAt(-5), 0);
assert.equal(new TimelineHeights([]).indexAt(0), -1);
for (let i = 0; i < values.length; i += 11) {
  values[i] += 81.5;
  heights.update(i, values[i]);
}
sum = 0;
for (let i = 0; i < values.length; i += 1) {
  assert.equal(heights.prefix(i), sum);
  assert.equal(heights.indexAt(sum), i);
  sum += values[i];
}
assert.equal(heights.total, sum);
console.log("PASS: 12,000 variable heights, prefix lookup, exact boundaries, updates and empty list");
