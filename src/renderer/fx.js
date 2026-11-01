import * as THREE from 'three';
import { TAU, rand, smoothstep } from './springs.js';
import { heartPath, starPath } from './face.js';

// Floating emote particles (hearts, Zzz, ?, sparkles...). Positions live in screen
// pixels so they stay where they were spawned while the robot walks away; each frame
// they are mapped into the robot-centred scene.

function glyphTexture(kind) {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const ctx = c.getContext('2d');
  ctx.translate(64, 64);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const outline = (fill, stroke = '#13213a', width = 9) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const text = (s, fill, size = 92) => {
    ctx.font = `900 ${size}px -apple-system, "Helvetica Neue", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#13213a';
    ctx.strokeText(s, 0, 6);
    ctx.fillStyle = fill;
    ctx.fillText(s, 0, 6);
  };
  switch (kind) {
    case 'heart':
      heartPath(ctx, 0, 6, 46);
      outline('#ff4f8e');
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.ellipse(-20, -14, 10, 6, -0.6, 0, TAU);
      ctx.fill();
      break;
    case 'spark':
      starPath(ctx, 0, 0, 54, 14, 4);
      ctx.shadowColor = '#fff3a0';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffe45c';
      ctx.fill();
      break;
    case 'star':
      starPath(ctx, 0, 0, 50, 22, 5);
      outline('#ffd23f');
      break;
    case 'tear':
      ctx.beginPath();
      ctx.moveTo(0, -46);
      ctx.bezierCurveTo(30, -8, 36, 34, 0, 40);
      ctx.bezierCurveTo(-36, 34, -30, -8, 0, -46);
      outline('#7fd0ff', '#1d4f8a', 7);
      break;
    case 'steam':
      ctx.fillStyle = 'rgba(245, 248, 252, 0.95)';
      for (const [x, y, r] of [[-18, 8, 28], [16, 4, 32], [0, -18, 26]]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      break;
    case 'dot':
      ctx.beginPath();
      ctx.arc(0, 0, 44, 0, TAU);
      outline('#ffffff', '#13213a', 8);
      break;
    case 'note':
      text(Math.random() < 0.5 ? '♪' : '♫', '#b48cff', 100);
      break;
    case 'z':
      text('Z', '#9fd8ff');
      break;
    case 'question':
      text('?', '#ffa94d');
      break;
    case 'bang':
      text('!', '#ffe14a');
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const DEFAULTS = {
  heart: { vy: -70, life: 1.8, size: 0.24, sway: 22 },
  spark: { vy: -20, life: 0.9, size: 0.2, sway: 0, spread: 40 },
  star: { vy: -30, life: 1.2, size: 0.2, sway: 0 },
  tear: { vy: 10, life: 1.4, size: 0.12, sway: 0, gravity: 420 },
  steam: { vy: -80, life: 1.1, size: 0.3, sway: 10, grow: 1.6 },
  dot: { vy: -45, life: 1.6, size: 0.1, sway: 8, grow: 1.8 },
  note: { vy: -60, life: 1.8, size: 0.26, sway: 26 },
  z: { vy: -45, life: 2.2, size: 0.24, sway: 18, grow: 1.5 },
  question: { vy: -40, life: 1.6, size: 0.3, sway: 6 },
  bang: { vy: -30, life: 1.0, size: 0.34, sway: 0 },
};

export class Particles {
  constructor(scene) {
    this.scene = scene;
    this.textures = {};
    this.items = [];
  }

  // x, y in screen pixels; o can override vx, vy, life, size, orbit...
  emit(kind, x, y, o = {}) {
    const d = { ...DEFAULTS[kind], ...o };
    this.textures[kind] ??= glyphTexture(kind);
    const mat = new THREE.SpriteMaterial({ map: this.textures[kind], transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    this.scene.add(sprite);
    this.items.push({
      sprite,
      x: x + (d.spread ? rand(-d.spread, d.spread) : 0),
      y: y + (d.spread ? rand(-d.spread, d.spread) : 0),
      vx: d.vx ?? rand(-14, 14),
      vy: d.vy,
      gravity: d.gravity ?? 0,
      life: 0,
      max: d.life,
      size: d.size * rand(0.85, 1.15),
      sway: d.sway,
      grow: d.grow ?? 1,
      phase: rand(0, TAU),
      spin: kind === 'star' || kind === 'spark' ? rand(-3, 3) : rand(-0.4, 0.4),
      orbit: d.orbit,
    });
  }

  update(dt, robotX, robotY, ppu) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life += dt;
      if (p.life >= p.max) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.items.splice(i, 1);
        continue;
      }
      let px;
      let py;
      if (p.orbit) {
        const c = p.orbit.center();
        const a = p.phase + p.life * p.orbit.speed;
        px = c.x + Math.cos(a) * p.orbit.rx;
        py = c.y + Math.sin(a) * p.orbit.ry;
      } else {
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        px = p.x + Math.sin(p.life * 3 + p.phase) * p.sway;
        py = p.y;
      }
      const u = p.life / p.max;
      const fade = smoothstep(0, 0.12, u) * (1 - smoothstep(0.65, 1, u));
      const pop = 0.55 + 0.45 * smoothstep(0, 0.18, u);
      const s = p.size * pop * (1 + (p.grow - 1) * u);
      p.sprite.position.set((px - robotX) / ppu, (robotY - py) / ppu, 0.9);
      p.sprite.scale.set(s, s, 1);
      p.sprite.material.opacity = fade;
      p.sprite.material.rotation = Math.sin(p.life * 2 + p.phase) * 0.25 + p.spin * p.life;
    }
  }
}
