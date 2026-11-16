// End-to-end smoke test: launches the app with the test show and drives it over the HTTP API.
// usage: node scripts/smoke.mjs <path-to-app-executable> [extra app args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exe = process.argv[2];
const port = 8080;
const base = `http://127.0.0.1:${port}/api/`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cuestage-smoke-'));
const app = spawn(exe, process.argv.slice(3), {
  env: { ...process.env, CUESTAGE_OPEN: path.resolve('test', 'smoke.cuestage'), CUESTAGE_USERDATA: userData, CUESTAGE_DEBUG: '1' }, stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p) => (await fetch(base + p)).json();
const failures = [];
const canSee = process.platform === 'win32'; // screen capture only works on a real desktop
const expect = (label, cond, detail = '') => {
  if (!canSee && /hold colour|on top|still image|returned to hold|back on hold/.test(label)) { console.log(`SKIP  ${label} (no screen capture here)`); return; } console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${detail}`); if (!cond) failures.push(label); };
const near = (a, b, tol = 40) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const live = async () => { const s = await api('state'); return s.cue.live || {}; };

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); try { await api('state'); up = true; } catch {} }
  expect('app started and web server answers', up);
  if (!up) throw new Error('no server');
  await sleep(3000);
  let dbg = await api('debug');
  console.log('DEBUG', JSON.stringify(dbg, null, 1));
  expect('both video engines running', dbg.layers.every((l) => l.alive), dbg.mpvError || '');
  expect('audio engine running', dbg.audioAlive > 0);
  const hold = [0x20, 0x30, 0x60];
  expect('hold colour visible on output', near(dbg.pixel, hold), JSON.stringify(dbg.pixel));

  await api('go'); await sleep(1500);
  let l = await live();
  expect('video cue live and held on first frame', l.state === 'held' && l.total > 3, JSON.stringify(l));
  dbg = await api('debug');
  expect('first frame is on top of the hold', dbg.pixel && !near(dbg.pixel, hold, 25), JSON.stringify(dbg.pixel));
  console.log('vo:', dbg.layers.map((x) => `${x.vo}/${x.hwdec}`).join(', '));

  await api('go'); await sleep(1500);
  l = await live();
  expect('video playing', l.state === 'running' && l.elapsed > 0.5, JSON.stringify(l));
  await sleep(3500);
  l = await live();
  expect('video holds its last frame', l.state === 'holding', JSON.stringify(l));

  await api('go'); await sleep(1000); // audio cue (auto-continue) + video with fades
  let s = await api('state');
  expect('audio + auto-continued video running together', s.cue.running.length >= 2, s.cue.running.map((r) => `${r.number}:${r.state}`).join(' '));
  await sleep(3500);
  dbg = await api('debug');
  s = await api('state');
  expect('video with "stop at end" returned to hold', near(dbg.pixel, hold) && !s.cue.running.some((r) => r.type === 'video'), JSON.stringify(dbg.pixel));

  await api('go'); await sleep(1200); // still image (pure blue)
  dbg = await api('debug');
  expect('still image visible', near(dbg.pixel, [0, 0, 255], 60), JSON.stringify(dbg.pixel));

  await api('go'); await sleep(4200); // playlist: second clip should be running via crossfade
  l = await live();
  expect('playlist advanced to second clip', /^2\/2/.test(l.sub || ''), JSON.stringify(l));

  await api('timer/start'); await api('timer/add/60'); await api('message?text=SMOKE'); await sleep(600);
  s = await api('state');
  expect('timer running with +1 min', s.timer.running && s.companion.timer_remaining_seconds > 100, String(s.companion.timer_remaining_seconds));
  expect('message set', s.companion.message === 'SMOKE');

  await api('panic'); await sleep(800);
  s = await api('state'); dbg = await api('debug');
  expect('panic stops everything', s.cue.running.length === 0);
  expect('output back on hold after panic', near(dbg.pixel, hold), JSON.stringify(dbg.pixel));
} catch (e) {
  console.log('SMOKE ERROR', e.message);
  failures.push('exception: ' + e.message);
} finally {
  app.kill();
  if (process.platform === 'win32') { try { (await import('node:child_process')).execSync('taskkill /F /IM mpv.exe /T', { stdio: 'ignore' }); } catch {} }
}
console.log(failures.length ? `\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}` : '\nAll smoke checks passed');
process.exit(failures.length ? 1 : 0);
