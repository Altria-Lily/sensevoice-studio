// Direct edge resizing does not rebuild the reader or touch media playback.
// The video retains its natural 16:9 frame; the text card follows its height.
const WORKSPACE_MIN_WIDTH = 960;
const WORKSPACE_MAX_WIDTH = 1920;
const clampWorkspace = (value, min, max) => Math.max(min, Math.min(max, value));

function chooseWorkspaceWidth({ available, viewportHeight, workspaceTop, chromeHeight, video, focused, manual }) {
  const maximum = Math.min(WORKSPACE_MAX_WIDTH, available);
  const minimum = Math.min(WORKSPACE_MIN_WIDTH, maximum);
  if (Number.isFinite(manual)) return Math.round(clampWorkspace(manual, minimum, maximum));
  if (focused) return Math.round(maximum);
  if (!video) return Math.round(Math.min(1240, maximum));
  const targetHeight = clampWorkspace(viewportHeight - workspaceTop - 24, 530, 1000);
  const videoWidth = Math.max(1, targetHeight - chromeHeight) * 16 / 9;
  // Two card borders, a 22px gutter and the existing 1.22:1 column ratio.
  return Math.round(clampWorkspace((videoWidth + 2) * 2.22 / 1.22 + 22, minimum, maximum));
}

class WorkspaceLayout {
  constructor({ shell, grid, mediaCard, mediaMount, output, onChange }) {
    Object.assign(this, { shell, grid, mediaCard, mediaMount, output, onChange });
    this.edges = [...shell.querySelectorAll('[data-resize-edge]')];
    this.active = false;
    this.manualWidth = null;
    this.frame = null;
    this.drag = null;
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(mediaCard);
    this.observer.observe(document.querySelector('.result-title-row'));
    for (const edge of this.edges) {
      edge.addEventListener('pointerdown', (event) => this.startDrag(event, edge));
      edge.addEventListener('pointermove', (event) => this.moveDrag(event));
      edge.addEventListener('pointerup', (event) => {
        if (this.drag?.pointerId !== event.pointerId) return;
        this.moveDrag(event);
        this.finishDrag(false);
      });
      edge.addEventListener('pointercancel', () => this.finishDrag(true));
      edge.addEventListener('lostpointercapture', () => this.finishDrag(true));
      edge.addEventListener('dblclick', () => this.reset());
      edge.addEventListener('keydown', (event) => this.onKeyDown(event, edge));
    }
    window.addEventListener('resize', () => { this.finishDrag(true); this.schedule(); });
    window.addEventListener('blur', () => this.finishDrag(true));
    document.addEventListener('fullscreenchange', () => { this.finishDrag(true); this.schedule(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.finishDrag(true); }
    });
  }

  get preference() { return this.drag ? this.drag.originalWidth : this.manualWidth; }

  restore(value) {
    this.manualWidth = typeof value === 'number' && Number.isFinite(value)
      && value >= WORKSPACE_MIN_WIDTH && value <= WORKSPACE_MAX_WIDTH ? Math.round(value) : null;
    this.schedule();
  }

  setActive(active) {
    this.finishDrag(true);
    this.active = active;
    if (active) this.schedule();
  }

  bounds() {
    const available = Math.max(1, document.documentElement.clientWidth - (innerWidth <= 760 ? 28 : 48));
    const maximum = Math.min(WORKSPACE_MAX_WIDTH, available);
    return { available, maximum, minimum: Math.min(WORKSPACE_MIN_WIDTH, maximum), stacked: innerWidth <= 980 };
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.layout(); });
  }

  layout() {
    if (!this.active || document.fullscreenElement) return;
    const bounds = this.bounds();
    const video = Boolean(this.mediaMount.querySelector('video'));
    const focused = this.grid.classList.contains('video-focus') && video;
    const chromeHeight = ['.media-heading', '.playback-settings', '.now-playing']
      .reduce((height, selector) => height + this.mediaCard.querySelector(selector).getBoundingClientRect().height, 2);
    const width = chooseWorkspaceWidth({ available: bounds.available, viewportHeight: innerHeight,
      workspaceTop: this.shell.getBoundingClientRect().top + scrollY, chromeHeight, video, focused,
      manual: bounds.stacked ? bounds.available : this.manualWidth });
    const property = width + 'px';
    const widthChanged = document.documentElement.style.getPropertyValue('--result-page-width') !== property;
    if (widthChanged) document.documentElement.style.setProperty('--result-page-width', property);
    const equalHeight = video && !focused && !bounds.stacked;
    this.grid.dataset.equalHeight = String(equalHeight);
    if (equalHeight && !widthChanged) {
      const height = Math.round(this.mediaCard.getBoundingClientRect().height * 100) / 100;
      this.grid.style.setProperty('--workspace-card-height', height + 'px');
    } else if (!equalHeight) this.grid.style.removeProperty('--workspace-card-height');
    this.shell.dataset.widthMode = this.manualWidth === null ? 'auto' : 'manual';
    this.shell.dataset.resizable = String(!bounds.stacked && bounds.maximum > bounds.minimum);
    this.output.textContent = (this.manualWidth === null ? '自适应' : '已调整') + ' · ' + width + ' px';
    for (const edge of this.edges) {
      edge.tabIndex = bounds.stacked || bounds.maximum <= bounds.minimum ? -1 : 0;
      edge.setAttribute('aria-valuemin', String(bounds.minimum));
      edge.setAttribute('aria-valuemax', String(bounds.maximum));
      edge.setAttribute('aria-valuenow', String(width));
      edge.setAttribute('aria-valuetext', this.output.textContent);
    }
    // Read the final card height on the next frame after a width change.
    if (widthChanged) this.schedule();
  }

  startDrag(event, edge) {
    const bounds = this.bounds();
    if (!this.active || this.drag || event.button !== 0 || event.isPrimary === false
      || bounds.stacked || bounds.maximum <= bounds.minimum) return;
    event.preventDefault();
    edge.focus({ preventScroll: true });
    this.drag = { edge, pointerId: event.pointerId, startX: event.clientX,
      startWidth: this.shell.getBoundingClientRect().width, originalWidth: this.manualWidth,
      direction: edge.dataset.resizeEdge === 'right' ? 1 : -1, moved: false };
    edge.setPointerCapture(event.pointerId);
    document.body.classList.add('workspace-resizing');
    edge.classList.add('dragging');
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(delta) < 2) return;
    drag.moved = true;
    const bounds = this.bounds();
    // The page remains centered: each edge moves by half the width change.
    this.manualWidth = Math.round(clampWorkspace(drag.startWidth + delta * 2 * drag.direction, bounds.minimum, bounds.maximum));
    this.schedule();
  }

  finishDrag(cancel) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (cancel) this.manualWidth = drag.originalWidth;
    document.body.classList.remove('workspace-resizing');
    drag.edge.classList.remove('dragging');
    if (drag.edge.hasPointerCapture(drag.pointerId)) drag.edge.releasePointerCapture(drag.pointerId);
    this.schedule();
    if (!cancel && drag.moved) this.onChange();
  }

  reset() {
    this.finishDrag(true);
    this.manualWidth = null;
    this.schedule();
    this.onChange();
  }

  onKeyDown(event, edge) {
    if (event.key === 'Enter') { event.preventDefault(); this.reset(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || this.drag) return;
    const bounds = this.bounds();
    if (bounds.stacked || bounds.maximum <= bounds.minimum) return;
    event.preventDefault();
    const direction = edge.dataset.resizeEdge === 'right' ? 1 : -1;
    const delta = (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 80 : 20);
    this.manualWidth = Math.round(event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum
      : clampWorkspace(this.shell.getBoundingClientRect().width + delta, bounds.minimum, bounds.maximum));
    this.schedule();
    this.onChange();
  }
}

if (typeof module !== 'undefined') module.exports = { chooseWorkspaceWidth };
