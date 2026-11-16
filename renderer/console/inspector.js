import { html, S, cmd, update, toast, flatten, findCue, cueLabel, basename, fmt, TYPE_NAMES, COLOURS, Text, Time, Num, Select, Check, Row, Btn } from './util.js';

const CONTINUE = [['none', 'Do not continue'], ['continue', 'Auto-continue (fire next when this starts)'], ['follow', 'Auto-follow (fire next when this ends)']];
const END_MODES = [['hold', 'Hold last frame'], ['stop', 'Stop to holding graphic'], ['advance', 'Auto-advance to next cue']];
const deviceOptions = (kind) => [['', kind === 'audio' ? 'Show default (audio cues)' : 'Show default (video audio)'], ...S.app.devices.map((d) => [d.name, d.description])];

function Media({ cue, set, kind }) {
  const missing = cue.file && S.missing.includes(cue.file);
  const pick = async () => { const f = await cmd('cue.pickFile', { kind }); if (f) set({ file: f, duration: 0, name: cue.name || basename(f).replace(/\.[^.]+$/, '') }); };
  return html`<${Row} label="File">
    <div class=${'file' + (missing ? ' missing' : '')} title=${cue.file}>${cue.file ? basename(cue.file) : 'No file'}${missing ? ' — MISSING' : ''}</div>
    <${Btn} onClick=${pick} disabled=${S.locked}>Browse…<//>
  <//>`;
}

function Levels({ cue, set, audio }) {
  return html`
    <${Row} label="Volume (dB)"><input type="range" min="-60" max="12" step="0.5" value=${cue.volume} disabled=${S.locked} onInput=${(e) => set({ volume: parseFloat(e.target.value) })} /><${Num} value=${cue.volume} min=${-60} max=${18} onCommit=${(v) => set({ volume: v })} /><//>
    <${Row} label="Fade in / out"><${Time} value=${cue.fadeIn} onCommit=${(v) => set({ fadeIn: Math.max(0, v) })} /><${Time} value=${cue.fadeOut} onCommit=${(v) => set({ fadeOut: Math.max(0, v) })} /><span class="unit">s</span><//>
    <${Row} label="Audio device"><${Select} value=${cue.audioDevice || ''} options=${deviceOptions(audio ? 'audio' : 'video')} onCommit=${(v) => set({ audioDevice: v })} /><//>`;
}

function Trim({ cue, set }) {
  return html`
    <${Row} label="In / out point" hint="Out point 0 = end of file"><${Time} value=${cue.inPoint} onCommit=${(v) => set({ inPoint: Math.max(0, v) })} /><${Time} value=${cue.outPoint} onCommit=${(v) => set({ outPoint: Math.max(0, v) })} /><span class="unit">${cue.duration ? 'of ' + fmt(cue.duration) : ''}</span><//>
    <${Row} label="Loop">
      <${Select} value=${cue.loop === 0 ? 'inf' : cue.loop > 1 ? 'n' : 'once'} options=${[['once', 'Play once'], ['n', 'Play N times'], ['inf', 'Loop forever']]} onCommit=${(v) => set({ loop: v === 'inf' ? 0 : v === 'n' ? 2 : 1 })} />
      ${cue.loop > 1 && html`<${Num} value=${cue.loop} min=${2} max=${999} onCommit=${(v) => set({ loop: Math.round(v) })} />`}
    <//>`;
}

function PlaylistItems({ cue, set }) {
  const items = cue.items;
  const patch = (i, p) => set({ items: items.map((it, j) => (j === i ? { ...it, ...p } : it)) });
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; const a = [...items]; [a[i], a[j]] = [a[j], a[i]]; set({ items: a }); };
  const add = async () => { const f = await cmd('cue.pickFile', { kind: 'any', multi: true }); if (f) cmd('playlist.addFiles', { id: cue.id, files: f }); };
  return html`<div class="pl">
    <div class="pl-head"><b>Items</b> <span class="dim">drop files here or</span> <${Btn} onClick=${add} disabled=${S.locked}>Add files…<//></div>
    ${items.length === 0 && html`<div class="empty">No clips yet.</div>`}
    ${items.map((it, i) => html`<div class=${'pl-item' + (S.missing.includes(it.file) ? ' missing' : '')}>
      <div class="pl-top"><span class="idx">${i + 1}</span><${Text} value=${it.name} onCommit=${(v) => patch(i, { name: v })} />
        <span class="dim">${it.duration ? fmt(it.duration) : ''}</span>
        <${Btn} cls="mini" onClick=${() => move(i, -1)} disabled=${S.locked}>▲<//><${Btn} cls="mini" onClick=${() => move(i, 1)} disabled=${S.locked}>▼<//>
        <${Btn} cls="mini danger" onClick=${() => set({ items: items.filter((x, j) => j !== i) })} disabled=${S.locked}>✕<//></div>
      <div class="pl-sub" title=${it.file}>
        <${Select} value=${it.endMode} options=${[['continue', 'Then continue'], ['hold', 'Then hold (wait for GO)']]} onCommit=${(v) => patch(i, { endMode: v })} />
        <span class="dim">in</span><${Time} value=${it.inPoint} onCommit=${(v) => patch(i, { inPoint: Math.max(0, v) })} />
        <span class="dim">out</span><${Time} value=${it.outPoint} onCommit=${(v) => patch(i, { outPoint: Math.max(0, v) })} />
        <span class="dim">dB</span><${Num} value=${it.volume} min=${-60} max=${12} onCommit=${(v) => patch(i, { volume: v })} />
      </div>
    </div>`)}
  </div>`;
}

function TypeFields({ cue, set }) {
  const others = flatten(S.doc.cues).map((r) => r.cue).filter((c) => c.id !== cue.id);
  const targets = (filter) => [['', '— choose target —'], ...others.filter(filter).map((c) => [c.id, cueLabel(c)])];
  switch (cue.type) {
    case 'video': return html`
      <${Media} cue=${cue} set=${set} kind="video" />
      <${Row} label="On GO"><${Select} value=${cue.startMode} options=${[['first-frame', 'Load to first frame (GO again to play)'], ['play', 'Play immediately']]} onCommit=${(v) => set({ startMode: v })} /><//>
      <${Row} label="At end"><${Select} value=${cue.endMode} options=${END_MODES} onCommit=${(v) => set({ endMode: v })} /><//>
      <${Trim} cue=${cue} set=${set} />
      <${Levels} cue=${cue} set=${set} />
      <${Row} label="Layer" hint="Overlay layer plays WebM video with alpha on top of everything else"><${Select} value=${cue.layer} options=${[['main', 'Main picture'], ['overlay', 'Overlay (alpha WebM, on top)']]} onCommit=${(v) => set({ layer: v })} /><//>`;
    case 'audio': return html`
      <${Media} cue=${cue} set=${set} kind="audio" />
      <${Trim} cue=${cue} set=${set} />
      <${Levels} cue=${cue} set=${set} audio />`;
    case 'image': return html`
      <${Media} cue=${cue} set=${set} kind="image" />
      <${Row} label="Duration" hint="0 = stay until replaced or stopped"><${Time} value=${cue.duration} onCommit=${(v) => set({ duration: Math.max(0, v) })} /><span class="unit">s (0 = until next)</span><//>
      ${cue.duration > 0 && html`<${Row} label="At end"><${Select} value=${cue.endMode} options=${[['hold', 'Stay on screen'], ['stop', 'Back to holding graphic'], ['advance', 'Auto-advance to next cue']]} onCommit=${(v) => set({ endMode: v })} /><//>`}
      <${Row} label="Fade in / out"><${Time} value=${cue.fadeIn} onCommit=${(v) => set({ fadeIn: Math.max(0, v) })} /><${Time} value=${cue.fadeOut} onCommit=${(v) => set({ fadeOut: Math.max(0, v) })} /><span class="unit">s</span><//>`;
    case 'colour': return html`
      <${Row} label="Colour"><input type="color" value=${cue.colour} disabled=${S.locked} onInput=${(e) => set({ colour: e.target.value })} /><${Text} value=${cue.colour} onCommit=${(v) => /^#[0-9a-f]{6}$/i.test(v) && set({ colour: v })} /><//>
      <${Row} label="Duration"><${Time} value=${cue.duration} onCommit=${(v) => set({ duration: Math.max(0, v) })} /><span class="unit">s (0 = until next)</span><//>
      <${Row} label="Fade in / out"><${Time} value=${cue.fadeIn} onCommit=${(v) => set({ fadeIn: Math.max(0, v) })} /><${Time} value=${cue.fadeOut} onCommit=${(v) => set({ fadeOut: Math.max(0, v) })} /><span class="unit">s</span><//>`;
    case 'playlist': return html`
      <${Row} label="On GO"><${Select} value=${cue.startMode} options=${[['first-frame', 'Load first clip to first frame'], ['play', 'Play immediately']]} onCommit=${(v) => set({ startMode: v })} /><//>
      <${Row} label="Between clips"><${Select} value=${cue.transition} options=${[['cut', 'Cut'], ['crossfade', 'Crossfade']]} onCommit=${(v) => set({ transition: v })} />
        ${cue.transition === 'crossfade' && html`<${Time} value=${cue.transitionTime} onCommit=${(v) => set({ transitionTime: Math.max(0, v) })} /><span class="unit">s</span>`}<//>
      <${Row} label="Loop"><${Check} value=${cue.loopPlaylist} onCommit=${(v) => set({ loopPlaylist: v })} label="Loop the whole playlist" /><//>
      <${Row} label="After last clip"><${Select} value=${cue.endMode} options=${END_MODES} onCommit=${(v) => set({ endMode: v })} disabled=${cue.loopPlaylist} /><//>
      <${Levels} cue=${cue} set=${set} />
      <${PlaylistItems} cue=${cue} set=${set} />
      <div class="hint">While a playlist is running under the playhead, GO steps to the next clip.</div>`;
    case 'wait': return html`<${Row} label="Duration"><${Time} value=${cue.duration} onCommit=${(v) => set({ duration: Math.max(0, v) })} /><span class="unit">s</span><//>`;
    case 'fade': return html`
      <${Row} label="Target cue"><${Select} value=${cue.targetId} options=${targets((c) => ['video', 'audio', 'playlist', 'image', 'colour', 'group'].includes(c.type))} onCommit=${(v) => set({ targetId: v })} /><//>
      <${Row} label="Duration"><${Time} value=${cue.duration} onCommit=${(v) => set({ duration: Math.max(0, v) })} /><span class="unit">s</span><//>
      <${Row} label="Volume"><${Check} value=${cue.fadeVolume} onCommit=${(v) => set({ fadeVolume: v })} label="Fade to" /><${Num} value=${cue.volumeTo} min=${-60} max=${12} onCommit=${(v) => set({ volumeTo: v })} disabled=${!cue.fadeVolume} /><span class="unit">dB (-60 = silent)</span><//>
      <${Row} label="Opacity"><${Check} value=${cue.fadeOpacity} onCommit=${(v) => set({ fadeOpacity: v })} label="Fade to" /><${Num} value=${cue.opacityTo} min=${0} max=${100} onCommit=${(v) => set({ opacityTo: v })} disabled=${!cue.fadeOpacity} /><span class="unit">%</span><//>
      <${Row} label="Then"><${Check} value=${cue.stopTarget} onCommit=${(v) => set({ stopTarget: v })} label="Stop the target when the fade completes" /><//>`;
    case 'stop': return html`<${Row} label="Target cue"><${Select} value=${cue.targetId} options=${[['', 'All running cues'], ...others.map((c) => [c.id, cueLabel(c)])]} onCommit=${(v) => set({ targetId: v })} /><//>
      <div class="hint">Targets with a fade-out time fade out; others stop immediately.</div>`;
    case 'timer': return html`
      <${Row} label="Action"><${Select} value=${cue.timerAction} options=${[['start', 'Start timer'], ['select', 'Select timer (do not start)'], ['next', 'Next timer and start'], ['pause', 'Pause current timer'], ['reset', 'Reset current timer']]} onCommit=${(v) => set({ timerAction: v })} /><//>
      ${['start', 'select'].includes(cue.timerAction) && html`<${Row} label="Timer"><${Select} value=${cue.timerId} options=${[['', 'Current timer'], ...S.doc.timers.map((t, i) => [t.id, `${i + 1} · ${t.title}`])]} onCommit=${(v) => set({ timerId: v })} /><//>`}`;
    case 'group': return html`
      <${Row} label="Mode"><${Select} value=${cue.mode} options=${[['parallel', 'Fire all children together'], ['sequence', 'Fire first child, then auto-advance through the rest']]} onCommit=${(v) => set({ mode: v })} /><//>
      <div class="hint">${cue.children.length} cue(s) in this group. Drag cues onto the group row to add them.</div>
      <${Btn} onClick=${() => cmd('cue.ungroup', { id: cue.id })} disabled=${S.locked}>Ungroup<//>`;
    default: return null;
  }
}

export function Inspector() {
  const ids = [...S.sel].filter((id) => findCue(id));
  if (!ids.length) return html`<div class="panel-body empty">Select a cue to edit it.<br/><br/>Drag media files from Explorer into the cue list to create cues.</div>`;
  const cue = findCue(ids[0]);
  const multi = ids.length > 1;
  const set = (patch) => cmd('cue.update', multi ? { ids, patch } : { id: cue.id, patch });
  return html`<div class="panel-body inspector">
    <div class="insp-title"><span class=${'badge t-' + cue.type}>${multi ? ids.length + ' cues' : TYPE_NAMES[cue.type]}</span>${S.locked && html`<span class="lockmsg">Locked – unlock to edit</span>`}</div>
    ${!multi && html`<${Row} label="Number / name"><${Text} class="short" value=${cue.number} onCommit=${(v) => set({ number: v })} /><${Text} value=${cue.name} onCommit=${(v) => set({ name: v })} /><//>`}
    <${Row} label="Colour"><div class="swatches">${COLOURS.map((c) => html`<span class=${`sw c-${c}` + (cue.color === c ? ' on' : '')} title=${c} onClick=${() => !S.locked && set({ color: c })}></span>`)}</div><//>
    <${Row} label="Pre / post wait"><${Time} value=${cue.preWait} onCommit=${(v) => set({ preWait: Math.max(0, v) })} /><${Time} value=${cue.postWait} onCommit=${(v) => set({ postWait: Math.max(0, v) })} /><span class="unit">s</span><//>
    <${Row} label="Continue"><${Select} value=${cue.continue} options=${CONTINUE} onCommit=${(v) => set({ continue: v })} /><//>
    <${Row} label=""><${Check} value=${cue.disabled} onCommit=${(v) => set({ disabled: v })} label="Disabled (skipped by GO)" /><//>
    ${!multi && html`<div class="sep"></div><${TypeFields} cue=${cue} set=${set} />`}
    ${!multi && html`<div class="sep"></div><div class="notes"><label>Notes</label><textarea disabled=${S.locked} value=${cue.notes} onInput=${(e) => set({ notes: e.target.value })} onKeyDown=${(e) => e.stopPropagation()}></textarea></div>`}
  </div>`;
}
