import { damp } from './springs.js';

// Plays the songs the main process fetches with yt-dlp (the model's play_music tool).
// A new song waits until Blu has finished saying it's on, then starts from the top,
// skipping any silence before the music (many videos open with a few silent seconds). It
// ducks under Blu's voice, and further while it listens so the microphone hears you.
// It goes through Web Audio so the louder volume settings can boost quiet songs, with
// a limiter so they never clip.

const DUCK = { talk: 0.3, listen: 0.05 };
const START_WAIT = 20; // seconds a new song waits at most for Blu to finish talking
const SCAN_RATE = 4; // silent intros are skipped through at this speed, muted
const MAX_SKIP = 15; // seconds of intro that may be skipped
const SOUND = 0.003; // RMS above which the music has begun (about -50 dBFS)

export class Music {
  constructor(api) {
    this.api = api;
    this.audio = null;
    this.started = false;
    this.title = '';
    this.volume = 1; // the user's setting; 1 is the song's own level
    this.level = 0;
    this.status = ''; // what the main process is doing to get the next song
    this.statusSince = 0;
    api.on('music', (msg) => {
      if (msg.op === 'status') {
        this.status = msg.text;
        this.statusSince = performance.now();
      } else if (msg.op === 'play') this.play(msg);
      else if (msg.op === 'stop') this.stop(false);
    });
  }

  get playing() {
    return this.started;
  }

  chain() {
    if (this.analyser) return this.analyser;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(1024);
    this.gain = this.ctx.createGain();
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    this.analyser.connect(this.gain).connect(limiter).connect(this.ctx.destination);
    return this.analyser;
  }

  play({ data, mime, title }) {
    this.stop(false);
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const audio = new Audio(url);
    const output = this.chain();
    this.source = this.ctx.createMediaElementSource(audio);
    this.source.connect(output);
    this.ctx.resume();
    audio.onended = () => this.stop();
    audio.onerror = () => this.failed(audio);
    this.audio = audio;
    this.url = url;
    this.title = title;
    this.started = false;
    this.waited = 0;
  }

  start() {
    const audio = this.audio;
    this.started = true;
    this.scanning = true;
    this.gain.gain.value = 0;
    audio.playbackRate = SCAN_RATE;
    audio.play().catch(() => this.failed(audio));
  }

  // The song's own loudness (before the volume), from the last few milliseconds.
  rms() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    return Math.sqrt(sum / this.samples.length);
  }

  failed(audio) {
    if (this.audio !== audio) return; // already stopped or replaced
    console.warn(`music: can't play "${this.title}"`);
    this.stop();
  }

  // `notify` tells the main process the song is over (not needed when it asked).
  stop(notify = true) {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.onended = this.audio.onerror = null;
    this.source.disconnect();
    URL.revokeObjectURL(this.url);
    this.audio = null;
    this.started = this.scanning = false;
    this.title = '';
    this.ctx.suspend(); // let the audio thread sleep until the next song
    if (notify) this.api.musicEnded?.();
  }

  setVolume(volume) {
    this.volume = volume;
  }

  // duck: null | 'talk' | 'listen'; busy: Blu is still replying or listening
  update(dt, duck, busy) {
    if (!this.audio) return;
    this.target = this.volume * (DUCK[duck] ?? 1);
    if (!this.started) {
      this.waited += dt;
      if (!(busy || duck) || this.waited > START_WAIT) this.start();
      return;
    }
    if (this.scanning) {
      if (this.rms() < SOUND && this.audio.currentTime < MAX_SKIP) return;
      // the music begins: back up to just before it and play at full level, no fade
      this.scanning = false;
      this.audio.playbackRate = 1;
      this.audio.currentTime = Math.max(0, this.audio.currentTime - 0.5);
      this.level = this.target;
      this.gain.gain.value = this.level;
      return;
    }
    // get out of the way quickly, come back gently
    this.level = damp(this.level, this.target, this.target < this.level ? 10 : 1.5, dt);
    this.gain.gain.value = this.level;
  }
}
