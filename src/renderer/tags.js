// The model prefixes its replies with tags like "[happy][wave]". TagStream pulls them out
// of a token stream (tags can be split across chunks) and hands back clean text.

export const EMOTIONS = ['neutral', 'happy', 'excited', 'love', 'sad', 'angry', 'surprised', 'thinking', 'confused', 'sleepy', 'shy'];
export const GESTURES = ['wave', 'nod', 'shake', 'jump', 'dance', 'shrug', 'spin'];

// Models occasionally translate or paraphrase tags; map the common ones back.
const ALIASES = {
  joy: 'happy', glad: 'happy', smile: 'happy', laugh: 'happy', cheerful: 'happy', proud: 'happy', playful: 'happy',
  calm: 'neutral', curious: 'thinking', think: 'thinking', hmm: 'thinking',
  sorry: 'sad', worried: 'sad', sympathetic: 'sad', upset: 'sad',
  caring: 'love', empathetic: 'love', affectionate: 'love', heart: 'love',
  mad: 'angry', annoyed: 'angry', shocked: 'surprised', surprise: 'surprised', wow: 'surprised',
  puzzled: 'confused', tired: 'sleepy', embarrassed: 'shy', blush: 'shy', hello: 'wave', hi: 'wave', bow: 'nod',
  'ปกติ': 'neutral', 'ดีใจ': 'happy', 'มีความสุข': 'happy', 'ยิ้ม': 'happy', 'สนุก': 'happy', 'ตื่นเต้น': 'excited',
  'รัก': 'love', 'ห่วงใย': 'love', 'เห็นใจ': 'sad', 'เศร้า': 'sad', 'เสียใจ': 'sad', 'กังวล': 'sad', 'โกรธ': 'angry',
  'ตกใจ': 'surprised', 'แปลกใจ': 'surprised', 'คิด': 'thinking', 'สงสัย': 'confused', 'งง': 'confused',
  'ง่วง': 'sleepy', 'เขิน': 'shy', 'อาย': 'shy', 'โบกมือ': 'wave', 'พยักหน้า': 'nod', 'ส่ายหัว': 'shake',
  'กระโดด': 'jump', 'เต้น': 'dance', 'ยักไหล่': 'shrug', 'หมุน': 'spin',
};

function resolve(word) {
  const w = word.toLowerCase();
  if (EMOTIONS.includes(w) || GESTURES.includes(w)) return w;
  return ALIASES[w] || null;
}

// "[happy]", "[happy, wave]", "[emotion: happy]" -> ['happy', ...]; anything else -> null.
export function parseTag(raw) {
  const parts = raw
    .split(/[\s,|:;/+]+/)
    .filter((p) => p && !/^(emotion|gesture|emo|action|mood)$/i.test(p));
  if (!parts.length || parts.length > 3) return null;
  const tags = parts.map(resolve);
  return tags.every(Boolean) ? tags : null;
}

const MAX_TAG = 32;

export class TagStream {
  constructor(onText, onTags) {
    this.onText = onText;
    this.onTags = onTags;
    this.buf = '';
    this.atStart = true;
  }

  push(chunk) {
    this.buf += chunk;
    while (this.buf) {
      const open = this.buf.indexOf('[');
      if (open < 0) {
        this.emit(this.buf);
        this.buf = '';
        return;
      }
      if (open > 0) {
        this.emit(this.buf.slice(0, open));
        this.buf = this.buf.slice(open);
      }
      const close = this.buf.indexOf(']');
      if (close < 0) {
        if (this.buf.length <= MAX_TAG) return; // wait for the rest of the tag
        this.emit('[');
        this.buf = this.buf.slice(1);
        continue;
      }
      const tags = close <= MAX_TAG ? parseTag(this.buf.slice(1, close).trim()) : null;
      if (tags) this.onTags(tags);
      // An unknown bracket right at the start is almost certainly a mangled tag.
      else if (!(this.atStart && close <= MAX_TAG)) {
        this.emit('[');
        this.buf = this.buf.slice(1);
        continue;
      }
      this.buf = this.buf.slice(close + 1);
    }
  }

  end() {
    if (this.buf) this.emit(this.buf);
    this.buf = '';
  }

  emit(text) {
    if (!text) return;
    if (this.atStart) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.atStart = false;
    }
    this.onText(text);
  }
}
