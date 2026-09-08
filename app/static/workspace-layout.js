// Direct edge resizing does not rebuild the reader or touch media playback.
// The text follows the dual-column video card; focus uses the video's own ratio.
const WORKSPACE_MIN_WIDTH = 960;
const FOCUSED_MIN_WIDTH = 640;
const WORKSPACE_MAX_WIDTH = 1920;
const clampWorkspace = (value, min, max) => Math.max(min, Math.min(max, value));

function chooseWorkspaceWidth({ available, viewportHeight, workspaceTop, chromeHeight, video, focused, manual, aspect = 16 / 9 }) {
  const maximum = Math.min(WORKSPACE_MAX_WIDTH, available);
  const minimum = Math.min(focused ? FOCUSED_MIN_WIDTH : WORKSPACE_MIN_WIDTH, maximum);
  if (Number.isFinite(manual)) return Math.round(clampWorkspace(manual, minimum, maximum));
  if (focused) {
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
    // Size the frame to the picture, not a full-width box with a fixed height.
    // Keep enough room for the reader and controls when a video is portrait.
    return Math.round(clampWorkspace(Math.min(viewportHeight * 0.72, 920) * ratio + 2, minimum, maximum));
  }
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
    this.focusWidth = null;
    this.focused = false;
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

  get preference() { return this.drag && !this.focused ? this.drag.originalWidth : this.manualWidth; }

  get currentWidth() { return this.focused ? this.focusWidth : this.manualWidth; }
  set currentWidth(value) {
    if (this.focused) this.focusWidth = value;
    else this.manualWidth = value;
  }

  setFocused(focused) {
    if (this.focused !== focused) {
      this.finishDrag(true);
      this.focused = focused;
      // Each visit starts fitted to the video; the dual-column preference stays intact.
      this.focusWidth = null;
    }
    this.schedule();
  }

  restore(value) {
    this.manualWidth = typeof value === 'number' && Number.isFinite(value)
      && value >= WORKSPACE_MIN_WIDTH && value <= WORKSPACE_MAX_WIDTH ? Math.round(value) : null;
    this.schedule();
  }

  setActive(active) {
    this.finishDrag(true);
    this.active = active;
    if (active) {
      this.focusWidth = null;
      this.schedule();
    }
  }

  bounds() {
    const available = Math.max(1, document.documentElement.clientWidth - (innerWidth <= 760 ? 28 : 48));
    const maximum = Math.min(WORKSPACE_MAX_WIDTH, available);
    return { available, maximum, minimum: Math.min(this.focused ? FOCUSED_MIN_WIDTH : WORKSPACE_MIN_WIDTH, maximum), stacked: innerWidth <= 980 };
  }

  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.layout(); });
  }

  layout() {
    if (!this.active || document.fullscreenElement) return;
    const bounds = this.bounds();
    const media = this.mediaMount.querySelector('video');
    const video = Boolean(media);
    const focused = this.focused && video;
    const aspect = media?.videoWidth > 0 && media?.videoHeight > 0 ? media.videoWidth / media.videoHeight : 16 / 9;
    this.grid.style.setProperty('--focus-video-aspect', String(aspect));
    const chromeHeight = ['.media-heading', '.playback-settings', '.now-playing']
      .reduce((height, selector) => height + this.mediaCard.querySelector(selector).getBoundingClientRect().height, 2);
    const width = chooseWorkspaceWidth({ available: bounds.available, viewportHeight: innerHeight,
      workspaceTop: this.shell.getBoundingClientRect().top + scrollY, chromeHeight, video, focused,
      manual: bounds.stacked ? bounds.available : this.currentWidth, aspect });
    const property = width + 'px';
    const widthChanged = document.documentElement.style.getPropertyValue('--result-page-width') !== property;
    if (widthChanged) document.documentElement.style.setProperty('--result-page-width', property);
    const equalHeight = video && !focused && !bounds.stacked;
    this.grid.dataset.equalHeight = String(equalHeight);
    if (equalHeight && !widthChanged) {
      const height = Math.round(this.mediaCard.getBoundingClientRect().height * 100) / 100;
      this.grid.style.setProperty('--workspace-card-height', height + 'px');
    } else if (!equalHeight) this.grid.style.removeProperty('--workspace-card-height');
    this.shell.dataset.widthMode = this.currentWidth === null ? 'auto' : 'manual';
    this.shell.dataset.resizable = String(!bounds.stacked && bounds.maximum > bounds.minimum);
    this.output.textContent = (this.currentWidth === null ? (focused ? '贴合视频' : '自适应') : '已调整') + ' · ' + width + ' px';
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
      startWidth: this.shell.getBoundingClientRect().width, originalWidth: this.currentWidth,
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
    this.currentWidth = Math.round(clampWorkspace(drag.startWidth + delta * 2 * drag.direction, bounds.minimum, bounds.maximum));
    this.schedule();
  }

  finishDrag(cancel) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (cancel) this.currentWidth = drag.originalWidth;
    document.body.classList.remove('workspace-resizing');
    drag.edge.classList.remove('dragging');
    if (drag.edge.hasPointerCapture(drag.pointerId)) drag.edge.releasePointerCapture(drag.pointerId);
    this.schedule();
    if (!cancel && drag.moved) this.onChange();
  }

  reset() {
    this.finishDrag(true);
    this.currentWidth = null;
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
    // Repeated keys can arrive before the next layout frame; accumulate the pending width.
    const current = Number.isFinite(this.currentWidth) ? clampWorkspace(this.currentWidth, bounds.minimum, bounds.maximum)
      : this.shell.getBoundingClientRect().width;
    this.currentWidth = Math.round(event.key === 'Home' ? bounds.minimum : event.key === 'End' ? bounds.maximum
      : clampWorkspace(current + delta, bounds.minimum, bounds.maximum));
    this.schedule();
    this.onChange();
  }
}

if (typeof module !== 'undefined') module.exports = { chooseWorkspaceWidth };
