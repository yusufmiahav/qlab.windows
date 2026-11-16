// CueStage main process: wires the show store, cue engine, timers, output, audio,
// web server and OSC together and serves the operator console.
const { app, BrowserWindow, ipcMain, dialog, screen, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { ShowStore, mediaRefs, typeForFile, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT, uid } = require('./show');
const { Timers, formatClock, formatMs } = require('./timers');
const { ShowLog } = require('./log');
const { Output } = require('./output');
const { AudioManager } = require('./audio');
const { Engine } = require('./engine');
const { WebServer } = require('./server');
const { OscServer } = require('./osc');
const { Mpv } = require('./mpv');

if (process.env.CUESTAGE_USERDATA) app.setPath('userData', process.env.CUESTAGE_USERDATA);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEFAULT_SHORTCUTS = {
  go: 'Space', panic: 'Escape', prev: 'ArrowUp', next: 'ArrowDown', playPause: 'KeyP',
  stepBack: 'Comma', stepForward: 'Period', toEnd: 'KeyE', restart: 'KeyR',
  save: 'Ctrl+KeyS', open: 'Ctrl+KeyO', undo: 'Ctrl+KeyZ', redo: 'Ctrl+KeyY', duplicate: 'Ctrl+KeyD',
  delete: 'Delete', selectAll: 'Ctrl+KeyA', group: 'Ctrl+KeyG', lock: 'Ctrl+KeyL',
  timerToggle: 'KeyT', timerNext: 'BracketRight', timerPrev: 'BracketLeft', timerPlus: 'Equal', timerMinus: 'Minus', timerReset: 'Ctrl+KeyT',
  blackout: 'KeyB', clearMessage: 'KeyM',
};

let settingsFile, appSettings, store, timers, log, output, audio, engine, web, osc, consoleWin, prober;
let rehearsal = false, quitting = false, lastCheck = null, qrCache = { key: '', urls: [] };

function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const defaults = { outputDisplayId: null, httpPort: 8080, oscPort: 53535, pin: '', shortcuts: {}, recent: [], livePreview: true };
  try { appSettings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { appSettings = defaults; }
}
function saveSettings() { try { fs.writeFileSync(settingsFile, JSON.stringify(appSettings, null, 2)); } catch {} }
function addRecent(file) {
  appSettings.recent = [file, ...appSettings.recent.filter((f) => f !== file)].slice(0, 10);
  saveSettings();
}

const send = (channel, payload) => { if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(channel, payload); };

// ---------- state pushed to the console ----------
function missingMedia() {
  const out = [];
  for (const ref of mediaRefs(store.doc)) if (ref.file && !fs.existsSync(ref.file)) out.push(ref.file);
  return out;
}
function pushDoc() {
  send('doc', { missing: missingMedia(), doc: store.doc, filePath: store.filePath, dirty: store.dirty, canUndo: store.undoStack.length > 0, canRedo: store.redoStack.length > 0, locked: store.locked, rev: store.rev });
}
async function pushApp() {
  const urls = web.urls();
  const key = urls.join() + appSettings.pin;
  if (qrCache.key !== key) {
    const base = urls[0];
    const views = [['Stage / presenter', '/stage'], ['Controller', '/controller'], ['Agenda', '/agenda']];
    qrCache = { key, urls: await Promise.all(views.map(async ([label, p]) => ({ label, url: base + p, qr: await QRCode.toDataURL(base + p, { margin: 1, width: 220 }) }))) };
  }
  send('app', {
    settings: { ...appSettings, shortcuts: { ...DEFAULT_SHORTCUTS, ...appSettings.shortcuts } },
    defaultShortcuts: DEFAULT_SHORTCUTS,
    displays: output.displays(), outputMode: output.mode, outputDisplayId: output.target() ? output.target().id : null,
    devices: audio.deviceList, rehearsal, links: qrCache.urls, allUrls: urls,
    webError: web.error, oscError: osc.error, mpvError: output.mpvError || audio.error || null,
    recovery: store.recoveryInfo(), version: app.getVersion(),
    recent: appSettings.recent.filter((f) => fs.existsSync(f)),
  });
}
let meters = { video: -90, audio: -90 };
function pushRt() {
  send('rt', { ...engine.status(), timer: timers.snapshot(), meters, now: Date.now() });
}

// ---------- state for web viewers / Companion ----------
function publicState() {
  const st = engine.status(), t = timers.snapshot();
  const cur = t.current;
  const secs = (v) => (v === null || v === undefined ? '' : Math.round(v));
  const companion = {
    live_cue_number: st.live ? st.live.number : '', live_cue_name: st.live ? st.live.name : '', live_cue_state: st.live ? st.live.state : 'idle',
    live_elapsed: st.live ? formatMs(st.live.elapsed * 1000) : '', live_remaining: st.live && st.live.remaining !== null ? formatMs(st.live.remaining * 1000) : '',
    live_remaining_seconds: st.live ? secs(st.live.remaining) : '',
    standby_cue_number: st.standby ? st.standby.number : '', standby_cue_name: st.standby ? st.standby.name : '',
    playing: st.playing, paused: st.paused, running_cues: st.runs.length,
    timer_title: cur ? cur.title : '', timer_speaker: cur ? cur.speaker : '', timer_display: cur ? cur.display : '',
    timer_colour: cur ? cur.colour : 'idle', timer_running: t.running, timer_state: t.state,
    timer_remaining_seconds: cur && cur.remainingMs !== null ? Math.round(cur.remainingMs / 1000) : '',
    timer_next_title: t.next ? t.next.title : '', message: t.message.text, blackout: t.blackout,
    schedule_offset_seconds: t.offsetMs === null ? '' : Math.round(t.offsetMs / 1000),
    clock: formatClock(Date.now()), rehearsal, locked: store.locked,
  };
  return {
    now: Date.now(), show: { name: store.doc.name }, pinRequired: !!appSettings.pin,
    cue: { live: st.live, standby: st.standby, playing: st.playing, paused: st.paused, running: st.runs },
    cues: store.doc.cues.map((c) => ({ number: c.number, name: c.name, type: c.type })),
    timer: t, presets: store.doc.settings.messagePresets, rehearsal, locked: store.locked, companion,
  };
}

// ---------- remote/control commands (shared by UI, HTTP, WebSocket and OSC) ----------
function run(name, args = {}, source = 'ui') {
  engine.source = source;
  log.source = source;
  try {
    switch (name) {
      case 'go': return engine.go();
      case 'stop': engine.stopAll(); return true;
      case 'panic': engine.stopAll(0); return true;
      case 'prev': engine.movePlayhead(-1); return true;
      case 'next': engine.movePlayhead(1); return true;
      case 'transport.toggle': return engine.transport('toggle', undefined, args.id);
      case 'transport': return engine.transport(args.action, args.value, args.id);
      case 'cue.go': case 'cue.fire': case 'cue.start': return engine.fireByNumber(args.number);
      case 'cue.select': case 'cue.standby': { const c = store.cueByNumber(args.number); if (!c) return false; engine.setPlayhead(c.id); return true; }
      case 'cue.stop': { const c = store.cueByNumber(args.number); const r = c && engine.runs.get(c.id); if (!r) return false; engine.stopRun(r, (r.cue.fadeOut || 0) * 1000); return true; }
      case 'timer.start': return timers.start(args.id);
      case 'timer.pause': return timers.pause();
      case 'timer.toggle': case 'timer.startstop': return timers.toggle();
      case 'timer.reset': return timers.reset();
      case 'timer.next': return timers.next(!!args.start);
      case 'timer.prev': case 'timer.previous': return timers.prev();
      case 'timer.select': return timers.select(args.id !== undefined ? args.id : args.index);
      case 'timer.add': return timers.add(Number(args.seconds));
      case 'message.send': case 'message': timers.setMessage(args.text, { flash: args.flash, bold: args.bold !== false }); return true;
      case 'message.clear': timers.clearMessage(); return true;
      case 'blackout': timers.setBlackout(args.on === undefined ? 'toggle' : args.on); return true;
      default: return false;
    }
  } catch (e) {
    log.add('error', `${name}: ${e.message}`, source);
    return false;
  } finally { engine.source = 'ui'; }
}

// ---------- media probing (durations for the cue list) ----------
class Prober {
  constructor() { this.queue = Promise.resolve(); this.mpv = new Mpv('probe', ['--vo=null', '--ao=null', '--vid=no']); this.started = this.mpv.start().catch(() => null); this.mpv.observe('duration'); }
  probe(file) {
    this.queue = this.queue.then(async () => {
      await this.started;
      if (!this.mpv.alive) return 0;
      return new Promise((resolve) => {
        const done = (v) => { this.mpv.off('event', on); clearTimeout(t); resolve(v); };
        const on = async (e) => {
          if (e.event === 'playback-restart' || e.event === 'file-loaded') done((await this.mpv.get('duration')) || 0);
          else if (e.event === 'end-file' && e.reason === 'error') done(0);
        };
        const t = setTimeout(() => done(0), 4000);
        this.mpv.on('event', on);
        this.mpv.command('loadfile', file, 'replace').catch(() => done(0));
      });
    });
    return this.queue;
  }
}
const probing = new Set();
function probeMissing() {
  const refs = [];
  store.walk((c) => {
    if ((c.type === 'video' || c.type === 'audio') && c.file && !c.duration) refs.push(c);
    if (c.type === 'playlist') for (const it of c.items) if (it.file && !it.duration) refs.push(it);
  });
  for (const ref of refs) {
    const k = ref.id + ref.file;
    if (probing.has(k) || !fs.existsSync(ref.file)) continue;
    probing.add(k);
    prober.probe(ref.file).then((d) => {
      probing.delete(k);
      if (!(d > 0)) return;
      // Write straight into the live doc (not undoable, does not dirty the show on its own).
      let target = null;
      store.walk((c) => { if (c.id === ref.id) target = c; if (c.items) for (const it of c.items) if (it.id === ref.id) target = it; });
      if (target && target.file === ref.file) { target.duration = Math.round(d * 1000) / 1000; store.rev++; pushDoc(); }
    });
  }
}

// ---------- console window ----------
function createConsole() {
  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: Math.min(1700, wa.width), height: Math.min(1000, wa.height), minWidth: 1100, minHeight: 640,
    backgroundColor: '#14161a', title: 'CueStage – Operator Console', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  consoleWin.setMenu(null);
  consoleWin.loadFile(path.join(__dirname, '..', 'renderer', 'console', 'index.html'));
  consoleWin.once('ready-to-show', () => { consoleWin.maximize(); consoleWin.show(); });
  if (process.env.CUESTAGE_DEBUG) consoleWin.webContents.on('console-message', (e, level, message, line, source) => console.log(`[console] ${message} (${source.split('/').pop()}:${line})`));
  consoleWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') consoleWin.webContents.toggleDevTools();
  });
  consoleWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    confirmQuit();
  });
}

async function confirmQuit() {
  const running = engine.runs.size > 0;
  if (store.dirty || running) {
    const buttons = store.dirty ? ['Save and quit', "Quit without saving", 'Cancel'] : ['Quit', 'Cancel'];
    const r = await dialog.showMessageBox(consoleWin, {
      type: 'warning', buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1,
      message: running ? 'Cues are still running. Quit CueStage?' : 'Save changes before quitting?',
      detail: store.dirty ? `"${store.doc.name}" has unsaved changes.` : undefined,
    });
    if (r.response === buttons.length - 1) return;
    if (store.dirty && r.response === 0) { if (!(await saveShow(false))) return; }
  }
  store.clearAutosave();
  quitting = true;
  app.quit();
}

const showFilters = [{ name: 'CueStage show', extensions: ['cuestage'] }];
async function saveShow(saveAs) {
  let file = store.filePath;
  if (saveAs || !file) {
    const r = await dialog.showSaveDialog(consoleWin, { filters: showFilters, defaultPath: (store.doc.name || 'show') + '.cuestage' });
    if (r.canceled || !r.filePath) return false;
    file = r.filePath;
  }
  try { store.save(file); addRecent(file); log.add('show', `Saved ${file}`); pushApp(); return true; }
  catch (e) { dialog.showErrorBox('Could not save show', e.message); return false; }
}
async function guardUnsaved() {
  if (!store.dirty) return true;
  const r = await dialog.showMessageBox(consoleWin, { type: 'warning', buttons: ['Save', "Don't save", 'Cancel'], cancelId: 2, message: `Save changes to "${store.doc.name}"?` });
  if (r.response === 2) return false;
  if (r.response === 0) return saveShow(false);
  return true;
}
function openShow(file) {
  try {
    engine.stopAll(0);
    timers.clearRun();
    store.load(file);
    engine.touched = false;
    engine.playheadId = null;
    engine.docChanged();
    addRecent(file);
    log.add('show', `Opened ${file}`);
    pushApp();
    return true;
  } catch (e) { dialog.showErrorBox('Could not open show', e.message); return false; }
}

// ---------- console → main API ----------
const ui = {
  // show file
  async 'show.new'() { if (!(await guardUnsaved())) return false; engine.stopAll(0); timers.clearRun(); store.newShow(); engine.touched = false; engine.playheadId = null; pushApp(); return true; },
  async 'show.open'(a) {
    if (!(await guardUnsaved())) return false;
    let file = a && a.file;
    if (!file) {
      const r = await dialog.showOpenDialog(consoleWin, { filters: showFilters, properties: ['openFile'] });
      if (r.canceled) return false;
      file = r.filePaths[0];
    }
    return openShow(file);
  },
  'show.save': () => saveShow(false),
  'show.saveAs': () => saveShow(true),
  'show.recover'() { store.recover(); engine.docChanged(); log.add('show', 'Recovered autosaved show'); pushApp(); return true; },
  'show.discardRecovery'() { store.clearAutosave(); pushApp(); return true; },
  async 'show.collect'() {
    const r = await dialog.showOpenDialog(consoleWin, { title: 'Collect show into folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    try {
      const res = store.collect(r.filePaths[0]);
      addRecent(res.file);
      log.add('show', `Collected show to ${r.filePaths[0]} (${res.copied} files)`);
      pushApp();
      return res;
    } catch (e) { return { error: e.message }; }
  },
  'show.rename': (a) => store.setName(a.name),
  'show.check'() { lastCheck = engine.check(); return lastCheck; },
  // editing
  'cue.add': (a) => store.addCue(a.type, a.props || {}, a.afterId),
  'cue.addFiles': (a) => store.addFiles(a.files, a.afterId),
  'cue.update': (a) => (a.ids ? store.updateCues(a.ids, a.patch) : store.updateCue(a.id, a.patch)),
  'cue.remove': (a) => store.removeCues(a.ids),
  'cue.duplicate': (a) => store.duplicateCues(a.ids),
  'cue.move': (a) => store.moveCues(a.ids, a.targetId, a.position),
  'cue.group': (a) => store.groupCues(a.ids),
  'cue.ungroup': (a) => store.ungroup(a.id),
  'cue.renumber': () => store.renumber(),
  async 'cue.pickFile'(a) {
    const ext = a.kind === 'video' ? VIDEO_EXT : a.kind === 'audio' ? AUDIO_EXT : a.kind === 'image' ? IMAGE_EXT : [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];
    const r = await dialog.showOpenDialog(consoleWin, { filters: [{ name: 'Media', extensions: ext }, { name: 'All files', extensions: ['*'] }], properties: a.multi ? ['openFile', 'multiSelections'] : ['openFile'] });
    return r.canceled ? null : (a.multi ? r.filePaths : r.filePaths[0]);
  },
  'playlist.addFiles'(a) {
    const c = store.cue(a.id);
    if (!c || c.type !== 'playlist') return false;
    const items = a.files.filter((f) => ['video', 'image', 'audio'].includes(typeForFile(f))).map((f) => ({ id: uid(), file: f, name: path.basename(f, path.extname(f)), endMode: 'continue', inPoint: 0, outPoint: 0, volume: 0, duration: 0 }));
    return store.updateCue(a.id, { items: [...c.items, ...items] });
  },
  undo: () => store.undo(),
  redo: () => store.redo(),
  lock(a) { store.locked = a.on; log.add('show', `Lock mode ${a.on ? 'ON' : 'OFF'}`); pushDoc(); return true; },
  // timers (editing)
  'timerdef.add': (a) => store.addTimer(a.props || {}, a.afterId),
  'timerdef.update': (a) => store.updateTimer(a.id, a.patch),
  'timerdef.remove': (a) => store.removeTimer(a.id),
  'timerdef.move': (a) => store.moveTimer(a.id, a.delta),
  'settings.show': (a) => store.updateSettings(a.patch),
  'settings.app'(a) {
    const before = { ...appSettings };
    Object.assign(appSettings, a.patch);
    saveSettings();
    if (appSettings.httpPort !== before.httpPort) web.listen(appSettings.httpPort);
    if (appSettings.oscPort !== before.oscPort) osc.listen(appSettings.oscPort);
    if (appSettings.outputDisplayId !== before.outputDisplayId) output.setDisplay(appSettings.outputDisplayId);
    setTimeout(pushApp, 300);
    return true;
  },
  rehearsal(a) { rehearsal = a.on; output.setRehearsal(rehearsal); log.add('show', `Rehearsal mode ${rehearsal ? 'ON' : 'OFF'}`); pushApp(); return true; },
  async 'displays.refresh'() { output.applyBounds(); await audio.refreshDevices(); pushApp(); return true; },
  // engine
  playhead(a) { engine.touched = true; engine.setPlayhead(a.id); return true; },
  'cue.fireId'(a) { const c = store.cue(a.id); if (!c) return false; engine.touched = true; engine.fire(c, {}); return true; },
  'cue.stopId'(a) { const r = engine.runs.get(a.id); if (r) engine.stopRun(r, a.fade ? (r.cue.fadeOut || 0) * 1000 : 0); return true; },
  // log
  'log.get': () => log.entries.slice(-500),
  async 'log.export'() {
    const r = await dialog.showSaveDialog(consoleWin, { filters: [{ name: 'CSV', extensions: ['csv'] }], defaultPath: `${store.doc.name || 'show'}-log.csv` });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, '﻿' + log.csv());
    return r.filePath;
  },
  'log.clear'() { log.clear(); return true; },
  openExternal(a) { if (/^https?:\/\//.test(a.url)) shell.openExternal(a.url); return true; },
};

app.whenReady().then(async () => {
  loadSettings();
  const userData = app.getPath('userData');
  store = new ShowStore({ userData });
  log = new ShowLog({ dir: path.join(userData, 'logs') });
  timers = new Timers({ getList: () => store.doc.timers, log: (cat, text) => log.add(cat, text, log.source || 'ui') });
  const masterDb = () => store.doc.settings.masterDb || 0;
  output = new Output({ preload: path.join(__dirname, 'preload.js'), masterDb });
  audio = new AudioManager({ masterDb });
  engine = new Engine({ store, output, audio, timers, log });
  web = new WebServer({ run, getState: publicState, getPin: () => appSettings.pin, onError: () => pushApp() });
  osc = new OscServer({ run, onError: () => pushApp() });
  prober = new Prober();

  ipcMain.handle('cmd', async (e, name, args) => {
    if (ui[name]) return ui[name](args || {});
    return run(name, args || {}, 'ui');
  });
  ipcMain.on('curtain-ready', (e, seq) => output.curtainReady(seq));
  ipcMain.on('alpha-ended', (e, id) => engine.alphaEnded(id));
  ipcMain.on('console-ready', () => { pushDoc(); pushApp(); pushRt(); send('log', { all: log.entries.slice(-500) }); });

  output.displayId = appSettings.outputDisplayId;
  output.consoleDisplayId = screen.getPrimaryDisplay().id;
  createConsole();
  await output.init();
  await audio.init();

  let lastHold = '', lastOverlay = '', lastMaster = null;
  const syncDoc = () => {
    const s = store.doc.settings;
    const h = JSON.stringify(s.hold);
    if (h !== lastHold) { lastHold = h; output.setHold(s.hold); }
    const o = JSON.stringify(s.timerOverlay);
    if (o !== lastOverlay) { lastOverlay = o; output.setTimerOverlay(s.timerOverlay); }
    if (s.masterDb !== lastMaster) { lastMaster = s.masterDb; for (const l of output.layers) l.player.applyVolume(); audio.applyMaster(); }
    engine.docChanged();
    probeMissing();
    pushDoc();
  };
  store.on('change', syncDoc);
  syncDoc();

  engine.on('change', () => { pushRt(); web.broadcast(); });
  timers.on('change', () => { output.setTimerState(timers.snapshot()); pushRt(); web.broadcast(); });
  log.on('entry', (e) => send('log', { entry: e }));
  log.on('cleared', () => send('log', { all: [] }));
  output.on('displays', () => { audio.refreshDevices().then(pushApp); log.add('system', `Displays changed – output is ${output.mode === 'live' ? 'LIVE on ' + output.target().label : 'in preview window'}`); });

  setInterval(() => { timers.tick(); output.setTimerState(timers.snapshot()); }, 250);
  setInterval(pushRt, 100);
  setInterval(async () => {
    let v = -90;
    for (const l of output.layers) if (l.role === 'live') v = Math.max(v, await l.player.pollLevel());
    meters = { video: v, audio: await audio.level() };
  }, 100);
  // Live output preview thumbnail (screen grab of the output display).
  setInterval(async () => {
    if (!appSettings.livePreview || output.mode !== 'live' || !consoleWin || consoleWin.isDestroyed() || consoleWin.isMinimized()) return;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 384, height: 216 } });
      const t = output.target();
      const src = sources.find((s) => String(s.display_id) === String(t.id)) || null;
      if (src && !src.thumbnail.isEmpty()) send('preview', src.thumbnail.toJPEG(70).toString('base64'));
    } catch {}
  }, 700);

  web.listen(appSettings.httpPort);
  osc.listen(appSettings.oscPort);
  log.add('system', `CueStage ${app.getVersion()} started`);
  pushApp();

  const argFile = process.env.CUESTAGE_OPEN || process.argv.slice(1).find((a) => a.endsWith('.cuestage'));
  if (argFile && fs.existsSync(argFile)) openShow(argFile);
});

app.on('second-instance', (e, argv) => {
  if (consoleWin) { if (consoleWin.isMinimized()) consoleWin.restore(); consoleWin.focus(); }
  const f = argv.find((a) => a.endsWith('.cuestage'));
  if (f && fs.existsSync(f)) guardUnsaved().then((ok) => ok && openShow(f));
});
app.on('before-quit', () => {
  quitting = true;
  try { store.autosave(); } catch {}
  try { output.quit(); audio.quit(); prober.mpv.quit(); web.close(); osc.close(); } catch {}
});
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => { try { log.add('error', `Internal error: ${e.message}`); } catch {} console.error(e); });
process.on('unhandledRejection', (e) => { console.error(e); });
