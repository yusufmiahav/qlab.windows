// Thin wrapper around an mpv process controlled over its JSON IPC socket.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const EventEmitter = require('events');

let counter = 0;

function mpvBinary() {
  if (process.env.CUESTAGE_MPV) return process.env.CUESTAGE_MPV;
  if (process.platform === 'win32') {
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, 'mpv', 'mpv.exe'),
      path.join(__dirname, '..', 'vendor', 'mpv', 'mpv.exe'),
    ].filter(Boolean);
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return 'mpv.exe';
  }
  return 'mpv';
}

function extraArgs() {
  return (process.env.CUESTAGE_MPV_ARGS || '').split(' ').filter(Boolean);
}

class Mpv extends EventEmitter {
  constructor(name, args = []) {
    super();
    this.setMaxListeners(50);
    this.name = name;
    this.args = args;
    this.props = {};
    this.pending = new Map();
    this.reqId = 0;
    this.observed = [];
    this.alive = false;
    this.closing = false;
    this.restarts = 0;
  }

  start() {
    const id = `cuestage-${process.pid}-${this.name}-${++counter}`;
    this.pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), id + '.sock');
    const args = [
      '--idle=yes', '--no-config', '--no-terminal', `--input-ipc-server=${this.pipe}`,
      '--no-input-default-bindings', '--input-vo-keyboard=no', '--no-osc', '--osd-level=0', '--no-osd-bar',
      '--keep-open=yes', '--pause=yes', '--volume-max=200', '--hr-seek=yes', '--audio-fallback-to-null=yes',
      '--sub-auto=no', '--sid=no', '--audio-client-name=CueStage',
      ...this.args, ...extraArgs(),
    ];
    this.proc = spawn(mpvBinary(), args, { stdio: 'ignore', windowsHide: false });
    this.proc.on('error', (e) => { this.lastError = e.message; this.emit('fatal', e); });
    this.proc.on('exit', () => this._onExit());
    this.ready = this._connect();
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const began = Date.now();
      const attempt = () => {
        if (this.closing) return reject(new Error('closed'));
        const sock = net.connect(this.pipe);
        sock.once('connect', () => {
          this.sock = sock;
          this.alive = true;
          let buf = '';
          sock.on('data', (d) => {
            buf += d.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (line.trim()) this._onLine(line);
            }
          });
          sock.on('error', () => {});
          for (const p of this.observed) this._send(['observe_property', 1, p]);
          resolve(this);
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() - began > 8000) reject(new Error(`mpv (${this.name}) did not start: ${this.lastError || 'no IPC'}`));
          else setTimeout(attempt, 60);
        });
      };
      setTimeout(attempt, 80);
    });
  }

  _onExit() {
    this.alive = false;
    if (this.sock) this.sock.destroy();
    for (const [, p] of this.pending) p.reject(new Error('mpv exited'));
    this.pending.clear();
    if (this.closing) return;
    this.emit('exit');
    // Auto-restart so a crashed player never takes the show down.
    if (this.restarts++ < 20) setTimeout(() => { if (!this.closing) this.start().then(() => this.emit('restarted')).catch(() => {}); }, 300);
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
      const p = this.pending.get(msg.request_id);
      this.pending.delete(msg.request_id);
      if (msg.error === 'success') p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    } else if (msg.event === 'property-change') {
      this.props[msg.name] = msg.data;
      this.emit('prop', msg.name, msg.data);
    } else if (msg.event) {
      this.emit('event', msg);
    }
  }

  _send(command) {
    if (!this.alive) return Promise.reject(new Error('mpv not running'));
    const request_id = ++this.reqId;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.sock.write(JSON.stringify({ command, request_id }) + '\n');
    });
  }

  command(...args) { return this._send(args); }
  // Fire-and-forget variants never throw (a dead player must not break the cue engine).
  cmd(...args) { return this._send(args).catch(() => undefined); }
  set(prop, value) { return this._send(['set_property', prop, value]).catch(() => undefined); }
  get(prop) { return this._send(['get_property', prop]).catch(() => undefined); }
  observe(...props) {
    for (const p of props) {
      if (!this.observed.includes(p)) this.observed.push(p);
      if (this.alive) this.cmd('observe_property', 1, p);
    }
  }

  quit() {
    this.closing = true;
    try { if (this.alive) this.sock.write(JSON.stringify({ command: ['quit'] }) + '\n'); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 400);
  }
}

module.exports = { Mpv, mpvBinary };
