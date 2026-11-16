import { html, render, S, cs, cmd, update, setRender, toast, flatten, findCue, fmt, clock, basename, TYPES, TYPE_NAMES, Btn } from './util.js';
import { Inspector } from './inspector.js';
import { TimersPanel, timerText } from './timers.js';
import { Monitor, Bottom, Settings, comboOf } from './panels.js';

// ---------- selection ----------
function selectRow(id, e) {
  const rows = flatten(S.doc.cues).map((r) => r.cue.id);
  if (e && e.shiftKey && S.anchor) {
    const a = rows.indexOf(S.anchor), b = rows.indexOf(id);
    S.sel = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (e && (e.ctrlKey || e.metaKey)) {
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    S.anchor = id;
  } else { S.sel = new Set([id]); S.anchor = id; }
  update({ rightTab: 'inspector' });
}
const selIds = () => flatten(S.doc.cues).map((r) => r.cue.id).filter((id) => S.sel.has(id));

// ---------- actions ----------
let lastEsc = 0;
const A = {
  go: () => cmd('go'),
  panic() { const now = Date.now(); if (now - lastEsc < 1500) cmd('panic'); else cmd('stop'); lastEsc = now; },
  prev: () => cmd('prev').then(followPlayhead), next: () => cmd('next').then(followPlayhead),
  playPause: () => cmd('transport', { action: 'toggle' }),
  stepBack: () => cmd('transport', { action: 'step', value: -1 }), stepForward: () => cmd('transport', { action: 'step', value: 1 }),
  toEnd: () => cmd('transport', { action: 'toEnd' }), restart: () => cmd('transport', { action: 'restart' }),
  save: () => cmd('show.save'), open: () => cmd('show.open'),
  undo: () => cmd('undo'), redo: () => cmd('redo'),
  duplicate: async () => { const made = await cmd('cue.duplicate', { ids: selIds() }); if (made && made.length) { S.sel = new Set(made.map((c) => c.id)); update(); } },
  delete: () => { const ids = selIds(); if (ids.length && !S.locked) { cmd('cue.remove', { ids }); S.sel = new Set(); update(); } },
  selectAll: () => { S.sel = new Set(flatten(S.doc.cues).map((r) => r.cue.id)); update(); },
  group: async () => { const ids = selIds(); if (ids.length) { const g = await cmd('cue.group', { ids }); if (g) { S.sel = new Set([g.id]); update(); } } },
  lock: () => cmd('lock', { on: !S.locked }),
  timerToggle: () => cmd('timer.toggle'), timerNext: () => cmd('timer.next'), timerPrev: () => cmd('timer.prev'),
  timerPlus: () => cmd('timer.add', { seconds: 60 }), timerMinus: () => cmd('timer.add', { seconds: -60 }), timerReset: () => cmd('timer.reset'),
  blackout: () => cmd('blackout', { on: 'toggle' }), clearMessage: () => cmd('message.clear'),
};
function followPlayhead() { setTimeout(() => { if (S.rt.playheadId) { S.sel = new Set([S.rt.playheadId]); S.anchor = S.rt.playheadId; update(); const el = document.querySelector('.cue.standby'); if (el) el.scrollIntoView({ block: 'nearest' }); } }, 60); }

window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (S.modal) { if (e.key === 'Escape') update({ modal: null }); return; }
  if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const combo = comboOf(e);
  const map = S.app.settings.shortcuts || {};
  const action = Object.keys(map).find((k) => map[k] === combo);
  if (action && A[action]) { e.preventDefault(); if (!e.repeat || ['prev', 'next', 'stepBack', 'stepForward'].includes(action)) A[action](); }
  else if (e.code === 'Space' || e.code === 'Enter') e.preventDefault(); // never let a focused button swallow/trigger on these keys
}, true);

// ---------- status bar ----------
function StatusBar() {
  const { live, standby, timer } = S.rt, a = S.app;
  const cur = timer && timer.current;
  return html`<div class="status">
    <div class=${'st-box live' + (live ? ' on' : '')}>
      <div class="st-label">LIVE</div>
      <div class="st-main">${live ? html`<span class="num">${live.number}</span> ${live.name}${live.sub ? html` <span class="dim">› ${live.sub}</span>` : ''}` : html`<span class="dim">— nothing playing —</span>`}</div>
      <div class="st-sub">${live ? html`<span class=${'state s-' + live.state}>${live.state.toUpperCase()}</span>` : ''}</div>
    </div>
    <div class="st-box times">
      <div class="st-label">ELAPSED</div><div class="st-time">${live ? fmt(live.elapsed) : '--:--'}</div>
    </div>
    <div class=${'st-box times remain' + (live && live.remaining !== null && live.remaining < 10 && live.state === 'running' ? ' low' : '')}>
      <div class="st-label">REMAINING</div><div class="st-time">${live && live.remaining !== null ? '-' + fmt(live.remaining) : '--:--'}</div>
    </div>
    <div class="st-box standby">
      <div class="st-label">STANDBY ${standby && standby.preloaded ? html`<span class="ready">● LOADED</span>` : ''}</div>
      <div class="st-main">${standby ? html`<span class="num">${standby.number}</span> ${standby.name || TYPE_NAMES[standby.type]}` : html`<span class="dim">— end of list —</span>`}</div>
    </div>
    <div class=${'st-box times tmr ' + (cur ? cur.colour : 'idle')}>
      <div class="st-label">TIMER${cur ? ' · ' + cur.title : ''}</div><div class="st-time">${cur ? timerText(timer) : '--:--'}</div>
    </div>
    <div class="st-box times"><div class="st-label">TIME</div><div class="st-time">${clock(S.rt.now || Date.now())}</div></div>
    <div class="st-flags">
      ${a.rehearsal && html`<span class="flag reh">REHEARSAL</span>`}
      ${S.locked && html`<span class="flag lock">LOCKED</span>`}
      ${a.mpvError && html`<span class="flag err" title=${a.mpvError}>ENGINE ERROR</span>`}
      ${S.missing.length > 0 && html`<span class="flag err" title=${S.missing.join('\n')}>${S.missing.length} MISSING</span>`}
    </div>
  </div>`;
}

// ---------- toolbar ----------
const ADD = ['video', 'audio', 'image', 'colour', 'playlist', 'timer', 'wait', 'fade', 'stop', 'group', 'memo'];
async function addCue(type) {
  const sel = selIds();
  let props = {};
  if (['video', 'audio', 'image'].includes(type)) {
    const files = await cmd('cue.pickFile', { kind: type, multi: true });
    if (!files) return;
    const made = await cmd('cue.addFiles', { files, afterId: sel[sel.length - 1] });
    if (made && made.length) { S.sel = new Set(made.map((c) => c.id)); update(); }
    return;
  }
  if ((type === 'fade' || type === 'stop') && sel.length === 1) { const t = findCue(sel[0]); if (t) props = { targetId: t.id, name: `${type === 'fade' ? 'Fade' : 'Stop'} ${t.name}` }; }
  const c = await cmd('cue.add', { type, props, afterId: sel[sel.length - 1] });
  if (c) { S.sel = new Set([c.id]); update({ rightTab: 'inspector' }); }
}
function FileMenu() {
  const close = () => update({ modal: null });
  const item = (label, fn, key) => html`<div class="mi" onClick=${() => { close(); fn(); }}>${label}<span class="dim">${key || ''}</span></div>`;
  return html`<div class="menu-back" onClick=${close}><div class="menu" onClick=${(e) => e.stopPropagation()}>
    ${item('New show', () => cmd('show.new'))}
    ${item('Open…', () => cmd('show.open'), 'Ctrl+O')}
    ${item('Save', () => cmd('show.save'), 'Ctrl+S')}
    ${item('Save as…', () => cmd('show.saveAs'))}
    ${item('Collect show (copy all media into one folder)…', async () => { const r = await cmd('show.collect'); if (r) toast(r.error ? 'Collect failed: ' + r.error : `Collected ${r.copied} file(s)${r.missing.length ? `, ${r.missing.length} missing` : ''} → ${r.file}`, r.error ? 'error' : 'info'); })}
    ${item('Renumber all cues', () => cmd('cue.renumber'))}
    <div class="mh">Recent shows</div>
    ${(S.app.recent || []).length === 0 && html`<div class="mi dim">None yet</div>`}
    ${(S.app.recent || []).map((f) => item(basename(f), () => cmd('show.open', { file: f })))}
  </div></div>`;
}
function Toolbar() {
  const a = S.app;
  return html`<div class="toolbar">
    <${Btn} onClick=${() => update({ modal: 'file' })}>File ▾<//>
    <input class="showname" value=${S.doc.name} disabled=${S.locked} onChange=${(e) => cmd('show.rename', { name: e.target.value })} onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); }} title=${S.filePath || 'Not saved yet'} />
    <span class=${'dirty' + (S.dirty ? ' on' : '')} title=${S.dirty ? 'Unsaved changes (autosaved for crash recovery)' : 'Saved'}>${S.dirty ? '● unsaved' : '✓ saved'}</span>
    <span class="tb-sep"></span>
    <span class="dim">Add:</span>
    ${ADD.map((t) => html`<${Btn} cls=${'add t-' + t} onClick=${() => addCue(t)} disabled=${S.locked} title=${'Add ' + TYPE_NAMES[t] + ' cue'}>${TYPE_NAMES[t]}<//>`)}
    <span class="tb-sep"></span>
    <${Btn} onClick=${A.undo} disabled=${!S.canUndo || S.locked} title="Undo">↶<//>
    <${Btn} onClick=${A.redo} disabled=${!S.canRedo || S.locked} title="Redo">↷<//>
    <span class="grow"></span>
    <${Btn} onClick=${async () => { const c = await cmd('show.check'); update({ check: c, bottomTab: 'check' }); toast(c.length ? `Check show: ${c.filter((i) => i.level === 'error').length} error(s), ${c.filter((i) => i.level === 'warn').length} warning(s)` : 'Check show: all good', c.some((i) => i.level === 'error') ? 'error' : 'info'); }}>Check show<//>
    <${Btn} cls=${a.rehearsal ? 'warn on' : ''} onClick=${() => cmd('rehearsal', { on: !a.rehearsal })} title="Rehearsal: nothing goes to the presentation screen">Rehearsal<//>
    <${Btn} cls=${S.locked ? 'danger on' : ''} onClick=${A.lock} title="Lock editing during the show">${S.locked ? 'Locked' : 'Lock'}<//>
    <${Btn} onClick=${() => update({ modal: 'settings' })}>Settings<//>
  </div>`;
}

// ---------- transport ----------
function Transport() {
  const live = S.rt.live;
  const has = live && live.hasPlayer;
  const t = (action, value) => cmd('transport', { action, value });
  const jump = () => { const el = document.getElementById('jump'); const parts = el.value.split(':').map(Number); let s = 0; for (const p of parts) s = s * 60 + (p || 0); t('seek', s); el.value = ''; };
  return html`<div class="transport">
    <button class="go-btn" onClick=${(e) => { e.currentTarget.blur(); A.go(); }} title="GO (Space)">GO</button>
    <div class="tr-col">
      <div class="btnrow">
        <${Btn} onClick=${A.prev} title="Standby previous (↑)">▲ Prev<//>
        <${Btn} onClick=${A.next} title="Standby next (↓)">▼ Next<//>
        <${Btn} cls="warn" onClick=${() => cmd('stop')} title="Fade out and stop everything (Esc)">Stop All<//>
        <${Btn} cls="danger" onClick=${() => cmd('panic')} title="Instant hard stop (Esc twice)">PANIC<//>
      </div>
      <div class="btnrow video-tr">
        <${Btn} onClick=${() => t('restart')} disabled=${!has} title="Jump to start (R)">⏮<//>
        <${Btn} onClick=${() => t('step', -1)} disabled=${!has} title="Frame back (,)">◀❙<//>
        <${Btn} cls=${has && !live.paused ? 'on' : 'go'} onClick=${() => t('toggle')} disabled=${!has} title="Play / pause (P)">${has && !live.paused && live.state === 'running' ? '❚❚ Pause' : '▶ Play'}<//>
        <${Btn} onClick=${() => t('step', 1)} disabled=${!has} title="Frame forward (.)">❙▶<//>
        <${Btn} onClick=${() => t('toEnd')} disabled=${!has} title="Jump to 10 seconds before the end (E)">−10s ⏭<//>
        <input id="jump" class="num" placeholder="m:ss" disabled=${!has} title="Jump to time (Enter)" onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') { jump(); e.target.blur(); } }} />
      </div>
    </div>
    <div class="scrub">
      <input type="range" min="0" max=${has && live.total ? live.total : 1} step="0.01" value=${has ? live.elapsed : 0} disabled=${!has || !live.total}
        onInput=${(e) => t('seek', parseFloat(e.target.value))} onMouseUp=${(e) => e.target.blur()} />
      <div class="scrub-times"><span>${has ? fmt(live.elapsed, true) : '--:--'}</span><span class="dim">${has ? `${live.number} ${live.name}` : 'No media live'}</span><span>${has && live.total ? '-' + fmt(live.remaining, true) : '--:--'}</span></div>
    </div>
  </div>`;
}

// ---------- cue list ----------
function describe(c) {
  const miss = (f) => f && S.missing.includes(f);
  switch (c.type) {
    case 'video': case 'audio': case 'image': return c.file ? html`<span class=${miss(c.file) ? 'missing' : ''}>${miss(c.file) ? '⚠ MISSING ' : ''}${basename(c.file)}</span>` : html`<span class="missing">⚠ no file</span>`;
    case 'colour': return html`<span class="swatch" style=${`background:${c.colour}`}></span> ${c.colour}`;
    case 'playlist': { const bad = c.items.filter((i) => miss(i.file)).length; return html`${c.items.length} clip(s) · ${c.transition}${c.loopPlaylist ? ' · loop' : ''}${bad ? html` <span class="missing">⚠ ${bad} missing</span>` : ''}`; }
    case 'fade': case 'stop': { const t = c.targetId && findCue(c.targetId); return c.targetId ? (t ? `→ ${t.number} ${t.name}` : html`<span class="missing">⚠ target deleted</span>`) : c.type === 'stop' ? '→ all cues' : html`<span class="missing">⚠ no target</span>`; }
    case 'timer': { const t = S.doc.timers.find((x) => x.id === c.timerId); return `${c.timerAction}${t ? ' · ' + t.title : ''}`; }
    case 'group': return c.mode === 'parallel' ? 'fire all together' : 'fire first, then auto-advance';
    default: return c.notes || '';
  }
}
function durationOf(c) {
  if (c.type === 'video' || c.type === 'audio') { const d = (c.outPoint > 0 ? c.outPoint : c.duration) - (c.inPoint || 0); return d > 0 ? fmt(d) + (c.loop === 0 ? ' ∞' : c.loop > 1 ? ` ×${c.loop}` : '') : ''; }
  if (c.type === 'playlist') { const d = c.items.reduce((s, i) => s + Math.max(0, (i.outPoint > 0 ? i.outPoint : i.duration || 0) - (i.inPoint || 0)), 0); return d > 0 ? fmt(d) : ''; }
  if (['wait', 'fade'].includes(c.type)) return fmt(c.duration);
  if (['image', 'colour'].includes(c.type)) return c.duration > 0 ? fmt(c.duration) : '';
  return '';
}

let dragIds = null;
function dropInfo(e, row) {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  const container = row.cue.type === 'group' || (row.cue.type === 'playlist' && !dragIds);
  if (container && y > 0.25 && y < 0.75) return 'into';
  return y < 0.5 ? 'before' : 'after';
}
async function onDrop(e, row) {
  e.preventDefault(); e.stopPropagation();
  const position = S.drop ? S.drop.position : 'after';
  S.drop = null;
  const files = [...(e.dataTransfer.files || [])].map((f) => cs.pathForFile(f)).filter(Boolean);
  if (files.length) {
    if (S.locked) return toast('Show is locked', 'error');
    if (row && row.cue.type === 'playlist' && position === 'into') { cmd('playlist.addFiles', { id: row.cue.id, files }); S.sel = new Set([row.cue.id]); return update(); }
    let afterId = row ? row.cue.id : null;
    if (row && position === 'before') { const rows = flatten(S.doc.cues); const i = rows.findIndex((x) => x.cue.id === row.cue.id); const prev = rows[i - 1]; afterId = prev && prev.depth === row.depth ? prev.cue.id : null; if (!afterId) { const made = await cmd('cue.addFiles', { files }); if (made && made.length) await cmd('cue.move', { ids: made.map((c) => c.id), targetId: row.cue.id, position: 'before' }); return finishAdd(made); } }
    return finishAdd(await cmd('cue.addFiles', { files, afterId }));
  }
  if (dragIds && row) cmd('cue.move', { ids: dragIds, targetId: row.cue.id, position });
  dragIds = null;
  update();
}
function finishAdd(made) { if (made && made.length) { S.sel = new Set(made.map((c) => c.id)); update(); } else toast('No supported media files in the drop', 'error'); }

function CueRow({ row }) {
  const c = row.cue;
  const run = (S.rt.runs || []).find((r) => r.id === c.id);
  const standby = S.rt.playheadId === c.id;
  const drop = S.drop && S.drop.id === c.id ? ' drop-' + S.drop.position : '';
  const cls = `cue c-${c.color || 'none'}${S.sel.has(c.id) ? ' sel' : ''}${standby ? ' standby' : ''}${run ? ' running' : ''}${c.disabled ? ' disabled' : ''}${drop}`;
  const pct = run && run.total > 0 ? Math.min(100, (run.elapsed / run.total) * 100) : 0;
  return html`<div class=${cls} draggable=${!S.locked}
    onClick=${(e) => selectRow(c.id, e)} onDblClick=${() => cmd('playhead', { id: c.id })}
    onDragStart=${(e) => { if (!S.sel.has(c.id)) { S.sel = new Set([c.id]); } dragIds = selIds(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'cues'); }}
    onDragEnd=${() => { dragIds = null; update({ drop: null }); }}
    onDragOver=${(e) => { e.preventDefault(); e.stopPropagation(); const position = dropInfo(e, row); if (!S.drop || S.drop.id !== c.id || S.drop.position !== position) update({ drop: { id: c.id, position } }); }}
    onDrop=${(e) => onDrop(e, row)}>
    ${run && html`<div class="progress" style=${`width:${pct}%`}></div>`}
    <span class="gutter" title="Click to make this the standby cue" onClick=${(e) => { e.stopPropagation(); if (row.depth === 0) cmd('playhead', { id: c.id }); }}>${standby ? '▶' : ''}</span>
    <span class="cnum">${c.number}</span>
    <span class=${'badge t-' + c.type}>${TYPES[c.type]}</span>
    <span class="cname" style=${`padding-left:${row.depth * 18}px`}>${row.depth > 0 ? '└ ' : ''}${c.name || html`<span class="dim">${TYPE_NAMES[c.type]}</span>`}</span>
    <span class="cdesc">${describe(c)}</span>
    <span class="cwait">${c.preWait ? fmt(c.preWait, true) : ''}</span>
    <span class="cdur">${run ? (run.remaining !== null ? '-' + fmt(run.remaining) : run.state) : durationOf(c)}</span>
    <span class="cwait">${c.postWait ? fmt(c.postWait, true) : ''}</span>
    <span class="ccont" title=${c.continue === 'continue' ? 'Auto-continue' : c.continue === 'follow' ? 'Auto-follow' : ''}>${c.continue === 'continue' ? '↓ cont' : c.continue === 'follow' ? '⤓ follow' : ''}${c.type === 'video' && c.startMode === 'first-frame' ? ' ❙▶' : ''}${(c.type === 'video' || c.type === 'playlist') && c.endMode === 'hold' ? ' ▶❙' : ''}</span>
  </div>`;
}
function CueList() {
  const rows = flatten(S.doc.cues);
  return html`<div class="cuelist" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDrop(e, null)} onClick=${(e) => { if (e.target === e.currentTarget) { S.sel = new Set(); update(); } }}>
    <div class="cue head"><span class="gutter"></span><span class="cnum">#</span><span class="badge">Type</span><span class="cname">Name</span><span class="cdesc">Target / media</span><span class="cwait">Pre</span><span class="cdur">Duration</span><span class="cwait">Post</span><span class="ccont">Flow</span></div>
    <div class="cue-rows" onClick=${(e) => { if (e.target === e.currentTarget) { S.sel = new Set(); update(); } }}>
      ${rows.map((r) => html`<${CueRow} key=${r.cue.id} row=${r} />`)}
      ${rows.length === 0 && html`<div class="empty big">Drop video, audio or image files here<br/><span class="dim">or use the Add buttons above</span></div>`}
    </div>
  </div>`;
}

function Recovery() {
  const r = S.app.recovery;
  if (!r || S.dirty) return null;
  return html`<div class="recovery">
    <b>Unsaved work found.</b> “${r.name}” (${r.cues} cues) was autosaved at ${clock(r.savedAt)} on ${new Date(r.savedAt).toLocaleDateString()} but never saved — the app may not have closed cleanly.
    <${Btn} cls="go" onClick=${() => cmd('show.recover')}>Recover it<//><${Btn} onClick=${() => cmd('show.discardRecovery')}>Discard<//>
  </div>`;
}

function App() {
  if (!S.doc) return html`<div class="loading">Starting CueStage…</div>`;
  return html`
    <${StatusBar} />
    <${Toolbar} />
    <${Recovery} />
    <div class="main">
      <div class="col-left"><${Transport} /><${CueList} /></div>
      <div class="col-mid"><${Monitor} /><div class="panel"><div class="panel-head">Inspector</div><${Inspector} /></div></div>
      <div class="col-right panel"><div class="panel-head">Timers</div><${TimersPanel} /></div>
    </div>
    <${Bottom} />
    ${S.modal === 'settings' && html`<${Settings} />`}
    ${S.modal === 'file' && html`<${FileMenu} />`}
    ${S.toast && html`<div class=${'toast ' + S.toast.kind}>${S.toast.text}</div>`}`;
}

setRender(() => render(html`<${App} />`, document.getElementById('root')));

cs.on('doc', (d) => {
  const first = !S.doc;
  Object.assign(S, d);
  for (const id of [...S.sel]) if (!findCue(id)) S.sel.delete(id);
  if (S.editTimer && !S.doc.timers.some((t) => t.id === S.editTimer)) S.editTimer = null;
  update();
  if (first) followPlayhead();
});
cs.on('rt', (rt) => update({ rt }));
cs.on('app', (app) => update({ app }));
cs.on('preview', (p) => { S.preview = p; });
cs.on('log', (l) => { if (l.all) S.log = l.all; else { S.log.push(l.entry); if (S.log.length > 1000) S.log.shift(); } if (S.bottomTab === 'log') update(); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
cs.send('console-ready');
