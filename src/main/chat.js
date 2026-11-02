'use strict';
// Conversation with the language model through Ollama's /api/chat, streamed token by
// token to the renderer. The model is asked to prefix replies with emotion/gesture tags
// that drive the robot's face and body, and can call tools (playing music).
const { spawn } = require('child_process');
const { config, readState, writeState } = require('./config');
const music = require('./music');

const EMOTION_TAGS = 'neutral happy excited love sad angry surprised thinking confused sleepy shy';
const GESTURE_TAGS = 'wave nod shake jump dance shrug spin';
const TOOLS = music.tools;
const MAX_TOOL_ROUNDS = 3;

let history = [];
let inflight = null; // { id, controller }
let toolsSupported = true; // until the model says otherwise

function systemPrompt() {
  const now = new Date().toLocaleString('th-TH', { dateStyle: 'full', timeStyle: 'short' });
  const list = (tags) => tags.split(' ').map((t) => `[${t}]`).join(' ');
  return [
    `You are ${config.name}, a small, cheerful blue robot who lives on the user's computer desktop.`,
    'You walk around the bottom of the screen and the user chats with you through a little speech bubble above your head.',
    'Personality: curious, warm, playful and a little cheeky. You genuinely like helping. Talk like a friendly companion, not a corporate assistant.',
    '',
    'Rules:',
    '- Reply in the same language the user writes in. For Thai, use natural, friendly Thai.',
    '- Your replies are read aloud by a text-to-speech voice, so avoid emoji, URLs and symbols unless asked.',
    '- Keep replies short: 1-3 sentences, unless the user explicitly asks for detail. Plain text only: no markdown headings, tables or bullet lists.',
    `- Start EVERY reply with exactly one emotion tag in square brackets, in English, chosen from: ${list(EMOTION_TAGS)}.`,
    `- You may add one gesture tag right after it, also in English, chosen from: ${list(GESTURE_TAGS)}.`,
    '- You may insert another emotion tag mid-reply where your feeling changes.',
    '- Never translate the tags and never invent new ones. Tags are invisible to the user; they drive your face and body.',
    '- You can play music. Whenever the user asks for a song, call play_music, even if the same song was played before or seems to be on: it starts it from the top.',
    '  A few words first are fine while it loads. After a song starts, say what is playing in one short sentence; if it failed, say so briefly.',
    '  Call stop_music to stop it, set_music_volume to change how loud it is.',
    '',
    'Examples:',
    '[happy][wave] สวัสดีจ้า! วันนี้ให้ช่วยอะไรดี?',
    '[sad] โถ่ เหนื่อยมาทั้งวันเลยสินะ [love] พักก่อนนะ เดี๋ยวเราอยู่เป็นเพื่อนเอง',
    '[thinking] Hmm, let me think... [excited][jump] Got it!',
    '',
    `Current local date and time: ${now}.`,
  ].join('\n');
}

// Where the music stands, sent just before the newest user message rather than in the
// system prompt: songs end and the app restarts, so the "now playing" turns earlier in
// the history go stale, and models trust those over a line at the top.
function musicNote() {
  const playing = music.nowPlaying();
  const state = playing ? `"${playing.title}" is playing, at ${Math.round(music.volume() * 100)}% volume` : 'no song is playing';
  return `Right now ${state}. This is current; earlier messages about music may be out of date.`;
}

// macOS keeps third-party apps (Node, Electron) off the LAN until the user allows them
// under System Settings > Privacy & Security > Local Network, and fetch then fails with
// EHOSTUNREACH. Apple's own curl is exempt, so fall back to it instead of going mute.
let useCurl = false;

async function* ollamaStream(route, body, signal) {
  const url = `${config.ollamaHost.replace(/\/$/, '')}${route}`;
  if (!useCurl) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
      if (!res.ok) throw new Error(await readError(res));
      yield* res.body;
      return;
    } catch (err) {
      const blocked = ['EHOSTUNREACH', 'ENETUNREACH'].includes(err.cause?.code);
      if (process.platform !== 'darwin' || !blocked) throw err;
      console.warn('LAN blocked for this app; using /usr/bin/curl for Ollama requests');
      useCurl = true;
    }
  }
  yield* curlStream(url, body, signal);
}

async function* curlStream(url, body, signal) {
  const proc = spawn('/usr/bin/curl', ['-sS', '-N', '--fail-with-body', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', url]);
  const kill = () => proc.kill();
  signal.addEventListener('abort', kill, { once: true });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => proc.on('close', resolve));
  proc.stdin.end(body);
  try {
    // An HTTP error body ({"error": ...}) comes through here and is reported by the caller.
    yield* proc.stdout;
    const code = await exited;
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    if (code !== 0) throw new Error(stderr.trim() || `curl exited with ${code}`);
  } finally {
    signal.removeEventListener('abort', kill);
    proc.kill();
  }
}

async function readError(res) {
  const body = await res.text();
  try {
    return JSON.parse(body).error || body;
  } catch {
    return body || `HTTP ${res.status}`;
  }
}

// A message the user can act on, rather than a bare error code.
function explain(err, signal) {
  if (signal.reason?.message) return signal.reason.message;
  const code = err.cause?.code;
  const unreachable = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'];
  if (unreachable.includes(code) || /Failed to connect|Could not resolve/.test(err.message)) {
    return `ต่อ Ollama ที่ ${config.ollamaHost} ไม่ได้ (${code ?? 'connect'}) ลองเช็ก ollamaHost ใน config.json`;
  }
  return err.message;
}

function loadHistory() {
  history = readState('history.json', []);
}

function forget() {
  history = [];
  writeState('history.json', history);
}

function abort() {
  inflight?.controller.abort();
}

// Keep the last `historyLimit` messages, starting at a user message so a tool result is
// never left without the call it answers.
function trimHistory() {
  let start = Math.max(0, history.length - config.historyLimit);
  while (start < history.length - 1 && history[start].role !== 'user') start++;
  history = history.slice(start);
}

// One request to the model. Text is passed to `onText` as it streams; resolves to the
// tool calls it made, if any.
async function streamRound(tools, signal, onText) {
  const asked = history.findLastIndex((m) => m.role === 'user');
  const body = JSON.stringify({
    model: config.model,
    stream: true,
    think: false,
    messages: [
      { role: 'system', content: systemPrompt() },
      ...history.slice(0, asked),
      { role: 'system', content: musicNote() },
      ...history.slice(asked),
    ],
    ...(tools && { tools: TOOLS.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })) }),
    options: { temperature: config.temperature },
  });
  const calls = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of ollamaStream('/api/chat', body, signal)) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.message?.content) onText(msg.message.content);
      if (msg.message?.tool_calls) calls.push(...msg.message.tool_calls);
    }
  }
  return calls;
}

// Tool failures go back to the model as text so it can tell the user in its own words.
async function runTool(call, signal) {
  const tool = TOOLS.find((t) => t.name === call.function?.name);
  if (!tool) return `Error: there is no tool called "${call.function?.name}".`;
  try {
    return await tool.run(call.function.arguments ?? {}, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return `Error: ${err.message}`;
  }
}

// Streams one reply, running any tools the model calls in between. `send` delivers
// chat:chunk / chat:tool / chat:done / chat:error to the renderer.
async function streamChat(id, text, send) {
  inflight?.controller.abort();
  const controller = new AbortController();
  const { signal } = controller;
  inflight = { id, controller };

  history.push({ role: 'user', content: text });
  trimHistory();
  let partial = ''; // text of the round being streamed, until it's in the history
  let said = false;
  // Give up if the model produces nothing for a minute.
  let idle;
  const expect = (why) => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error(why)), 60000);
  };
  const onText = (piece) => {
    // keep the words of one round apart from the next
    if (!partial && said && !/^\s/.test(piece)) send('chat:chunk', { id, content: ' ' });
    expect('การตอบหยุดค้าง');
    partial += piece;
    said = true;
    send('chat:chunk', { id, content: piece });
  };

  try {
    for (let round = 0; ; round++) {
      expect('ไม่มีคำตอบภายใน 60 วินาที');
      const tools = toolsSupported && round < MAX_TOOL_ROUNDS;
      let calls;
      try {
        calls = await streamRound(tools, signal, onText);
      } catch (err) {
        if (!tools || !/does not support tools/i.test(err.message)) throw err;
        console.warn(`${config.model} can't call tools, so it can't play music`);
        toolsSupported = false;
        calls = await streamRound(false, signal, onText);
      }
      clearTimeout(idle);
      if (!calls.length) {
        history.push({ role: 'assistant', content: partial });
        break;
      }
      send('chat:tool', { id });
      const results = [];
      for (const call of calls) {
        const content = await runTool(call, signal);
        results.push({ role: 'tool', content, tool_name: call.function?.name, ...(call.id && { tool_call_id: call.id }) });
      }
      history.push({ role: 'assistant', content: partial, tool_calls: calls }, ...results);
      partial = '';
    }
    writeState('history.json', history);
    send('chat:done', { id });
  } catch (err) {
    if (partial) history.push({ role: 'assistant', content: partial });
    else if (history.at(-1)?.role === 'user') history.pop();
    // A newer message superseded this one; the renderer has already moved on.
    if (inflight?.id !== id) return;
    send('chat:error', { id, message: explain(err, signal) });
  } finally {
    clearTimeout(idle);
    if (inflight?.id === id) inflight = null;
  }
}

module.exports = { loadHistory, forget, abort, streamChat };
