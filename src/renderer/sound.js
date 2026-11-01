import { clamp, pick, rand } from './springs.js';

// All sounds are synthesised with Web Audio (no asset files): little chirps for
// interactions and an Animal-Crossing-style babble while text types out.

const BABBLE_PITCH = {
  neutral: 520, happy: 640, excited: 760, love: 600, sad: 380, angry: 300,
  surprised: 700, thinking: 470, confused: 500, sleepy: 360, shy: 580,
};
const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2]; // major pentatonic-ish steps

export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.lastBabble = 0;
  }

  get ac() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      // soften the square waves so the chirps stay cute rather than harsh
      this.soft = this.ctx.createBiquadFilter();
      this.soft.type = 'lowpass';
      this.soft.frequency.value = 2400;
      this.soft.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // let the audio thread sleep when nothing has played for a while
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.hold && this.ctx.state === 'running') this.ctx.suspend();
    }, 5000);
    return this.ctx;
  }

  tone(f0, f1, dur, { type = 'sine', vol = 0.08, delay = 0 } = {}) {
    if (!this.enabled) return;
    const ac = this.ac;
    const t = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.015, dur / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(type === 'sine' ? this.master : this.soft);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  play(name) {
    switch (name) {
      case 'boop':
        this.tone(520, 900, 0.09, { type: 'triangle', vol: 0.1 });
        break;
      case 'pop':
        this.tone(650, 1250, 0.07, { vol: 0.07 });
        break;
      case 'pickup':
        this.tone(380, 950, 0.2, { type: 'triangle', vol: 0.09 });
        break;
      case 'whee':
        this.tone(450, 1500, 0.5, { vol: 0.08 });
        break;
      case 'land':
        this.tone(170, 80, 0.14, { vol: 0.16 });
        break;
      case 'boing':
        this.tone(260, 520, 0.08, { type: 'triangle', vol: 0.1 });
        this.tone(520, 220, 0.22, { type: 'triangle', vol: 0.08, delay: 0.08 });
        break;
      case 'dizzy':
        for (let i = 0; i < 4; i++) this.tone(900 - i * 120, 700 - i * 120, 0.12, { vol: 0.06, delay: i * 0.11 });
        break;
      case 'angry':
        this.tone(190, 160, 0.11, { type: 'sawtooth', vol: 0.07 });
        this.tone(190, 150, 0.14, { type: 'sawtooth', vol: 0.07, delay: 0.14 });
        break;
      case 'love':
        this.tone(660, 700, 0.12, { vol: 0.07 });
        this.tone(880, 940, 0.2, { vol: 0.07, delay: 0.12 });
        break;
      case 'wake':
        [523, 659, 784].forEach((f, i) => this.tone(f, f * 1.02, 0.14, { type: 'triangle', vol: 0.07, delay: i * 0.1 }));
        break;
      case 'sleep':
        [784, 659, 523].forEach((f, i) => this.tone(f, f * 0.98, 0.18, { vol: 0.05, delay: i * 0.14 }));
        break;
      case 'listenOn':
        this.tone(660, 700, 0.08, { type: 'triangle', vol: 0.08 });
        this.tone(990, 1040, 0.12, { type: 'triangle', vol: 0.08, delay: 0.09 });
        break;
      case 'listenOff':
        this.tone(990, 940, 0.08, { type: 'triangle', vol: 0.07 });
        this.tone(660, 620, 0.12, { type: 'triangle', vol: 0.07, delay: 0.09 });
        break;
      case 'hello':
        this.tone(600, 820, 0.1, { type: 'triangle', vol: 0.08 });
        this.tone(820, 1100, 0.14, { type: 'triangle', vol: 0.08, delay: 0.12 });
        break;
    }
  }

  // One syllable of robot babble; rate-limited so long text doesn't turn into a buzz.
  babble(emotion = 'neutral') {
    const now = performance.now();
    if (!this.enabled || now - this.lastBabble < 65) return;
    this.lastBabble = now;
    const f = (BABBLE_PITCH[emotion] ?? 520) * pick(SCALE) * rand(0.97, 1.03);
    this.tone(f, f * rand(0.85, 1.2), rand(0.045, 0.075), { type: 'square', vol: 0.035 });
  }
}

// Speech playback. TTS comes out around -21 dBFS while music and videos sit near -14,
// so on its own Blu sounds far quieter than everything else. Each clip is normalised,
// then compressed, given make-up gain and limited (so peaks never clip) before it plays.
// An analyser at the end lets the mouth follow the real loudness.

const TARGET_RMS = 0.16; // per-clip level going into the compressor (about -16 dBFS)
const MAKEUP = 1.6; // about +4 dB after compression

export class Voice {
  constructor(api, sound) {
    this.api = api;
    this.sound = sound;
    this.enabled = Boolean(api.tts);
    this.volume = 1;
    this.current = null;
    this.level = 0;
    this.samples = new Float32Array(512);
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.volumeNode) this.volumeNode.gain.value = MAKEUP * volume;
  }

  chain() {
    if (this.input) return this.input;
    const ac = this.sound.ac;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.volumeNode = ac.createGain();
    this.volumeNode.gain.value = MAKEUP * this.volume;
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    // last line of defence: round off anything the limiter lets through instead of clipping
    const soft = ac.createWaveShaper();
    soft.curve = softClipCurve();
    soft.oversample = '2x';
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 512;
    comp.connect(this.volumeNode).connect(limiter).connect(soft).connect(this.analyser).connect(ac.destination);
    this.input = comp;
    return comp;
  }

  // Starts synthesis right away; resolves to { buffer, rate }, or null when there is
  // nothing speakable or speech is unavailable.
  synth(text) {
    const speakable = text.replace(/\p{Extended_Pictographic}|[*_`#~]/gu, '').trim();
    if (!this.enabled || !/[\p{L}\p{N}]/u.test(speakable)) return Promise.resolve(null);
    return this.api
      .tts(speakable)
      .then(async (res) => {
        if (!res) return null;
        const bytes = res.audio;
        const buffer = await this.sound.ac.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return { buffer, rate: res.rate, gain: normalizeGain(buffer) };
      })
      .catch(() => null);
  }

  play({ buffer, rate, gain }) {
    const ac = this.sound.ac;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const level = ac.createGain();
    level.gain.value = gain;
    src.connect(level).connect(this.chain());
    const start = ac.currentTime;
    const duration = buffer.duration / rate;
    const playback = { ended: false, progress: () => clamp((ac.currentTime - start) / duration, 0, 1) };
    src.onended = () => {
      playback.ended = true;
      if (this.current === src) this.current = null;
      this.sound.hold = Boolean(this.current);
    };
    src.start();
    this.current = src;
    this.sound.hold = true; // keep the audio context awake mid-sentence
    return playback;
  }

  stop() {
    try {
      this.current?.stop();
    } catch {}
    this.current = null;
    this.sound.hold = false;
  }

  // Mouth openness 0..1 from the speech loudness, or null when not speaking.
  meter() {
    if (!this.current || !this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    const rms = Math.sqrt(sum / this.samples.length);
    this.level += (clamp((rms * 3.5) / Math.max(this.volume, 0.5), 0, 1) - this.level) * 0.5;
    return this.level;
  }
}

function softClipCurve() {
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19));
  }
  return curve;
}

// Gain that brings a clip's speech (ignoring silences) to TARGET_RMS.
function normalizeGain(buffer) {
  const data = buffer.getChannelData(0);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const s = data[i];
    if (Math.abs(s) > 0.01) {
      sum += s * s;
      n++;
    }
  }
  return n ? clamp(TARGET_RMS / Math.sqrt(sum / n), 0.5, 6) : 1;
}
