import { html, S, cmd, update, fmt, clock, parseTime, Text, Time, Num, Select, Check, Row, Btn } from './util.js';

const MODES = [['countdown', 'Countdown'], ['countup', 'Count up'], ['until', 'Count down to time of day'], ['clock', 'Time-of-day clock']];
const POSITIONS = [['top-left', 'Top left'], ['top-centre', 'Top centre'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-centre', 'Bottom centre'], ['bottom-right', 'Bottom right']];

// Interpolated display between state pushes from main.
export function timerText(t, now = Date.now()) {
  const cur = t && t.current;
  if (!cur) return '--:--';
  if (cur.mode === 'clock') return clock(now);
  if (!t.running || cur.remainingMs === null && cur.mode !== 'countup') return cur.display;
  return cur.display; // main pushes at 10 Hz to the console, no interpolation needed
}

function TimerEditor({ t }) {
  const set = (patch) => cmd('timerdef.update', { id: t.id, patch });
  return html`<div class="t-edit" onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
    <${Row} label="Title"><${Text} value=${t.title} onCommit=${(v) => set({ title: v })} /><//>
    <${Row} label="Speaker"><${Text} value=${t.speaker} onCommit=${(v) => set({ speaker: v })} /><//>
    <${Row} label="Mode"><${Select} value=${t.mode} options=${MODES} onCommit=${(v) => set({ mode: v })} /><//>
    ${(t.mode === 'countdown' || t.mode === 'countup') && html`<${Row} label="Duration"><${Time} value=${t.duration} onCommit=${(v) => set({ duration: Math.max(0, v) })} /><span class="unit">m:ss</span><//>`}
    ${t.mode === 'until' && html`<${Row} label="Ends at"><${Text} class="short" placeholder="14:30" value=${t.endAt} onCommit=${(v) => set({ endAt: v })} /><span class="unit">24h HH:MM</span><//>`}
    <${Row} label="Auto-start at" hint="Start automatically at this clock time"><${Text} class="short" placeholder="--:--" value=${t.startAt} onCommit=${(v) => set({ startAt: v })} /><span class="unit">HH:MM (blank = manual)</span><//>
    <${Row} label="Link"><${Check} value=${t.linked} onCommit=${(v) => set({ linked: v })} label="Start when the previous timer ends" /><//>
    ${t.mode !== 'clock' && html`
      <${Row} label="Amber / red at"><${Time} value=${t.amber} onCommit=${(v) => set({ amber: Math.max(0, v) })} /><${Time} value=${t.red} onCommit=${(v) => set({ red: Math.max(0, v) })} /><span class="unit">remaining</span><//>
      <${Row} label="At zero"><${Check} value=${t.flashAtZero} onCommit=${(v) => set({ flashAtZero: v })} label="Flash" /><${Check} value=${t.overrun} onCommit=${(v) => set({ overrun: v })} label="Show overrun (negative, red)" /><//>`}
    <div class="notes"><label>Notes</label><textarea disabled=${S.locked} value=${t.notes} onInput=${(e) => set({ notes: e.target.value })} onKeyDown=${(e) => e.stopPropagation()}></textarea></div>
    <div class="btnrow">
      <${Btn} cls="mini" onClick=${() => cmd('timerdef.move', { id: t.id, delta: -1 })} disabled=${S.locked}>▲ Up<//>
      <${Btn} cls="mini" onClick=${() => cmd('timerdef.move', { id: t.id, delta: 1 })} disabled=${S.locked}>▼ Down<//>
      <${Btn} cls="mini danger" onClick=${() => cmd('timerdef.remove', { id: t.id })} disabled=${S.locked}>Delete<//>
      <${Btn} cls="mini" onClick=${() => update({ editTimer: null })}>Done<//>
    </div>
  </div>`;
}

function summary(t) {
  if (t.mode === 'clock') return 'Clock';
  if (t.mode === 'until') return `→ ${t.endAt || '??:??'}`;
  return (t.mode === 'countup' ? '↑ ' : '') + fmt(t.duration);
}

export function TimersPanel() {
  const t = S.rt.timer || {};
  const cur = t.current;
  const ov = S.doc.settings.timerOverlay;
  const setOv = (patch) => cmd('settings.show', { patch: { timerOverlay: patch } });
  const off = t.offsetMs;
  const sendMsg = () => { const el = document.getElementById('msg-input'); if (el.value.trim()) cmd('message.send', { text: el.value.trim(), flash: document.getElementById('msg-flash').checked, bold: document.getElementById('msg-bold').checked }); };
  const custom = (sign) => { const el = document.getElementById('adj-input'); const s = parseTime(el.value); if (s) cmd('timer.add', { seconds: sign * Math.abs(s) }); };
  return html`<div class="panel-body timers">
    <div class=${`t-display ${cur ? cur.colour : 'idle'} ${cur && cur.flash ? 'flash' : ''} ${t.blackout ? 'blackout' : ''}`}>
      <div class="t-title">${cur ? cur.title : 'No timer selected'}${cur && cur.speaker ? html` <span class="dim">· ${cur.speaker}</span>` : ''}</div>
      <div class="t-digits">${timerText(t)}</div>
      <div class="t-meta">
        <span>${t.state === 'running' ? '● RUNNING' : t.state === 'paused' ? '❚❚ PAUSED' : 'READY'}</span>
        <span>${t.next ? `Next: ${t.next.title}` : ''}</span>
        <span class=${off > 30000 ? 'behind' : off < -30000 ? 'ahead' : ''}>${off === null || off === undefined ? '' : Math.abs(off) < 5000 ? 'On time' : `${fmt(Math.abs(off) / 1000)} ${off > 0 ? 'behind' : 'ahead'}`}</span>
      </div>
      ${t.blackout && html`<div class="t-black">BLACKOUT</div>`}
    </div>
    <div class="btnrow big">
      <${Btn} cls=${t.running ? 'warn' : 'go'} onClick=${() => cmd('timer.toggle')}>${t.running ? 'Pause' : 'Start'}<//>
      <${Btn} onClick=${() => cmd('timer.reset')}>Reset<//>
      <${Btn} onClick=${() => cmd('timer.prev')}>◀ Prev<//>
      <${Btn} onClick=${() => cmd('timer.next')}>Next ▶<//>
    </div>
    <div class="btnrow">
      <${Btn} onClick=${() => cmd('timer.add', { seconds: -300 })}>−5m<//>
      <${Btn} onClick=${() => cmd('timer.add', { seconds: -60 })}>−1m<//>
      <${Btn} onClick=${() => cmd('timer.add', { seconds: 60 })}>+1m<//>
      <${Btn} onClick=${() => cmd('timer.add', { seconds: 300 })}>+5m<//>
      <input id="adj-input" class="num" placeholder="m:ss" onKeyDown=${(e) => e.stopPropagation()} />
      <${Btn} onClick=${() => custom(-1)}>−<//><${Btn} onClick=${() => custom(1)}>+<//>
    </div>

    <div class="sub">Message to stage</div>
    <div class="btnrow">
      <input id="msg-input" class="grow" placeholder="Type a message…" onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Enter') sendMsg(); }} />
      <${Btn} cls="go" onClick=${sendMsg}>Send<//>
      <${Btn} cls=${t.message && t.message.text ? 'warn' : ''} onClick=${() => cmd('message.clear')}>Clear<//>
    </div>
    <div class="btnrow">
      <label class="check"><input type="checkbox" id="msg-bold" checked /> Bold</label>
      <label class="check"><input type="checkbox" id="msg-flash" /> Flash</label>
      <${Btn} cls=${t.blackout ? 'danger on' : ''} onClick=${() => cmd('blackout', { on: 'toggle' })}>Blackout timer screens<//>
    </div>
    <div class="chips">${S.doc.settings.messagePresets.map((p) => html`<span class="chip" onClick=${() => cmd('message.send', { text: p, flash: document.getElementById('msg-flash').checked, bold: document.getElementById('msg-bold').checked })}>${p}</span>`)}</div>
    ${t.message && t.message.text && html`<div class="live-msg">On stage: <b>${t.message.text}</b></div>`}

    <div class="sub">Rundown <${Btn} cls="mini" onClick=${async () => { const n = await cmd('timerdef.add', { afterId: S.editTimer }); if (n) update({ editTimer: n.id }); }} disabled=${S.locked}>+ Add timer<//></div>
    <div class="rundown">
      ${S.doc.timers.length === 0 && html`<div class="empty">No timers yet. Add one for each agenda item.</div>`}
      ${S.doc.timers.map((x, i) => { const a = (t.agenda || []).find((r) => r.id === x.id) || {}; return html`
        <div class=${'t-row' + (t.activeId === x.id ? ' active' : '') + (a.actualEnd ? ' done' : '')} onClick=${() => cmd('timer.select', { id: x.id })} onDblClick=${() => cmd('timer.start', { id: x.id })} title="Click to select · double-click to start">
          <span class="idx">${i + 1}</span>
          <span class="t-name">${x.linked ? '↳ ' : ''}${x.title}${x.speaker ? html` <span class="dim">· ${x.speaker}</span>` : ''}</span>
          <span class="dim">${x.startAt ? '@' + x.startAt : a.plannedStart ? clock(a.plannedStart, false) : ''}</span>
          <span class="t-dur">${summary(x)}</span>
          <${Btn} cls="mini" onClick=${(e) => { e.stopPropagation(); update({ editTimer: S.editTimer === x.id ? null : x.id }); }}>✎<//>
        </div>
        ${S.editTimer === x.id && html`<${TimerEditor} t=${x} />`}`; })}
    </div>

    <div class="sub">Timer on presentation output</div>
    <div class="btnrow">
      <${Check} value=${ov.enabled} onCommit=${(v) => setOv({ enabled: v })} label="Show" />
      <${Select} value=${ov.mode} options=${[['overlay', 'Overlay'], ['fullscreen', 'Fullscreen']]} onCommit=${(v) => setOv({ mode: v })} />
      <${Select} value=${ov.position} options=${POSITIONS} onCommit=${(v) => setOv({ position: v })} disabled=${ov.mode !== 'overlay'} />
    </div>
    <div class="btnrow">
      <span class="dim">Size</span><input type="range" min="5" max="40" value=${ov.size} disabled=${S.locked} onInput=${(e) => setOv({ size: +e.target.value })} />
      <span class="dim">Opacity</span><input type="range" min="0.2" max="1" step="0.05" value=${ov.opacity} disabled=${S.locked} onInput=${(e) => setOv({ opacity: +e.target.value })} />
      <${Check} value=${ov.showLabel} onCommit=${(v) => setOv({ showLabel: v })} label="Label" />
    </div>
  </div>`;
}
