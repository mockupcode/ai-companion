'use strict';
// yt-dlp lives inside the project (build/yt-dlp), not on the system, so any Mac with the
// project can play music: `npm run setup` fetches it, and so does Blu the first time it's
// asked for a song. It's the official macOS "onedir" release; the single-file build
// unpacks itself on every run and takes ~10 s to start.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/yt-dlp/yt-dlp';
const ASSET = 'yt-dlp_macos.zip';

const dirOf = (root) => path.join(root, 'build', 'yt-dlp');
const exe = (root) => path.join(dirOf(root), 'yt-dlp_macos');
const installed = (root) => fs.existsSync(exe(root));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with ${code}`))));
  });
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// The newest release's tag, from where GitHub's "latest" page redirects to.
async function latestTag() {
  const res = await fetch(`${REPO}/releases/latest`, { redirect: 'manual' });
  const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
  if (!tag) throw new Error(`couldn't find the latest yt-dlp release (HTTP ${res.status})`);
  return tag;
}

// Downloads the latest release unless it's already the one installed. Resolves to true
// when a new copy was put in place.
async function update(root) {
  if (process.platform !== 'darwin') throw new Error('the bundled yt-dlp is for macOS only');
  const release = `${REPO}/releases/download/${await latestTag()}`;
  const sums = await (await get(`${release}/SHA2-256SUMS`)).text();
  const sha = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === ASSET)?.[0];
  if (!sha) throw new Error(`${ASSET} is missing from the latest yt-dlp release`);
  const dir = dirOf(root);
  const stamp = path.join(dir, '.sha256');
  if (installed(root) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === sha) return false;

  const zip = Buffer.from(await (await get(`${release}/${ASSET}`)).arrayBuffer());
  if (crypto.createHash('sha256').update(zip).digest('hex') !== sha) throw new Error('the yt-dlp download is corrupt');
  const tmp = `${dir}.new`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zipFile = path.join(tmp, ASSET);
  fs.writeFileSync(zipFile, zip);
  await run('/usr/bin/ditto', ['-x', '-k', zipFile, tmp]);
  fs.rmSync(zipFile);
  fs.writeFileSync(path.join(tmp, '.sha256'), sha);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  // The first run is slow while macOS checks the new binaries; get that over with now.
  await run(exe(root), ['--version']);
  return true;
}

let pending = null;
const install = (root) => (pending ??= update(root).finally(() => (pending = null)));

module.exports = { exe, installed, install };
