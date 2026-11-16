// LAN web server: timer viewers (static pages), HTTP control API and a WebSocket for live state.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const WEB = path.join(__dirname, '..', 'web');
const PAGES = { '/': 'index.html', '/stage': 'stage.html', '/controller': 'controller.html', '/agenda': 'agenda.html' };

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// Translate an API path into a command. Returns [name, args] or null.
function routeApi(parts, q) {
  const [a, b, c] = parts;
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const flag = (v) => v === '1' || v === 'true' || v === 'on';
  switch (a) {
    case 'go': return ['go', {}];
    case 'stop': return ['stop', {}];
    case 'panic': return ['panic', {}];
    case 'prev': case 'previous': return ['prev', {}];
    case 'next': return ['next', {}];
    case 'pause': case 'resume': case 'playpause': return ['transport.toggle', {}];
    case 'cue':
      if (b && c) return [`cue.${c}`, { number: decodeURIComponent(b) }];
      return null;
    case 'timer':
      if (b === 'add' || b === 'subtract') { const s = num(c !== undefined ? c : q.seconds); return ['timer.add', { seconds: (b === 'add' ? 1 : -1) * (s || 0) }]; }
      if (c) return [`timer.${c}`, { id: decodeURIComponent(b) }];
      if (b) return [`timer.${b}`, { id: q.id }];
      return null;
    case 'message':
      if (b === 'clear') return ['message.clear', {}];
      return ['message.send', { text: q.text !== undefined ? q.text : b ? decodeURIComponent(b) : '', flash: flag(q.flash), bold: q.bold === undefined ? true : flag(q.bold) }];
    case 'blackout': { const v = b !== undefined ? b : q.on; return ['blackout', { on: v === undefined || v === 'toggle' ? 'toggle' : flag(v) }]; }
    default: return null;
  }
}

class WebServer {
  constructor({ run, getState, getPin, onError }) {
    this.run = run;
    this.getState = getState;
    this.getPin = getPin;
    this.onError = onError || (() => {});
    this.clients = new Set();
    this.port = 0;
  }

  pinOk(pin) { const want = this.getPin(); return !want || String(pin || '') === String(want); }

  listen(port) {
    this.close();
    this.port = port;
    this.error = null;
    const server = http.createServer((req, res) => this.handle(req, res));
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.cmd === 'auth') { ws.send(JSON.stringify({ type: 'auth', ok: this.pinOk(msg.pin) })); return; }
        if (!msg.cmd) return;
        if (!this.pinOk(msg.pin)) { ws.send(JSON.stringify({ type: 'error', error: 'pin' })); return; }
        const ok = this.run(msg.cmd, msg.args || {}, 'web');
        ws.send(JSON.stringify({ type: 'ack', cmd: msg.cmd, ok }));
      });
      ws.send(JSON.stringify({ type: 'state', state: this.getState() }));
    });
    server.on('error', (e) => { this.error = e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message; this.onError(e); });
    server.listen(port, '0.0.0.0');
    this.server = server; this.wss = wss;
    clearInterval(this.pulse);
    this.pulse = setInterval(() => this.broadcast(), 500);
  }

  broadcast() {
    if (!this.clients.size) return;
    const payload = JSON.stringify({ type: 'state', state: this.getState() });
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(payload);
  }

  urls() {
    const hosts = lanAddresses();
    if (!hosts.length) hosts.push('localhost');
    return hosts.map((h) => `http://${h}:${this.port}`);
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, '');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p.startsWith('/api')) {
      const q = Object.fromEntries(url.searchParams);
      const parts = p.split('/').slice(2);
      if (parts[0] === 'state') return send(200, this.getState());
      if (parts[0] === 'companion') return send(200, this.getState().companion);
      if (parts[0] === 'auth') return send(200, { ok: this.pinOk(q.pin), pinRequired: !!this.getPin() });
      const finish = (extra = {}) => {
        const merged = { ...q, ...extra };
        const pin = merged.pin || req.headers['x-pin'];
        if (!this.pinOk(pin)) return send(401, { ok: false, error: 'PIN required (add ?pin=1234)' });
        const r = routeApi(parts, merged);
        if (!r) return send(404, { ok: false, error: 'Unknown endpoint' });
        const ok = this.run(r[0], r[1], 'http');
        send(ok === false ? 400 : 200, { ok: ok !== false, command: r[0] });
      };
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
        req.on('end', () => { let j = {}; try { j = body ? JSON.parse(body) : {}; } catch {} finish(j); });
        return;
      }
      return finish();
    }
    const file = PAGES[p] ? path.join(WEB, PAGES[p]) : path.join(WEB, path.normalize(p).replace(/^([/\\]|\.\.)+/, ''));
    if (!file.startsWith(WEB)) return send(403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'Not found', 'text/plain');
      send(200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  }

  close() {
    clearInterval(this.pulse);
    if (this.wss) { for (const c of this.clients) try { c.terminate(); } catch {} this.wss.close(); this.wss = null; }
    if (this.server) { this.server.close(); this.server = null; }
    this.clients.clear();
  }
}

module.exports = { WebServer, lanAddresses, routeApi };
