// Show log: every cue fired and timer action, timestamped, exportable as CSV.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

class ShowLog extends EventEmitter {
  constructor({ dir }) {
    super();
    this.entries = [];
    this.seq = 0;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      this.file = path.join(dir, `showlog-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`);
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, 'Date,Time,Category,Event,Source\r\n');
    } catch { this.file = null; }
  }
  static row(e) {
    const d = new Date(e.ts);
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return [`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`, e.category, e.text, e.source || ''].map(csvCell).join(',');
  }
  add(category, text, source = '') {
    const e = { seq: ++this.seq, ts: Date.now(), category, text, source };
    this.entries.push(e);
    if (this.entries.length > 5000) this.entries.shift();
    if (this.file) fs.appendFile(this.file, ShowLog.row(e) + '\r\n', () => {});
    this.emit('entry', e);
    return e;
  }
  csv() { return 'Date,Time,Category,Event,Source\r\n' + this.entries.map(ShowLog.row).join('\r\n') + '\r\n'; }
  clear() { this.entries = []; this.emit('cleared'); }
}

module.exports = { ShowLog };
