"""Speech for Blu, in one long-lived process so torch and the models load once.

- text-to-speech: Wayu-Paxa-TTS-Edge (Thai + English, fixed voices, 24 kHz)
- speech-to-text: Typhoon ASR Realtime (Thai, NVIDIA NeMo)

Both models are downloaded from Hugging Face on first use.

Protocol: JSON lines on stdin/stdout.
  {"id": 1, "op": "tts", "text": "...", "out": "/tmp/x.wav", "voice": "f_teen_bright", "speed": 1.0}
      -> {"id": 1, "ok": true}
  {"id": 2, "op": "asr", "wav": "/tmp/16k-mono.wav"}  -> {"id": 2, "text": "..."}
Prints {"ready": "tts"} once speech can be synthesized and {"ready": "asr"} once it can
listen. The voice loads first so Blu can talk while the bigger ASR model is still loading.

`python server.py --selftest` downloads both models, speaks a sentence and transcribes it
back; `npm run setup` uses it to check the installation.
"""

import json
import logging
import os
import sys
import tempfile
import threading
import time
import warnings

TTS_MODEL = os.environ.get("BLU_TTS_MODEL", "wayu-ai/wayu-paxa-tts-edge")
TTS_VOICE = os.environ.get("BLU_TTS_VOICE", "f_teen_bright")
ASR_MODEL = os.environ.get("BLU_ASR_MODEL", "scb10x/typhoon-asr-realtime")
WANT_ASR = os.environ.get("BLU_ASR", "1") == "1"

# The model libraries print freely to stdout; keep stdout for the protocol only.
protocol = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
write_lock = threading.Lock()

warnings.filterwarnings("ignore")
logging.disable(logging.WARNING)


def reply(**msg):
    with write_lock:
        protocol.write(json.dumps(msg, ensure_ascii=False) + "\n")


def shorten_espeak_path():
    """espeak-ng (used for English words) can't use a data path longer than ~160
    characters and exits the process, which a deeply nested checkout can exceed. Keep a
    copy of its data (19 MB) somewhere short instead; a symlink won't do, phonemizer
    resolves it back to the long path."""
    import shutil

    import espeakng_loader
    from misaki import espeak  # noqa: F401  (sets the long default path when imported)
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    data = espeakng_loader.get_data_path()
    if len(data) < 140:
        return
    short = os.path.join(os.path.expanduser("~"), ".cache", "blu", "espeak-ng-data")
    stamp = os.path.join(short, ".source")
    if not os.path.exists(stamp) or open(stamp).read() != data:
        shutil.rmtree(short, ignore_errors=True)
        shutil.copytree(data, short)
        with open(stamp, "w") as f:
            f.write(data)
    EspeakWrapper.set_data_path(short)


def load_tts():
    shorten_espeak_path()
    from wayu_tts import ThaiTTS

    tts = ThaiTTS.from_pretrained(TTS_MODEL, device="cpu")
    tts("สวัสดี hello", voice=TTS_VOICE)  # the first call loads the Thai dictionaries; do it now
    return tts


def load_asr():
    import nemo.collections.asr as nemo_asr
    import numpy as np
    import soundfile as sf

    asr = nemo_asr.models.ASRModel.from_pretrained(model_name=ASR_MODEL, map_location="cpu")
    asr.eval()
    # warm up on a second of silence so the first real question isn't slow
    with tempfile.NamedTemporaryFile(suffix=".wav") as silence:
        sf.write(silence.name, np.zeros(16000, dtype=np.float32), 16000)
        asr.transcribe(audio=[silence.name], batch_size=1, verbose=False)
    return asr


def transcribe(asr, wav_path):
    out = asr.transcribe(audio=[wav_path], batch_size=1, verbose=False)
    hyp = out[0] if out else ""
    text = getattr(hyp, "text", hyp) or ""
    # the model spells sara am as nikhahit + sara aa (ํา); use the proper ำ
    return text.replace("ํา", "ำ").strip()


def serve(tts, asr_box):
    """Answer requests until stdin closes. asr_box = [model or None, loaded Event]."""
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            started = time.time()
            if req["op"] == "tts":
                audio = tts(req["text"], voice=req.get("voice", TTS_VOICE), speed=float(req.get("speed", 1.0)))
                tts.save(req["out"], audio)
                reply(id=req["id"], ok=True, seconds=round(time.time() - started, 2))
            elif req["op"] == "asr":
                if not WANT_ASR:
                    raise RuntimeError("ASR is turned off")
                asr_box[1].wait()
                text = transcribe(asr_box[0], req["wav"])
                reply(id=req["id"], text=text, seconds=round(time.time() - started, 2))
        except Exception as err:  # report and keep serving
            reply(id=req.get("id"), error=str(err))
    os._exit(0)  # parent went away


def main():
    t0 = time.time()
    tts = load_tts()
    reply(ready="tts", seconds=round(time.time() - t0, 1))

    # Serve speech right away; the ASR model loads on the main thread meanwhile
    # (some of NeMo's setup only works on the main thread).
    asr_box = [None, threading.Event()]
    threading.Thread(target=serve, args=(tts, asr_box), daemon=True).start()
    if WANT_ASR:
        t1 = time.time()
        asr_box[0] = load_asr()
        asr_box[1].set()
        reply(ready="asr", seconds=round(time.time() - t1, 1))
    threading.Event().wait()  # serve() exits the process when stdin closes


def selftest():
    import librosa
    import soundfile as sf

    sentence = "สวัสดีครับ ยินดีที่ได้รู้จัก"
    t0 = time.time()
    tts = load_tts()
    audio = tts(sentence, voice=TTS_VOICE)
    protocol.write(f"✓ voice  {TTS_MODEL} ({TTS_VOICE}) loaded in {time.time() - t0:.0f}s, said: {sentence}\n")
    if not WANT_ASR:
        return 0
    t1 = time.time()
    asr = load_asr()
    with tempfile.NamedTemporaryFile(suffix=".wav") as clip:
        sf.write(clip.name, librosa.resample(audio, orig_sr=tts.sample_rate, target_sr=16000), 16000)
        heard = transcribe(asr, clip.name)
    protocol.write(f"✓ ears   {ASR_MODEL} loaded in {time.time() - t1:.0f}s, heard: {heard}\n")
    return 0 if heard else 1


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
