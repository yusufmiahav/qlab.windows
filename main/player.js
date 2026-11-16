// MediaPlayer: one mpv instance presented as a simple cue player (load paused on
// first frame, play, pause, seek, frame-step, volume ramps, end detection).
const EventEmitter = require('events');

const METER_AF = '@meter:lavfi=[astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level]';

function dbToVol(db) {
  if (db <= -60) return 0;
  return Math.min(200, 100 * Math.pow(10, db / 60)); // mpv volume is cubic: gain = (vol/100)^3
}

class MediaPlayer extends EventEmitter {
  constructor(mpv, { masterDb = () => 0 } = {}) {
    super();
    this.mpv = mpv;
    this.masterDb = masterDb;
    this.db = 0;
    this.spec = null;
    this.loadSeq = 0;
    this.loaded = false;
    this.ended = false;
    this.level = -90;
    mpv.observe('time-pos', 'duration', 'pause', 'eof-reached', 'idle-active');
    mpv.on('prop', (name, value) => {
      if (name === 'eof-reached' && value === true && this.loaded && !this.ended) {
        if (this.manualLoops > 0) { // finite loops with an in-point: re-seek ourselves
          this.manualLoops--;
          mpv.cmd('seek', this.start, 'absolute+exact');
          mpv.set('pause', false);
          return;
        }
        this.ended = true;
        this.emit('ended');
        if (this.onEnded) this.onEnded();
      }
    });
    mpv.on('restarted', () => { this.loaded = false; this.spec = null; this.emit('crashed'); });
  }

  // spec: { file, start, end, loops (0 = infinite, n = play n times), device }
  load(spec) {
    const seq = ++this.loadSeq;
    const m = this.mpv;
    this.spec = spec;
    this.loaded = false;
    this.ended = false;
    this.stopRamp();
    this.ready = (async () => {
      await m.set('pause', true);
      await m.set('start', spec.start > 0 ? String(spec.start) : 'none');
      // mpv's loop-file restarts from 0, so loops with an in-point are re-seeked by us at the out point.
      const hasIn = spec.start > 0;
      this.manualLoops = !hasIn ? 0 : spec.loops === 0 ? Infinity : Math.max(0, spec.loops - 1);
      await m.set('end', spec.end > 0 ? String(spec.end) : 'none');
      await m.set('loop-file', hasIn ? 'no' : spec.loops === 0 ? 'inf' : spec.loops > 1 ? String(spec.loops - 1) : 'no');
      await m.set('audio-device', spec.device || 'auto');
      await m.set('af', spec.novideo || spec.meter !== false ? METER_AF : '');
      this.applyVolume();
      const ok = await new Promise((resolve) => {
        const done = (v) => { m.off('event', onEvent); clearTimeout(t); resolve(v); };
        const onEvent = (e) => {
          if (e.event === 'playback-restart') done(true);
          else if (e.event === 'end-file' && e.reason === 'error') done(false);
        };
        const t = setTimeout(() => done(false), 8000);
        m.on('event', onEvent);
        m.command('loadfile', spec.file, 'replace').catch(() => done(false));
      });
      if (seq !== this.loadSeq) return false;
      this.loaded = ok;
      return ok;
    })();
    return this.ready;
  }

  get paused() { return this.mpv.props.pause !== false; }
  get playing() { return this.loaded && !this.paused && !this.ended; }
  get start() { return (this.spec && this.spec.start) || 0; }
  get total() {
    if (!this.spec) return 0;
    const end = this.spec.end > 0 ? this.spec.end : (this.mpv.props.duration || 0);
    return Math.max(0, end - this.start);
  }
  get pos() {
    if (!this.loaded) return 0;
    if (this.ended) return this.total;
    return Math.max(0, Math.min(this.total || Infinity, (this.mpv.props['time-pos'] || 0) - this.start));
  }
  get remaining() { return Math.max(0, this.total - this.pos); }

  play() {
    if (this.ended) { this.ended = false; this.mpv.cmd('seek', this.start, 'absolute+exact'); }
    this.mpv.set('pause', false);
  }
  pause() { this.mpv.set('pause', true); }
  seek(t) {
    this.ended = false;
    const total = this.total;
    const target = Math.max(0, total ? Math.min(t, total - 0.05) : t);
    return this.mpv.cmd('seek', this.start + target, 'absolute+exact');
  }
  step(dir) {
    this.ended = false;
    this.mpv.cmd(dir < 0 ? 'frame-back-step' : 'frame-step');
  }
  stop() {
    this.loadSeq++;
    this.loaded = false;
    this.spec = null;
    this.onEnded = null;
    this.stopRamp();
    this.mpv.cmd('stop');
  }

  applyVolume() { this.mpv.set('volume', dbToVol(this.db + this.masterDb())); }
  setDb(db) { this.stopRamp(); this.db = db; this.applyVolume(); }
  stopRamp() { if (this.ramp) { clearInterval(this.ramp); this.ramp = null; if (this.rampDone) this.rampDone(); this.rampDone = null; } }
  // Ramp linearly in mpv volume units (perceptually smooth). Resolves when finished or interrupted.
  fadeTo(db, ms) {
    this.stopRamp();
    if (!(ms > 0)) { this.setDb(db); return Promise.resolve(); }
    const from = dbToVol(this.db), to = dbToVol(db), t0 = Date.now();
    return new Promise((resolve) => {
      this.rampDone = resolve;
      this.ramp = setInterval(() => {
        const k = Math.min(1, (Date.now() - t0) / ms);
        const v = from + (to - from) * k;
        this.db = v <= 0 ? -60 : 60 * Math.log10(v / 100);
        this.applyVolume();
        if (k >= 1) { this.db = db; this.stopRamp(); }
      }, 30);
    });
  }

  async pollLevel() {
    if (!this.playing) { this.level = -90; return this.level; }
    const md = await this.mpv.get('af-metadata/meter');
    const v = md && parseFloat(md['lavfi.astats.Overall.Peak_level']);
    const master = this.db + this.masterDb();
    this.level = Number.isFinite(v) ? Math.max(-90, v + master) : -90;
    return this.level;
  }
}

module.exports = { MediaPlayer, dbToVol };
