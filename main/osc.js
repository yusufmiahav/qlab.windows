// Minimal OSC 1.0 server over UDP (messages + bundles; int, float, string, bool args).
const dgram = require('dgram');

function readString(buf, pos) {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', pos, end);
  return [str, (end + 4) & ~3];
}

function parsePacket(buf, out = []) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    let pos = 16;
    while (pos + 4 <= buf.length) {
      const size = buf.readInt32BE(pos); pos += 4;
      parsePacket(buf.subarray(pos, pos + size), out);
      pos += size;
    }
    return out;
  }
  let [address, pos] = readString(buf, 0);
  if (!address.startsWith('/')) return out;
  const args = [];
  if (pos < buf.length && buf[pos] === 0x2c) {
    let tags;
    [tags, pos] = readString(buf, pos);
    for (const t of tags.slice(1)) {
      if (t === 'i') { args.push(buf.readInt32BE(pos)); pos += 4; }
      else if (t === 'f') { args.push(buf.readFloatBE(pos)); pos += 4; }
      else if (t === 'd') { args.push(buf.readDoubleBE(pos)); pos += 8; }
      else if (t === 'h') { args.push(Number(buf.readBigInt64BE(pos))); pos += 8; }
      else if (t === 's') { let s; [s, pos] = readString(buf, pos); args.push(s); }
      else if (t === 'T') args.push(true);
      else if (t === 'F') args.push(false);
    }
  }
  out.push({ address, args });
  return out;
}

function encodeMessage(address, args = []) {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
  const parts = [pad(Buffer.from(address))];
  let tags = ',';
  const data = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; data.push(pad(Buffer.from(a))); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); data.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); data.push(b); }
  }
  parts.push(pad(Buffer.from(tags)), ...data);
  return Buffer.concat(parts);
}

// Map an OSC message onto a command name + args (see docs/API.md).
function route(address, args) {
  const p = address.replace(/\/+$/, '').split('/').slice(1);
  const a0 = args[0];
  const on = (v) => (v === undefined ? 'toggle' : v === 'toggle' ? 'toggle' : !!(typeof v === 'string' ? +v : v));
  switch (p[0]) {
    case 'go': return ['go', {}];
    case 'stop': return ['stop', {}];
    case 'panic': return ['panic', {}];
    case 'prev': case 'previous': return ['prev', {}];
    case 'next': return ['next', {}];
    case 'pause': case 'resume': case 'playpause': return ['transport.toggle', {}];
    case 'cue':
      if (p.length === 3) return [`cue.${p[2]}`, { number: p[1] }];
      if (p.length === 2) return [`cue.${p[1]}`, { number: a0 }];
      return null;
    case 'timer':
      if (p.length === 3) return [`timer.${p[2]}`, { id: p[1] }];
      if (p[1] === 'add' || p[1] === 'subtract') return ['timer.add', { seconds: (p[1] === 'add' ? 1 : -1) * Number(a0 || 0) }];
      if (p[1] === 'select' || p[1] === 'start') return [`timer.${p[1]}`, { id: a0 }];
      return [`timer.${p[1]}`, {}];
    case 'message':
      if (p[1] === 'clear') return ['message.clear', {}];
      return ['message.send', { text: a0 === undefined ? '' : String(a0), flash: !!args[1], bold: args[2] === undefined ? true : !!args[2] }];
    case 'blackout': return ['blackout', { on: on(a0) }];
    default: return null;
  }
}

class OscServer {
  constructor({ run, onError }) {
    this.run = run;
    this.onError = onError || (() => {});
    this.port = 0;
  }
  listen(port) {
    this.close();
    if (!port) return;
    this.port = port;
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', (e) => { this.error = e.message; this.onError(e); });
    this.sock.on('message', (buf) => {
      let msgs = [];
      try { msgs = parsePacket(buf); } catch { return; }
      for (const m of msgs) {
        const r = route(m.address, m.args);
        if (r) this.run(r[0], r[1], 'osc');
      }
    });
    this.error = null;
    this.sock.bind(port);
  }
  close() { if (this.sock) { try { this.sock.close(); } catch {} this.sock = null; } }
}

module.exports = { OscServer, parsePacket, encodeMessage, route };
