import * as THREE from 'three';
import { TAU, clamp, lerp } from './springs.js';

const DEG = Math.PI / 180;

// The mouth and cheeks are painted on a canvas that is wrapped onto this slice of the
// head (Three's sphere parameterisation: phi around Y, theta down from +Y; +Z is phi = 90deg).
export const FACE_SLICE = {
  phiStart: 90 * DEG - 75 * DEG,
  phiLength: 150 * DEG,
  thetaStart: 45 * DEG,
  thetaLength: 105 * DEG,
};

const FW = 1024;
const FH = 512;
const MOUTH_Y = 372;
const INK = '#13213a';

const bezier = (a, b, c, u) => (1 - u) * (1 - u) * a + 2 * u * (1 - u) * b + u * u * c;
const q = (v) => Math.round(v * 60);

export class FaceDecal {
  constructor() {
    // drawn in FW x FH units onto a half-size canvas: plenty sharp, and 4x cheaper to upload
    // every frame while the mouth is moving
    this.canvas = Object.assign(document.createElement('canvas'), { width: FW / 2, height: FH / 2 });
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(0.5, 0.5);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.key = '';
    this.drawnAt = -1;
  }

  update(f, t) {
    const wobblePhase = f.wobble > 0.03 ? Math.round(t * 24) : 0;
    const key = [f.smile, f.open, f.round, f.teeth, f.blush, f.wobble].map(q).join() + ',' + wobblePhase;
    // every redraw is a texture upload; 30fps is plenty for a mouth
    if (key === this.key || t - this.drawnAt < 1 / 30) return;
    this.key = key;
    this.drawnAt = t;
    this.ctx.clearRect(0, 0, FW, FH);
    if (f.blush > 0.02) this.drawBlush(f.blush);
    this.drawMouth(f, t);
    this.texture.needsUpdate = true;
  }

  drawBlush(amount) {
    const ctx = this.ctx;
    for (const side of [-1, 1]) {
      const x = 512 + side * 292;
      const y = 318;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1.5, 0.8);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 70);
      g.addColorStop(0, `rgba(255, 96, 150, ${0.62 * amount})`);
      g.addColorStop(1, 'rgba(255, 96, 150, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 70, 0, TAU);
      ctx.fill();
      ctx.restore();
      if (amount > 0.6) {
        // anime-style blush strokes
        ctx.strokeStyle = `rgba(230, 70, 120, ${(amount - 0.6) * 2})`;
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(x + i * 26 - 10, y + 16);
          ctx.lineTo(x + i * 26 + 10, y - 16);
          ctx.stroke();
        }
      }
    }
  }

  drawMouth(f, t) {
    const ctx = this.ctx;
    const open = clamp(f.open, 0, 1);
    const w = lerp(196, 92, f.round);
    const x0 = 512 - w / 2;
    const cornerY = MOUTH_Y - f.smile * 20;
    const midY = MOUTH_Y + f.smile * 40;
    const wob = (u) => f.wobble * 11 * Math.sin(u * Math.PI * 3 + t * 7);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;

    if (open < 0.04) {
      ctx.lineWidth = 15;
      ctx.beginPath();
      for (let i = 0; i <= 28; i++) {
        const u = i / 28;
        const x = x0 + w * u;
        const y = bezier(cornerY, midY, cornerY, u) + wob(u);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
      return;
    }

    const depth = 26 + open * 92;
    const upper = (u) => bezier(cornerY, midY - open * 16, cornerY, u) + wob(u) * 0.5;
    const lower = (u) => bezier(cornerY, midY + depth, cornerY, u) + wob(u) * 0.5;
    ctx.beginPath();
    for (let i = 0; i <= 28; i++) ctx.lineTo(x0 + (w * i) / 28, upper(i / 28));
    for (let i = 28; i >= 0; i--) ctx.lineTo(x0 + (w * i) / 28, lower(i / 28));
    ctx.closePath();
    ctx.fillStyle = '#1a2335';
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#ff7d9b';
    ctx.beginPath();
    ctx.ellipse(512, lower(0.5) - 4, w * 0.3, depth * 0.42, 0, 0, TAU);
    ctx.fill();
    if (f.teeth > 0.02) {
      ctx.fillStyle = `rgba(255, 255, 255, ${f.teeth})`;
      ctx.fillRect(x0, cornerY - 80, w, upper(0.5) - cornerY + 102);
    }
    ctx.restore();

    ctx.lineWidth = 11;
    ctx.stroke();
  }
}

// Little glowing display on the chest plate.
const SW = 256;
const SH = 150;

export class ChestScreen {
  constructor() {
    this.canvas = Object.assign(document.createElement('canvas'), { width: SW, height: SH });
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.last = -1;
  }

  update(mode, color, t, level) {
    if (t - this.last < 1 / 15) return; // an LED panel can be choppy; saves texture uploads
    this.last = t;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SW, SH);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(4, 4, SW - 8, SH - 8, 26);
    const bg = ctx.createLinearGradient(0, 0, 0, SH);
    bg.addColorStop(0, '#16304d');
    bg.addColorStop(1, '#0b1728');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.clip();

    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const cx = SW / 2;
    const cy = SH / 2;
    const beat = 1 + 0.08 * Math.sin(t * 7);

    switch (mode) {
      case 'talk': {
        const n = 7;
        for (let i = 0; i < n; i++) {
          const h = 14 + (level * 0.75 + 0.25 * Math.abs(Math.sin(t * 11 + i * 1.7))) * 70 * (1 - Math.abs(i - 3) / 5);
          ctx.beginPath();
          ctx.roundRect(cx - 84 + i * 25, cy - h / 2, 14, h, 7);
          ctx.fill();
        }
        break;
      }
      case 'listen': {
        // microphone with sound rings that grow with your voice
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.roundRect(cx - 13, cy - 38, 26, 46, 13);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy - 4, 24, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.moveTo(cx, cy + 20);
        ctx.lineTo(cx, cy + 34);
        ctx.stroke();
        for (let i = 1; i <= 2; i++) {
          ctx.globalAlpha = Math.min(1, level * 2.2 - (i - 1) * 0.4);
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(cx, cy - 12, 36 + i * 16, (s > 0 ? -0.25 : 0.75) * Math.PI, (s > 0 ? 0.25 : 1.25) * Math.PI);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'heart':
        ctx.translate(cx, cy + 4);
        ctx.scale(beat, beat);
        heartPath(ctx, 0, 0, 44);
        ctx.fill();
        break;
      case 'drop':
        ctx.translate(cx, cy + Math.sin(t * 2) * 4);
        ctx.beginPath();
        ctx.moveTo(0, -38);
        ctx.bezierCurveTo(26, -6, 30, 30, 0, 34);
        ctx.bezierCurveTo(-30, 30, -26, -6, 0, -38);
        ctx.fill();
        break;
      case 'smile':
        ctx.lineWidth = 9;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(cx + s * 40, cy - 6, 14, Math.PI * 1.1, Math.PI * 1.9);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(cx, cy + 2, 30, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
        break;
      case 'star':
        ctx.translate(cx, cy);
        ctx.rotate(t * 1.5);
        ctx.scale(beat, beat);
        starPath(ctx, 0, 0, 44, 18, 5);
        ctx.fill();
        break;
      case 'dots':
        for (let i = 0; i < 3; i++) {
          const y = cy + Math.sin(t * 6 - i * 0.9) * 9;
          ctx.beginPath();
          ctx.arc(cx - 46 + i * 46, y, 12, 0, TAU);
          ctx.fill();
        }
        break;
      case 'z':
      case 'question':
      case 'bang':
      case 'angry':
      case 'shy': {
        const glyph = { z: 'z Z', question: '?', bang: '!', angry: '#!', shy: '///' }[mode];
        ctx.font = '800 76px -apple-system, "Helvetica Neue", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const jitter = mode === 'angry' ? Math.sin(t * 40) * 3 : 0;
        ctx.fillText(glyph, cx + jitter, cy + 4 + (mode === 'z' ? Math.sin(t * 2) * 5 : 0));
        break;
      }
      default: {
        // heartbeat line scrolling across the screen
        ctx.lineWidth = 6;
        ctx.beginPath();
        for (let x = 10; x <= SW - 10; x += 4) {
          const p = ((x / SW + t * 0.45) % 1) * 5;
          const k = p % 1;
          let y = 0;
          if (k > 0.38 && k < 0.44) y = -40 * Math.sin(((k - 0.38) / 0.06) * Math.PI);
          else if (k > 0.44 && k < 0.5) y = 18 * Math.sin(((k - 0.44) / 0.06) * Math.PI);
          if (x === 10) ctx.moveTo(x, cy + y);
          else ctx.lineTo(x, cy + y);
        }
        ctx.stroke();
      }
    }
    ctx.restore();

    // glass reflection
    const glare = ctx.createLinearGradient(0, 0, SW, SH);
    glare.addColorStop(0, 'rgba(255,255,255,0.16)');
    glare.addColorStop(0.45, 'rgba(255,255,255,0.03)');
    glare.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glare;
    ctx.beginPath();
    ctx.roundRect(4, 4, SW - 8, SH - 8, 26);
    ctx.fill();
    this.texture.needsUpdate = true;
  }
}

export function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.75);
  ctx.bezierCurveTo(x - s * 1.25, y - s * 0.1, x - s * 0.6, y - s * 1.05, x, y - s * 0.42);
  ctx.bezierCurveTo(x + s * 0.6, y - s * 1.05, x + s * 1.25, y - s * 0.1, x, y + s * 0.75);
  ctx.closePath();
}

export function starPath(ctx, x, y, outer, inner, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / (points * 2)) * TAU - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}
