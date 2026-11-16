// Shared by the web viewers: live state over WebSocket with auto-reconnect, plus formatting helpers.
const CS = {
  state: null, at: 0, skew: 0, connected: false, listeners: [], pin: localStorage.getItem('cs-pin') || '',
  on(fn) { this.listeners.push(fn); },
  emit() { for (const fn of this.listeners) fn(this.state); },
  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; document.body.classList.remove('offline'); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') { this.state = m.state; this.at = Date.now(); this.skew = m.state.now - Date.now(); this.emit(); }
      else if (m.type === 'error' && m.error === 'pin') { this.pin = ''; localStorage.removeItem('cs-pin'); if (this.onPinFail) this.onPinFail(); }
    };
    ws.onclose = () => { this.connected = false; document.body.classList.add('offline'); setTimeout(() => this.connect(), 1000); };
    ws.onerror = () => ws.close();
  },
  send(cmd, args = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ cmd, args, pin: this.pin })); },
  // Server clock, so every screen shows the same time regardless of the device's own clock.
  now() { return Date.now() + this.skew; },
};
function csFmt(ms) {
  const neg = ms < 0, s = neg ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60, p = (n) => String(n).padStart(2, '0');
  return (neg && s > 0 ? '-' : '') + (h > 0 ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`);
}
function csClock(ms, secs = true) {
  if (!ms) return '';
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${secs ? ':' + p(d.getSeconds()) : ''}`;
}
function csDur(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return s ? `${m}:${String(s).padStart(2, '0')}` : `${m} min`; }
// Timer text interpolated between server pushes so the digits tick smoothly.
function csTimerText(t) {
  const cur = t && t.current;
  if (!cur) return '';
  if (cur.mode === 'clock') return csClock(CS.now());
  if (!t.running || (cur.remainingMs === null && cur.mode !== 'countup')) return cur.display;
  const dt = Date.now() - CS.at;
  if (cur.mode === 'countup') return csFmt(-(cur.elapsedMs + dt)).replace('-', '');
  let rem = cur.remainingMs - dt;
  if (rem < 0 && !cur.overrun) rem = 0;
  return csFmt(rem);
}
function csColour(t) {
  const cur = t && t.current;
  if (!cur) return 'idle';
  if (!t.running || cur.remainingMs === null || cur.mode === 'clock') return cur.colour;
  const rem = cur.remainingMs - (Date.now() - CS.at);
  return rem <= 0 ? 'over' : rem <= cur.red * 1000 ? 'red' : rem <= cur.amber * 1000 ? 'amber' : 'green';
}
const csEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
