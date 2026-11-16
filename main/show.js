// Show document: model defaults, edit operations with undo/redo, load/save with
// relative media paths, autosave + crash recovery, collect-show.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const uid = () => crypto.randomBytes(5).toString('hex');

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'mxf', 'ts', 'm2ts', 'flv'];
const AUDIO_EXT = ['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'aif', 'aiff', 'wma', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff', 'svg'];

function typeForFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return null;
}

const TYPE_COLOURS = { video: 'blue', audio: 'green', image: 'purple', colour: 'grey', playlist: 'teal', timer: 'orange', wait: 'none', fade: 'none', stop: 'red', group: 'none', memo: 'none' };

function defaultCue(type) {
  const base = { id: uid(), type, number: '', name: '', notes: '', color: TYPE_COLOURS[type] || 'none', preWait: 0, postWait: 0, continue: 'none', disabled: false };
  const media = { file: '', duration: 0, inPoint: 0, outPoint: 0, loop: 1, volume: 0, fadeIn: 0, fadeOut: 0, audioDevice: '' };
  switch (type) {
    case 'video': return { ...base, ...media, startMode: 'first-frame', endMode: 'hold', layer: 'main' };
    case 'audio': return { ...base, ...media };
    case 'image': return { ...base, file: '', duration: 0, fadeIn: 0, fadeOut: 0, endMode: 'hold' };
    case 'colour': return { ...base, name: 'Holding colour', colour: '#000000', duration: 0, fadeIn: 0, fadeOut: 0, endMode: 'hold' };
    case 'playlist': return { ...base, name: 'Playlist', items: [], transition: 'cut', transitionTime: 1, loopPlaylist: false, startMode: 'first-frame', endMode: 'hold', volume: 0, fadeIn: 0, fadeOut: 0, audioDevice: '' };
    case 'timer': return { ...base, name: 'Timer', timerAction: 'start', timerId: '' };
    case 'wait': return { ...base, name: 'Wait', duration: 5, continue: 'follow' };
    case 'fade': return { ...base, name: 'Fade', targetId: '', duration: 3, fadeVolume: true, volumeTo: -60, fadeOpacity: false, opacityTo: 0, stopTarget: true };
    case 'stop': return { ...base, name: 'Stop', targetId: '' };
    case 'group': return { ...base, name: 'Group', mode: 'parallel', children: [] };
    case 'memo': return { ...base, name: 'Memo' };
    default: return base;
  }
}

function defaultTimer() {
  return { id: uid(), title: 'New timer', speaker: '', notes: '', mode: 'countdown', duration: 600, endAt: '', startAt: '', linked: false, amber: 120, red: 30, overrun: true, flashAtZero: true };
}

function defaultShow() {
  return {
    format: 'cuestage', version: 1, id: uid(), name: 'Untitled show',
    cues: [], timers: [],
    settings: {
      hold: { type: 'colour', colour: '#000000', file: '' },
      holdFade: 1, panicFade: 1, masterDb: 0,
      videoAudioDevice: 'auto', audioCueDevice: 'auto',
      timerOverlay: { enabled: false, mode: 'overlay', position: 'bottom-right', size: 14, opacity: 1, showLabel: true },
      messagePresets: ['WRAP UP', '5 MINS', '2 MINS', 'Q&A', 'SPEAK UP', 'SLOW DOWN'],
    },
  };
}

function walk(cues, fn, parent = null, depth = 0) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (fn(c, cues, i, parent, depth) === false) return false;
    if (c.children && walk(c.children, fn, c, depth + 1) === false) return false;
  }
  return true;
}

// All media file references in a doc: yields objects with a `file` property.
function mediaRefs(doc) {
  const refs = [];
  walk(doc.cues, (c) => {
    if (c.file !== undefined && ['video', 'audio', 'image'].includes(c.type)) refs.push(c);
    if (c.type === 'playlist') for (const it of c.items) refs.push(it);
  });
  if (doc.settings.hold.type === 'image') refs.push(doc.settings.hold);
  return refs;
}

class ShowStore extends EventEmitter {
  constructor({ userData }) {
    super();
    this.userData = userData;
    this.autosaveDir = path.join(userData, 'autosave');
    fs.mkdirSync(this.autosaveDir, { recursive: true });
    this.locked = false;
    this.reset(defaultShow(), null);
    this.autosaveTimer = setInterval(() => this.autosave(), 15000);
  }

  reset(doc, filePath) {
    this.doc = doc;
    this.filePath = filePath;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.lastCoalesce = null;
    this.rev = (this.rev || 0) + 1;
    this.emit('change', { reset: true });
  }

  // ---------- lookup ----------
  walk(fn) { return walk(this.doc.cues, fn); }
  find(id) {
    let hit = null;
    walk(this.doc.cues, (cue, list, index, parent, depth) => { if (cue.id === id) { hit = { cue, list, index, parent, depth }; return false; } });
    return hit;
  }
  cue(id) { const h = this.find(id); return h && h.cue; }
  cueByNumber(n) {
    let hit = null;
    walk(this.doc.cues, (c) => { if (String(c.number) === String(n)) { hit = c; return false; } });
    return hit;
  }
  timer(id) { return this.doc.timers.find((t) => t.id === id); }

  // ---------- mutation + undo ----------
  mutate(fn, coalesce) {
    if (this.locked) return false;
    const now = Date.now();
    const merge = coalesce && this.lastCoalesce && this.lastCoalesce.key === coalesce && now - this.lastCoalesce.at < 1200;
    if (!merge) {
      this.undoStack.push(JSON.stringify(this.doc));
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
    this.redoStack = [];
    fn(this.doc);
    this.touch();
    return true;
  }
  touch() { this.dirty = true; this.rev++; this.emit('change', {}); }
  undo() {
    if (this.locked || !this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.undoStack.pop());
    this.lastCoalesce = null;
    this.touch();
  }
  redo() {
    if (this.locked || !this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.redoStack.pop());
    this.touch();
  }

  nextNumber() {
    let max = 0;
    walk(this.doc.cues, (c) => { const n = parseFloat(c.number); if (Number.isFinite(n) && n > max) max = n; });
    return String(Math.floor(max) + 1);
  }

  // ---------- cue operations ----------
  addCue(type, props = {}, afterId = null) {
    const cue = { ...defaultCue(type), ...props };
    this.mutate((doc) => {
      if (!cue.number) cue.number = this.nextNumber();
      const at = afterId && this.find(afterId);
      if (at) at.list.splice(at.index + 1, 0, cue); else doc.cues.push(cue);
    });
    return this.locked ? null : cue;
  }
  addFiles(files, afterId = null) {
    const added = [];
    this.mutate((doc) => {
      let at = afterId && this.find(afterId);
      let list = at ? at.list : doc.cues, idx = at ? at.index + 1 : doc.cues.length;
      for (const file of files) {
        const type = typeForFile(file);
        if (!type) continue;
        const cue = { ...defaultCue(type), file, name: path.basename(file, path.extname(file)), number: this.nextNumber() };
        list.splice(idx++, 0, cue);
        added.push(cue);
      }
    });
    return added;
  }
  updateCue(id, patch) {
    return this.mutate(() => { const c = this.cue(id); if (c) Object.assign(c, patch); }, `cue:${id}:${Object.keys(patch).join(',')}`);
  }
  updateCues(ids, patch) {
    return this.mutate(() => { for (const id of ids) { const c = this.cue(id); if (c) Object.assign(c, patch); } }, `cues:${ids.join()}:${Object.keys(patch).join(',')}`);
  }
  removeCues(ids) {
    return this.mutate(() => { for (const id of ids) { const h = this.find(id); if (h) h.list.splice(h.index, 1); } });
  }
  duplicateCues(ids) {
    const made = [];
    this.mutate(() => {
      const reId = (c) => { c.id = uid(); if (c.children) c.children.forEach(reId); if (c.items) c.items.forEach((i) => { i.id = uid(); }); };
      for (const id of [...ids].reverse()) {
        const h = this.find(id);
        if (!h) continue;
        const copy = JSON.parse(JSON.stringify(h.cue));
        reId(copy);
        copy.number = '';
        h.list.splice(h.index + 1, 0, copy);
        made.push(copy);
      }
      for (const c of made.reverse()) c.number = this.nextNumber();
    });
    return made;
  }
  // position: 'before' | 'after' | 'into' (into = append to a group)
  moveCues(ids, targetId, position) {
    return this.mutate((doc) => {
      if (ids.includes(targetId)) return;
      // Never move a group into itself / its own descendants.
      for (const id of ids) {
        const g = this.cue(id);
        let inside = false;
        if (g && g.children) walk(g.children, (c) => { if (c.id === targetId) inside = true; });
        if (inside) return;
      }
      const moving = [];
      walk(doc.cues, (c) => { if (ids.includes(c.id)) moving.push(c); });
      for (const c of moving) { const h = this.find(c.id); if (h) h.list.splice(h.index, 1); }
      const t = targetId && this.find(targetId);
      if (!t) { doc.cues.push(...moving); return; }
      if (position === 'into' && t.cue.children) t.cue.children.push(...moving);
      else t.list.splice(t.index + (position === 'after' ? 1 : 0), 0, ...moving);
    });
  }
  groupCues(ids) {
    let group = null;
    this.mutate(() => {
      const first = ids.map((id) => this.find(id)).filter(Boolean).sort((a, b) => a.depth - b.depth)[0];
      if (!first) return;
      const list = first.list;
      const members = list.filter((c) => ids.includes(c.id));
      const at = list.indexOf(members[0]);
      for (const m of members) list.splice(list.indexOf(m), 1);
      group = { ...defaultCue('group'), number: this.nextNumber(), children: members };
      list.splice(at, 0, group);
    });
    return group;
  }
  ungroup(id) {
    return this.mutate(() => { const h = this.find(id); if (h && h.cue.children) h.list.splice(h.index, 1, ...h.cue.children); });
  }
  renumber() {
    return this.mutate((doc) => { let n = 1; walk(doc.cues, (c) => { c.number = String(n++); }); });
  }

  // ---------- timers ----------
  addTimer(props = {}, afterId = null) {
    const t = { ...defaultTimer(), ...props };
    this.mutate((doc) => { const i = doc.timers.findIndex((x) => x.id === afterId); if (i >= 0) doc.timers.splice(i + 1, 0, t); else doc.timers.push(t); });
    return t;
  }
  updateTimer(id, patch) { return this.mutate(() => { const t = this.timer(id); if (t) Object.assign(t, patch); }, `timer:${id}:${Object.keys(patch).join(',')}`); }
  removeTimer(id) { return this.mutate((doc) => { doc.timers = doc.timers.filter((t) => t.id !== id); }); }
  moveTimer(id, delta) {
    return this.mutate((doc) => {
      const i = doc.timers.findIndex((t) => t.id === id), j = i + delta;
      if (i < 0 || j < 0 || j >= doc.timers.length) return;
      const [t] = doc.timers.splice(i, 1);
      doc.timers.splice(j, 0, t);
    });
  }
  updateSettings(patch) {
    return this.mutate((doc) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) doc.settings[k] = { ...doc.settings[k], ...v };
        else doc.settings[k] = v;
      }
    }, `settings:${Object.keys(patch).join(',')}`);
  }
  setName(name) { return this.mutate((doc) => { doc.name = name; }, 'name'); }

  // ---------- persistence ----------
  // In memory, media paths are absolute. On disk each reference keeps a path
  // relative to the show file plus the last known absolute path as a fallback.
  serialise(forPath) {
    const out = JSON.parse(JSON.stringify(this.doc));
    const dir = forPath ? path.dirname(forPath) : null;
    for (const ref of mediaRefs(out)) {
      if (!ref.file) continue;
      ref.fileAbs = ref.file;
      if (dir) ref.file = path.relative(dir, ref.file).split(path.sep).join('/');
    }
    return JSON.stringify(out, null, 2);
  }
  static parse(text, fromPath) {
    const doc = JSON.parse(text);
    if (doc.format !== 'cuestage') throw new Error('Not a CueStage show file');
    const base = defaultShow();
    doc.settings = { ...base.settings, ...doc.settings, hold: { ...base.settings.hold, ...(doc.settings || {}).hold }, timerOverlay: { ...base.settings.timerOverlay, ...(doc.settings || {}).timerOverlay } };
    doc.cues = doc.cues || [];
    doc.timers = (doc.timers || []).map((t) => ({ ...defaultTimer(), ...t }));
    walk(doc.cues, (c, list, i) => { list[i] = Object.assign(c, { ...defaultCue(c.type), ...c }); });
    const dir = fromPath ? path.dirname(fromPath) : null;
    for (const ref of mediaRefs(doc)) {
      if (!ref.file) continue;
      const rel = dir && !path.isAbsolute(ref.file) ? path.resolve(dir, ref.file) : ref.file;
      ref.file = fs.existsSync(rel) || !ref.fileAbs || !fs.existsSync(ref.fileAbs) ? rel : ref.fileAbs;
      delete ref.fileAbs;
    }
    return doc;
  }
  newShow() { this.clearAutosave(); this.reset(defaultShow(), null); }
  load(file) {
    const doc = ShowStore.parse(fs.readFileSync(file, 'utf8'), file);
    this.clearAutosave();
    this.reset(doc, file);
  }
  save(file = this.filePath) {
    if (!file) throw new Error('No file path');
    if (this.doc.name === 'Untitled show') this.doc.name = path.basename(file, path.extname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, this.serialise(file));
    fs.renameSync(tmp, file);
    this.filePath = file;
    this.dirty = false;
    this.clearAutosave();
    this.rev++;
    this.emit('change', {});
  }

  get autosaveFile() { return path.join(this.autosaveDir, 'recovery.json'); }
  autosave() {
    if (!this.dirty) return;
    try {
      const payload = JSON.stringify({ savedAt: Date.now(), filePath: this.filePath, doc: JSON.parse(this.serialise(null)) });
      fs.writeFileSync(this.autosaveFile + '.tmp', payload);
      fs.renameSync(this.autosaveFile + '.tmp', this.autosaveFile);
    } catch (e) { /* disk full etc. – never interrupt the show */ }
  }
  clearAutosave() { try { fs.unlinkSync(this.autosaveFile); } catch {} }
  // Present after a crash / power loss: an autosave that was never superseded by a real save.
  recoveryInfo() {
    try {
      const r = JSON.parse(fs.readFileSync(this.autosaveFile, 'utf8'));
      return { savedAt: r.savedAt, filePath: r.filePath, name: r.doc.name, cues: r.doc.cues.length };
    } catch { return null; }
  }
  recover() {
    const r = JSON.parse(fs.readFileSync(this.autosaveFile, 'utf8'));
    const doc = ShowStore.parse(JSON.stringify(r.doc), null);
    this.reset(doc, r.filePath || null);
    this.dirty = true;
    this.emit('change', {});
  }

  // Copy every media file next to a new copy of the show so it can move between machines.
  collect(folder) {
    const mediaDir = path.join(folder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const used = new Map(); // source path -> collected path
    const names = new Set();
    const missing = [];
    const copy = JSON.parse(JSON.stringify(this.doc));
    for (const ref of mediaRefs(copy)) {
      if (!ref.file) continue;
      if (!fs.existsSync(ref.file)) { missing.push(ref.file); continue; }
      if (!used.has(ref.file)) {
        const ext = path.extname(ref.file), stem = path.basename(ref.file, ext);
        let name = stem + ext, n = 1;
        while (names.has(name.toLowerCase())) name = `${stem}_${++n}${ext}`;
        names.add(name.toLowerCase());
        const dest = path.join(mediaDir, name);
        if (path.resolve(dest) !== path.resolve(ref.file)) fs.copyFileSync(ref.file, dest);
        used.set(ref.file, dest);
      }
      ref.file = used.get(ref.file);
    }
    const safe = (this.doc.name || 'show').replace(/[<>:"/\\|?*]+/g, '_');
    const file = path.join(folder, safe + '.cuestage');
    this.doc = copy;
    this.save(file);
    return { file, copied: used.size, missing };
  }
}

module.exports = { ShowStore, defaultCue, defaultTimer, defaultShow, typeForFile, walk, mediaRefs, uid, VIDEO_EXT, AUDIO_EXT, IMAGE_EXT };
