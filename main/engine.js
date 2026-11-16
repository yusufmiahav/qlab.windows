// Cue engine: playhead, GO, running cues, waits, continue modes, fades, groups, playlists.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { walk, mediaRefs } = require('./show');

const VISUAL = ['video', 'playlist', 'image', 'colour'];

class Engine extends EventEmitter {
  constructor({ store, output, audio, timers, log }) {
    super();
    this.store = store;
    this.output = output;
    this.audio = audio;
    this.timers = timers;
    this.log = log;
    this.runs = new Map();
    this.program = null; // the run that owns the picture
    this.playheadId = null;
    this.pending = new Set();
    this.source = 'ui';
    this.tickTimer = setInterval(() => this.tick(), 100);
  }

  get doc() { return this.store.doc; }
  get L() { return this.output.layers; }
  label(cue) { return `${cue.number ? cue.number + ' ' : ''}${cue.name || cue.type}`; }
  changed() { this.emit('change'); }
  note(text) { this.log.add('cue', text, this.source); }

  later(seconds, fn) {
    if (!(seconds > 0)) { fn(); return; }
    const t = setTimeout(() => { this.pending.delete(t); fn(); }, seconds * 1000);
    this.pending.add(t);
  }

  // ---------- playhead ----------
  playheadCue() {
    const c = this.doc.cues.find((x) => x.id === this.playheadId);
    return c || null;
  }
  setPlayhead(id) {
    const h = id && this.store.find(id);
    // The playhead lives on top-level cues; selecting a child puts it on its outermost group.
    let top = null;
    if (h) top = this.doc.cues.find((c) => c.id === id) || this.doc.cues.find((c) => { let inside = false; if (c.children) walk(c.children, (x) => { if (x.id === id) inside = true; }); return inside; });
    this.playheadId = top ? top.id : null;
    this.changed();
    this.schedulePreload();
  }
  movePlayhead(delta) {
    const list = this.doc.cues;
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === this.playheadId);
    const j = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + delta));
    this.setPlayhead(list[j].id);
  }
  advance() {
    const list = this.doc.cues;
    const i = list.findIndex((c) => c.id === this.playheadId);
    this.playheadId = i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
    this.changed();
    this.schedulePreload();
  }
  // Cues that keep the playhead after the first GO (a second GO plays / steps them).
  stays(cue) {
    return (cue.type === 'video' && cue.layer !== 'overlay' && cue.startMode === 'first-frame') || cue.type === 'playlist';
  }
  // Called when the document changes: drop a playhead that no longer exists.
  docChanged() {
    if (this.playheadId && !this.doc.cues.some((c) => c.id === this.playheadId)) this.playheadId = null;
    if (!this.playheadId && this.doc.cues.length && !this.runs.size && !this.touched) this.playheadId = this.doc.cues[0].id;
    this.schedulePreload();
  }

  // ---------- GO ----------
  go() {
    this.touched = true;
    const cue = this.playheadCue();
    if (!cue) return false;
    const run = this.runs.get(cue.id);
    if (run && run.state === 'held') {
      this.playRun(run);
      if (cue.type === 'video') this.advance(); else this.leavePlaylistIfLast(run);
      return true;
    }
    if (run && cue.type === 'playlist' && run.player && !run.advancing) { this.playlistAdvance(run, true); return true; }
    this.fire(cue, { fromGo: true });
    return true;
  }
  fireByNumber(number) {
    const cue = this.store.cueByNumber(number);
    if (!cue) return false;
    this.touched = true;
    const run = this.runs.get(cue.id);
    if (run && run.state === 'held') { this.playRun(run); if (this.playheadId === cue.id && cue.type === 'video') this.advance(); return true; }
    this.fire(cue, {});
    return true;
  }

  fire(cue, { fromGo = false } = {}) {
    if (!cue) return null;
    if (cue.disabled) {
      this.note(`Skipped disabled cue ${this.label(cue)}`);
      if (fromGo) this.advance();
      return null;
    }
    const old = this.runs.get(cue.id);
    if (old) {
      if (this.program === old && VISUAL.includes(cue.type)) { old.dead = true; this.runs.delete(old.id); } // replaced seamlessly by the new run
      else this.finish(old, 'stopped');
    }
    const run = { id: cue.id, cue: JSON.parse(JSON.stringify(cue)), state: 'prewait', startedAt: Date.now(), phaseStart: Date.now(), timers: [] };
    const h = this.store.find(cue.id);
    if (h && h.parent && this.runs.has(h.parent.id)) { run.parentRun = this.runs.get(h.parent.id); run.parentRun.live.add(run.id); }
    this.runs.set(cue.id, run);
    this.note(`GO ${this.label(cue)} [${cue.type}]`);
    if (fromGo && !this.stays(cue)) this.advance();
    if (cue.preWait > 0) run.timers.push(setTimeout(() => this.start(run), cue.preWait * 1000));
    else this.start(run);
    this.changed();
    return run;
  }

  start(run) {
    if (run.dead) return;
    const cue = run.cue;
    run.state = 'running';
    run.phaseStart = Date.now();
    switch (cue.type) {
      case 'video': this.startVideo(run); break;
      case 'playlist': this.startPlaylist(run); break;
      case 'audio': this.startAudio(run); break;
      case 'image': case 'colour': this.startStill(run); break;
      case 'wait': run.timed = cue.duration; this.began(run); run.timers.push(setTimeout(() => this.finish(run, 'ended'), cue.duration * 1000)); break;
      case 'fade': this.startFade(run); break;
      case 'stop': this.startStop(run); break;
      case 'timer': this.startTimer(run); break;
      case 'group': this.startGroup(run); break;
      default: this.began(run); this.finish(run, 'ended');
    }
    this.changed();
  }

  // The cue has actually started playing: handle auto-continue.
  began(run) {
    if (run.begun) return;
    run.begun = true;
    if (run.cue.continue === 'continue') this.later(run.cue.postWait, () => this.fireNext(run));
  }
  // The cue completed naturally: handle auto-follow.
  follow(run) {
    if (run.followed) return;
    run.followed = true;
    if (run.cue.continue === 'follow') this.later(run.cue.postWait, () => this.fireNext(run));
  }
  fireNext(run) {
    const h = this.store.find(run.id);
    if (!h) return;
    const next = h.list[h.index + 1];
    if (!next) return;
    this.fire(next, {});
    if (!h.parent && this.playheadId === next.id && !this.stays(next)) this.advance();
  }

  finish(run, reason) {
    if (run.finished) return;
    run.finished = run.dead = true;
    run.timers.forEach(clearTimeout);
    if (this.runs.get(run.id) === run) this.runs.delete(run.id);
    for (const r of [...this.runs.values()]) if (r.parentRun === run && reason !== 'ended') this.stopRun(r, 0);
    this.releaseMedia(run);
    if (this.program === run) this.program = null;
    if (reason === 'ended') {
      this.follow(run);
      const g = run.parentRun;
      if (g && !g.dead) {
        g.live.delete(run.id);
        if (g.cue.mode === 'sequence' && run.cue.continue === 'none') {
          const kids = g.cue.children, i = kids.findIndex((k) => k.id === run.id);
          const live = i >= 0 && this.store.cue(g.id);
          const next = live && live.children[i + 1];
          if (next) this.fire(next, {});
        }
        if (g.live.size === 0) this.finish(g, 'ended');
      }
    } else if (run.parentRun && !run.parentRun.dead) {
      run.parentRun.live.delete(run.id);
      if (run.parentRun.live.size === 0) this.finish(run.parentRun, 'ended');
    }
    this.changed();
    this.schedulePreload();
  }

  releaseMedia(run) {
    if (run.voice) { run.voice.player.onEnded = null; this.audio.release(run.voice); run.voice = null; }
    for (const l of this.L) {
      if (l.owner === run) { l.player.stop(); l.owner = null; l.key = null; l.hash = null; l.role = 'idle'; }
    }
    if (run.alpha) { this.output.setAlpha(null); run.alpha = false; }
    run.player = null;
  }

  stopRun(run, fadeMs = 0, reason = 'stopped') {
    if (run.finished) return;
    if (run.stopping && fadeMs > 0) return;
    run.stopping = true;
    run.timers.forEach(clearTimeout);
    for (const r of [...this.runs.values()]) if (r.parentRun === run) this.stopRun(r, fadeMs, reason);
    if (reason !== 'ended') this.note(`Stop ${this.label(run.cue)}`);
    const visual = this.program === run;
    if (fadeMs > 0 && (run.player || visual)) {
      run.state = 'fading';
      run.timed = fadeMs / 1000; run.phaseStart = Date.now(); run.fadeOnly = true;
      const jobs = [];
      if (run.player) jobs.push(run.player.fadeTo(-60, fadeMs));
      if (visual) jobs.push(this.output.toStage(null, fadeMs));
      else jobs.push(this.output.sleep(fadeMs));
      Promise.all(jobs).then(() => this.finish(run, reason));
      this.changed();
    } else {
      if (visual) this.output.toStage(null, 0);
      this.finish(run, reason);
    }
  }

  // Stop everything. fadeMs undefined = the show's panic fade time; 0 = hard cut.
  stopAll(fadeMs) {
    const ms = fadeMs === undefined ? (this.doc.settings.panicFade || 0) * 1000 : fadeMs;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.note(ms > 0 ? `STOP ALL (fade ${ms / 1000}s)` : 'PANIC (hard stop)');
    if (ms === 0) this.output.skip();
    for (const run of [...this.runs.values()]) {
      if (ms === 0 && run.stopping) { if (this.program === run) this.output.toStage(null, 0); this.finish(run, 'stopped'); }
      else this.stopRun(run, ms);
    }
    if (ms === 0) { this.output.toStage(null, 0); }
    this.changed();
  }

  // ---------- media helpers ----------
  device(cue, kind) {
    const s = this.doc.settings;
    return cue.audioDevice || (kind === 'audio' ? s.audioCueDevice : s.videoAudioDevice) || 'auto';
  }
  spec(cue, kind, parent) {
    return { file: cue.file, start: cue.inPoint || 0, end: cue.outPoint || 0, loops: cue.loop === undefined ? 1 : cue.loop, device: this.device(parent || cue, kind) };
  }

  async acquireLayer(run, key, spec) {
    const hash = JSON.stringify(spec);
    const busy = this.program && this.program !== run ? this.program.layerIdx : undefined;
    let layer = this.L.find((l) => l.role === 'preload' && l.key === key && l.hash === hash && (!l.owner || l.owner === run) && l.index !== busy);
    if (!layer) {
      const free = this.L.filter((l) => l.index !== busy);
      layer = free.find((l) => l.role !== 'live') || free[0];
      if (layer.owner && layer.owner !== run) {
        const o = layer.owner;
        if (o.nextIdx === layer.index) o.nextIdx = null; // steal a playlist's look-ahead layer
        else if (!o.finished) { layer.owner = null; this.finish(o, 'stopped'); }
      }
      layer.key = key; layer.hash = hash;
      layer.player.load(spec);
    }
    layer.role = 'live';
    layer.owner = run;
    const ok = await layer.player.ready;
    if (run.dead) return -1;
    if (!ok || layer.key !== key) {
      if (layer.owner === run) { layer.owner = null; layer.role = 'idle'; layer.key = null; }
      return -1;
    }
    return layer.index;
  }

  async takeProgram(run, kind, arg, ms) {
    const prev = this.program;
    this.program = run;
    if (prev && prev !== run && prev.player) prev.player.fadeTo(-60, ms);
    if (kind === 'video') {
      await this.output.toVideo(arg, ms);
      if (this.program === run) this.output.setVisual(null, 0);
    } else {
      await this.output.toStage(arg, ms);
    }
    if (prev && prev !== run && !prev.finished) {
      prev.dead = true;
      if (this.runs.get(prev.id) === prev) this.note(`${this.label(prev.cue)} replaced by ${this.label(run.cue)}`);
      this.finish(prev, 'replaced');
    }
  }

  playRun(run, fadeMs = 0) {
    if (!run.player) return;
    run.state = 'running';
    run.startedAt = Date.now();
    const vol = run.gain !== undefined ? run.gain : run.cue.volume || 0;
    if (fadeMs > 0) { run.player.setDb(-60); run.player.fadeTo(vol, fadeMs); } else run.player.setDb(vol);
    run.player.play();
    if (run.wasHeld) this.note(`Play ${this.label(run.cue)}`);
    this.began(run);
    this.changed();
  }

  // ---------- video ----------
  async startVideo(run) {
    const cue = run.cue;
    if (!cue.file || !fs.existsSync(cue.file)) { this.note(`ERROR missing media for ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    if (cue.layer === 'overlay') {
      run.alpha = true;
      this.output.setAlpha({ key: run.id + ':' + run.startedAt, id: run.id, file: cue.file, loop: cue.loop === 0, volume: Math.min(1, Math.pow(10, (cue.volume || 0) / 20)) });
      this.began(run);
      return;
    }
    run.state = 'loading';
    const idx = await this.acquireLayer(run, cue.id, this.spec(cue, 'video'));
    if (run.dead) return;
    if (idx < 0) { this.note(`ERROR could not load ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    run.layerIdx = idx;
    run.player = this.L[idx].player;
    run.player.onEnded = () => { if (!run.dead) this.programEnd(run); };
    const fade = (cue.fadeIn || 0) * 1000;
    if (cue.startMode === 'first-frame') {
      run.state = 'held'; run.wasHeld = true;
      run.player.setDb(cue.volume || 0);
      this.changed();
      this.takeProgram(run, 'video', idx, fade);
    } else {
      this.playRun(run, fade);
      this.takeProgram(run, 'video', idx, fade);
    }
  }

  // End of a visual cue (video, playlist, timed still): hold / stop / advance.
  programEnd(run) {
    if (run.dead || run.stopping) return;
    const mode = run.cue.endMode || 'hold';
    if (mode === 'stop') { this.stopRun(run, (run.cue.fadeOut || 0) * 1000, 'ended'); return; }
    run.state = 'holding';
    this.changed();
    if (mode === 'advance') { if (!run.advanced) { run.advanced = true; this.fireNext(run); } }
    else this.follow(run);
  }

  alphaEnded(id) {
    const run = this.runs.get(id);
    if (run && run.alpha) this.finish(run, 'ended');
  }

  // ---------- stills ----------
  startStill(run) {
    const cue = run.cue;
    if (cue.type === 'image' && (!cue.file || !fs.existsSync(cue.file))) { this.note(`ERROR missing media for ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    const visual = cue.type === 'image' ? { type: 'image', file: cue.file } : { type: 'colour', colour: cue.colour };
    this.takeProgram(run, 'stage', visual, (cue.fadeIn || 0) * 1000);
    this.began(run);
    if (cue.duration > 0) { run.timed = cue.duration; run.timers.push(setTimeout(() => this.programEnd(run), cue.duration * 1000)); }
  }

  // ---------- audio ----------
  async startAudio(run) {
    const cue = run.cue;
    if (!cue.file || !fs.existsSync(cue.file)) { this.note(`ERROR missing media for ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    run.state = 'loading';
    const spec = this.spec(cue, 'audio');
    const voice = await this.audio.acquire(cue.id, JSON.stringify(spec), spec);
    if (run.dead) { if (voice) this.audio.release(voice); return; }
    if (!voice) { this.note(`ERROR could not load ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    run.voice = voice;
    run.player = voice.player;
    run.player.onEnded = () => { if (!run.dead) this.finish(run, 'ended'); };
    this.playRun(run, (cue.fadeIn || 0) * 1000);
  }

  // ---------- playlist ----------
  plKey(run, i) { return `${run.id}:${run.cue.items[i].id}`; }
  plSpec(run, i) { return this.spec({ ...run.cue.items[i], loop: 1 }, 'video', run.cue); }
  plNext(run) {
    const n = run.cue.items.length;
    for (let step = 1; step <= n; step++) {
      let i = run.index + step;
      if (i >= n) { if (!run.cue.loopPlaylist) return -1; i %= n; }
      if (run.cue.items[i].file && fs.existsSync(run.cue.items[i].file)) return i;
    }
    return -1;
  }
  async startPlaylist(run) {
    const cue = run.cue;
    run.index = -1;
    const first = this.plNext({ ...run, cue: { ...cue, loopPlaylist: false } });
    if (first < 0) { this.note(`ERROR playlist ${this.label(cue)} has no playable items`); this.finish(run, 'stopped'); return; }
    run.index = first;
    run.state = 'loading';
    const idx = await this.acquireLayer(run, this.plKey(run, first), this.plSpec(run, first));
    if (run.dead) return;
    if (idx < 0) { this.note(`ERROR could not load playlist ${this.label(cue)}`); this.finish(run, 'stopped'); return; }
    run.layerIdx = idx;
    run.player = this.L[idx].player;
    run.player.onEnded = () => this.playlistItemEnded(run);
    run.gain = (cue.volume || 0) + (cue.items[first].volume || 0);
    const fade = (cue.fadeIn || 0) * 1000;
    if (cue.startMode === 'first-frame') {
      run.state = 'held'; run.wasHeld = true;
      run.player.setDb(run.gain);
      this.changed();
    } else {
      this.playRun(run, fade);
      this.leavePlaylistIfLast(run);
    }
    this.takeProgram(run, 'video', idx, fade).then(() => this.playlistPreload(run));
  }
  leavePlaylistIfLast(run) {
    if (run.cue.type === 'playlist' && this.plNext(run) < 0 && this.playheadId === run.id) this.advance();
  }
  playlistPreload(run) {
    if (run.dead) return;
    const n = this.plNext(run);
    if (n < 0) return;
    const other = this.L[1 - run.layerIdx];
    if (other.owner && other.owner !== run) return;
    const key = this.plKey(run, n), spec = this.plSpec(run, n), hash = JSON.stringify(spec);
    Object.assign(other, { owner: run, role: 'preload', key, hash });
    other.player.load(spec);
    run.nextIdx = other.index;
    run.nextItem = n;
  }
  playlistItemEnded(run) {
    if (run.dead || run.stopping) return;
    const item = run.cue.items[run.index];
    if (item.endMode === 'hold' && this.plNext(run) >= 0) { run.state = 'holding'; this.changed(); return; }
    this.playlistAdvance(run, false);
  }
  async playlistAdvance(run, manual) {
    if (run.dead || run.advancing) return;
    const cue = run.cue;
    const n = this.plNext(run);
    if (n < 0) { if (!manual) this.programEnd(run); else this.leavePlaylistIfLast(run); return; }
    run.advancing = true;
    try {
      const other = this.L[1 - run.layerIdx];
      const key = this.plKey(run, n), spec = this.plSpec(run, n), hash = JSON.stringify(spec);
      if (!(other.owner === run && other.key === key && other.hash === hash)) {
        if (other.owner && other.owner !== run) { this.note(`Playlist ${this.label(cue)} lost its second layer`); return; }
        Object.assign(other, { owner: run, role: 'preload', key, hash });
        other.player.load(spec);
      }
      const ok = await other.player.ready;
      if (run.dead) return;
      if (!ok) { this.note(`ERROR could not load playlist item ${cue.items[n].name || n + 1}`); run.index = n; run.advancing = false; return this.playlistAdvance(run, manual); }
      const old = this.L[run.layerIdx];
      const ms = cue.transition === 'crossfade' ? (cue.transitionTime || 0) * 1000 : 0;
      old.player.onEnded = null;
      run.index = n; run.layerIdx = other.index; run.player = other.player; run.nextIdx = null;
      other.role = 'live';
      run.gain = (cue.volume || 0) + (cue.items[n].volume || 0);
      run.player.onEnded = () => this.playlistItemEnded(run);
      this.note(`Playlist ${this.label(cue)} › ${cue.items[n].name || 'item ' + (n + 1)}`);
      old.player.fadeTo(-60, ms);
      this.playRun(run, ms);
      await this.output.toVideo(other.index, ms);
      if (old.owner === run && run.layerIdx !== old.index) { old.player.stop(); Object.assign(old, { owner: null, role: 'idle', key: null, hash: null }); }
    } finally { run.advancing = false; }
    if (run.dead) return;
    this.playlistPreload(run);
    this.leavePlaylistIfLast(run);
    this.changed();
  }

  // ---------- control cues ----------
  startFade(run) {
    const cue = run.cue;
    const target = this.runs.get(cue.targetId);
    this.began(run);
    if (!target) { this.note(`Fade ${this.label(cue)}: target is not running`); this.finish(run, 'ended'); return; }
    const ms = (cue.duration || 0) * 1000;
    run.timed = cue.duration;
    const players = target.player ? [target.player] : [...this.runs.values()].filter((r) => r.parentRun === target && r.player).map((r) => r.player);
    if (cue.fadeVolume) for (const p of players) p.fadeTo(cue.volumeTo, ms);
    if (cue.fadeOpacity && this.program === target) {
      const level = Math.max(0, Math.min(100, cue.opacityTo)) / 100;
      if (typeof this.output.top === 'number') this.output.dimVideo(level, ms);
      else if (level === 0 && !cue.stopTarget) this.output.toStage(null, ms);
    }
    run.timers.push(setTimeout(() => {
      if (cue.stopTarget && !target.finished) {
        if (this.program === target && typeof this.output.top !== 'number' && cue.fadeOpacity) this.stopRun(target, 0);
        else this.stopRun(target, 0);
      }
      this.finish(run, 'ended');
    }, ms));
  }
  startStop(run) {
    const cue = run.cue;
    this.began(run);
    if (!cue.targetId) {
      for (const r of [...this.runs.values()]) if (r !== run && !r.parentRun) this.stopRun(r, (r.cue.fadeOut || 0) * 1000);
    } else {
      const target = this.runs.get(cue.targetId);
      if (target) this.stopRun(target, (target.cue.fadeOut || 0) * 1000);
    }
    this.finish(run, 'ended');
  }
  startTimer(run) {
    const cue = run.cue, T = this.timers;
    this.began(run);
    switch (cue.timerAction) {
      case 'start': T.start(cue.timerId || undefined); break;
      case 'select': T.select(cue.timerId || undefined); break;
      case 'pause': T.pause(); break;
      case 'reset': T.reset(); break;
      case 'next': T.next(true); break;
    }
    this.finish(run, 'ended');
  }
  startGroup(run) {
    const kids = run.cue.children || [];
    run.live = new Set();
    this.began(run);
    const live = this.store.cue(run.id);
    if (!kids.length || !live) { this.finish(run, 'ended'); return; }
    if (run.cue.mode === 'sequence') this.fire(live.children[0], {});
    else for (const k of [...live.children]) this.fire(k, {});
    if (run.live.size === 0) this.finish(run, 'ended');
  }

  // ---------- transport on the live picture / a running cue ----------
  transportRun(id) {
    if (id && this.runs.get(id)) return this.runs.get(id);
    if (this.program && this.program.player) return this.program;
    const media = [...this.runs.values()].filter((r) => r.player);
    return media[media.length - 1] || null;
  }
  transport(action, value, id) {
    const run = this.transportRun(id);
    if (!run || !run.player) return false;
    const p = run.player;
    switch (action) {
      case 'toggle':
        if (run.state === 'held') { this.playRun(run); if (this.playheadId === run.id) { if (run.cue.type === 'video') this.advance(); else this.leavePlaylistIfLast(run); } }
        else if (p.paused || p.ended) { run.state = 'running'; p.play(); this.note(`Resume ${this.label(run.cue)}`); }
        else { run.state = 'paused'; p.pause(); this.note(`Pause ${this.label(run.cue)}`); }
        break;
      case 'pause': if (!p.paused) { run.state = 'paused'; p.pause(); } break;
      case 'seek': if (run.state === 'holding') run.state = 'paused'; p.seek(value); break;
      case 'nudge': if (run.state === 'holding') run.state = 'paused'; p.seek(p.pos + value); break;
      case 'step': if (run.state !== 'held') run.state = 'paused'; p.pause(); p.step(value); break;
      case 'toEnd': if (run.state === 'holding') run.state = 'paused'; p.seek(Math.max(0, p.total - 10)); break;
      case 'restart': if (run.state === 'holding') run.state = 'paused'; p.seek(0); break;
      default: return false;
    }
    this.changed();
    return true;
  }

  // ---------- preload the standby cue so GO is instant ----------
  schedulePreload() {
    clearTimeout(this.preloadTimer);
    this.preloadTimer = setTimeout(() => this.doPreload(), 150);
  }
  doPreload() {
    const cue = this.playheadCue();
    let video = null, audioCue = null;
    if (cue && !this.runs.has(cue.id) && !cue.disabled) {
      if (cue.type === 'video' && cue.layer !== 'overlay' && cue.file) video = { key: cue.id, spec: this.spec(cue, 'video') };
      else if (cue.type === 'playlist' && cue.items.length && cue.items[0].file) video = { key: `${cue.id}:${cue.items[0].id}`, spec: this.spec({ ...cue.items[0], loop: 1 }, 'video', cue) };
      else if (cue.type === 'audio' && cue.file) audioCue = cue;
    }
    if (video && fs.existsSync(video.spec.file)) {
      const busy = this.program ? this.program.layerIdx : undefined;
      const layer = this.L.find((l) => l.index !== busy && l.role !== 'live' && !l.owner);
      const hash = JSON.stringify(video.spec);
      if (layer && !(layer.key === video.key && layer.hash === hash && layer.role === 'preload')) {
        Object.assign(layer, { key: video.key, hash, role: 'preload' });
        layer.player.load(video.spec);
      }
    }
    if (audioCue && fs.existsSync(audioCue.file)) {
      const spec = this.spec(audioCue, 'audio');
      this.audio.preload(audioCue.id, JSON.stringify(spec), spec);
    } else this.audio.dropPreload();
  }

  tick() {
    for (const run of this.runs.values()) {
      const p = run.player, cue = run.cue;
      if (!p || run.stopping || run.dead || !p.playing || !(cue.fadeOut > 0)) continue;
      if (cue.type === 'playlist' || (cue.loop !== undefined && cue.loop !== 1)) continue;
      if (cue.type === 'video' && cue.endMode !== 'stop') continue;
      if (p.total > 0 && p.remaining <= cue.fadeOut) this.stopRun(run, Math.max(50, p.remaining * 1000), 'ended');
    }
  }

  // ---------- status for UI / API ----------
  runInfo(r) {
    const now = Date.now(), p = r.player, cue = r.cue;
    let elapsed = (now - r.startedAt) / 1000, total = 0;
    if (r.state === 'prewait') { elapsed = (now - r.phaseStart) / 1000; total = cue.preWait; }
    else if (r.fadeOnly) { elapsed = (now - r.phaseStart) / 1000; total = r.timed; }
    else if (p && p.loaded) { elapsed = p.pos; total = p.total; }
    else if (r.timed) { elapsed = (now - r.phaseStart) / 1000; total = r.timed; }
    let sub = '';
    if (cue.type === 'playlist' && r.index >= 0 && cue.items[r.index]) sub = `${r.index + 1}/${cue.items.length} ${cue.items[r.index].name || path.basename(cue.items[r.index].file || '')}`;
    return {
      id: r.id, number: cue.number, name: cue.name, type: cue.type, color: cue.color, state: r.state, sub,
      elapsed: Math.max(0, elapsed), total, remaining: total > 0 ? Math.max(0, total - elapsed) : null,
      program: this.program === r, hasPlayer: !!p, paused: !!p && p.paused,
    };
  }
  status() {
    const runs = [...this.runs.values()].map((r) => this.runInfo(r));
    const liveRun = (this.program && !this.program.finished && this.runs.get(this.program.id) === this.program ? this.program : null) || [...this.runs.values()].filter((r) => r.player).pop() || [...this.runs.values()].pop() || null;
    const live = liveRun ? this.runInfo(liveRun) : null;
    const sb = this.playheadCue();
    const pre = sb && this.L.find((l) => l.role === 'preload' && l.key && l.key.startsWith(sb.id));
    return {
      playheadId: this.playheadId, runs, live,
      standby: sb ? { id: sb.id, number: sb.number, name: sb.name, type: sb.type, preloaded: !!(pre && pre.player.loaded) } : null,
      playing: !!live && (live.state === 'running' || live.state === 'fading') && !(live.hasPlayer && live.paused),
      paused: !!live && (live.state === 'paused' || live.state === 'held' || live.state === 'holding'),
    };
  }

  // ---------- pre-show check ----------
  check() {
    const issues = [];
    const add = (level, cue, text) => issues.push({ level, cueId: cue ? cue.id : null, cue: cue ? this.label(cue) : '', text });
    const numbers = new Map(), ids = new Set();
    const devices = new Set(this.audio.deviceList.map((d) => d.name));
    const s = this.doc.settings;
    walk(this.doc.cues, (c) => { ids.add(c.id); });
    if (s.hold.type === 'image' && (!s.hold.file || !fs.existsSync(s.hold.file))) add('error', null, 'Holding image file is missing');
    for (const [k, label] of [['videoAudioDevice', 'Video audio device'], ['audioCueDevice', 'Audio cue device']]) {
      if (s[k] && !devices.has(s[k])) add('warn', null, `${label} "${s[k]}" is not connected – the system default will be used`);
    }
    if (this.output.mode !== 'live') add('warn', null, this.output.rehearsal ? 'Rehearsal mode is ON – nothing is sent to the presentation screen' : 'No separate output display detected – output is in the preview window');
    if (this.output.mpvError) add('error', null, `Video engine problem: ${this.output.mpvError}`);
    walk(this.doc.cues, (c) => {
      if (c.number) { if (numbers.has(c.number)) add('warn', c, `Duplicate cue number ${c.number}`); numbers.set(c.number, c); }
      if (['video', 'audio', 'image'].includes(c.type)) {
        if (!c.file) add('error', c, 'No media file assigned');
        else if (!fs.existsSync(c.file)) add('error', c, `Missing media: ${c.file}`);
        if (c.outPoint > 0 && c.outPoint <= c.inPoint) add('error', c, 'Out point is before the in point');
        if (c.duration > 0 && c.inPoint >= c.duration) add('error', c, 'In point is beyond the end of the file');
      }
      if (c.type === 'video' && c.layer === 'overlay' && !/\.(webm|mp4|m4v|mov)$/i.test(c.file || '')) add('warn', c, 'Overlay-layer video should be WebM (VP8/VP9 with alpha)');
      if (c.type === 'playlist') {
        if (!c.items.length) add('warn', c, 'Playlist is empty');
        c.items.forEach((it, i) => { if (!it.file || !fs.existsSync(it.file)) add('error', c, `Playlist item ${i + 1} missing media: ${it.file || '(none)'}`); });
      }
      if (c.audioDevice && !devices.has(c.audioDevice)) add('warn', c, `Audio device "${c.audioDevice}" is not connected`);
      if (c.type === 'fade') {
        if (!c.targetId || !ids.has(c.targetId)) add('error', c, 'Fade cue has no valid target');
        if (!c.fadeVolume && !c.fadeOpacity) add('warn', c, 'Fade cue fades neither volume nor opacity');
      }
      if (c.type === 'stop' && c.targetId && !ids.has(c.targetId)) add('error', c, 'Stop cue target no longer exists');
      if (c.type === 'timer' && c.timerId && !this.doc.timers.some((t) => t.id === c.timerId)) add('error', c, 'Timer cue points at a deleted timer');
      if (c.type === 'group' && !c.children.length) add('warn', c, 'Group is empty');
      if (c.continue !== 'none') { const h = this.store.find(c.id); if (h && !h.list[h.index + 1]) add('warn', c, 'Continue mode set on the last cue – nothing follows it'); }
    });
    for (const t of this.doc.timers) {
      if (t.mode === 'until' && !/^\d{1,2}:\d{2}/.test(t.endAt)) add('error', null, `Timer "${t.title}" needs an end time (HH:MM)`);
      if (t.mode === 'countdown' && !(t.duration > 0)) add('warn', null, `Timer "${t.title}" has zero duration`);
    }
    return issues;
  }
}

module.exports = { Engine, mediaRefs };
