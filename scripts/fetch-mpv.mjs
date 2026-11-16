// Downloads a current 64-bit Windows build of mpv into vendor/mpv (bundled into the app by electron-builder).
// Source: https://github.com/shinchiro/mpv-winbuild-cmake/releases (the builds linked from mpv.io).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dest = path.resolve('vendor', 'mpv');
if (fs.existsSync(path.join(dest, 'mpv.exe')) && !process.argv.includes('--force')) {
  console.log('vendor/mpv/mpv.exe already present (use --force to refresh)');
  process.exit(0);
}
const headers = { 'User-Agent': 'cuestage-build', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const releases = await (await fetch('https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases?per_page=5', { headers })).json();
if (!Array.isArray(releases)) throw new Error('Could not list mpv releases: ' + JSON.stringify(releases).slice(0, 300));
let asset = null;
for (const rel of releases) {
  asset = (rel.assets || []).find((a) => /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/.test(a.name));
  if (asset) break;
}
if (!asset) throw new Error('No mpv-x86_64 build found in the latest releases');
console.log('Downloading', asset.name);
fs.mkdirSync(dest, { recursive: true });
const archive = path.resolve('vendor', asset.name);
const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'cuestage-build' } });
if (!res.ok) throw new Error('Download failed: ' + res.status);
fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

const sevenZip = process.platform === 'win32' ? '7z' : (process.env.SEVENZIP || '7z');
execFileSync(sevenZip, ['x', '-y', `-o${dest}`, archive], { stdio: 'inherit' });
fs.rmSync(archive);
for (const junk of ['installer', 'doc', 'updater.bat', 'mpv.com']) fs.rmSync(path.join(dest, junk), { recursive: true, force: true });
if (!fs.existsSync(path.join(dest, 'mpv.exe'))) throw new Error('mpv.exe missing after extraction');
fs.writeFileSync(path.join(dest, 'SOURCE.txt'), `mpv build: ${asset.name}\n${asset.browser_download_url}\nmpv is licensed under GPLv2+/LGPLv2.1+ – https://mpv.io\n`);
console.log('mpv ready in', dest);
