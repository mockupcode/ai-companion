#!/usr/bin/env node
// One-time setup for Blu: Node packages, config.json (which Ollama server and model to
// use), the Python environment for the voice and listening models (downloaded from
// Hugging Face), and the double-Ctrl keyboard helper. Safe to run again.
//
//   npm run setup                  interactive
//   npm run setup -- --yes         no questions; keeps or creates config.json as is
//   npm run setup -- --no-speech   text chat only: skip the ~3 GB of speech models
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const interactive = process.stdin.isTTY && !flags.has('--yes');
const withSpeech = !flags.has('--no-speech');
const CONFIG = path.join(ROOT, 'config.json');
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');

const step = (msg) => console.log(`\n▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const has = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// Subprocesses get no stdin, so nothing they do can swallow the answers typed below.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (res.status !== 0) throw new Error(`\`${cmd} ${args.join(' ')}\` failed`);
}

// Ollama's model list. Node may be kept off the LAN by macOS (Local Network privacy),
// so fall back to Apple's curl, which is exempt.
async function listModels(host) {
  const url = `${host.replace(/\/$/, '')}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return (await res.json()).models.map((m) => m.name);
  } catch {
    const res = spawnSync('/usr/bin/curl', ['-s', '-m', '5', url], { encoding: 'utf8' });
    try {
      return JSON.parse(res.stdout).models.map((m) => m.name);
    } catch {
      return null;
    }
  }
}

async function configure() {
  step('Ollama (the brain)');
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const current = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
  const config = { ...example, ...current };
  if (!interactive) {
    if (!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
    ok(`config.json: ${config.ollamaHost}, model ${config.model}`);
    return config;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const host = (await rl.question(`  Ollama address [${config.ollamaHost}]: `)).trim() || config.ollamaHost;
  config.ollamaHost = /^https?:\/\//.test(host) ? host : `http://${host}`;
  if (!/:\d+\/?$/.test(config.ollamaHost)) config.ollamaHost = config.ollamaHost.replace(/\/$/, '') + ':11434';

  const models = await listModels(config.ollamaHost);
  if (models?.length) {
    models.forEach((m, i) => console.log(`    ${String(i + 1).padStart(2)}. ${m}`));
    const fallback = models.includes(config.model) ? config.model : models[0];
    const pick = (await rl.question(`  Model (number or name) [${fallback}]: `)).trim();
    config.model = /^\d+$/.test(pick) ? (models[Number(pick) - 1] ?? fallback) : pick || fallback;
  } else {
    warn(`couldn't reach ${config.ollamaHost} to list its models; check the address and that Ollama is running`);
    config.model = (await rl.question(`  Model name [${config.model}]: `)).trim() || config.model;
  }
  rl.close();
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
  ok(`saved config.json: ${config.ollamaHost}, model ${config.model}`);
  if (config.model.endsWith(':cloud')) warn('cloud models need `ollama signin` on the Ollama machine');
  return config;
}

function setupSpeech() {
  step('Voice and listening (Wayu TTS + Typhoon ASR, run locally)');
  if (!has('uv')) {
    warn('uv is needed for the speech models. Install it, then run `npm run setup` again:');
    console.log('      brew install uv      (or: curl -LsSf https://astral.sh/uv/install.sh | sh)');
    warn('skipping for now: Blu will use the built-in macOS voice and voice input stays off');
    return false;
  }
  if (!fs.existsSync(VENV_PYTHON)) run('uv', ['venv', '.venv', '--python', '3.11']);
  run('uv', ['pip', 'sync', '--python', VENV_PYTHON, 'speech/requirements.lock']);
  ok('Python packages installed in .venv');
  console.log('  Downloading the models from Hugging Face and testing them (first time ~1 GB)…');
  const test = spawnSync(VENV_PYTHON, ['speech/server.py', '--selftest'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'ignore'] });
  if (test.status !== 0) {
    warn('the speech self-test failed; run `.venv/bin/python speech/server.py --selftest` to see why');
    return false;
  }
  return true;
}

function build() {
  step('Building');
  run('npm', ['run', 'build']);
  if (fs.existsSync(path.join(ROOT, 'build', 'keytap'))) ok('double-Ctrl helper built');
  else warn('double-Ctrl helper skipped (needs Xcode Command Line Tools: xcode-select --install)');
}

async function main() {
  if (process.platform !== 'darwin') {
    warn('Blu is made for macOS (Apple silicon). Text chat may work elsewhere; voice features are untested.');
  }
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) throw new Error(`Node.js 20 or newer is needed (you have ${process.versions.node})`);

  step('Node packages');
  run('npm', ['install', '--no-audit', '--no-fund']);

  await configure();
  const speech = withSpeech && setupSpeech();
  build();

  console.log(`\n✓ Ready. Start Blu with:  npm start`);
  if (speech) {
    console.log('  First start: macOS asks for the microphone, and for Input Monitoring for "keytap" (double-Ctrl).');
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
