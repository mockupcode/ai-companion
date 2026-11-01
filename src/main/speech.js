'use strict';
// Blu's voice and ears run in a long-lived Python process (speech/server.py in the
// project's .venv): Wayu-Paxa-TTS-Edge speaks, Typhoon ASR listens. The models load once;
// requests and replies are JSON lines. Without the .venv, Blu falls back to macOS `say`
// and voice input is turned off.
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, config } = require('./config');

const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const SERVER = path.join(ROOT, 'speech', 'server.py');

let speech = null; // { proc, ready: { tts, asr }, pending: Map<id, resolve>, seq, buf }
let usedAt = Date.now();
let tmpSeq = 0;
let send = () => {};

const installed = () => fs.existsSync(VENV_PYTHON);
const asrAvailable = () => config.asr && installed();
const wayuVoice = () => config.ttsEngine === 'wayu' && installed();
const tmpFile = (kind) => path.join(app.getPath('temp'), `blu-${kind}-${process.pid}-${++tmpSeq}.wav`);
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

// 'off' (not installed) | 'asleep' (unloaded) | 'loading' | 'tts' (can talk) | 'ready'
function speechState() {
  if (!speech) return installed() ? 'asleep' : 'off';
  if (speech.ready.tts && (speech.ready.asr || !asrAvailable())) return 'ready';
  return speech.ready.tts ? 'tts' : 'loading';
}

// `notify(channel, data)` reaches the renderer; state changes go out as 'speech-state'.
function init(notify) {
  send = notify;
  // Give the memory back when nobody has talked to Blu for a while; the next request
  // loads the models again, and the renderer shows that it's "waking up".
  setInterval(() => {
    if (!speech || speech.pending.size || !config.speechIdleMinutes) return;
    if (Date.now() - usedAt < config.speechIdleMinutes * 60000) return;
    console.log('speech: unloading after being idle');
    const idle = speech;
    speech = null;
    idle.proc.kill();
    send('speech-state', speechState());
  }, 30000);
}

function start() {
  if (speech || !(asrAvailable() || wayuVoice())) return;
  const env = { ...process.env, BLU_TTS_VOICE: config.ttsVoice, BLU_ASR: asrAvailable() ? '1' : '0' };
  const proc = spawn(VENV_PYTHON, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { proc, ready: {}, pending: new Map(), seq: 0, buf: '' };
  speech = state;
  usedAt = Date.now();
  send('speech-state', speechState());
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ready) {
        state.ready[msg.ready] = true;
        console.log(`speech: ${msg.ready} ready in ${msg.seconds}s`);
        send('speech-state', speechState());
        continue;
      }
      state.pending.get(msg.id)?.(msg);
      state.pending.delete(msg.id);
    }
  });
  proc.stderr.on('data', () => {}); // the model libraries are chatty; drain it
  proc.on('exit', (code) => {
    console.warn(`speech server exited (${code})`);
    for (const resolve of state.pending.values()) resolve({ error: 'ระบบเสียงหยุดทำงาน' });
    if (speech === state) {
      speech = null;
      send('speech-state', speechState());
    }
  });
}

function stop() {
  speech?.proc.kill();
}

// Requests sent before the models finish loading simply wait in the server's queue.
function request(op, payload) {
  usedAt = Date.now();
  start();
  if (!speech) return Promise.resolve({ error: 'ยังไม่ได้ติดตั้งระบบเสียง (npm run setup)' });
  const id = ++speech.seq;
  const pending = speech.pending;
  speech.proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}

// Fallback voice: macOS `say` (Kanya for Thai).
function sayToFile(text) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const voice = /[฀-๿]/.test(text) ? config.voiceTh : config.voiceEn;
  const file = tmpFile('say');
  return new Promise((resolve) => {
    const args = ['-v', voice, '-r', String(config.speechRate), '-o', file, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'];
    const proc = spawn('/usr/bin/say', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => {
      console.warn('say:', err.message);
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) console.warn('say:', stderr.trim() || `exited with ${code}`);
      fs.readFile(file, (err, data) => {
        fs.rm(file, { force: true }, () => {});
        resolve(code === 0 && !err ? data : null);
      });
    });
    proc.stdin.end(text);
  });
}

// Returns { audio: WAV bytes, rate: playback rate } for the renderer to play and lip-sync.
async function synthesize(text) {
  if (wayuVoice()) {
    const file = tmpFile('tts');
    const res = await withTimeout(request('tts', { text, out: file, speed: config.ttsSpeed }), 30000);
    const audio = res?.ok ? await fs.promises.readFile(file).catch(() => null) : null;
    fs.rm(file, { force: true }, () => {});
    if (audio) return { audio, rate: 1 };
    console.warn('wayu tts failed, using say:', res?.error ?? 'timed out');
  }
  const audio = await sayToFile(text);
  // the stock voice gets sped up a touch so it sounds more like a little robot
  return audio ? { audio, rate: 1.1 } : null;
}

async function transcribe(wav) {
  if (!asrAvailable()) return { error: 'ยังไม่ได้ติดตั้ง ASR (npm run setup)' };
  const file = tmpFile('asr');
  fs.writeFileSync(file, Buffer.from(wav));
  const res = await request('asr', { wav: file });
  fs.rm(file, { force: true }, () => {});
  return res.error ? { error: res.error } : { text: res.text };
}

module.exports = { init, start, stop, speechState, asrAvailable, synthesize, transcribe };
