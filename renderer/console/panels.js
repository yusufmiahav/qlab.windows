import { html, S, cmd, update, toast, fmt, clock, Text, Time, Num, Select, Check, Row, Btn, TYPES } from './util.js';

const dbPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

export function Monitor() {
  const a = S.app, m = S.rt.meters || {};
  const master = S.doc.settings.masterDb || 0;
  return html`<div class="monitor">
    <div class="preview" id="preview-box">
      ${a.outputMode === 'live' && (S.preview && a.settings.livePreview ? html`<img src=${'data:image/jpeg;base64,' + S.preview} />` : html`<div class="preview-msg">Live preview off</div>`)}
    </div>
    <div class=${'out-line ' + (a.outputMode === 'live' ? 'live' : 'off')}>${a.outputMode === 'live' ? '● OUTPUT LIVE on the presentation display' : a.rehearsal ? 'REHEARSAL — picture shown here only, nothing on the presentation screen' : 'PREVIEW ONLY — no separate output display connected'}</div>
    <div class="meters">
      ${[['Video', m.video], ['Audio', m.audio]].map(([label, v]) => html`<div class="meter"><span>${label}</span><div class="bar"><div class=${'fill' + (v > -3 ? ' hot' : v > -12 ? ' warm' : '')} style=${`width:${dbPct(v ?? -90)}%`}></div></div></div>`)}
      <div class="meter"><span>Master</span><input type="range" min="-60" max="6" step="0.5" value=${master} onInput=${(e) => cmd('settings.show', { patch: { masterDb: parseFloat(e.target.value) } })} onDblClick=${() => cmd('settings.show', { patch: { masterDb: 0 } })} title="Double-click to reset to 0 dB" /><span class="db">${master > 0 ? '+' : ''}${master} dB</span></div>
    </div>
  </div>`;
}

function Running() {
  const runs = S.rt.runs || [];
  if (!runs.length) return html`<div class="empty">Nothing running.</div>`;
  return html`<div class="running">${runs.map((r) => html`
    <div class=${'run c-' + (r.color || 'none')}>
      <span class=${'badge t-' + r.type}>${TYPES[r.type]}</span>
      <span class="run-name">${r.number} ${r.name}${r.sub ? html` <span class="dim">› ${r.sub}</span>` : ''}</span>
      <span class=${'state s-' + r.state}>${r.state.toUpperCase()}</span>
      <div class="bar"><div class="fill" style=${`width:${r.total > 0 ? Math.min(100, (r.elapsed / r.total) * 100) : r.state === 'running' ? 100 : 0}%`}></div></div>
      <span class="times">${fmt(r.elapsed, true)}${r.remaining !== null ? html` <b>−${fmt(r.remaining, true)}</b>` : ''}</span>
      <${Btn} cls="mini danger" onClick=${() => cmd('cue.stopId', { id: r.id, fade: true })}>Stop<//>
    </div>`)}</div>`;
}

function Log() {
  const rows = S.log.slice(-300).reverse();
  return html`<div class="logwrap">
    <div class="log-tools"><${Btn} cls="mini" onClick=${async () => { const f = await cmd('log.export'); if (f) toast('Log exported to ' + f); }}>Export CSV…<//><${Btn} cls="mini" onClick=${() => cmd('log.clear')}>Clear<//><span class="dim">A daily CSV is also written automatically to the app's logs folder.</span></div>
    <div class="log">${rows.map((e) => html`<div class=${'log-row l-' + e.category}><span class="ts">${clock(e.ts)}</span><span class="cat">${e.category}</span><span class="txt">${e.text}</span><span class="src">${e.source}</span></div>`)}</div>
  </div>`;
}

function Remote() {
  const a = S.app;
  return html`<div class="remote">
    ${a.webError && html`<div class="error">Web server: ${a.webError}. Change the port in Settings.</div>`}
    ${a.oscError && html`<div class="error">OSC: ${a.oscError}</div>`}
    <div class="qrs">${(a.links || []).map((l) => html`<div class="qr"><img src=${l.qr} /><b>${l.label}</b><a onClick=${() => cmd('openExternal', { url: l.url })}>${l.url}</a></div>`)}</div>
    <div class="remote-info">
      <div><b>Other addresses:</b> ${(a.allUrls || []).join('  ·  ')}</div>
      <div><b>HTTP API:</b> <code>${(a.allUrls || [''])[0]}/api/go</code> · state at <code>/api/state</code> · WebSocket <code>/ws</code></div>
      <div><b>OSC:</b> UDP port <code>${a.settings.oscPort}</code> — e.g. <code>/go</code>, <code>/cue/5/go</code>, <code>/timer/start</code></div>
      <div><b>Controller PIN:</b> ${a.settings.pin ? html`<code>${a.settings.pin}</code> (API calls need <code>?pin=${a.settings.pin}</code>)` : 'none set'}</div>
      <div class="dim">Devices must be on the same network. Full endpoint list: docs/API.md and docs/COMPANION.md.</div>
    </div>
  </div>`;
}

function CheckResults() {
  const c = S.check;
  if (!c) return html`<div class="empty">Press “Check show” to verify media, targets and devices before going live.</div>`;
  if (!c.length) return html`<div class="ok-big">✔ Show check passed — no problems found.</div>`;
  return html`<div class="check-list">${c.map((i) => html`<div class=${'issue ' + i.level} onClick=${() => { if (i.cueId) { S.sel = new Set([i.cueId]); update({ rightTab: 'inspector' }); } }}>
    <span class="lvl">${i.level === 'error' ? 'ERROR' : 'WARN'}</span><span class="who">${i.cue}</span><span>${i.text}</span></div>`)}</div>`;
}

export function Bottom() {
  const tabs = [['running', `Running cues (${(S.rt.runs || []).length})`], ['log', 'Show log'], ['remote', 'Web viewers & remote'], ['check', 'Check show' + (S.check && S.check.length ? ` (${S.check.length})` : '')]];
  return html`<div class="bottom">
    <div class="tabs">${tabs.map(([k, l]) => html`<span class=${'tab' + (S.bottomTab === k ? ' on' : '')} onClick=${() => update({ bottomTab: k })}>${l}</span>`)}</div>
    <div class="bottom-body">${S.bottomTab === 'running' ? html`<${Running} />` : S.bottomTab === 'log' ? html`<${Log} />` : S.bottomTab === 'remote' ? html`<${Remote} />` : html`<${CheckResults} />`}</div>
  </div>`;
}

const ACTION_LABELS = {
  go: 'GO', panic: 'Stop all / panic', prev: 'Standby previous cue', next: 'Standby next cue', playPause: 'Play / pause live video',
  stepBack: 'Frame step back', stepForward: 'Frame step forward', toEnd: 'Jump to 10 s before end', restart: 'Jump to start',
  save: 'Save show', open: 'Open show', undo: 'Undo', redo: 'Redo', duplicate: 'Duplicate cue', delete: 'Delete cue', selectAll: 'Select all cues', group: 'Group selected cues', lock: 'Toggle lock mode',
  timerToggle: 'Timer start / pause', timerNext: 'Next timer', timerPrev: 'Previous timer', timerPlus: 'Timer +1 minute', timerMinus: 'Timer −1 minute', timerReset: 'Timer reset',
  blackout: 'Timer blackout', clearMessage: 'Clear stage message',
};
export const comboOf = (e) => (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.code;
const pretty = (c) => (c || '—').replace(/Key|Digit/g, '').replace('Arrow', '').replace('Escape', 'Esc').replace('BracketRight', ']').replace('BracketLeft', '[').replace('Equal', '=').replace('Minus', '-').replace('Comma', ',').replace('Period', '.');

export function Settings() {
  const a = S.app, s = S.doc.settings, as = a.settings;
  const setShow = (patch) => cmd('settings.show', { patch });
  const setApp = (patch) => cmd('settings.app', { patch });
  const devs = a.devices.map((d) => [d.name, d.description]);
  const capture = (action) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Tab'].includes(e.code)) return;
    setApp({ shortcuts: { ...as.shortcuts, [action]: e.code === 'Backspace' ? '' : comboOf(e) } });
    e.target.blur();
  };
  const pickHold = async () => { const f = await cmd('cue.pickFile', { kind: 'image' }); if (f) setShow({ hold: { type: 'image', file: f } }); };
  return html`<div class="modal-back" onClick=${() => update({ modal: null })}><div class="modal" onClick=${(e) => e.stopPropagation()}>
    <div class="modal-head"><b>Settings</b><${Btn} onClick=${() => update({ modal: null })}>Close<//></div>
    <div class="modal-body cols">
      <div>
        <h4>Presentation output</h4>
        <${Row} label="Output display"><select value=${as.outputDisplayId === null ? '' : String(as.outputDisplayId)} onChange=${(e) => setApp({ outputDisplayId: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">Auto (first non-primary display)</option>${a.displays.map((d) => html`<option value=${String(d.id)} selected=${as.outputDisplayId === d.id}>${d.label}</option>`)}</select>
          <${Btn} onClick=${() => cmd('displays.refresh')}>Refresh<//><//>
        <div class="hint">${a.outputMode === 'live' ? 'Output is live and fullscreen on the selected display.' : 'Output is shown in a small preview window (rehearsal mode, or only one display connected). Displays are re-detected automatically when plugged in.'}</div>
        <${Row} label="Live preview"><label class="check"><input type="checkbox" checked=${as.livePreview} onChange=${(e) => setApp({ livePreview: e.target.checked })} /> Show output thumbnail in the console</label><//>
        <h4>Holding graphic (shown when nothing is playing)</h4>
        <${Row} label="Type"><${Select} value=${s.hold.type} options=${[['colour', 'Colour'], ['image', 'Image']]} onCommit=${(v) => setShow({ hold: { type: v } })} />
          ${s.hold.type === 'colour' ? html`<input type="color" value=${s.hold.colour} disabled=${S.locked} onInput=${(e) => setShow({ hold: { colour: e.target.value } })} />` : html`<${Btn} onClick=${pickHold} disabled=${S.locked}>Choose image…<//>`}<//>
        ${s.hold.type === 'image' && html`<div class=${'file' + (S.missing.includes(s.hold.file) ? ' missing' : '')}>${s.hold.file || 'No image chosen'}</div>`}
        <${Row} label="Stop All fade" hint="Fade time used by Stop All / Esc"><${Time} value=${s.panicFade} onCommit=${(v) => setShow({ panicFade: Math.max(0, v) })} /><span class="unit">s (press Esc twice for an instant cut)</span><//>
        <h4>Audio</h4>
        <${Row} label="Video audio device"><${Select} value=${s.videoAudioDevice} options=${devs} onCommit=${(v) => setShow({ videoAudioDevice: v })} /><//>
        <${Row} label="Audio cue device"><${Select} value=${s.audioCueDevice} options=${devs} onCommit=${(v) => setShow({ audioCueDevice: v })} /><//>
        <div class="hint">Video sound and audio cues can go to different devices; any cue can override its device in the inspector.</div>
        <h4>Network</h4>
        <${Row} label="Web / API port"><${Num} value=${as.httpPort} min=${1} max=${65535} disabled=${false} onCommit=${(v) => setApp({ httpPort: Math.round(v) })} /><//>
        <${Row} label="OSC port (UDP)"><${Num} value=${as.oscPort} min=${0} max=${65535} disabled=${false} onCommit=${(v) => setApp({ oscPort: Math.round(v) })} /><span class="unit">0 = off</span><//>
        <${Row} label="Controller PIN"><${Text} class="short" value=${as.pin} disabled=${false} onCommit=${(v) => setApp({ pin: v.trim() })} /><span class="unit">blank = no PIN</span><//>
        <h4>Message presets</h4>
        <textarea class="presets" disabled=${S.locked} value=${s.messagePresets.join('\n')} onKeyDown=${(e) => e.stopPropagation()} onChange=${(e) => setShow({ messagePresets: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}></textarea>
      </div>
      <div>
        <h4>Keyboard shortcuts</h4>
        <div class="hint">Click a box and press the new key. Backspace clears it.</div>
        <div class="keys">${Object.keys(ACTION_LABELS).map((k) => html`<div class="keyrow"><span>${ACTION_LABELS[k]}</span><input readonly class="key" value=${pretty(as.shortcuts[k])} onKeyDown=${capture(k)} /></div>`)}</div>
        <${Btn} onClick=${() => setApp({ shortcuts: {} })}>Reset shortcuts to defaults<//>
      </div>
    </div>
  </div></div>`;
}
