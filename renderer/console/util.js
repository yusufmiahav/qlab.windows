import { h, render, Component } from '../../node_modules/preact/dist/preact.module.js';
import htm from '../../node_modules/htm/dist/htm.module.js';

export const html = htm.bind(h);
export { h, render, Component };

export const cs = window.cs;
export const cmd = (name, args) => cs.cmd(name, args);

// Global UI state. Components read from S; update() re-renders the whole tree (cheap with Preact).
export const S = {
  doc: null, filePath: null, dirty: false, canUndo: false, canRedo: false, locked: false, missing: [],
  rt: { runs: [], live: null, standby: null, playheadId: null, timer: null, meters: { video: -90, audio: -90 } },
  app: { settings: { shortcuts: {} }, displays: [], devices: [], links: [], recent: [], allUrls: [] },
  sel: new Set(), anchor: null, log: [], preview: null, check: null,
  rightTab: 'inspector', bottomTab: 'running', modal: null, toast: null, editTimer: null, drop: null,
};
let renderFn = () => {};
export const setRender = (fn) => { renderFn = fn; };
export const update = (patch) => { if (patch) Object.assign(S, patch); renderFn(); };
export function toast(text, kind = 'info') {
  S.toast = { text, kind };
  update();
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { S.toast = null; update(); }, 4000);
}

export const TYPES = {
  video: 'VID', audio: 'AUD', image: 'IMG', colour: 'COL', playlist: 'LIST', timer: 'TMR', wait: 'WAIT', fade: 'FADE', stop: 'STOP', group: 'GRP', memo: 'MEMO',
};
export const TYPE_NAMES = { video: 'Video', audio: 'Audio', image: 'Image', colour: 'Colour', playlist: 'Playlist', timer: 'Timer', wait: 'Wait', fade: 'Fade', stop: 'Stop', group: 'Group', memo: 'Memo' };
export const COLOURS = ['none', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'grey'];

export function fmt(sec, tenths = false) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--';
  const neg = sec < 0; sec = Math.abs(sec);
  const whole = tenths ? Math.floor(sec) : Math.round(sec);
  const hh = Math.floor(whole / 3600), mm = Math.floor((whole % 3600) / 60), ss = whole % 60;
  const p = (n) => String(n).padStart(2, '0');
  let out = hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
  if (tenths) out += '.' + Math.floor((sec - whole) * 10);
  return (neg ? '-' : '') + out;
}
// "90", "1:30", "1:02:03.5" -> seconds
export function parseTime(str) {
  str = String(str).trim();
  if (!str) return 0;
  const neg = str.startsWith('-');
  const parts = str.replace(/^-/, '').split(':').map((x) => parseFloat(x) || 0);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return neg ? -s : s;
}
export function timeText(sec) {
  if (!sec) return '0';
  const r = Math.round(sec * 100) / 100;
  if (r < 60) return String(r);
  const whole = Math.floor(r), frac = Math.round((r - whole) * 100);
  return fmt(whole) + (frac ? '.' + String(frac).padStart(2, '0').replace(/0$/, '') : '');
}
export const clock = (ms, secs = true) => {
  if (!ms) return '--:--';
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}${secs ? ':' + p(d.getSeconds()) : ''}`;
};
export const basename = (f) => (f || '').split(/[\\/]/).pop();

export function flatten(cues, depth = 0, parent = null, out = []) {
  for (const c of cues) {
    out.push({ cue: c, depth, parent });
    if (c.children) flatten(c.children, depth + 1, c, out);
  }
  return out;
}
export const findCue = (id) => { const r = flatten(S.doc.cues).find((x) => x.cue.id === id); return r ? r.cue : null; };
export const cueLabel = (c) => `${c.number ? c.number + ' · ' : ''}${c.name || TYPE_NAMES[c.type]}`;

// ---------- small form controls ----------
// Text-like input with a local draft so typing never fights with state pushes from main.
export class Field extends Component {
  constructor(p) { super(p); this.state = { draft: null }; }
  render({ value, onCommit, parse, format, live, ...rest }, { draft }) {
    const shown = draft !== null ? draft : (format ? format(value) : value ?? '');
    const commit = (v) => { const out = parse ? parse(v) : v; if (out !== value) onCommit(out); };
    return html`<input ...${rest} value=${shown} disabled=${rest.disabled || S.locked}
      onInput=${(e) => { this.setState({ draft: e.target.value }); if (live) commit(e.target.value); }}
      onFocus=${(e) => { this.setState({ draft: e.target.value }); if (!live) e.target.select(); }}
      onBlur=${(e) => { commit(e.target.value); this.setState({ draft: null }); }}
      onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { this.setState({ draft: null }); e.target.blur(); e.stopPropagation(); } }} />`;
  }
}
export const Text = (p) => html`<${Field} type="text" live ...${p} />`;
export const Time = (p) => html`<${Field} type="text" class="num" parse=${parseTime} format=${timeText} title="Seconds, m:ss or h:mm:ss" ...${p} />`;
export const Num = ({ min, max, ...p }) => html`<${Field} type="text" class="num" parse=${(v) => { let n = parseFloat(v); if (!Number.isFinite(n)) n = 0; if (min !== undefined) n = Math.max(min, n); if (max !== undefined) n = Math.min(max, n); return n; }} ...${p} />`;
export const Select = ({ value, options, onCommit, ...rest }) => html`<select ...${rest} value=${value} disabled=${rest.disabled || S.locked} onChange=${(e) => onCommit(e.target.value)}>
  ${options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return html`<option value=${v} selected=${v === value}>${l}</option>`; })}</select>`;
export const Check = ({ value, onCommit, label, ...rest }) => html`<label class="check"><input type="checkbox" ...${rest} checked=${!!value} disabled=${rest.disabled || S.locked} onChange=${(e) => onCommit(e.target.checked)} /> ${label}</label>`;
export const Row = ({ label, children, hint }) => html`<div class="row" title=${hint || ''}><label>${label}</label><div class="ctl">${children}</div></div>`;
export const Btn = ({ onClick, children, cls = '', ...rest }) => html`<button class=${'btn ' + cls} ...${rest} onClick=${(e) => { e.currentTarget.blur(); onClick && onClick(e); }}>${children}</button>`;
