const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Timers, formatMs } = require('../main/timers');
const { ShowStore } = require('../main/show');
const { parsePacket, encodeMessage, route } = require('../main/osc');
const { routeApi } = require('../main/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cuestage-test-'));
function mkTimers(list) {
  let now = new Date(2026, 0, 5, 10, 0, 0).getTime();
  const t = new Timers({ getList: () => list, now: () => now });
  return { t, adv: (s) => { now += s * 1000; t.tick(); }, at: () => now };
}
const T = (o) => ({ id: o.id, title: o.id, speaker: '', notes: '', mode: 'countdown', duration: 60, endAt: '', startAt: '', linked: false, amber: 20, red: 10, overrun: true, flashAtZero: true, ...o });

test('formatMs rounds countdowns up and overrun down', () => {
  assert.equal(formatMs(90000), '1:30');
  assert.equal(formatMs(500), '0:01');
  assert.equal(formatMs(0), '0:00');
  assert.equal(formatMs(-500), '0:00');
  assert.equal(formatMs(-61000), '-1:01');
  assert.equal(formatMs(3723000), '1:02:03');
});

test('countdown: colours, pause, add/subtract, overrun', () => {
  const { t, adv } = mkTimers([T({ id: 'a' })]);
  t.start();
  adv(30); assert.equal(t.compute().display, '0:30'); assert.equal(t.compute().colour, 'green');
  adv(15); assert.equal(t.compute().colour, 'amber');
  t.pause(); adv(100); assert.equal(t.compute().display, '0:15');
  t.start(); adv(6); assert.equal(t.compute().colour, 'red');
  t.add(60); assert.equal(t.compute().display, '1:09'); assert.equal(t.compute().colour, 'green');
  t.add(-60); adv(19); assert.equal(t.compute().colour, 'over'); assert.equal(t.compute().display, '-0:10');
  t.reset(); assert.equal(t.state, 'idle'); assert.equal(t.compute().display, '1:00');
});

test('no-overrun timers stop at zero', () => {
  const { t, adv } = mkTimers([T({ id: 'a', overrun: false })]);
  t.start(); adv(61); adv(5);
  assert.equal(t.compute().display, '0:00');
  assert.equal(t.state, 'paused');
});

test('linked timer starts when the previous one ends', () => {
  const { t, adv } = mkTimers([T({ id: 'a', duration: 10 }), T({ id: 'b', linked: true })]);
  t.start('a'); adv(9); assert.equal(t.activeId, 'a');
  adv(2); assert.equal(t.activeId, 'b'); assert.equal(t.state, 'running');
});

test('scheduled start fires at clock time; countdown to time of day', () => {
  const { t, adv } = mkTimers([T({ id: 'a', startAt: '10:05' }), T({ id: 'b', mode: 'until', endAt: '10:30' })]);
  adv(299); assert.equal(t.state, 'idle');
  adv(2); assert.equal(t.activeId, 'a'); assert.equal(t.state, 'running');
  t.start('b'); assert.equal(t.compute().display, '24:59');
});

test('count-up and select by 1-based index', () => {
  const { t, adv } = mkTimers([T({ id: 'a' }), T({ id: 'b', mode: 'countup', duration: 0 })]);
  assert.ok(t.select(2)); assert.equal(t.activeId, 'b');
  t.start(); adv(75); assert.equal(t.compute().display, '1:15');
});

test('agenda reports planned vs actual and behind-schedule offset', () => {
  const { t, adv } = mkTimers([T({ id: 'a', startAt: '10:00', duration: 600 }), T({ id: 'b', duration: 300 })]);
  adv(120); t.start('a'); // started 2 minutes late
  const s = t.snapshot();
  assert.equal(Math.round(s.offsetMs / 1000), 120);
  assert.equal(s.agenda[1].plannedStart - s.agenda[0].plannedStart, 600000);
});

test('show store: undo/redo, grouping, relative paths on save/load, collect', () => {
  const dir = tmp();
  const media = path.join(dir, 'clips'); fs.mkdirSync(media);
  const clip = path.join(media, 'intro.mp4'); fs.writeFileSync(clip, 'x');
  const store = new ShowStore({ userData: path.join(dir, 'ud') });
  clearInterval(store.autosaveTimer);
  const [v] = store.addFiles([clip, path.join(dir, 'notes.txt')]);
  assert.equal(store.doc.cues.length, 1); assert.equal(v.type, 'video');
  const a = store.addCue('wait'); const b = store.addCue('memo');
  const g = store.groupCues([a.id, b.id]);
  assert.equal(store.doc.cues.length, 2); assert.equal(g.children.length, 2);
  store.undo(); assert.equal(store.doc.cues.length, 3);
  store.redo(); assert.equal(store.doc.cues.length, 2);
  store.moveCues([v.id], g.id, 'into'); assert.equal(store.cue(g.id).children.length, 3);
  const file = path.join(dir, 'show.cuestage');
  store.save(file);
  assert.match(fs.readFileSync(file, 'utf8'), /"file": "clips\/intro.mp4"/);
  // move the whole folder: relative paths must still resolve
  const moved = dir + '-moved'; fs.renameSync(dir, moved);
  const s2 = new ShowStore({ userData: path.join(moved, 'ud2') }); clearInterval(s2.autosaveTimer);
  s2.load(path.join(moved, 'show.cuestage'));
  assert.equal(s2.cue(v.id).file, path.join(moved, 'clips', 'intro.mp4'));
  const out = path.join(moved, 'collected');
  const res = s2.collect(out);
  assert.equal(res.copied, 1); assert.ok(fs.existsSync(path.join(out, 'media', 'intro.mp4')));
  // lock blocks edits
  s2.locked = true; s2.addCue('memo'); assert.equal(s2.doc.cues.length, 1);
  // autosave + recovery
  s2.locked = false; s2.addCue('memo'); s2.autosave();
  const s3 = new ShowStore({ userData: path.join(moved, 'ud2') }); clearInterval(s3.autosaveTimer);
  assert.equal(s3.recoveryInfo().cues, 2); s3.recover(); assert.equal(s3.doc.cues.length, 2);
});

test('OSC parsing and routing', () => {
  const [m] = parsePacket(encodeMessage('/timer/add', [60]));
  assert.deepEqual(m, { address: '/timer/add', args: [60] });
  assert.deepEqual(route('/cue/12.5/go', []), ['cue.go', { number: '12.5' }]);
  assert.deepEqual(route('/timer/subtract', [30]), ['timer.add', { seconds: -30 }]);
  assert.deepEqual(route('/message', ['WRAP UP', 1]), ['message.send', { text: 'WRAP UP', flash: true, bold: true }]);
  assert.deepEqual(route('/timer/3/start', []), ['timer.start', { id: '3' }]);
  assert.equal(route('/nope', []), null);
});

test('HTTP API routing', () => {
  assert.deepEqual(routeApi(['go'], {}), ['go', {}]);
  assert.deepEqual(routeApi(['cue', '4', 'go'], {}), ['cue.go', { number: '4' }]);
  assert.deepEqual(routeApi(['timer', 'add', '-60'], {}), ['timer.add', { seconds: -60 }]);
  assert.deepEqual(routeApi(['timer', 'subtract'], { seconds: '300' }), ['timer.add', { seconds: -300 }]);
  assert.deepEqual(routeApi(['timer', '2', 'select'], {}), ['timer.select', { id: '2' }]);
  assert.deepEqual(routeApi(['message'], { text: 'Hi', flash: '1' }), ['message.send', { text: 'Hi', flash: true, bold: true }]);
  assert.deepEqual(routeApi(['blackout', 'on'], {}), ['blackout', { on: true }]);
});
