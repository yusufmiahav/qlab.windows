// Presentation output: a stack of borderless always-on-top windows on the output display.
//
//   overlay  (transparent Electron window: timer overlay, messages, fade curtain, alpha video)
//   video A / video B  (Electron host windows, each with an mpv instance embedded via --wid)
//   stage    (opaque Electron window: holding colour/image and still cues)
//
// Windows are never hidden while output is enabled; what the audience sees is decided
// purely by z-order, so bringing a pre-loaded video layer live is a single atomic restack.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const EventEmitter = require('events');
const { Mpv } = require('./mpv');
const { MediaPlayer } = require('./player');

const fileUrl = (f) => (f ? pathToFileURL(f).href : '');

class Output extends EventEmitter {
  constructor({ preload, masterDb }) {
    super();
    this.preload = preload;
    this.masterDb = masterDb;
    this.layers = [];
    this.top = 'stage'; // 'stage' | 0 | 1
    this.displayId = null; // chosen output display (null = auto)
    this.rehearsal = false;
    this.stageState = { hold: { type: 'colour', colour: '#000000', url: '' }, visual: null, fadeMs: 0 };
    this.overlayState = { curtain: null, timerOverlay: null, timer: null, alpha: null };
    this.sleepers = new Set();
    this.curtainSeq = 0;
    this.curtainWaiters = new Map();
    this.snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuestage-snap-'));
    this.snapN = 0;
  }

  mkWindow(opts, page) {
    const win = new BrowserWindow({
      show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, focusable: process.platform !== 'win32' ? true : false, hasShadow: false, roundedCorners: false,
      thickFrame: false, backgroundColor: '#000000', enableLargerThanScreen: true,
      webPreferences: { preload: this.preload, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
      ...opts,
    });
    win.setMenu(null);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'output', page));
    win.on('close', (e) => { if (!this.quitting) e.preventDefault(); });
    return win;
  }

  async init() {
    this.stage = this.mkWindow({}, 'stage.html');
    this.overlay = this.mkWindow({ transparent: true, backgroundColor: '#00000000' }, 'overlay.html');
    this.overlay.setIgnoreMouseEvents(true);
    for (let i = 0; i < 2; i++) {
      const win = this.mkWindow({}, 'host.html');
      const handle = win.getNativeWindowHandle();
      const wid = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
      const mpv = new Mpv(`video${i}`, [`--wid=${wid}`, '--force-window=yes', '--hwdec=auto-safe', '--cursor-autohide=always', '--no-window-dragging', '--image-display-duration=inf']);
      const player = new MediaPlayer(mpv, { masterDb: this.masterDb });
      this.layers.push({ index: i, win, mpv, player, key: null, hash: null, role: 'idle' });
    }
    await Promise.all([this.stage, this.overlay].map((w) => new Promise((r) => w.webContents.once('did-finish-load', r))));
    this.pushStage();
    this.pushOverlay();
    this.applyBounds();
    this.mpvError = null;
    await Promise.all(this.layers.map((l) => l.mpv.start().catch((e) => { this.mpvError = e.message; })));
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(ev, () => { clearTimeout(this.hotplugTimer); this.hotplugTimer = setTimeout(() => { this.applyBounds(); this.emit('displays'); }, 400); });
    }
  }

  // ---------- displays ----------
  displays() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id, index: i + 1, primary: d.id === primary,
      label: `${i + 1}: ${d.label || 'Display'} ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.id === primary ? ' (primary)' : ''}`,
      bounds: d.bounds,
    }));
  }
  target() {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let d = this.displayId !== null ? all.find((x) => x.id === this.displayId) : all.find((x) => x.id !== primary.id);
    return d || null;
  }
  // 'live' = fullscreen on output display, 'preview' = small floating window on the operator screen.
  get mode() {
    if (this.rehearsal) return 'preview';
    const t = this.target();
    if (!t) return 'preview';
    // Never cover the operator console: if the chosen output is the screen the console is on, stay in preview.
    const con = this.consoleWin && !this.consoleWin.isDestroyed() ? screen.getDisplayMatching(this.consoleWin.getBounds()).id : this.consoleDisplayId;
    if (t.id === con) return 'preview';
    return 'live';
  }
  setDisplay(id) { this.displayId = id; this.applyBounds(); this.emit('displays'); }
  setRehearsal(on) { this.rehearsal = !!on; this.applyBounds(); this.emit('displays'); }
  windows() { return [this.stage, ...this.layers.map((l) => l.win), this.overlay]; }
  // In preview mode the stack sits exactly over the console's preview box (rect reported by the console page).
  setPreviewRect(rect) {
    const key = JSON.stringify(rect);
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.previewRect = rect;
    if (this.mode === 'preview') this.applyBounds();
  }
  applyBounds() {
    if (!this.stage) return;
    const live = this.mode === 'live';
    const con = this.consoleWin && !this.consoleWin.isDestroyed() ? this.consoleWin : null;
    if (live !== this.wasLive) {
      this.wasLive = live;
      for (const w of this.windows()) {
        // Live: independent always-on-top windows on the output display.
        // Preview: owned by the console so they never float over other applications.
        if (live) { w.setParentWindow(null); w.setAlwaysOnTop(true, 'screen-saver'); }
        else { w.setAlwaysOnTop(false); if (con) w.setParentWindow(con); }
      }
    }
    let bounds = null;
    if (live) bounds = this.target().bounds;
    else if (con && this.previewRect && !con.isMinimized()) {
      const c = con.getContentBounds(), r = this.previewRect;
      bounds = { x: Math.round(c.x + r.x), y: Math.round(c.y + r.y), width: Math.max(16, Math.round(r.width)), height: Math.max(9, Math.round(r.height)) };
    }
    if (!bounds) { this.bounds = null; for (const w of this.windows()) if (w.isVisible()) w.hide(); return; }
    this.bounds = bounds;
    for (const w of this.windows()) {
      w.setBounds(bounds);
      if (live) w.setBounds(bounds); // twice: works around mixed-DPI placement glitches on Windows
      if (!w.isVisible()) w.showInactive();
    }
    this.restack();
  }
  restack() {
    const order = [this.stage];
    const live = typeof this.top === 'number' ? this.layers[this.top] : null;
    for (const l of this.layers) if (l !== live) order.unshift(l.win); // idle layers go under the stage
    if (live) order.push(live.win);
    order.push(this.overlay);
    for (const w of order) w.moveTop();
  }

  // ---------- z-order (what is live) ----------
  showLayer(i) {
    if (this.top === i) return;
    const win = this.layers[i].win;
    const above = typeof this.top === 'number' ? this.layers[this.top].win : this.stage;
    this.top = i;
    try { win.moveAbove(above.getMediaSourceId()); this.overlay.moveTop(); } catch { this.restack(); }
  }
  showStage() {
    if (this.top === 'stage') return;
    const from = this.layers[this.top].win;
    this.top = 'stage';
    try { this.stage.moveAbove(from.getMediaSourceId()); this.overlay.moveTop(); } catch { this.restack(); }
  }

  // ---------- stage (hold + stills) ----------
  pushStage() { if (this.stage && !this.stage.isDestroyed()) this.stage.webContents.send('stage', this.stageState); }
  pushOverlay() { if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('overlay', this.overlayState); }
  setHold(hold) {
    this.stageState = { ...this.stageState, hold: { type: hold.type, colour: hold.colour, url: hold.type === 'image' ? fileUrl(hold.file) : '' }, fadeMs: 0 };
    this.pushStage();
  }
  // visual: null (hold) | { type:'image', file } | { type:'colour', colour }
  setVisual(visual, fadeMs = 0) {
    const v = visual ? { type: visual.type, colour: visual.colour, url: visual.type === 'image' ? fileUrl(visual.file) : '' } : null;
    this.stageState = { ...this.stageState, visual: v, fadeMs };
    this.pushStage();
  }

  // ---------- cancellable sleeps (so panic / a new GO can cut through a running fade) ----------
  sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const s = { resolve, t: setTimeout(() => { this.sleepers.delete(s); resolve(); }, ms) };
      this.sleepers.add(s);
    });
  }
  skip() { for (const s of this.sleepers) { clearTimeout(s.t); s.resolve(); } this.sleepers.clear(); }

  // ---------- curtain (overlay layer that fakes opacity for the video layers) ----------
  // content: { mirror:true } (copy of current stage) | { url } (snapshot image)
  async curtainShow(content, opacity) {
    const seq = ++this.curtainSeq;
    const c = content.mirror ? { stage: { hold: this.stageState.hold, visual: this.stageState.visual } } : { url: content.url };
    this.overlayState = { ...this.overlayState, curtain: { seq, ...c, opacity, ms: 0 } };
    const ready = new Promise((resolve) => {
      this.curtainWaiters.set(seq, resolve);
      setTimeout(() => { this.curtainWaiters.delete(seq); resolve(); }, 600);
    });
    this.pushOverlay();
    await ready;
  }
  curtainReady(seq) { const r = this.curtainWaiters.get(seq); if (r) { this.curtainWaiters.delete(seq); r(); } }
  async curtainFade(to, ms) {
    if (!this.overlayState.curtain) return;
    this.overlayState = { ...this.overlayState, curtain: { ...this.overlayState.curtain, opacity: to, ms } };
    this.pushOverlay();
    await this.sleep(ms);
  }
  curtainClear() { this.overlayState = { ...this.overlayState, curtain: null }; this.pushOverlay(); }
  get curtainOpacity() { return this.overlayState.curtain ? this.overlayState.curtain.opacity : 0; }

  async snapshot(i) {
    const file = path.join(this.snapDir, `snap${++this.snapN % 6}.jpg`);
    try { await this.layers[i].mpv.command('screenshot-to-file', file, 'video'); return fileUrl(file) + `?n=${this.snapN}`; } catch { return null; }
  }

  // ---------- transitions ----------
  // Bring video layer i live over `ms` (0 = cut).
  async toVideo(i, ms) {
    this.skip();
    if (ms > 0 && this.top !== i) {
      if (this.top === 'stage') await this.curtainShow({ mirror: true }, 1);
      else {
        const url = await this.snapshot(this.top);
        if (url) await this.curtainShow({ url }, 1);
      }
      this.showLayer(i);
      await this.curtainFade(0, ms);
      this.curtainClear();
    } else {
      this.showLayer(i);
      if (this.overlayState.curtain) this.curtainClear();
    }
  }
  // Bring the stage live showing `visual` (null = holding graphic) over `ms`.
  async toStage(visual, ms) {
    this.skip();
    if (this.top === 'stage') {
      this.setVisual(visual, ms);
      if (this.overlayState.curtain) this.curtainClear();
      await this.sleep(ms);
      return;
    }
    const from = this.curtainOpacity;
    this.setVisual(visual, 0);
    if (ms > 0) {
      await this.curtainShow({ mirror: true }, from);
      await this.curtainFade(1, ms);
    }
    this.showStage();
    this.curtainClear();
  }
  // Dim the live video towards the hold (used by Fade cues on opacity). level 1 = fully visible.
  async dimVideo(level, ms) {
    if (typeof this.top !== 'number') return;
    this.skip();
    if (!this.overlayState.curtain) await this.curtainShow({ mirror: true }, 0);
    await this.curtainFade(1 - level, ms);
  }

  // ---------- overlay extras ----------
  setTimerOverlay(cfg) { this.overlayState = { ...this.overlayState, timerOverlay: cfg }; this.pushOverlay(); }
  setTimerState(timer) { this.overlayState.timer = timer; if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('timer', timer); }
  setAlpha(alpha) { this.overlayState = { ...this.overlayState, alpha: alpha ? { ...alpha, url: fileUrl(alpha.file) } : null }; this.pushOverlay(); }

  quit() {
    this.quitting = true;
    for (const l of this.layers) l.mpv.quit();
    for (const w of this.windows()) if (w && !w.isDestroyed()) w.destroy();
    try { fs.rmSync(this.snapDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { Output, fileUrl };
