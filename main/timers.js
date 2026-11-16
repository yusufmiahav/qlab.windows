// Stagetimer-style rundown engine. Pure logic: the clock is injected so it can be unit-tested.
const EventEmitter = require('events');

function parseClock(str, nowMs) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((str || '').trim());
  if (!m) return null;
  const d = new Date(nowMs);
  d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
  return d.getTime();
}

function formatMs(ms, { showSign = true } = {}) {
  const neg = ms < 0;
  // Countdowns round up so "0:00" only shows when time is really up; overrun counts up from 0:01.
  const s = neg ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return (neg && s > 0 && showSign ? '-' : '') + body;
}

function formatClock(ms, seconds = true) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`;
}

class Timers extends EventEmitter {
  constructor({ getList, now = () => Date.now(), log = () => {} }) {
    super();
    this.getList = getList;
    this.now = now;
    this.log = log;
    this.activeId = null;
    this.state = 'idle'; // idle | running | paused
    this.startedAt = 0;
    this.accum = 0; // ms elapsed before the last start
    this.adjust = 0; // ms added (+) or removed (-) live
    this.zeroFired = false;
    this.actual = {}; // id -> { start, end }
    this.message = { text: '', flash: false, bold: true };
    this.blackout = false;
    this.schedFired = {};
  }

  get list() { return this.getList(); }
  get active() { return this.list.find((t) => t.id === this.activeId) || null; }
  index(id = this.activeId) { return this.list.findIndex((t) => t.id === id); }
  changed() { this.emit('change'); }

  resolve(ref) {
    if (ref === undefined || ref === null || ref === '') return this.active || this.list[0] || null;
    const byId = this.list.find((t) => t.id === ref);
    if (byId) return byId;
    const n = parseInt(ref, 10);
    return Number.isFinite(n) ? this.list[n - 1] || null : null; // 1-based index
  }

  select(ref) {
    const t = this.resolve(ref);
    if (!t) return false;
    this._closeActual();
    this.activeId = t.id;
    this.state = 'idle';
    this.accum = 0; this.adjust = 0; this.zeroFired = false;
    this.log('timer', `Select "${t.title}"`);
    this.changed();
    return true;
  }
  start(ref) {
    const t = this.resolve(ref);
    if (!t) return false;
    if (t.id !== this.activeId) { this._closeActual(); this.activeId = t.id; this.state = 'idle'; this.accum = 0; this.adjust = 0; this.zeroFired = false; }
    if (this.state === 'running') return true;
    this.startedAt = this.now();
    if (this.state === 'idle') { this.actual[t.id] = { start: this.startedAt, end: null }; this.zeroFired = false; }
    this.state = 'running';
    this.log('timer', `Start "${t.title}"`);
    this.changed();
    return true;
  }
  pause() {
    if (this.state !== 'running') return false;
    this.accum += this.now() - this.startedAt;
    this.state = 'paused';
    this.log('timer', `Pause "${this.active ? this.active.title : ''}"`);
    this.changed();
    return true;
  }
  toggle() { return this.state === 'running' ? this.pause() : this.start(); }
  reset() {
    if (!this.active) return false;
    this._closeActual();
    delete this.actual[this.activeId];
    this.state = 'idle'; this.accum = 0; this.adjust = 0; this.zeroFired = false;
    this.log('timer', `Reset "${this.active.title}"`);
    this.changed();
    return true;
  }
  next(autoStart = false) {
    const i = this.index();
    const t = this.list[i + 1];
    if (!t) return false;
    this.select(t.id);
    if (autoStart) this.start();
    return true;
  }
  prev() {
    const i = this.index();
    const t = this.list[Math.max(0, i - 1)];
    if (!t || i <= 0) return false;
    return this.select(t.id);
  }
  add(seconds) {
    if (!this.active || !Number.isFinite(seconds)) return false;
    this.adjust += seconds * 1000;
    if (this.compute().remainingMs > 0) this.zeroFired = false;
    this.log('timer', `${seconds >= 0 ? '+' : ''}${seconds}s on "${this.active.title}"`);
    this.changed();
    return true;
  }
  setMessage(text, { flash = false, bold = true } = {}) {
    this.message = { text: String(text || ''), flash: !!flash, bold: !!bold };
    this.log('message', this.message.text ? `Message: ${this.message.text}` : 'Message cleared');
    this.changed();
  }
  clearMessage() { this.setMessage(''); }
  setBlackout(on) {
    this.blackout = on === 'toggle' ? !this.blackout : !!on;
    this.log('timer', `Timer blackout ${this.blackout ? 'ON' : 'OFF'}`);
    this.changed();
  }
  clearRun() { this.activeId = null; this.state = 'idle'; this.accum = 0; this.adjust = 0; this.actual = {}; this.schedFired = {}; this.changed(); }

  _closeActual() {
    const a = this.actual[this.activeId];
    if (a && !a.end && this.state !== 'idle') a.end = this.now();
  }

  elapsedMs() { return this.accum + (this.state === 'running' ? this.now() - this.startedAt : 0); }

  // Values for the active timer.
  compute() {
    const t = this.active, now = this.now();
    if (!t) return { remainingMs: 0, elapsedMs: 0, display: '0:00', colour: 'idle', over: false };
    const elapsedMs = this.elapsedMs();
    let remainingMs = null, display;
    if (t.mode === 'clock') {
      display = formatClock(now);
    } else if (t.mode === 'until') {
      let target = parseClock(t.endAt, now);
      if (target !== null) {
        const a = this.actual[t.id];
        // If the end time is long past when started, it means tomorrow.
        if (a && target < a.start - 12 * 3600e3) target += 24 * 3600e3;
        remainingMs = target + this.adjust - now;
      } else remainingMs = 0;
    } else if (t.mode === 'countup') {
      remainingMs = t.duration > 0 ? t.duration * 1000 + this.adjust - elapsedMs : null;
      display = formatMs(elapsedMs);
    } else {
      remainingMs = t.duration * 1000 + this.adjust - elapsedMs;
    }
    const over = remainingMs !== null && remainingMs <= 0 && (this.state !== 'idle' || t.mode === 'until');
    if (remainingMs !== null && over && !t.overrun) { remainingMs = 0; if (t.mode === 'countup') display = formatMs(t.duration * 1000 + this.adjust); }
    if (display === undefined) display = formatMs(remainingMs);
    let colour = 'green';
    if (t.mode === 'clock' || remainingMs === null) colour = 'green';
    else if (over) colour = 'over';
    else if (remainingMs <= t.red * 1000) colour = 'red';
    else if (remainingMs <= t.amber * 1000) colour = 'amber';
    return { remainingMs, elapsedMs, display, colour, over, flash: over && !!t.flashAtZero };
  }

  // Call ~4x per second: handles zero crossing (linked start) and scheduled starts.
  tick() {
    const now = this.now();
    const t = this.active;
    if (t && this.state === 'running' && !this.zeroFired) {
      const c = this.compute();
      if (c.remainingMs !== null && c.remainingMs <= 0) {
        this.zeroFired = true;
        const a = this.actual[t.id];
        if (a && !a.end && !t.overrun) a.end = now;
        this.log('timer', `"${t.title}" reached zero`);
        const nxt = this.list[this.index() + 1];
        if (nxt && nxt.linked) { this.select(nxt.id); this.start(); return; }
        if (!t.overrun && t.mode !== 'countup') { this.accum = this.elapsedMs(); this.state = 'paused'; }
        this.changed();
      }
    }
    for (const s of this.list) {
      if (!s.startAt) continue;
      const at = parseClock(s.startAt, now);
      if (at === null) continue;
      const key = `${s.id}@${at}`;
      if (now >= at && now - at < 5000 && !this.schedFired[key]) {
        this.schedFired[key] = true;
        if (!(this.activeId === s.id && this.state === 'running')) {
          this.log('timer', `Scheduled start ${s.startAt}`);
          this.select(s.id);
          this.start();
        }
      }
    }
  }

  // Planned vs actual schedule for the agenda view.
  agenda() {
    const now = this.now();
    let cursor = null;
    return this.list.map((t) => {
      const sched = parseClock(t.startAt, now);
      const a = this.actual[t.id] || {};
      let plannedStart = sched !== null ? sched : cursor;
      if (plannedStart === null && a.start) plannedStart = a.start;
      let plannedEnd = null;
      if (t.mode === 'until') plannedEnd = parseClock(t.endAt, now);
      else if (plannedStart !== null && t.mode !== 'clock') plannedEnd = plannedStart + t.duration * 1000;
      cursor = plannedEnd !== null ? plannedEnd : plannedStart;
      return {
        id: t.id, title: t.title, speaker: t.speaker, notes: t.notes, mode: t.mode, duration: t.duration,
        endAt: t.endAt, startAt: t.startAt, linked: t.linked,
        plannedStart, plannedEnd, actualStart: a.start || null, actualEnd: a.end || null, active: t.id === this.activeId,
      };
    });
  }

  snapshot() {
    const now = this.now();
    const t = this.active;
    const c = this.compute();
    const agenda = this.agenda();
    const nxt = this.list[this.index() + 1] || (t ? null : this.list[0]) || null;
    // Positive offset = running behind schedule.
    let offsetMs = null;
    const row = agenda.find((r) => r.active);
    if (row && row.plannedEnd !== null && c.remainingMs !== null && this.state !== 'idle') {
      offsetMs = now + Math.max(0, c.remainingMs) - row.plannedEnd;
    } else if (row && row.plannedStart !== null && this.state === 'idle' && now > row.plannedStart) {
      offsetMs = now - row.plannedStart;
    }
    return {
      now, state: this.state, running: this.state === 'running', activeId: this.activeId, activeIndex: this.index(),
      current: t ? { id: t.id, title: t.title, speaker: t.speaker, notes: t.notes, mode: t.mode, duration: t.duration, overrun: t.overrun, amber: t.amber, red: t.red, flashAtZero: t.flashAtZero, ...c } : null,
      next: nxt ? { id: nxt.id, title: nxt.title, speaker: nxt.speaker, duration: nxt.duration, mode: nxt.mode } : null,
      message: this.message, blackout: this.blackout, offsetMs, agenda,
    };
  }
}

module.exports = { Timers, formatMs, formatClock, parseClock };
