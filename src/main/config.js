'use strict';
// Settings live in config.json at the project root. Only `ollamaHost` and `model` are
// needed (see config.example.json); everything else has a sensible default below.
// Per-user state (menu toggles, chat history) is kept in Electron's userData folder.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const DEFAULTS = {
  ollamaHost: 'http://localhost:11434',
  model: 'deepseek-v4.1-flash:cloud',
  name: 'Blu',
  scale: 0.9, // robot size on screen
  temperature: 0.8,
  historyLimit: 24, // messages of conversation the model remembers

  shortcut: 'CommandOrControl+Shift+Space', // open the chat box
  talkShortcut: 'CommandOrControl+Shift+M', // talk by voice
  doubleCtrl: true, // double-tap left Control to talk (needs Input Monitoring)

  asr: true, // speech-to-text with Typhoon ASR
  ttsEngine: 'wayu', // 'wayu' (Wayu-Paxa-TTS-Edge) or 'say' (built-in macOS voices)
  ttsVoice: 'f_teen_bright',
  ttsSpeed: 1.0,
  speechIdleMinutes: 10, // unload the speech models (~2 GB RAM) after this long unused; 0 = never

  voiceTh: 'Kanya', // fallback `say` voices
  voiceEn: 'Samantha',
  speechRate: 185,
};

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('config.json not found, using defaults (run `npm run setup`)');
    else console.error('config.json:', err.message);
    return { ...DEFAULTS };
  }
}

const config = loadConfig();

function readState(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeState(name, data) {
  fs.writeFile(path.join(app.getPath('userData'), name), JSON.stringify(data), (err) => {
    if (err) console.error(`saving ${name}:`, err.message);
  });
}

module.exports = { ROOT, config, readState, writeState };
