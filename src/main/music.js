'use strict';
// The model's play_music / stop_music tools. yt-dlp finds the song on YouTube and
// downloads its audio into a cache in userData; the renderer plays it (Blu dances along
// and turns it down while it talks or listens).
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');
const ytdlp = require('./ytdlp');

const KEEP = 40; // songs kept in the cache
const MAX_MINUTES = 15; // skip hour-long mixes
const TIMEOUT = 180000;
const MIME = { webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', opus: 'audio/ogg', ogg: 'audio/ogg' };

let send = () => {};
let hooks = { changed() {}, volume: () => 1, setVolume() {} };
let current = null; // { title, duration } of the song playing
let updated = false; // yt-dlp was already checked for a newer release after a failure

const cacheDir = () => path.join(app.getPath('userData'), 'music');
const indexFile = () => path.join(cacheDir(), 'index.json');
// "The TOYS ลาลาลอย" and "ลาลาลอย the toys" are the same request
const keyOf = (query) => query.toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// `notify(channel, data)` reaches the renderer. The music volume is one of the menu
// settings, so it's read and set through `hooks`; `hooks.changed()` runs when the song changes.
function init(notify, appHooks) {
  send = notify;
  hooks = appHooks;
}

function status(text) {
  send('music', { op: 'status', text });
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
  } catch {
    return {};
  }
}

// A song fetched before for the same request, if it's still in the cache.
function cached(query) {
  const song = readIndex()[keyOf(query)];
  if (!song || !fs.existsSync(song.file)) return null;
  const now = new Date();
  fs.utimesSync(song.file, now, now); // recently played songs stay in the cache longest
  return song;
}

function remember(query, song) {
  const index = { ...readIndex(), [keyOf(query)]: song };
  const files = fs
    .readdirSync(cacheDir())
    .filter((f) => f !== 'index.json')
    .map((f) => path.join(cacheDir(), f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files.slice(KEEP)) fs.rmSync(file, { force: true });
  for (const [key, s] of Object.entries(index)) if (!fs.existsSync(s.file)) delete index[key];
  fs.writeFileSync(indexFile(), JSON.stringify(index));
}

// Searches YouTube (or opens a link) and downloads the first match's audio.
// Resolves to { id, title, duration, filepath }, or null when nothing matched.
function download(query, signal) {
  signal.throwIfAborted();
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-progress',
    '-f', 'bestaudio/best',
    '--match-filter', `duration<=${MAX_MINUTES * 60} & !is_live`,
    '--max-downloads', '1',
    // YouTube needs a JavaScript runtime; Electron doubles as Node for that
    '--js-runtimes', `node:${process.execPath}`,
    '-o', path.join(cacheDir(), '%(id)s.%(ext)s'),
    '--print', 'after_move:%(.{id,title,duration,filepath})j',
    '--no-simulate',
    /^https?:\/\//.test(query) ? query : `ytsearch5:${query}`,
  ];
  const proc = spawn(ytdlp.exe(ROOT), args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  let timedOut = false;
  const kill = () => proc.kill();
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, TIMEOUT);
  signal.addEventListener('abort', kill, { once: true });
  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
      if (timedOut) return reject(new Error(`yt-dlp took longer than ${TIMEOUT / 60000} minutes`));
      const line = stdout.trim().split('\n').pop();
      if (line) return resolve(JSON.parse(line));
      // 101 means it stopped after --max-downloads; finishing without output, nothing matched
      if (code === 0 || code === 101) return resolve(null);
      const error = stderr.split('\n').filter((l) => l.startsWith('ERROR:')).pop();
      reject(new Error(error?.replace(/^ERROR:\s*/, '') || `yt-dlp exited with ${code}`));
    });
  });
}

async function fetchSong(query, signal) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  if (!ytdlp.installed(ROOT)) {
    status('กำลังติดตั้ง yt-dlp ไว้ในโปรเจกต์ (ครั้งแรก)…');
    await ytdlp.install(ROOT);
  }
  status(`กำลังหาเพลง “${query}”…`);
  try {
    return await download(query, signal);
  } catch (err) {
    if (signal.aborted || updated) throw err;
    // YouTube changes often and older yt-dlp releases stop working: update and retry once
    updated = true;
    status('กำลังอัปเดต yt-dlp…');
    if (!(await ytdlp.install(ROOT).catch(() => false))) throw err;
    status(`กำลังหาเพลง “${query}”…`);
    return download(query, signal);
  }
}

async function play(query, signal) {
  query = String(query ?? '').trim();
  if (!query) return 'Error: no song was given.';
  let song = cached(query);
  if (!song) {
    let found;
    try {
      found = await fetchSong(query, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn('music:', err.message);
      return `Error: couldn't get the song (${err.message}).`;
    } finally {
      status('');
    }
    if (!found) return `Error: found nothing on YouTube for "${query}" (songs over ${MAX_MINUTES} minutes and live streams are skipped).`;
    song = { id: found.id, title: found.title, duration: found.duration, file: found.filepath };
    remember(query, song);
  }
  const data = await fs.promises.readFile(song.file);
  current = { title: song.title, duration: song.duration };
  send('music', { op: 'play', title: song.title, mime: MIME[path.extname(song.file).slice(1)] ?? '', data });
  hooks.changed();
  return `Now playing "${song.title}" (${clock(song.duration)}).`;
}

function stop() {
  if (!current) return 'Nothing is playing.';
  const { title } = current;
  current = null;
  send('music', { op: 'stop' });
  hooks.changed();
  return `Stopped "${title}".`;
}

// percent of the song's own level: 100 is normal, up to 200
function setVolume(percent) {
  const v = Math.round(Math.min(200, Math.max(10, Number(percent) || 100)) / 10) / 10;
  hooks.setVolume(v);
  return `Music volume is now ${Math.round(v * 100)}%.`;
}

// The renderer reports that the song finished (or couldn't play).
function ended() {
  current = null;
  hooks.changed();
}

const nowPlaying = () => current;
const volume = () => hooks.volume();

const tools = [
  {
    name: 'play_music',
    description:
      'Find a song on YouTube and play it on the computer speakers, replacing any song already playing. ' +
      'Use it whenever the user asks you to play or put on a song or some music. ' +
      'If they only name a mood, genre or artist, pick a fitting well-known song yourself.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search YouTube for: the song title and artist, e.g. "ลาลาลอย The TOYS". A YouTube link also works.' },
      },
      required: ['query'],
    },
    run: ({ query }, signal) => play(query, signal),
  },
  {
    name: 'stop_music',
    description: 'Stop the song that is playing.',
    parameters: { type: 'object', properties: {} },
    run: () => stop(),
  },
  {
    name: 'set_music_volume',
    description: 'Make the music louder or quieter.',
    parameters: {
      type: 'object',
      properties: {
        percent: { type: 'number', description: 'Volume in percent of normal: 100 is normal, 50 half as loud, 200 the loudest. Go up or down by about 30 when asked for a bit louder or quieter.' },
      },
      required: ['percent'],
    },
    run: ({ percent }) => setVolume(percent),
  },
];

module.exports = { init, tools, stop, ended, nowPlaying, volume };
