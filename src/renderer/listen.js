import { clamp } from './springs.js';

// Records one utterance from the microphone. Recording ends by itself after a pause
// in speech (simple energy-based voice activity detection), or when stop() is called,
// and yields 16 kHz mono 16-bit WAV bytes for the ASR.

const TARGET_RATE = 16000;
const END_SILENCE = 1.1; // seconds of quiet after speech that ends the utterance
const NO_SPEECH_TIMEOUT = 7;
const MAX_SECONDS = 25;

export class Listener {
  constructor(sound) {
    this.sound = sound;
    this.active = false;
    this.level = 0;
  }

  // Resolves with WAV bytes, or null if nothing was said.
  async record() {
    const ac = this.sound.ac;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.sound.hold = true; // keep the audio context awake while recording
    this.active = true;
    const source = ac.createMediaStreamSource(this.stream);
    const tap = ac.createScriptProcessor(2048, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    source.connect(tap);
    tap.connect(mute).connect(ac.destination); // a ScriptProcessor only runs when connected

    const chunks = [];
    const blockSeconds = 2048 / ac.sampleRate;
    let elapsed = 0;
    let floor = 0.006; // background noise level, learned from the quiet moments
    let speech = 0;
    let quiet = 0;
    let heard = false;

    const result = await new Promise((resolve) => {
      this.finish = resolve;
      tap.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (const s of data) sum += s * s;
        const rms = Math.sqrt(sum / data.length);
        this.level += (clamp(rms * 12, 0, 1) - this.level) * 0.4;
        elapsed += blockSeconds;

        const threshold = Math.max(0.012, floor * 2.5);
        if (rms > threshold) {
          speech += blockSeconds;
          quiet = 0;
          if (speech > 0.15) heard = true;
        } else {
          quiet += blockSeconds;
          floor += (rms - floor) * 0.05;
          if (!heard) speech = 0;
        }
        if ((heard && quiet > END_SILENCE) || elapsed > MAX_SECONDS) resolve(true);
        else if (!heard && elapsed > NO_SPEECH_TIMEOUT) resolve(false);
      };
    });

    tap.onaudioprocess = null;
    source.disconnect();
    tap.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    this.active = false;
    this.level = 0;
    this.sound.hold = false;
    this.sound.ac; // restart the idle timer
    return result && heard ? encodeWav(downsample(chunks, ac.sampleRate)) : null;
  }

  // End the current recording now (keeps whatever was said so far).
  stop() {
    this.finish?.(true);
  }
}

function downsample(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    input.set(c, offset);
    offset += c.length;
  }
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(total / ratio));
  let peak = 1e-6;
  for (let i = 0; i < out.length; i++) {
    // average the source samples that fall into this output sample (cheap low-pass)
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  // normalise like the Typhoon reference pipeline does
  const gain = 0.95 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, TARGET_RATE, true);
  v.setUint32(28, TARGET_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, clamp(samples[i], -1, 1) * 0x7fff, true);
  return new Uint8Array(buf);
}
