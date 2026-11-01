import { TagStream, EMOTIONS, GESTURES } from './tags.js';
import { clamp, damp } from './springs.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const split = (text) => Array.from(graphemes.segment(text), (s) => s.segment);

// Where to cut streamed text into utterances for speech: after a sentence end that is
// followed by whitespace, or at the first space past 40 characters (Thai separates
// phrases with spaces rather than punctuation).
function utteranceEnd(s) {
  for (let i = 0; i < s.length - 1; i++) {
    if ('.!?…\n'.includes(s[i]) && /\s/.test(s[i + 1])) return i + 1;
    if (s[i] === ' ' && i >= 40) return i + 1;
  }
  return -1;
}

// Speech bubble + input pill. Replies stream in from the model but are revealed at a
// steady pace (typewriter, or in step with the spoken audio when voice is on) so the
// mouth, emotions and text stay in sync.
export class ChatUI {
  /**
   * @param host { name, onEmotion(name, seconds), onGesture(name), onFirstText(), onOpen(), onChars(n), onShow() }
   * @param voice optional Voice; when enabled, replies are spoken
   */
  constructor(api, host, voice) {
    this.api = api;
    this.host = host;
    this.voice = voice;
    this.utter = '';
    this.typedAt = 0;
    this.wrap = document.getElementById('bubble-wrap');
    this.pop = this.wrap.querySelector('.pop');
    this.scroll = this.wrap.querySelector('.scroll');
    this.youEl = this.wrap.querySelector('.you');
    this.textEl = this.wrap.querySelector('.text');
    this.tail = this.wrap.querySelector('.tail');
    this.form = document.getElementById('ask');
    this.input = document.getElementById('ask-input');
    this.input.placeholder = `คุยกับ ${host.name}…`;
    this.mic = document.getElementById('mic');
    this.mic.hidden = !host.canListen;
    this.mic.addEventListener('click', () => host.onMic());
    this.listenState = 'off';
    this.statusEl = this.wrap.querySelector('.status');
    this.status = '';

    this.id = 0;
    this.busy = false;
    this.streamDone = true;
    this.queue = [];
    this.budget = 0;
    this.raw = '';
    this.visible = false;
    this.isOpen = false;
    this.hovered = false;
    this.talking = false;
    this.hideAt = 0;
    this.bubblePos = null;
    this.formPos = null;

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.send(this.input.value);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('input', () => (this.typedAt = performance.now()));
    api.on('chat:chunk', ({ id, content }) => {
      if (id === this.id) this.parser.push(content);
    });
    api.on('chat:done', ({ id }) => {
      if (id !== this.id) return;
      this.parser.end();
      this.flush();
      this.streamDone = true;
    });
    api.on('chat:error', ({ id, message }) => {
      if (id !== this.id) return;
      this.parser.end();
      this.enqueueTags(['sad']);
      this.enqueueText(`${this.raw ? '\n' : ''}อุ๊ย ติดต่อสมองไม่ได้ 😵 (${message})`);
      this.flush();
      this.streamDone = true;
    });
  }

  send(text) {
    text = text.trim();
    if (!text) return;
    if (this.busy) this.api.abort();
    this.input.value = '';
    this.begin(text);
    this.host.onEmotion('thinking', 120);
    this.api.chat(this.id, text);
  }

  // Scripted lines (greetings, reactions) use the same tags and typewriter as replies.
  say(line) {
    if (this.busy) return;
    this.begin('');
    this.parser.push(line);
    this.parser.end();
    this.flush();
    this.streamDone = true;
  }

  begin(userText) {
    this.id++;
    this.voice?.stop();
    this.utter = '';
    this.busy = true;
    this.streamDone = false;
    this.queue = [];
    this.budget = 0;
    this.raw = '';
    this.gotText = false;
    this.parser = new TagStream(
      (text) => this.enqueueText(text),
      (tags) => this.enqueueTags(tags),
    );
    this.youEl.textContent = userText;
    this.youEl.hidden = !userText;
    this.textEl.textContent = '';
    this.wrap.classList.add('waiting'); // dots until the first words (or voice) arrive
    this.show();
  }

  enqueueText(text) {
    if (!this.voice?.enabled) {
      this.queue.push({ chars: split(text) });
      return;
    }
    // Speak in short utterances so the voice starts long before the reply is complete.
    this.utter += text;
    let cut;
    while ((cut = utteranceEnd(this.utter)) > 0) {
      this.pushUtterance(this.utter.slice(0, cut));
      this.utter = this.utter.slice(cut);
    }
  }

  pushUtterance(text) {
    // synthesis starts now, while earlier utterances are still playing
    this.queue.push(text.trim() ? { chars: split(text), audio: this.voice.synth(text) } : { chars: split(text) });
  }

  flush() {
    if (this.utter) this.pushUtterance(this.utter);
    this.utter = '';
  }

  enqueueTags(tags) {
    this.flush(); // so the emotion changes exactly between the words it was placed between
    this.queue.push({ tags });
  }

  pendingChars() {
    return this.queue.reduce((n, item) => n + (item.chars ? item.chars.length : 0), 0);
  }

  applyTags(tags) {
    for (const tag of tags) {
      if (EMOTIONS.includes(tag)) this.host.onEmotion(tag, 8 + this.pendingChars() / 25);
      else if (GESTURES.includes(tag)) this.host.onGesture(tag);
    }
  }

  append(s) {
    if (!this.gotText) {
      this.gotText = true;
      this.wrap.classList.remove('waiting');
      this.host.onFirstText();
    }
    this.raw += s;
    // strip stray markdown and the double spaces left where mid-sentence tags were
    this.textEl.textContent = this.raw.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/ {2,}/g, ' ');
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  update(dt, now) {
    // Typewriter speeds up when a long reply is backing up, so it never falls far behind.
    if (this.queue.some((item) => item.chars && !item.audio)) this.budget += (28 + this.pendingChars() * 1.2) * dt;
    else this.budget = 0;
    let speaking = false;
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.tags) {
        this.queue.shift();
        this.applyTags(item.tags);
        continue;
      }
      if (item.audio) {
        if (!item.started) {
          if (!item.pending) {
            item.pending = true;
            item.audio.then((buffer) => Object.assign(item, { buffer, ready: true }));
          }
          if (!item.ready) break;
          item.started = true;
          if (!item.buffer) {
            delete item.audio; // couldn't speak this one: fall back to the typewriter
            continue;
          }
          item.playback = this.voice.play(item.buffer);
          item.shown = 0;
        }
        // reveal the words a little ahead of the voice speaking them
        speaking = true;
        const total = item.chars.length;
        const want = Math.min(total, Math.ceil(total * item.playback.progress() * 1.1));
        if (want > item.shown) {
          this.append(item.chars.slice(item.shown, want).join(''));
          item.shown = want;
        }
        if (!item.playback.ended) break;
        if (item.shown < total) this.append(item.chars.slice(item.shown).join(''));
        this.queue.shift();
        continue;
      }
      if (this.budget < 1) break;
      const n = Math.min(item.chars.length, Math.floor(this.budget));
      this.append(item.chars.splice(0, n).join(''));
      this.host.onChars(n);
      this.budget -= n;
      if (!item.chars.length) this.queue.shift();
    }
    this.talking = speaking || this.queue.some((item) => item.chars && !item.audio);
    this.level = speaking ? this.voice.meter() : null;

    if (this.busy && this.streamDone && !this.queue.length) {
      this.busy = false;
      this.wrap.classList.remove('waiting');
      this.hideAt = now + 9000 + this.raw.length * 60;
    }
    if (this.visible && !this.busy && !this.isOpen && !this.hovered && now > this.hideAt) this.hide();
  }

  show() {
    if (!this.visible) this.host.onShow();
    this.visible = true;
    this.wrap.classList.add('show');
  }

  hide() {
    this.visible = false;
    this.wrap.classList.remove('show');
  }

  open() {
    this.isOpen = true;
    this.form.classList.add('show');
    if (this.raw) this.show();
    this.api.focus();
    setTimeout(() => this.input.focus(), 40);
    this.host.onOpen();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.form.classList.remove('show');
    this.input.blur();
    this.hideAt = Math.max(this.hideAt, performance.now() + 5000);
  }

  // 'off' | 'listening' | 'transcribing'
  setListening(state) {
    this.listenState = state;
    this.form.classList.toggle('listening', state === 'listening');
    this.mic.classList.toggle('on', state === 'listening');
    this.input.placeholder =
      state === 'listening' ? 'กำลังฟัง… พูดได้เลย' : state === 'transcribing' ? 'กำลังแปลงเสียงเป็นข้อความ…' : `คุยกับ ${this.host.name}…`;
  }

  // A progress note shown under the waiting dots (and in the input while transcribing).
  setStatus(text) {
    text ||= '';
    if (text === this.status) return;
    this.status = text;
    this.statusEl.textContent = text;
    if (this.listenState === 'transcribing') this.input.placeholder = text || 'กำลังแปลงเสียงเป็นข้อความ…';
  }

  setMicLevel(level) {
    this.mic.style.setProperty('--lvl', level.toFixed(2));
  }

  // Keep the bubble above the robot's antenna and the input pill beside its chest.
  layout(rx, ry, ppu, dt) {
    const W = innerWidth;
    const H = innerHeight;
    if (this.visible) {
      const bw = this.pop.offsetWidth;
      const bh = this.pop.offsetHeight;
      const ax = rx;
      const ay = ry - 2.6 * ppu;
      const bx = clamp(ax - bw / 2, 10, W - bw - 10);
      const by = Math.max(8, ay - bh - 14);
      this.bubblePos ??= { x: bx, y: by };
      this.bubblePos.x = damp(this.bubblePos.x, bx, 16, dt);
      this.bubblePos.y = damp(this.bubblePos.y, by, 16, dt);
      const tailX = clamp(ax - this.bubblePos.x, 24, bw - 24);
      this.wrap.style.transform = `translate3d(${this.bubblePos.x}px, ${this.bubblePos.y}px, 0)`;
      this.tail.style.left = `${tailX}px`;
      this.pop.style.transformOrigin = `${tailX}px 100%`;
    }
    if (this.isOpen) {
      const fw = this.form.offsetWidth;
      const fh = this.form.offsetHeight;
      const onRight = rx < W / 2;
      const fx = clamp(onRight ? rx + 0.8 * ppu : rx - 0.8 * ppu - fw, 10, W - fw - 10);
      const fy = clamp(ry - 1.15 * ppu - fh / 2, 10, H - fh - 10);
      this.formPos ??= { x: fx, y: fy };
      this.formPos.x = damp(this.formPos.x, fx, 14, dt);
      this.formPos.y = damp(this.formPos.y, fy, 14, dt);
      this.form.style.transform = `translate3d(${this.formPos.x}px, ${this.formPos.y}px, 0)`;
    }
  }

  hit(x, y) {
    const inside = (el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    this.hovered = this.visible && inside(this.pop);
    return this.hovered || (this.isOpen && inside(this.form));
  }

  // Roughly where the text caret is, so the robot can watch you type.
  caretPoint() {
    const r = this.input.getBoundingClientRect();
    this.measure ??= document.createElement('canvas').getContext('2d');
    this.measure.font = getComputedStyle(this.input).font;
    const w = this.measure.measureText(this.input.value).width;
    return { x: r.left + Math.min(w, r.width), y: r.top + r.height / 2 };
  }

  inputCenter() {
    const r = this.form.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
}
