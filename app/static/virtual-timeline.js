// Variable-height windowing keeps long transcripts editable without thousands
// of textareas in the DOM. Drafts belong to app.js, never to recycled rows.
class TimelineHeights {
  constructor(values) {
    this.values = Float64Array.from(values);
    this.tree = new Float64Array(values.length + 1);
    for (let i = 1; i < this.tree.length; i += 1) {
      this.tree[i] += this.values[i - 1];
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent] += this.tree[i];
    }
  }

  prefix(end) {
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }

  get total() { return this.prefix(this.values.length); }

  update(index, height) {
    const delta = height - this.values[index];
    if (Math.abs(delta) < 0.5) return false;
    this.values[index] = height;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += delta;
    return true;
  }

  indexAt(offset) {
    if (!this.values.length) return -1;
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.values.length) step *= 2;
    for (; step; step >>= 1) {
      const next = index + step;
      if (next < this.tree.length && sum + this.tree[next] <= offset) {
        sum += this.tree[next];
        index = next;
      }
    }
    return Math.min(index, this.values.length - 1);
  }
}

class VirtualTimeline {
  constructor({ viewport, list, createRow, onRender, onRangeChange }) {
    Object.assign(this, { viewport, list, createRow, onRender, onRangeChange });
    this.items = [];
    this.rows = new Map();
    this.heightCache = new Map();
    this.heights = new TimelineHeights([]);
    this.estimatedHeight = 132;
    this.width = 0;
    this.frame = null;
    this.jumpEpoch = 0;
    this.needsMeasure = false;
    viewport.addEventListener("scroll", () => this.schedule(), { passive: true });
    viewport.addEventListener("focusout", () => this.schedule());
    this.rowObserver = new ResizeObserver((entries) => this.measure(entries));
    this.viewportObserver = new ResizeObserver(() => this.schedule());
    this.viewportObserver.observe(viewport);
  }

  anchor() {
    const index = this.heights.indexAt(this.viewport.scrollTop);
    return { id: this.items[index]?.id, offset: this.viewport.scrollTop - this.heights.prefix(Math.max(0, index)) };
  }

  restoreAnchor(anchor) {
    const index = this.indices.get(anchor.id);
    this.viewport.scrollTop = index === undefined ? 0 : this.heights.prefix(index) + Math.min(anchor.offset, this.heights.values[index] - 1);
  }

  setItems(items, { reset = true } = {}) {
    const anchor = this.anchor();
    this.cancelJump();
    this.rowObserver.disconnect();
    this.rows.clear();
    this.list.replaceChildren();
    this.items = items;
    this.indices = new Map(items.map((item, index) => [item.id, index]));
    this.heights = new TimelineHeights(items.map((item) => this.heightCache.get(item.id) || this.estimatedHeight));
    this.list.style.height = this.heights.total + "px";
    if (reset) this.viewport.scrollTop = 0;
    else this.restoreAnchor(anchor);
    this.render();
  }

  clear() {
    this.heightCache.clear();
    this.setItems([]);
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  refreshLayout() {
    this.width = 0;
    this.schedule();
  }

  render() {
    const { viewport, list, items } = this;
    if (!viewport.clientHeight || !viewport.clientWidth) return;
    if (this.width !== viewport.clientWidth) {
      const anchor = this.anchor();
      this.width = viewport.clientWidth;
      this.heightCache.clear();
      this.heights = new TimelineHeights(items.map(() => this.estimatedHeight));
      list.style.height = this.heights.total + "px";
      this.restoreAnchor(anchor);
      this.needsMeasure = true;
    }
    const first = this.heights.indexAt(viewport.scrollTop);
    const last = this.heights.indexAt(viewport.scrollTop + viewport.clientHeight - 1);
    const start = Math.max(0, first - 12);
    const end = Math.min(items.length, Math.max(start, last + 13), start + 80);
    const wanted = new Set(Array.from({ length: end - start }, (_, i) => start + i));
    // Keep at most one off-screen focused editor mounted (including IME input).
    const focused = document.activeElement?.closest(".segment");
    if (focused && list.contains(focused)) wanted.add(Number(focused.dataset.virtualIndex));
    for (const [index, row] of this.rows) {
      if (!wanted.has(index)) {
        this.rowObserver.unobserve(row);
        row.remove();
        this.rows.delete(index);
      }
    }
    let added = false;
    let cursor = list.firstElementChild;
    for (const index of [...wanted].sort((a, b) => a - b)) {
      let row = this.rows.get(index);
      if (!row) {
        row = this.createRow(items[index]);
        row.dataset.virtualIndex = index;
        this.rows.set(index, row);
        this.rowObserver.observe(row);
        added = true;
      }
      row.style.transform = "translateY(" + this.heights.prefix(index) + "px)";
      if (row === cursor) cursor = cursor.nextElementSibling;
      else list.insertBefore(row, cursor);
    }
    list.style.height = this.heights.total + "px";
    if (added || this.needsMeasure) {
      this.needsMeasure = false;
      this.onRender();
      // A small width change can invalidate the cache without changing a row's
      // physical height. ResizeObserver won't report that unchanged row, so
      // remeasure the bounded window rather than leaving estimated overlaps.
      this.measure([...this.rows.values()].map((target) => ({ target })));
      for (const [index, row] of this.rows) row.style.transform = "translateY(" + this.heights.prefix(index) + "px)";
    }
    const maxScroll = Math.max(0, this.heights.total - viewport.clientHeight);
    this.onRangeChange({ first: first + 1, last: last + 1, total: items.length,
      atEnd: viewport.scrollTop >= maxScroll - 2,
      progress: items.length ? (maxScroll ? Math.min(1, viewport.scrollTop / maxScroll) : 1) : 0 });
  }

  measure(entries) {
    if (!this.viewport.clientHeight) return;
    const anchor = this.anchor();
    const atEnd = this.viewport.scrollTop > 0 && this.viewport.scrollTop >= this.heights.total - this.viewport.clientHeight - 2;
    let changed = false;
    for (const entry of entries) {
      const index = Number(entry.target.dataset.virtualIndex);
      if (this.rows.get(index) !== entry.target) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize || entry.target.getBoundingClientRect().height;
      if (height > 0 && this.heights.update(index, height)) {
        this.heightCache.set(this.items[index].id, height);
        changed = true;
      }
    }
    if (changed) {
      this.list.style.height = this.heights.total + "px";
      if (atEnd) this.viewport.scrollTop = this.heights.total;
      else this.restoreAnchor(anchor);
      this.schedule();
    }
  }

  isVisible(index) {
    const top = this.heights.prefix(index);
    const bottom = top + this.heights.values[index];
    return top >= this.viewport.scrollTop && bottom <= this.viewport.scrollTop + this.viewport.clientHeight;
  }

  cancelJump() { this.jumpEpoch += 1; }

  scrollToIndex(index) {
    if (index < 0 || index >= this.items.length) return;
    const epoch = ++this.jumpEpoch;
    // Re-align after measuring new rows; no animated travel through 12,000 rows.
    const align = (remaining) => {
      if (epoch !== this.jumpEpoch) return;
      this.viewport.scrollTop = this.heights.prefix(index) - (this.viewport.clientHeight - this.heights.values[index]) / 2;
      this.render();
      if (remaining) requestAnimationFrame(() => align(remaining - 1));
    };
    align(2);
  }
}

if (typeof module !== "undefined") module.exports = { TimelineHeights };
