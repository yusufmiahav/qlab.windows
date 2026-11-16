// Audio cue players: a pool of headless mpv instances, one per playing cue, each
// routable to its own output device. Idle players are kept warm so GO is instant.
const { Mpv } = require('./mpv');
const { MediaPlayer } = require('./player');

class AudioManager {
  constructor({ masterDb }) {
    this.masterDb = masterDb;
    this.voices = []; // { mpv, player, key, hash, role: 'idle' | 'preload' | 'live' }
    this.n = 0;
    this.deviceList = [{ name: 'auto', description: 'System default' }];
  }

  async init() {
    await Promise.all([this.spawn(), this.spawn()]);
    await this.refreshDevices();
  }

  async spawn() {
    const mpv = new Mpv(`audio${this.n++}`, ['--no-video', '--vid=no', '--audio-display=no']);
    const player = new MediaPlayer(mpv, { masterDb: this.masterDb });
    const voice = { mpv, player, key: null, hash: null, role: 'idle' };
    this.voices.push(voice);
    try { await mpv.start(); } catch (e) { this.error = e.message; }
    return voice;
  }

  async refreshDevices() {
    const v = this.voices.find((x) => x.mpv.alive);
    const list = v && await v.mpv.get('audio-device-list');
    if (Array.isArray(list) && list.length) {
      this.deviceList = list.map((d) => ({ name: d.name, description: d.name === 'auto' ? 'System default' : d.description || d.name }));
    }
    return this.deviceList;
  }

  async idleVoice() {
    let v = this.voices.find((x) => x.role === 'idle' && x.mpv.alive);
    if (!v) v = await this.spawn();
    // keep one spare warm
    if (!this.voices.some((x) => x !== v && x.role === 'idle')) this.spawn();
    return v;
  }

  // Load paused, ready for an instant start.
  async preload(key, hash, spec) {
    const existing = this.voices.find((v) => v.role === 'preload');
    if (existing && existing.key === key && existing.hash === hash) return existing;
    if (existing) this.release(existing);
    const v = await this.idleVoice();
    Object.assign(v, { key, hash, role: 'preload' });
    v.player.load({ ...spec, novideo: true });
    return v;
  }
  dropPreload(exceptKey) {
    for (const v of this.voices) if (v.role === 'preload' && v.key !== exceptKey) this.release(v);
  }

  async acquire(key, hash, spec) {
    let v = this.voices.find((x) => x.role === 'preload' && x.key === key && x.hash === hash);
    if (!v) { v = await this.idleVoice(); Object.assign(v, { key, hash }); v.player.load({ ...spec, novideo: true }); }
    v.role = 'live';
    const ok = await v.player.ready;
    return ok ? v : (this.release(v), null);
  }

  release(v) {
    v.player.stop();
    Object.assign(v, { key: null, hash: null, role: 'idle' });
    // trim the pool
    const idle = this.voices.filter((x) => x.role === 'idle');
    if (idle.length > 3) { const kill = idle[idle.length - 1]; if (kill !== v) { kill.mpv.quit(); this.voices = this.voices.filter((x) => x !== kill); } }
  }

  applyMaster() { for (const v of this.voices) if (v.role !== 'idle') v.player.applyVolume(); }

  async level() {
    let max = -90;
    for (const v of this.voices) if (v.role === 'live') max = Math.max(max, await v.player.pollLevel());
    return max;
  }

  quit() { for (const v of this.voices) v.mpv.quit(); }
}

module.exports = { AudioManager };
