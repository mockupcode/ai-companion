import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FaceDecal, ChestScreen, FACE_SLICE } from './face.js';
import { Spring, TAU, clamp, damp, easeInOut, lerp, noise, rand, smoothstep } from './springs.js';

// A procedural 3D take on the Blu character sheet (front, both sides, back), down to its
// ink outlines. Scene units: ground at y = 0, the robot faces +z, about 2.48 units from
// feet to antenna tip. Nothing is keyframed; poses are targets that joints chase through
// damping and springs, so every transition stays smooth.

const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

const HIP_Y = 0.46;
const SHOULDER = { x: 0.375, y: 0.91 };
const NECK_Y = 1.0;
export const HEAD_Y = 1.565;
// Half extents, and superellipse exponents per axis as [jaw, dome]: the dome is nearly
// round, the jaw squarer from the front than from the side.
const HEAD = { rx: 0.54, rz: 0.48, top: 0.48, bot: 0.475, ex: [0.5, 0.95], ey: [0.56, 0.95], ez: [0.78, 0.95] };
// The white is an rx by ry ellipse domed out of the face; out: how far it bulges.
// look: furthest the iris slides off centre.
const EYE = { rx: 0.185, ry: 0.195, x: 0.245, y: -0.045, out: 0.07, iris: 0.1, pupil: 0.078, look: 0.075 };
const EAR = { y: -0.1, z: -0.08 };
const TORSO_Z = 0.8; // torso depth relative to its width
const ANKLE_Y = 0.17;
const STEP = 0.2; // ground covered per half walk cycle
const WALK_YAW = 1.05; // body turn toward the walking direction (a readable 3/4 view)
const INK = 0x0c1326;
const LINE = 0.014; // outline width
// how much colour is left at the silhouette, see shadeEdges()
const EDGE = { blue: 0.5, metal: 0.66, white: 0.84 };

// ---------------------------------------------------------------- expressions

//  lidTop/lidBot: 0 open .. 1 closed   tilt: + angry brows, - worried   pupil/eye: scale
//  heart: heart-shaped pupils   smile: -1 frown .. 1 grin   open/round/teeth/wobble: mouth
export const EXPRESSIONS = {
  neutral: { lidTop: 0.02, lidBot: 0, tilt: 0, pupil: 1, eye: 1, heart: 0, sparkle: 0, asym: 0, smile: 0.6, open: 0, round: 0, teeth: 0, wobble: 0, blush: 0, glow: 0x5ee0ff },
  happy: { lidTop: 0, lidBot: 0.42, tilt: 0, pupil: 1.1, eye: 1, heart: 0, sparkle: 0.4, asym: 0, smile: 1, open: 0.42, round: 0, teeth: 0, wobble: 0, blush: 0.35, glow: 0x6dffa0 },
  excited: { lidTop: 0, lidBot: 0.18, tilt: 0, pupil: 1.25, eye: 1.08, heart: 0, sparkle: 1, asym: 0, smile: 1, open: 0.8, round: 0.1, teeth: 0, wobble: 0, blush: 0.3, glow: 0xffd84a },
  love: { lidTop: 0.05, lidBot: 0.3, tilt: 0, pupil: 1, eye: 1.03, heart: 1, sparkle: 0.5, asym: 0, smile: 0.9, open: 0.2, round: 0, teeth: 0, wobble: 0, blush: 0.9, glow: 0xff6fae },
  sad: { lidTop: 0.36, lidBot: 0.08, tilt: -0.75, pupil: 1.22, eye: 1, heart: 0, sparkle: 0.7, asym: 0, smile: -0.75, open: 0.04, round: 0, teeth: 0, wobble: 0.25, blush: 0, glow: 0x6a8cff },
  angry: { lidTop: 0.42, lidBot: 0.15, tilt: 0.9, pupil: 0.75, eye: 0.97, heart: 0, sparkle: 0, asym: 0, smile: -0.6, open: 0.25, round: 0, teeth: 1, wobble: 0, blush: 0, glow: 0xff4b4b },
  surprised: { lidTop: 0, lidBot: 0, tilt: -0.1, pupil: 0.6, eye: 1.16, heart: 0, sparkle: 0.3, asym: 0, smile: 0, open: 0.75, round: 1, teeth: 0, wobble: 0, blush: 0, glow: 0xffe14a },
  thinking: { lidTop: 0.28, lidBot: 0.12, tilt: 0.15, pupil: 1, eye: 1, heart: 0, sparkle: 0, asym: 0.2, smile: 0.1, open: 0, round: 0.35, teeth: 0, wobble: 0, blush: 0, glow: 0xb48cff },
  confused: { lidTop: 0.2, lidBot: 0.05, tilt: -0.25, pupil: 0.9, eye: 1.02, heart: 0, sparkle: 0, asym: 0.7, smile: -0.15, open: 0.04, round: 0, teeth: 0, wobble: 1, blush: 0, glow: 0xffa94d },
  sleepy: { lidTop: 0.62, lidBot: 0.12, tilt: -0.2, pupil: 1, eye: 0.98, heart: 0, sparkle: 0, asym: 0, smile: 0.15, open: 0.1, round: 0.4, teeth: 0, wobble: 0, blush: 0, glow: 0x7f93ad },
  shy: { lidTop: 0.2, lidBot: 0.35, tilt: -0.3, pupil: 1.15, eye: 1, heart: 0, sparkle: 0.5, asym: 0, smile: 0.55, open: 0, round: 0, teeth: 0, wobble: 0.3, blush: 1, glow: 0xff9ec4 },
};
const EXPR_KEYS = Object.keys(EXPRESSIONS.neutral).filter((k) => k !== 'glow');

// Body language that goes with each emotion. arms: [right arm (screen left), left arm].
const POSTURES = {
  neutral: { arms: ['rest', 'rest'], pitch: 0, roll: 0, lean: 0, crouch: 0, bounce: 0, droop: 0, lookYaw: 0, lookPitch: 0 },
  happy: { arms: ['open', 'open'], pitch: 0.08, roll: 0, lean: 0, crouch: 0, bounce: 0.6, droop: 0, lookYaw: 0, lookPitch: 0 },
  excited: { arms: ['cheer', 'cheer'], pitch: 0.12, roll: 0, lean: -0.04, crouch: 0, bounce: 1, droop: 0, lookYaw: 0, lookPitch: 0 },
  love: { arms: ['heart', 'heart'], pitch: 0.1, roll: 0.14, lean: 0, crouch: 0, bounce: 0.3, droop: 0, lookYaw: 0, lookPitch: 0 },
  sad: { arms: ['limp', 'limp'], pitch: -0.3, roll: 0.06, lean: 0.12, crouch: 0.04, bounce: 0, droop: 0.55, lookYaw: 0, lookPitch: -0.2 },
  angry: { arms: ['hips', 'hips'], pitch: -0.12, roll: 0, lean: 0.07, crouch: 0.02, bounce: 0, droop: -0.1, lookYaw: 0, lookPitch: 0 },
  surprised: { arms: ['startle', 'startle'], pitch: 0.14, roll: 0, lean: -0.1, crouch: 0, bounce: 0, droop: -0.2, lookYaw: 0, lookPitch: 0 },
  thinking: { arms: ['rest', 'chin'], pitch: 0.16, roll: 0.16, lean: 0, crouch: 0, bounce: 0, droop: 0, lookYaw: 0.3, lookPitch: 0.3 },
  confused: { arms: ['rest', 'scratch'], pitch: 0.05, roll: -0.22, lean: 0, crouch: 0, bounce: 0, droop: 0.15, lookYaw: 0, lookPitch: 0.1 },
  sleepy: { arms: ['limp', 'limp'], pitch: -0.1, roll: 0.1, lean: 0.05, crouch: 0.02, bounce: 0, droop: 0.7, lookYaw: 0, lookPitch: -0.15 },
  shy: { arms: ['shy', 'shy'], pitch: -0.22, roll: -0.14, lean: 0.04, crouch: 0, bounce: 0, droop: 0.2, lookYaw: -0.35, lookPitch: -0.25 },
};
const POSTURE_KEYS = Object.keys(POSTURES.neutral).filter((k) => k !== 'arms');

// Arm FK targets: shoulder swings forward (fwd) and out to the side (out); the elbow
// bends forward (bend) and toward the body (inw). Radians.
const ARM_POSES = {
  rest: { fwd: 0.06, out: 0.5, bend: 0.3, inw: 0.34 },
  open: { fwd: 0.15, out: 0.4, bend: 0.5, inw: -0.2 },
  limp: { fwd: -0.02, out: 0.05, bend: 0.08, inw: 0 },
  cheer: { fwd: 0.1, out: 2.65, bend: 0.25, inw: 0 },
  hips: { fwd: -0.15, out: 0.85, bend: 0.4, inw: 1.7 },
  chin: { fwd: 1.15, out: -0.25, bend: 2.0, inw: 0.55 },
  heart: { fwd: 0.85, out: -0.05, bend: 1.55, inw: 0.95 },
  shy: { fwd: 0.45, out: -0.18, bend: 0.85, inw: 0.75 },
  shrug: { fwd: 0.3, out: 0.75, bend: 1.5, inw: -0.65 },
  startle: { fwd: 0.35, out: 1.05, bend: 1.0, inw: -0.35 },
  scratch: { fwd: 0.35, out: 2.3, bend: 0.7, inw: 1.7 },
  dangle: { fwd: 0, out: 0.55, bend: 0.25, inw: 0 },
  flail: { fwd: 0.2, out: 1.9, bend: 0.5, inw: 0 },
  sit: { fwd: 0.4, out: 0.2, bend: 0.7, inw: 0.35 },
};
const SWINGY = new Set(['rest', 'open', 'limp']);

function blendPose(a, b, w) {
  return { fwd: lerp(a.fwd, b.fwd, w), out: lerp(a.out, b.out, w), bend: lerp(a.bend, b.bend, w), inw: lerp(a.inw, b.inw, w) };
}

// ---------------------------------------------------------------- gestures

// Each gesture writes overrides into `o`; w is a 0..1 envelope that eases in and out.
const GESTURES = {
  wave: {
    dur: 2.2,
    fn(o, u, t, w) {
      o.arms[1] = { fwd: 0.25, out: 2.35, bend: 0.35, inw: Math.sin(t * 11) * 0.6 };
      o.roll = 0.12 * w;
      o.pitch = 0.06 * w;
    },
  },
  nod: { dur: 1.0, fn: (o, u, t, w) => void (o.pitch = -Math.sin(u * Math.PI * 3) * 0.3 * w) },
  shake: { dur: 1.1, fn: (o, u, t, w) => void (o.headYaw = Math.sin(u * Math.PI * 4) * 0.5 * w) },
  shrug: {
    dur: 1.5,
    fn(o, u, t, w) {
      o.arms[0] = o.arms[1] = ARM_POSES.shrug;
      o.roll = 0.2 * w;
      o.pitch = 0.05 * w;
      o.crouch = -0.03 * w;
    },
  },
  dance: {
    dur: 4.2,
    fn(o, u, t, w) {
      const b = t * 7.5;
      o.arms[0] = { fwd: 0.3, out: 1.5 + Math.sin(b) * 1.1, bend: 0.7, inw: 0 };
      o.arms[1] = { fwd: 0.3, out: 1.5 - Math.sin(b) * 1.1, bend: 0.7, inw: 0 };
      o.crouch = (0.05 + Math.sin(b * 2) * 0.04) * w;
      o.bodyRoll = Math.sin(b) * 0.14 * w;
      o.roll = Math.sin(b + 0.6) * 0.18 * w;
      o.yaw = Math.sin(b * 0.5) * 0.6 * w;
    },
  },
  spin: { dur: 1.1, fn: (o, u) => void (o.spin = easeInOut(u) * TAU) },
  stretch: {
    dur: 2.6,
    fn(o, u, t, w) {
      o.arms[0] = o.arms[1] = ARM_POSES.cheer;
      o.lean = -0.12 * w;
      o.pitch = 0.25 * w;
      o.lidTop = 0.85 * w;
      o.mouth = 0.7 * w;
      o.crouch = -0.04 * w;
    },
  },
  lookaround: {
    dur: 3.2,
    fn(o, u, t, w) {
      o.headYaw = Math.sin(u * TAU) * 0.7 * w;
      o.pitch = 0.05 * w;
    },
  },
  jump: { dur: 0.9, fn: (o) => void (o.arms[0] = o.arms[1] = ARM_POSES.cheer) },
};

const SCREEN_MODES = {
  neutral: 'pulse', happy: 'smile', excited: 'star', love: 'heart', sad: 'drop', angry: 'angry',
  surprised: 'bang', thinking: 'dots', confused: 'question', sleepy: 'z', shy: 'shy',
};

// ---------------------------------------------------------------- geometry

const spow = (c, e) => Math.sign(c) * Math.abs(c) ** e;
const headExp = ([jaw, dome], dy) => lerp(jaw, dome, smoothstep(-0.6, 0.6, dy));

function headPoint(dir, out, inflate = 1) {
  // Map a unit direction onto a soft superellipsoid: a round dome over a squarer jaw,
  // like the reference head.
  const x = spow(dir.x, headExp(HEAD.ex, dir.y)) * HEAD.rx;
  const y = spow(dir.y, headExp(HEAD.ey, dir.y)) * (dir.y > 0 ? HEAD.top : HEAD.bot);
  const z = spow(dir.z, headExp(HEAD.ez, dir.y)) * HEAD.rz;
  return out.set(x, y, z).multiplyScalar(inflate);
}

// Inverse of headPoint: the point on the face (or the back of the head) at height y,
// x across. With ({ y, z, side }) instead, the point on that side of the head.
function headAt({ x, y, z, back = false, side = 1 }, inflate = 1) {
  const fy = clamp(y / (y > 0 ? HEAD.top : HEAD.bot), -1, 1);
  let dy = fy;
  for (let i = 0; i < 6; i++) dy = spow(fy, 1 / headExp(HEAD.ey, dy));
  const ex = headExp(HEAD.ex, dy);
  const ez = headExp(HEAD.ez, dy);
  const rest = (c) => Math.sqrt(Math.max(0, 1 - c * c - dy * dy));
  const p = new THREE.Vector3(x ?? 0, y, z ?? 0);
  if (x !== undefined) p.z = spow(rest(spow(clamp(x / HEAD.rx, -1, 1), 1 / ex)), ez) * HEAD.rz * (back ? -1 : 1);
  else p.x = spow(rest(spow(clamp(z / HEAD.rz, -1, 1), 1 / ez)), ex) * HEAD.rx * side;
  return p.multiplyScalar(inflate);
}

// A raised panel. at(u, v, top) maps the unit square onto the body, u to the viewer's
// right; top picks the panel face, otherwise where its edge sinks into the body.
function plateGeometry(at, nu, nv, uvOf = (u, v) => [u, v]) {
  const pos = [];
  const uv = [];
  const idx = [];
  const put = (p, u, v) => {
    pos.push(p.x, p.y, p.z);
    uv.push(...uvOf(u, v));
    return pos.length / 3 - 1;
  };
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) put(at(i / nu, j / nv, true), i / nu, j / nv);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
    }
  }
  const base = plateEdge(nu, nv).map(([u, v]) => [put(at(u, v, true), u, v), put(at(u, v, false), u, v)]);
  base.forEach(([a, b], k) => {
    const [c, d] = base[(k + 1) % base.length];
    idx.push(a, b, d, a, d, c);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData = { nu, nv };
  return g;
}

// the skirt runs counter-clockwise round the edge so it faces outward
function plateEdge(nu, nv) {
  const ring = [];
  for (let i = 0; i < nu; i++) ring.push([i / nu, 0]);
  for (let j = 0; j < nv; j++) ring.push([1, j / nv]);
  for (let i = nu; i > 0; i--) ring.push([i / nu, 1]);
  for (let j = nv; j > 0; j--) ring.push([0, j / nv]);
  return ring;
}

// Moves a plate's vertices onto a new at(), keeping its layout.
function reshapePlate(geo, at) {
  const { nu, nv } = geo.userData;
  const p = geo.attributes.position;
  let n = 0;
  const put = (v) => p.setXYZ(n++, v.x, v.y, v.z);
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) put(at(i / nu, j / nv, true));
  for (const [u, v] of plateEdge(nu, nv)) {
    put(at(u, v, true));
    put(at(u, v, false));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  geo.boundingSphere = null;
}

// The eye in head space: the face, domed up inside an ellipse rx by ry round (cx, cy).
// Points are given as offsets from that centre.
function eyeSurface(cx, cy, rx, ry) {
  return (dx, dy, lift = 0) => {
    const p = headAt({ x: cx + dx, y: cy + dy });
    const q = Math.min(1, Math.hypot(dx / rx, dy / ry));
    return p.addScaledVector(p.clone().normalize(), EYE.out * (1 - q * q) ** 0.65 + lift);
  };
}

// A disc (or a ring when k0 > 0) of plate on an eye surface: k scales the ellipse,
// grow is added to it outright, so a ring can keep a constant width.
const eyeDisc = (surface, place, { rx, ry, k0 = 0, k1 = 1, grow0 = 0, grow1 = 0, lift = 0, sink = -0.006, ox = 0, oy = 0, rows = (v) => v }) =>
  (u, v, top) => {
    const a = -u * TAU;
    const k = lerp(k0, k1, rows(v));
    const g = lerp(grow0, grow1, v);
    return place(surface(ox + (rx * k + g) * Math.cos(a), oy + (ry * k + g) * Math.sin(a), top ? lift : sink));
  };

// Half-width at t (0 bottom .. 1 top) of a rounded rectangle w wide, h tall, corner radius c.
const roundedRect = (w, h, c) => (t) => {
  const d = Math.max(0, Math.abs(t - 0.5) * h - (h / 2 - c));
  return w / 2 - c + Math.sqrt(Math.max(0, c * c - d * d));
};
// Half-width following straight lines through [t, w] stops.
const polyline = (...stops) => (t) => {
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const [t0, w0] = stops[i - 1];
  const [t1, w1] = stops[i];
  return lerp(w0, w1, clamp((t - t0) / (t1 - t0), 0, 1)) / 2;
};
// rows bunch up at the ends, where rounded corners need them
const easeRows = (v) => 0.5 - 0.5 * Math.cos(Math.PI * v);

// A panel on the head, y0..y1 high, hw(t) half as wide, on the face or the back.
function headPlate({ y0, y1, width, lift, back = false, nu = 12, nv = 10 }) {
  return plateGeometry((u, v, top) => {
    const t = easeRows(v);
    const p = headAt({ x: (2 * u - 1) * width(t) * (back ? -1 : 1), y: lerp(y0, y1, t), back });
    return p.addScaledVector(p.clone().normalize(), top ? lift : -0.006);
  }, nu, nv);
}

function deformToHead(geo, inflate) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    headPoint(v, v, inflate);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return geo;
}

function headGeometry(sphere = new THREE.SphereGeometry(1, 72, 48), inflate = 1) {
  let g = deformToHead(sphere, inflate);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g); // weld the UV seam so normals are smooth all round
  g.computeVertexNormals();
  return g;
}

function faceGeometry() {
  const s = FACE_SLICE;
  const g = deformToHead(new THREE.SphereGeometry(1, 56, 36, s.phiStart, s.phiLength, s.thetaStart, s.thetaLength), 1.007);
  g.computeVertexNormals();
  return g;
}

const TORSO_PROFILE = [
  [0.01, 0.395], [0.14, 0.4], [0.22, 0.43], [0.27, 0.49], [0.31, 0.58], [0.34, 0.69], [0.355, 0.8],
  [0.354, 0.89], [0.335, 0.955], [0.29, 1.003], [0.2, 1.035], [0.01, 1.05],
];
const TORSO_POINTS = new THREE.SplineCurve(TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(48);

function torsoR(y) {
  const p = TORSO_POINTS;
  let i = 1;
  while (i < p.length - 1 && p[i].y < y) i++;
  return lerp(p[i - 1].x, p[i].x, clamp((y - p[i - 1].y) / (p[i].y - p[i - 1].y || 1), 0, 1));
}

// Point on the torso at angle a round it (0 = front) and height y, lifted off the surface.
function torsoAt(a, y, lift) {
  const r = torsoR(y);
  const slope = (torsoR(y + 0.005) - torsoR(y - 0.005)) / 0.01;
  const n = new THREE.Vector3(Math.sin(a), -slope, Math.cos(a) / TORSO_Z).normalize();
  return new THREE.Vector3(r * Math.sin(a), y, r * Math.cos(a) * TORSO_Z).addScaledVector(n, lift);
}

// A panel on the torso centred at angle a0, y0..y1 high, width(t) half as wide.
function torsoPlate({ a0 = 0, y0, y1, width, lift, nu = 14, nv = 14, rows = easeRows, uvOf }) {
  return plateGeometry((u, v, top) => {
    const t = rows(v);
    const y = lerp(y0, y1, t);
    const a = a0 + Math.asin(clamp(((2 * u - 1) * width(t)) / torsoR(y), -1, 1));
    return torsoAt(a, y, top ? lift : -0.006);
  }, nu, nv, uvOf);
}

// Accordion tube, unit length hanging down from the origin; scale.y sets its length,
// which conveniently squashes or stretches the folds.
function bellowsGeometry(rIn, rOut, folds) {
  const pts = [new THREE.Vector2(0.001, -1)];
  const n = folds * 8;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new THREE.Vector2(lerp(rIn, rOut, 0.5 - 0.5 * Math.cos(t * folds * TAU)), -1 + t));
  }
  pts.push(new THREE.Vector2(0.001, 0));
  return new THREE.LatheGeometry(pts, 20);
}

function heartGeometry(size) {
  const s = new THREE.Shape();
  s.moveTo(0, -size * 0.75);
  s.bezierCurveTo(-size * 1.25, size * 0.1, -size * 0.6, size * 1.05, 0, size * 0.42);
  s.bezierCurveTo(size * 0.6, size * 1.05, size * 1.25, size * 0.1, 0, -size * 0.75);
  return new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3 });
}

function makeMaterials() {
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);
  const M = {
    blue: phys({ color: 0x64c3f2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 }),
    lid: phys({ color: 0x64c3f2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
    blueSoft: phys({ color: 0x9fdaf7, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.18 }),
    blueDeep: phys({ color: 0x2a7cc2, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    armor: phys({ color: 0x47a3e3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.14 }),
    plate: phys({ color: 0xb2cde9, roughness: 0.3, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.16 }),
    cup: phys({ color: 0x8fb1d8, roughness: 0.3, metalness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.16 }),
    navy: phys({ color: 0x1c2a50, roughness: 0.45, clearcoat: 0.4 }),
    slate: phys({ color: 0x3e4d7a, roughness: 0.4, clearcoat: 0.5 }),
    joint: phys({ color: 0x1e2944, roughness: 0.5, metalness: 0.25 }),
    silver: phys({ color: 0xc3d5e8, roughness: 0.28, metalness: 0.3, clearcoat: 0.7 }),
    steel: phys({ color: 0x6f87a9, roughness: 0.36, metalness: 0.3, clearcoat: 0.4 }),
    white: phys({ color: 0xffffff, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 }),
    // iris layers sit a hair above the eye white; the offsets keep them winning the depth test
    irisInk: new THREE.MeshBasicMaterial({ color: INK, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    iris: phys({ color: 0x7f8f2c, roughness: 0.25, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    pupil: phys({ color: 0x06080c, roughness: 0.1, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    heart: phys({ color: 0xff4f8e, emissive: 0xff2470, emissiveIntensity: 0.45, roughness: 0.25, clearcoat: 1 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xff9800, emissive: 0xff6a00, emissiveIntensity: 0.18, roughness: 0.22, toneMapped: false }),
    glow: phys({ color: 0x64c3f2, emissive: 0x5ee0ff, emissiveIntensity: 0.4, roughness: 0.25, clearcoat: 1 }),
    catchlight: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    ink: new THREE.MeshBasicMaterial({ color: INK }),
  };
  // rivets: a navy dot with a bright head, too small for a hull of their own
  M.dot = M.navy.clone();
  M.dotSilver = M.silver.clone();
  M.dotOrange = M.orange.clone();
  // drawn without a hull: highlights, the ink itself, and painted-on parts
  for (const k of ['catchlight', 'ink', 'irisInk', 'iris', 'pupil', 'dot', 'dotSilver', 'dotOrange']) M[k].userData.noOutline = true;
  for (const k of ['blue', 'blueSoft', 'blueDeep', 'armor', 'plate', 'cup', 'glow']) shadeEdges(M[k], EDGE.blue);
  for (const k of ['navy', 'slate', 'joint', 'silver', 'steel']) shadeEdges(M[k], EDGE.metal);
  shadeEdges(M.white, EDGE.white);
  return M;
}

// Cartoon ink lines: each part also draws its back faces, pushed out along the normals
// and filled with ink, so a dark rim shows wherever it sits in front of something else.
function outlineMaterial(jellyUniforms) {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    let decl = '';
    let move = '';
    if (jellyUniforms) {
      Object.assign(shader.uniforms, jellyUniforms);
      decl = 'uniform float uJellyAmp;\nuniform float uJellyTime;\nuniform vec3 uJellyDir;';
      move = 'transformed += normal * sin(dot(position, uJellyDir) * 9.0 - uJellyTime * 24.0) * uJellyAmp;';
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${move}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>\nmvPosition.xyz += normalize(normalMatrix * normal) * ${LINE.toFixed(4)};\ngl_Position = projectionMatrix * mvPosition;`,
      );
  };
  m.customProgramCacheKey = () => (jellyUniforms ? 'outline-jelly' : 'outline');
  return m;
}
const OUTLINE = outlineMaterial();

// Eyelid: a skin over the eye white that only shows past its cut lines, edged in ink.
// cut = (upper lid height, lower lid height, upper slope, lower slope) in eye space.
function lidMaterial(base) {
  const m = shadeEdges(base.clone(), EDGE.blue);
  m.side = THREE.FrontSide;
  Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.userData.noOutline = true;
  m.userData.cut = { value: new THREE.Vector4(1, -1, 0, 0) };
  const ink = new THREE.Color(INK);
  return patchShader(m, 'lid', (shader) => {
    shader.uniforms.uCut = m.userData.cut;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLid;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLid = position.xy;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLid;\nuniform vec4 uCut;')
      .replace(
        'void main() {',
        'void main() {\nfloat lidIn = max(vLid.y - uCut.x - uCut.z * vLid.x, uCut.y + uCut.w * vLid.x - vLid.y);\nif (lidIn < 0.0) discard;',
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>\ngl_FragColor.rgb = mix(vec3(${ink.r.toFixed(4)}, ${ink.g.toFixed(4)}, ${ink.b.toFixed(4)}), gl_FragColor.rgb, smoothstep(0.009, 0.016, lidIn));`,
      );
  });
}

// Soft-body ripple: vertices slide along their normals in a travelling wave whose
// amplitude is kicked by impacts and pokes, so the shell jiggles like jelly.
function jellify(material, uniforms) {
  return patchShader(material, 'jelly', (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uJellyAmp;\nuniform float uJellyTime;\nuniform vec3 uJellyDir;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += objectNormal * sin(dot(position, uJellyDir) * 9.0 - uJellyTime * 24.0) * uJellyAmp;',
      );
  });
}

// Stacks a shader tweak on whatever the material already has, and keys its program.
function patchShader(material, key, patch) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    patch(shader);
  };
  material.customProgramCacheKey = () => `${prevKey}|${key}`;
  return material;
}

// Cartoon shading: the colour deepens toward the silhouette, as on the character sheet.
// edge is how much of the colour is left where the surface turns away from the viewer.
function shadeEdges(material, edge) {
  return patchShader(material, `edge${edge}`, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      {
        vec3 toEye = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
        diffuseColor.rgb *= mix(${edge.toFixed(3)}, 1.0, pow(clamp(dot(normal, toEye), 0.0, 1.0), 0.6));
      }`,
    );
  });
}

function mesh(geo, mat, parent, { pos, rot, scale, shadow = false, outline = OUTLINE } = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  if (outline && !mat.userData.noOutline) m.add(new THREE.Mesh(geo, outline));
  return m;
}

// Static pieces of one rigid part, merged per material: drawing cost is dominated by
// the number of draw calls, so ten little rivets should cost one, not ten.
class Batch {
  constructor() {
    this.byMaterial = new Map();
  }

  add(geo, mat, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}, parentMatrix) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
      new THREE.Vector3(...scale),
    );
    if (parentMatrix) m.premultiply(parentMatrix);
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!this.byMaterial.has(mat)) this.byMaterial.set(mat, []);
    this.byMaterial.get(mat).push(g);
  }

  into(parent, opts) {
    for (const [mat, geos] of this.byMaterial) mesh(mergeGeometries(geos), mat, parent, opts);
  }
}

// ---------------------------------------------------------------- robot

export class Robot {
  constructor() {
    this.M = makeMaterials();
    // shared by the head shell, its painted face and the torso so they ripple together
    this.jellyU = { uJellyAmp: { value: 0 }, uJellyTime: { value: 0 }, uJellyDir: { value: new THREE.Vector3(0, 1, 0) } };
    this.M.shell = jellify(shadeEdges(this.M.blue.clone(), EDGE.blue), this.jellyU);
    this.M.body = jellify(shadeEdges(this.M.armor.clone(), EDGE.blue), this.jellyU);
    this.M.jaw = jellify(shadeEdges(this.M.armor.clone(), EDGE.blue), this.jellyU);
    this.M.rim = jellify(shadeEdges(this.M.navy.clone(), EDGE.metal), this.jellyU);
    this.M.outlineJelly = outlineMaterial(this.jellyU);
    this.jellyAmp = 0;
    this.geo = {
      armBellows: bellowsGeometry(0.031, 0.043, 4),
      legBellows: bellowsGeometry(0.044, 0.06, 4),
      knuckle: new THREE.SphereGeometry(0.017, 12, 8),
      hook: new THREE.TorusGeometry(0.028, 0.016, 8, 14, (150 * Math.PI) / 180),
      fingertip: new THREE.SphereGeometry(0.016, 10, 8),
      thumb: new THREE.CapsuleGeometry(0.016, 0.03, 4, 10), // also the straight part of a finger
      rivet: new THREE.SphereGeometry(0.014, 12, 8),
      rivetHead: new THREE.SphereGeometry(0.008, 10, 6),
    };

    // root > hangPivot (swings when held by the head) > squash > yaw > body
    this.root = new THREE.Group();
    this.hangPivot = new THREE.Group();
    this.hangPivot.position.y = HEAD_Y;
    const hangOffset = new THREE.Group();
    hangOffset.position.y = -HEAD_Y;
    this.squashGroup = new THREE.Group();
    this.yawGroup = new THREE.Group();
    this.body = new THREE.Group(); // pivots at the hips
    this.bodyInner = new THREE.Group();
    this.bodyInner.position.y = -HIP_Y;
    this.root.add(this.hangPivot);
    this.hangPivot.add(hangOffset);
    hangOffset.add(this.squashGroup);
    this.squashGroup.add(this.yawGroup);
    this.yawGroup.add(this.body);
    this.body.add(this.bodyInner);

    this.neck = new THREE.Group();
    this.neck.position.y = NECK_Y;
    this.jelly = new THREE.Group();
    this.head = new THREE.Group();
    this.head.position.y = HEAD_Y - NECK_Y;
    this.bodyInner.add(this.neck);
    this.neck.add(this.jelly);
    this.jelly.add(this.head);

    this.buildTorso();
    this.buildHead();
    this.eyes = [this.buildEye(-1), this.buildEye(1)];
    this.buildAntenna();
    this.arms = [this.buildArm(-1), this.buildArm(1)];
    this.legs = [this.buildLeg(-1), this.buildLeg(1)];

    // animation state
    this.t = 0;
    this.emotion = 'neutral';
    this.expr = { ...EXPRESSIONS.neutral };
    this.glow = new THREE.Color(EXPRESSIONS.neutral.glow);
    this.glowTarget = this.glow.clone();
    this.post = { ...POSTURES.neutral };
    this.yaw = new Spring(0, 60, 10);
    this.headYaw = new Spring(0, 55, 11);
    this.headPitch = new Spring(0, 55, 11);
    this.headRoll = 0;
    this.crouch = new Spring(0, 160, 16);
    this.squash = new Spring(0, 260, 11);
    this.hang = new Spring(0, 18, 2.4);
    this.legSwing = new Spring(0, 30, 3);
    this.jx = new Spring(0, 90, 8);
    this.jy = new Spring(0, 110, 9);
    this.jz = new Spring(0, 90, 8);
    this.antX = new Spring(0, 70, 3.5);
    this.antZ = new Spring(0, 70, 3.5);
    this.walkAmt = 0;
    this.phase = 0;
    this.dangle = 0;
    this.sit = 0;
    this.sleep = 0;
    this.talk = 0;
    this.anticipate = 0;
    this.listen = 0;
    this.listenLevel = 0;
    this.gesture = null;
    this.eyeYaw = 0;
    this.eyePitch = 0;
    this.saccade = { yaw: 0, pitch: 0, hold: 0 };
    this.blinkAt = rand(1.5, 4);
    this.blinkT = -1;
    this.blinkAmt = 0;
    this.lookYaw = 0;
    this.lastHeadWorld = null;
    this.flap = 0;
  }

  // ---------------------------------------------------------- build

  buildTorso() {
    const { M } = this;
    const B = this.bodyInner;
    this.torso = mesh(new THREE.LatheGeometry(TORSO_POINTS, 44), M.body, B, { scale: [1, 1, TORSO_Z], shadow: true, outline: M.outlineJelly });
    mesh(new THREE.CylinderGeometry(0.1, 0.112, 0.14, 28), M.navy, this.neck, { pos: [0, 0.05, 0] }); // turns with the head

    // chest display, curved to the belly
    this.chest = new ChestScreen();
    const screen = { w: 0.336, h: 0.204 };
    const screenWidth = roundedRect(screen.w, screen.h, 0.036);
    const screenMat = new THREE.MeshBasicMaterial({ map: this.chest.texture, toneMapped: false });
    screenMat.userData.noOutline = true;
    const screenGeo = torsoPlate({
      y0: 0.706, y1: 0.91, width: screenWidth, lift: 0.034, nu: 20, nv: 14,
      uvOf: (u, v) => [0.5 + ((2 * u - 1) * screenWidth(easeRows(v))) / screen.w, easeRows(v)],
    });
    mesh(screenGeo, screenMat, B);

    const parts = new Batch();
    const pelvis = TORSO_POINTS.filter((p) => p.y <= 0.57).map((p) => new THREE.Vector2(p.x * 1.022, p.y));
    parts.add(new THREE.LatheGeometry(pelvis, 44), M.navy, { scale: [1, 1, TORSO_Z * 1.01] });
    parts.add(new THREE.TorusGeometry(0.12, 0.03, 10, 32), M.navy, { pos: [0, 1.035, 0], rot: [Math.PI / 2, 0, 0], scale: [1, TORSO_Z, 1] });

    // front: silver frame round the screen, a lighter belly plate below it, the orange light
    parts.add(torsoPlate({ y0: 0.655, y1: 0.958, width: roundedRect(0.43, 0.303, 0.05), lift: 0.02 }), M.silver);
    parts.add(torsoPlate({ y0: 0.45, y1: 0.672, width: polyline([0, 0.24], [0.35, 0.37], [0.8, 0.43], [1, 0.41]), lift: 0.012, rows: (v) => v }), M.plate);
    parts.add(torsoPlate({ y0: 0.54, y1: 0.66, width: (t) => lerp(0.062, 0.102, t) - 0.012 * (Math.abs(t - 0.5) > 0.42 ? 1 : 0), lift: 0.036, nu: 10, nv: 8 }), M.orange);
    for (const s of [-1, 1]) {
      parts.add(this.geo.rivet, M.dot, { pos: torsoAt(Math.asin((s * 0.158) / torsoR(0.925)), 0.925, 0.022).toArray() });
      parts.add(this.geo.rivetHead, M.dotOrange, { pos: torsoAt(Math.asin((s * 0.158) / torsoR(0.925)), 0.925, 0.032).toArray() });
      parts.add(this.geo.rivet, M.dot, { pos: torsoAt(Math.asin((s * 0.168) / torsoR(0.683)), 0.683, 0.02).toArray() });
      parts.add(this.geo.rivetHead, M.dotSilver, { pos: torsoAt(Math.asin((s * 0.168) / torsoR(0.683)), 0.683, 0.03).toArray() });
      // side armour with a vent below it
      parts.add(torsoPlate({ a0: s * 0.98, y0: 0.785, y1: 0.93, width: roundedRect(0.1, 0.145, 0.025), lift: 0.014, nu: 6, nv: 10 }), M.plate);
      parts.add(torsoPlate({ a0: s * 0.98, y0: 0.69, y1: 0.765, width: roundedRect(0.1, 0.075, 0.012), lift: 0.012, nu: 6, nv: 8 }), M.navy);
      for (const y of [0.708, 0.727, 0.746]) {
        parts.add(torsoPlate({ a0: s * 0.98, y0: y - 0.004, y1: y + 0.004, width: () => 0.038, lift: 0.016, nu: 4, nv: 1, rows: (v) => v }), M.steel);
      }
    }

    // back: a service hatch with two screws and a vent, and a tab on the hips
    const back = Math.PI;
    parts.add(torsoPlate({ a0: back, y0: 0.62, y1: 0.925, width: roundedRect(0.4, 0.305, 0.045), lift: 0.02 }), M.steel);
    parts.add(torsoPlate({ a0: back, y0: 0.645, y1: 0.785, width: (t) => lerp(0.085, 0.06, t), lift: 0.03, nu: 8, nv: 6, rows: (v) => v }), M.navy);
    for (let i = 0; i < 4; i++) {
      const y = 0.667 + i * 0.03;
      parts.add(torsoPlate({ a0: back, y0: y - 0.006, y1: y + 0.006, width: () => lerp(0.078, 0.055, (y - 0.645) / 0.14), lift: 0.036, nu: 4, nv: 1, rows: (v) => v }), M.steel);
    }
    for (const s of [-1, 1]) {
      const a = back + Math.asin((s * 0.135) / torsoR(0.87));
      parts.add(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 20), M.silver, { pos: torsoAt(a, 0.87, 0.026).toArray(), rot: [Math.PI / 2, 0, 0] });
      parts.add(new THREE.BoxGeometry(0.036, 0.008, 0.008), M.navy, { pos: torsoAt(a, 0.87, 0.033).toArray(), rot: [0, 0, s * 0.7] });
      parts.add(torsoPlate({ a0: back + Math.asin((s * 0.155) / torsoR(0.74)), y0: 0.7, y1: 0.775, width: () => 0.011, lift: 0.03, nu: 2, nv: 4 }), M.navy);
    }
    parts.add(torsoPlate({ a0: back, y0: 0.43, y1: 0.54, width: (t) => lerp(0.085, 0.12, t), lift: 0.028, nu: 10, nv: 6, rows: (v) => v }), M.blueSoft);
    parts.into(B, { shadow: true });
  }

  buildHead() {
    const { M, geo } = this;
    const H = this.head;
    mesh(headGeometry(), M.shell, H, { shadow: true, outline: M.outlineJelly });
    // The jaw is a deeper blue panel of the same shell, tipped so it rides higher round the
    // back (its seam is inked below), with just a thin navy edge underneath.
    const jaw = { angle: 0.9, tip: 0.25 };
    const cap = (angle, tip, inflate) => headGeometry(new THREE.SphereGeometry(1, 72, 12, 0, TAU, Math.PI - angle, angle).rotateX(tip), inflate);
    mesh(cap(jaw.angle, jaw.tip, 1.003), M.jaw, H, { outline: null });
    mesh(cap(0.45, 0, 1.006), M.rim, H, { outline: null });

    this.face = new FaceDecal();
    const faceMat = jellify(new THREE.MeshStandardMaterial({
      map: this.face.texture,
      transparent: true,
      roughness: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }), this.jellyU);
    mesh(faceGeometry(), faceMat, H, { shadow: false, outline: null });

    const parts = new Batch();
    const rivet = (p, head = M.dotSilver) => {
      parts.add(geo.rivet, M.dot, { pos: p.toArray() });
      parts.add(geo.rivetHead, head, { pos: p.clone().multiplyScalar(1.012).toArray() });
    };
    // panel seams: across the forehead, a cap on the back, down each side through the ear
    const seam = (pts) => {
      const curve = new THREE.CatmullRomCurve3(pts);
      parts.add(new THREE.TubeGeometry(curve, pts.length * 8, 0.0062, 6), M.ink);
    };
    const front = [[-0.3, 0.418], [-0.262, 0.38], [-0.13, 0.371], [0, 0.37], [0.13, 0.371], [0.262, 0.38], [0.3, 0.418]];
    seam(front.map(([x, y]) => headAt({ x, y })));
    const crown = [[-0.31, 0.43], [-0.25, 0.31], [-0.13, 0.225], [0, 0.2], [0.13, 0.225], [0.25, 0.31], [0.31, 0.43]];
    seam(crown.map(([x, y]) => headAt({ x, y, back: true })));
    const tipJaw = new THREE.Matrix4().makeRotationX(jaw.tip);
    const jawLine = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      const r = Math.sin(jaw.angle);
      const dir = new THREE.Vector3(r * Math.cos(a), -Math.cos(jaw.angle), r * Math.sin(a)).applyMatrix4(tipJaw);
      jawLine.push(headPoint(dir, new THREE.Vector3(), 1.003));
    }
    parts.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(jawLine, true), 192, 0.0062, 6, true), M.ink);
    for (const s of [-1, 1]) {
      seam([0.455, 0.4, 0.3, 0.2, 0.135].map((y) => headAt({ y, z: lerp(-0.035, -0.06, (0.455 - y) / 0.32), side: s })));
      seam([-0.335, -0.38, -0.43].map((y) => headAt({ y, z: -0.075, side: s })));
      for (const [x, y] of [[0.495, -0.03], [0.36, -0.29]]) rivet(headAt({ x: s * x, y }));
      for (const [y, z] of [[0.265, -0.1], [0.39, 0.25], [-0.24, -0.4], [-0.28, 0.26]]) rivet(headAt({ y, z, side: s }));
      for (const [x, y] of [[0.3, -0.395], [0.18, -0.315]]) rivet(headAt({ x: s * x, y, back: true }, 1.016));

      // headphone-style ear disc, its top tipped out a little: a straight-sided steel-blue
      // cup, then a flat navy rim, a silver ring and a domed orange lens
      const ear = new THREE.Matrix4().compose(
        new THREE.Vector3(s * 0.48, EAR.y, EAR.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * (Math.PI / 2 + 0.14))),
        new THREE.Vector3(1, 1, 1),
      );
      const lathe = (pts) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 56);
      parts.add(lathe([[0.001, 0], [0.218, 0], [0.226, 0.008], [0.226, 0.122], [0.218, 0.13], [0.001, 0.13]]), M.cup, {}, ear);
      const rim = [[0.19, 0.126], [0.228, 0.126], [0.234, 0.132], [0.234, 0.16], [0.228, 0.166], [0.196, 0.166], [0.19, 0.16], [0.19, 0.126]];
      parts.add(lathe(rim), M.navy, {}, ear);
      parts.add(new THREE.CylinderGeometry(0.192, 0.192, 0.02, 56), M.silver, { pos: [0, 0.142, 0] }, ear);
      parts.add(new THREE.CylinderGeometry(0.137, 0.137, 0.006, 48), M.ink, { pos: [0, 0.154, 0] }, ear); // dark line round the lens
      // lens: a cap 0.125 round at the base and 0.065 high
      const lens = (0.125 ** 2 + 0.065 ** 2) / 0.13;
      parts.add(new THREE.SphereGeometry(lens, 40, 10, 0, TAU, 0, Math.asin(0.125 / lens)), M.orange, { pos: [0, 0.222 - lens, 0] }, ear);
    }
    rivet(headAt({ x: 0, y: 0.41 }), M.dotOrange);
    rivet(headAt({ x: 0, y: 0.3, back: true }));
    // raised plate on the back of the jaw
    // A plate on the back of the jaw, nearly flush so it reads as part of the shell; its
    // edge is inked on the surface instead of getting a hull.
    const plate = { y0: -0.44, y1: -0.28, width: (t) => lerp(0.38, 0.25, t), lift: 0.007, back: true };
    mesh(headPlate(plate), M.slate, H, { outline: null, shadow: true });
    const plateEdge = [];
    const n = 8;
    for (let i = 0; i < 4 * n; i++) {
      const k = (i % n) / n;
      const [u, v] = [[k, 0], [1, k], [1 - k, 1], [0, 1 - k]][Math.floor(i / n)];
      const t = easeRows(v);
      const p = headAt({ x: -(2 * u - 1) * plate.width(t), y: lerp(plate.y0, plate.y1, t), back: true });
      plateEdge.push(p.addScaledVector(p.clone().normalize(), plate.lift));
    }
    parts.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(plateEdge, true, 'centripetal'), 128, 0.0062, 6, true), M.ink);
    // antenna mount: a steel bell on a navy flange
    const bell = [[0.001, -0.02], [0.1, -0.015], [0.104, 0.004], [0.086, 0.03], [0.06, 0.052], [0.034, 0.066], [0.001, 0.07]];
    parts.add(new THREE.LatheGeometry(bell.map(([r, y]) => new THREE.Vector2(r, y)), 36), M.steel, { pos: [0, HEAD.top - 0.012, 0] });
    parts.add(new THREE.TorusGeometry(0.098, 0.014, 8, 36), M.navy, { pos: [0, HEAD.top - 0.008, 0], rot: [Math.PI / 2, 0, 0] });
    parts.into(H, { shadow: true });
  }

  buildEye(side) {
    const { M } = this;
    const cx = side * EYE.x;
    // The eye's frame sits on the face with z along its normal; the lids cut in its xy.
    const p0 = headAt({ x: cx, y: EYE.y });
    const n0 = new THREE.Vector3()
      .crossVectors(headAt({ x: cx + 0.01, y: EYE.y }).sub(p0), headAt({ x: cx, y: EYE.y + 0.01 }).sub(p0))
      .normalize();
    const socket = new THREE.Group();
    socket.position.copy(p0);
    socket.quaternion.setFromUnitVectors(FWD, n0);
    this.head.add(socket);
    socket.updateMatrix();
    const toLocal = socket.matrix.clone().invert();

    // Every part is a plate laid on the face, so the eye stays round however the head
    // curves under it; shapeEye() lays them out.
    const plate = (nu, nv, mat, opts) => mesh(plateGeometry(() => new THREE.Vector3(), nu, nv), mat, socket, opts);
    const lidMat = lidMaterial(M.lid);
    const eye = {
      side,
      cx,
      socket,
      place: (p) => p.applyMatrix4(toLocal),
      white: plate(48, 8, M.white),
      ring: plate(48, 2, M.navy), // thick navy rim round the white
      irisInk: plate(32, 3, M.irisInk, { shadow: false }),
      iris: plate(32, 3, M.iris, { shadow: false }),
      pupil: plate(32, 3, M.pupil, { shadow: false }),
      lid: plate(48, 8, lidMat),
      lidMat,
      heart: mesh(heartGeometry(0.075), M.heart, socket, { shadow: false }),
      // catchlights stay put while the iris moves: that is what makes eyes look wet
      catchlights: [
        mesh(new THREE.SphereGeometry(0.025, 16, 10), M.catchlight, socket, { shadow: false }),
        mesh(new THREE.SphereGeometry(0.01, 12, 8), M.catchlight, socket, { shadow: false }),
      ],
    };
    eye.heart.visible = false;
    this.shapeEye(eye, 1, 0, 0, 1, 1);
    return eye;
  }

  // Lays the eye's plates out for its size, the gaze offset and iris and pupil scales.
  shapeEye(eye, size, ox, oy, irisK, pupilK) {
    const key = [size, ox, oy, irisK, pupilK].map((v) => Math.round(v * 2000)).join();
    if (key === eye.key) return;
    eye.key = key;
    const rx = EYE.rx * size;
    const ry = EYE.ry * size;
    const surface = eyeSurface(eye.cx, EYE.y, rx, ry);
    const { place } = eye;
    if (size !== eye.size) {
      eye.size = size;
      const rim = (v) => Math.sin((v * Math.PI) / 2); // rows crowd the steep edge of the dome
      reshapePlate(eye.white.geometry, eyeDisc(surface, place, { rx, ry, rows: rim, sink: -0.012 }));
      reshapePlate(eye.ring.geometry, eyeDisc(surface, place, { rx, ry, k0: 1, grow0: -0.006, grow1: 0.032, lift: 0.016 }));
      // the lid rides clear of the iris layers and the catchlight beads, so it hides them all
      reshapePlate(eye.lid.geometry, eyeDisc(surface, place, { rx, ry, grow1: 0.012, rows: rim, lift: 0.036, sink: 0.03 }));
      eye.catchlights[0].position.copy(place(surface(0.03 * size, 0.036 * size, 0.008)));
      eye.catchlights[1].position.copy(place(surface(-0.042 * size, -0.046 * size, 0.008)));
    }
    const dot = (r, lift) => eyeDisc(surface, place, { rx: r, ry: r, ox, oy, lift, sink: lift - 0.004 });
    reshapePlate(eye.irisInk.geometry, dot(EYE.iris * size * irisK * 1.08, 0.002));
    reshapePlate(eye.iris.geometry, dot(EYE.iris * size * irisK, 0.004));
    reshapePlate(eye.pupil.geometry, dot(EYE.pupil * size * pupilK, 0.006));
    eye.heart.position.copy(place(surface(ox, oy, 0.004)));
  }

  buildAntenna() {
    const { M } = this;
    this.antenna = new THREE.Group();
    this.antenna.position.y = HEAD.top + 0.045; // top of the mount
    this.head.add(this.antenna);
    mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.28, 10), M.navy, this.antenna, { pos: [0, 0.13, 0] });
    this.antennaBall = mesh(new THREE.SphereGeometry(0.065, 32, 20), M.glow, this.antenna, { pos: [0, 0.31, 0], shadow: false });
    this.antennaLight = new THREE.PointLight(0x5ee0ff, 0.35, 1.6, 2);
    this.antennaLight.position.y = 0.31;
    this.antenna.add(this.antennaLight);
  }

  buildArm(side) {
    const { M, geo } = this;
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER.x, SHOULDER.y, 0);
    this.bodyInner.add(shoulder);
    mesh(new THREE.SphereGeometry(0.07, 24, 16), M.blue, shoulder, { pos: [side * 0.006, 0.012, 0], scale: [1, 0.85, 1], shadow: true });
    mesh(new THREE.TorusGeometry(0.046, 0.018, 8, 24), M.navy, shoulder, { pos: [0, -0.062, 0], rot: [Math.PI / 2, 0, 0] });
    mesh(geo.armBellows, M.joint, shoulder, { pos: [0, -0.05, 0], scale: [1, 0.18, 1], shadow: true });

    // forearm: a silver bracer with a round emblem on the outside, between navy bands
    const elbow = new THREE.Group();
    elbow.position.y = -0.225;
    shoulder.add(elbow);
    const parts = new Batch();
    const facing = (x, y, z) =>
      new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, y, z).normalize())).toArray();
    parts.add(new THREE.SphereGeometry(0.044, 20, 14), M.navy);
    parts.add(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 28), M.navy, { pos: [0, -0.012, 0] });
    parts.add(new THREE.CylinderGeometry(0.078, 0.072, 0.13, 32), M.cup, { pos: [0, -0.082, 0] });
    parts.add(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 22), M.blueSoft, { pos: [side * 0.076, -0.082, 0], rot: facing(side, 0, 0) });
    parts.add(new THREE.CylinderGeometry(0.011, 0.011, 0.016, 12), M.navy, { pos: [side * 0.078, -0.082, 0], rot: facing(side, 0, 0) });
    parts.add(new THREE.CylinderGeometry(0.064, 0.064, 0.02, 28), M.navy, { pos: [0, -0.15, 0] });
    parts.add(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 16), M.navy, { pos: [0, -0.17, 0] });

    // Hand: a knuckle disc on the back, four fingers curled under and a thumb above, so
    // together they make a C that opens toward the body.
    const hand = new THREE.Matrix4().compose(new THREE.Vector3(0, -0.226, 0), new THREE.Quaternion(), new THREE.Vector3(1.35, 1.35, 1.35));
    parts.add(new RoundedBoxGeometry(0.1, 0.09, 0.092, 3, 0.034), M.armor, {}, hand);
    parts.add(new THREE.CylinderGeometry(0.04, 0.04, 0.014, 24), M.silver, { pos: [side * 0.047, 0.002, 0.016], rot: facing(side, 0, 0.45) }, hand);
    parts.add(new THREE.CylinderGeometry(0.015, 0.015, 0.018, 14), M.navy, { pos: [side * 0.05, 0.002, 0.017], rot: facing(side, 0, 0.45) }, hand);
    const deg = Math.PI / 180;
    const inward = -side;
    // Each finger hangs straight down from the palm, then its tip curls in round this centre.
    const curl = [inward * 0.028, -0.104];
    const arc = (a) => [curl[0] + 0.028 * Math.cos(a * deg), curl[1] + 0.028 * Math.sin(a * deg)];
    // the curl runs 180 -> 330 degrees on the left hand; the right hand is its mirror image
    const [start, tip] = side < 0 ? [180, 330] : [210, 210];
    for (const [z, drop] of [[-0.035, 0.008], [-0.0117, 0], [0.0117, 0], [0.035, 0.008]]) {
      parts.add(geo.knuckle, M.armor, { pos: [0, -0.046 + drop, z] }, hand);
      parts.add(geo.thumb, M.armor, { pos: [0, -0.075 + drop, z] }, hand);
      parts.add(geo.hook, M.armor, { pos: [curl[0], curl[1] + drop, z], rot: [0, 0, start * deg] }, hand);
      const [tx, ty] = arc(tip);
      parts.add(geo.fingertip, M.armor, { pos: [tx, ty + drop, z] }, hand);
    }
    // the thumb sticks out from the inner side, leaving the C open between it and the fingers
    parts.add(geo.knuckle, M.armor, { pos: [inward * 0.048, -0.004, 0.02] }, hand);
    parts.add(geo.thumb, M.armor, { pos: [inward * 0.068, -0.012, 0.02], rot: facing(inward, -0.35, 0) }, hand);
    parts.add(geo.thumb, M.armor, { pos: [inward * 0.092, -0.035, 0.02], rot: facing(inward * 0.45, -1, 0) }, hand);
    parts.into(elbow, { shadow: true });
    return { side, shoulder, elbow, cur: { ...ARM_POSES.rest } };
  }

  buildLeg(side) {
    const { M, geo } = this;
    const hip = new THREE.Object3D();
    hip.position.set(side * 0.15, HIP_Y - 0.05, 0);
    this.bodyInner.add(hip);
    const leg = new THREE.Group();
    this.yawGroup.add(leg);
    const bellows = mesh(geo.legBellows, M.joint, leg, { shadow: true });
    const knee = mesh(new THREE.SphereGeometry(0.052, 20, 14), M.navy, leg, { shadow: true });

    // a chunky boot: cuffed shaft over the heel, rounded toe, steel sole, wheel at the heel
    const foot = new THREE.Group();
    this.yawGroup.add(foot);
    const parts = new Batch();
    parts.add(new RoundedBoxGeometry(0.205, 0.12, 0.21, 4, 0.045), M.blueDeep, { pos: [0, 0.03, -0.02] });
    parts.add(new RoundedBoxGeometry(0.222, 0.03, 0.227, 3, 0.014), M.blueSoft, { pos: [0, 0.083, -0.02] });
    parts.add(new THREE.CylinderGeometry(0.068, 0.068, 0.02, 24), M.navy, { pos: [0, 0.097, -0.02] });
    parts.add(new RoundedBoxGeometry(0.3, 0.13, 0.44, 5, 0.06), M.armor, { pos: [0, -0.07, 0.065] });
    parts.add(new RoundedBoxGeometry(0.26, 0.09, 0.2, 4, 0.04), M.armor, { pos: [0, -0.02, 0.085], rot: [0.5, 0, 0] }); // instep
    parts.add(new THREE.SphereGeometry(1, 24, 16), M.blue, { pos: [0, -0.07, 0.19], scale: [0.14, 0.07, 0.125] }); // round toe
    parts.add(new RoundedBoxGeometry(0.312, 0.045, 0.455, 3, 0.02), M.silver, { pos: [0, -0.113, 0.065] }); // midsole
    parts.add(new RoundedBoxGeometry(0.32, 0.05, 0.47, 3, 0.022), M.slate, { pos: [0, -0.145, 0.065] });
    parts.add(new THREE.CylinderGeometry(0.052, 0.052, 0.03, 24), M.silver, { pos: [side * 0.152, -0.085, -0.08], rot: [0, 0, Math.PI / 2] });
    parts.add(new THREE.CylinderGeometry(0.022, 0.022, 0.036, 14), M.navy, { pos: [side * 0.153, -0.085, -0.08], rot: [0, 0, Math.PI / 2] });
    parts.into(foot, { shadow: true });
    return { side, hip, leg, bellows, knee, foot };
  }

  // ---------------------------------------------------------- control

  setEmotion(name) {
    if (!EXPRESSIONS[name] || name === this.emotion) return;
    this.emotion = name;
    this.glowTarget.setHex(EXPRESSIONS[name].glow);
    if (name === 'surprised') this.blink(0.6);
  }

  play(name) {
    if (!GESTURES[name]) return false;
    this.gesture = { name, t: 0, dur: GESTURES[name].dur };
    return true;
  }

  blink(chance = 1) {
    if (this.blinkT < 0 && Math.random() < chance) this.blinkT = 0;
  }

  // Positive squashes on landing, negative stretches for take-off.
  kick(amount) {
    this.squash.vel -= amount;
    this.wobble(Math.abs(amount) * 0.3);
  }

  // Make the shell jiggle; dir is the axis the ripple travels along.
  wobble(strength, dir) {
    this.jellyAmp = Math.min(0.03, this.jellyAmp + strength * 0.018);
    if (dir) this.jellyU.uJellyDir.value.copy(dir).normalize();
  }

  isFacing(dir) {
    return Math.abs(this.yaw.value - dir * WALK_YAW) < 0.45;
  }

  anchor(name, out = new THREE.Vector3()) {
    const obj = { top: this.antennaBall, head: this.head, eyeL: this.eyes[0].socket, eyeR: this.eyes[1].socket }[name];
    return obj.getWorldPosition(out);
  }

  // ---------------------------------------------------------- per frame

  /**
   * @param {number} dt seconds
   * @param {object} input
   *   speed   horizontal velocity in units/s (screen space, + = right)
   *   accel   {x, y} acceleration in units/s^2 (y up), drives the jelly springs
   *   facing  -1 | 0 | 1 (0 = face the viewer)
   *   lookAt  THREE.Vector3 in scene space
   *   mode    'ground' | 'drag' | 'air' | 'sit' | 'sleep'
   *   talking bool
   *   talkLevel 0..1 loudness of the spoken voice, or null to fake mouth flaps
   *   listening bool, listenLevel 0..1 microphone loudness while you speak to it
   */
  update(dt, input) {
    const t = (this.t += dt);
    const ex = this.expr;
    const target = EXPRESSIONS[this.emotion];
    for (const k of EXPR_KEYS) ex[k] = damp(ex[k], target[k], 9, dt);
    this.glow.lerp(this.glowTarget, 1 - Math.exp(-6 * dt));
    const posture = POSTURES[this.emotion];
    for (const k of POSTURE_KEYS) this.post[k] = damp(this.post[k], posture[k], 5, dt);
    const post = this.post;

    const mode = input.mode;
    this.dangle = damp(this.dangle, mode === 'drag' ? 1 : mode === 'air' ? 0.4 : 0, 8, dt);
    this.sit = damp(this.sit, mode === 'sit' || mode === 'sleep' ? 1 : 0, 3.5, dt);
    this.sleep = damp(this.sleep, mode === 'sleep' ? 1 : 0, 2, dt);
    this.talk = damp(this.talk, input.talking ? 1 : 0, 10, dt);
    this.talkLevel = input.talkLevel ?? null;
    this.listen = damp(this.listen, input.listening ? 1 : 0, 8, dt);
    this.listenLevel = input.listenLevel ?? 0;
    this.anticipate = damp(this.anticipate, input.anticipate ? 1 : 0, 25, dt);

    const o = this.evalGesture(dt);
    const a = { x: clamp(input.accel.x, -30, 30), y: clamp(input.accel.y, -30, 30) };

    // ---- facing & walk cycle
    const look = input.lookAt;
    const lookDx = look.x;
    const lookDy = look.y - HEAD_Y;
    const absYaw = Math.atan2(lookDx, look.z);
    const absPitch = Math.atan2(lookDy, Math.hypot(lookDx, look.z));
    this.yaw.target = (input.facing ? input.facing * WALK_YAW : clamp(absYaw * 0.35, -0.5, 0.5) * (1 - this.sit)) + o.yaw;
    this.yaw.update(dt);
    const yaw = this.yaw.value + o.spin;
    this.yawGroup.rotation.y = yaw;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const ax = a.x * cy; // acceleration in the robot's own frame
    const az = a.x * sy;

    const speed = Math.abs(input.speed);
    const walking = mode === 'ground' && speed > 0.05;
    this.walkAmt = damp(this.walkAmt, walking ? clamp(speed / 0.55, 0.35, 1) : 0, 7, dt);
    this.phase += ((speed * dt) / STEP) * Math.PI;
    const ph = this.phase;
    const wa = this.walkAmt;

    // ---- body
    const breathRate = lerp(1.9, 1.1, this.sleep);
    const breathe = Math.sin(t * breathRate);
    const bounce = post.bounce * Math.abs(Math.sin(t * 5.2)) * 0.035 * (1 - this.sit) * (1 - wa);
    const bob = wa * (Math.abs(Math.sin(ph)) * 0.035 - 0.012);
    this.crouch.target = post.crouch + o.crouch + this.sit * 0.25 + this.anticipate * 0.1;
    this.crouch.update(dt);
    this.body.position.set(wa * Math.cos(ph) * 0.018, HIP_Y + bob + bounce - this.crouch.value + breathe * 0.004, 0);
    this.body.rotation.x = post.lean + o.lean + wa * 0.08 - this.sit * 0.05 + this.sleep * 0.08 + this.listen * 0.06;
    this.body.rotation.z = o.bodyRoll + wa * Math.sin(ph) * 0.045 + noise(t * 0.4, 3) * 0.018;
    const br = 1 + breathe * lerp(0.008, 0.02, this.sleep);
    this.torso.scale.set(br, 1 + breathe * 0.012, TORSO_Z * br);

    // ---- head: turns toward what the eyes want, lagging behind them like a real neck
    const relYaw = Math.atan2(Math.sin(absYaw - yaw), Math.cos(absYaw - yaw));
    const engaged = 1 - this.sleep;
    this.headYaw.target = (clamp(relYaw * 0.65, -0.7, 0.7) * engaged + o.headYaw + post.lookYaw * 0.5) * (1 - this.dangle * 0.5);
    this.headPitch.target = clamp(absPitch * 0.6, -0.3, 0.35) * engaged + post.pitch + o.pitch - this.sleep * 0.12;
    this.headYaw.update(dt);
    this.headPitch.update(dt);
    // listening: the classic attentive head tilt
    this.headRoll = damp(this.headRoll, post.roll + o.roll + this.sleep * 0.08 + this.listen * 0.15 + noise(t * 0.5, 9) * 0.04, 6, dt);
    this.lookYaw = absYaw;

    // jelly: the head lags behind body acceleration and wobbles back
    this.jx.vel -= ax * 0.5 * dt;
    this.jy.vel -= a.y * 0.3 * dt;
    this.jz.vel -= az * 0.5 * dt;
    this.jx.update(dt);
    this.jy.update(dt);
    this.jz.update(dt);
    const jx = clamp(this.jx.value, -0.09, 0.09);
    const jz = clamp(this.jz.value, -0.09, 0.09);
    this.jelly.position.set(jx, clamp(this.jy.value, -0.06, 0.06), jz);
    this.neck.rotation.set(-this.headPitch.value + jz * 2, this.headYaw.value, this.headRoll - jx * 2.4, 'YXZ');

    // ---- squash & stretch and the held-by-the-head pendulum
    this.squash.update(dt);
    this.jellyAmp = Math.max(damp(this.jellyAmp, 0, 3, dt), Math.min(0.012, Math.hypot(a.x, a.y) * 0.0005));
    this.jellyU.uJellyAmp.value = this.jellyAmp;
    this.jellyU.uJellyTime.value = t;
    const s = clamp(this.squash.value, -0.35, 0.35);
    this.squashGroup.scale.set(1 - s * 0.55, 1 + s, 1 - s * 0.55);
    this.hang.vel -= a.x * 0.6 * this.dangle * dt;
    this.hang.update(dt);
    this.hangPivot.rotation.z = clamp(this.hang.value, -1.2, 1.2) * this.dangle;
    this.legSwing.vel -= (a.x * 0.5 + this.hang.vel * 2) * this.dangle * dt;
    this.legSwing.update(dt);

    this.updateEyes(dt, relYaw, absPitch, o);
    this.updateArms(dt, o, ph, wa);
    this.updateLegs(ph, wa, sy);
    this.updateAntenna(dt, ax, az);
    this.updateFace(t, o);
  }

  evalGesture(dt) {
    const o = { arms: [null, null], w: 0, pitch: 0, headYaw: 0, roll: 0, lean: 0, crouch: 0, bodyRoll: 0, yaw: 0, spin: 0, lidTop: 0, mouth: 0 };
    const g = this.gesture;
    if (!g) return o;
    g.t += dt;
    const u = g.t / g.dur;
    if (u >= 1) {
      this.gesture = null;
      return o;
    }
    o.w = smoothstep(0, 0.12, u) * (1 - smoothstep(0.82, 1, u));
    GESTURES[g.name].fn(o, u, g.t, o.w);
    return o;
  }

  updateEyes(dt, relYaw, absPitch, o) {
    const ex = this.expr;
    const post = this.post;
    // Saccades: the eyes jump to a new fixation and hold it, rather than gliding.
    const wantYaw = clamp(relYaw - this.headYaw.value, -0.5, 0.5) + post.lookYaw;
    const wantPitch = clamp(absPitch - this.headPitch.value, -0.4, 0.4) + post.lookPitch;
    const sac = this.saccade;
    const jump = Math.hypot(wantYaw - sac.yaw, wantPitch - sac.pitch);
    sac.hold -= dt;
    if (jump > 0.08 || sac.hold <= 0) {
      if (jump > 0.35) this.blink(0.5);
      sac.yaw = wantYaw + rand(-0.03, 0.03);
      sac.pitch = wantPitch + rand(-0.03, 0.03);
      sac.hold = rand(0.5, 2.5);
    }
    this.eyeYaw = damp(this.eyeYaw, sac.yaw, 32, dt);
    this.eyePitch = damp(this.eyePitch, sac.pitch, 32, dt);

    // blinking: quick close, slower open
    if (this.t > this.blinkAt) {
      this.blink();
      this.blinkAt = this.t + (Math.random() < 0.15 ? 0.25 : rand(2, 5.5));
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const u = this.blinkT / 0.2;
      this.blinkAmt = u < 0.35 ? u / 0.35 : Math.max(0, 1 - (u - 0.35) / 0.65);
      if (u >= 1) this.blinkT = -1;
    } else this.blinkAmt = 0;

    const sleepClose = smoothstep(0.3, 0.9, this.sleep);
    for (const eye of this.eyes) {
      const squint = eye.side > 0 ? ex.asym : 0; // confused: one eye narrower
      let bot = Math.max(ex.lidBot, this.blinkAmt * 0.3);
      let top = clamp(ex.lidTop + squint * 0.3 + o.lidTop - this.listen * 0.12, 0, 1);
      top = Math.max(top, this.blinkAmt * (1 - bot), sleepClose * (1 - bot));
      if (top + bot > 1) top = 1 - bot;
      const size = ex.eye * (1 + (eye.side < 0 ? ex.asym * 0.06 : 0) + this.listen * 0.05);
      const irisK = Math.max(0.001, 1 - ex.heart);
      const gx = this.eyeYaw / 0.6;
      const gy = this.eyePitch / 0.5;
      const g = Math.max(1, Math.hypot(gx, gy)) / (EYE.look * size);
      this.shapeEye(eye, size, gx / g, gy / g, irisK, ex.pupil * irisK);
      // lid lines: height and slope; the upper lid follows the gaze a little, like a real eyelid
      const r = EYE.ry * size;
      eye.lidMat.userData.cut.value.set(
        lerp(1.15, -1.15, top) * r + this.eyePitch * 0.3 * r * (1 - top),
        lerp(-1.15, 1.15, bot) * r,
        Math.tan(eye.side * ex.tilt * 0.45),
        Math.tan(-eye.side * ex.tilt * 0.12),
      );
      eye.heart.visible = ex.heart > 0.02;
      eye.heart.scale.setScalar(ex.heart * (1 + 0.1 * Math.sin(this.t * 8)));
      eye.catchlights[0].scale.setScalar(1 + ex.sparkle * 0.6);
      eye.catchlights[1].scale.setScalar(1 + ex.sparkle * 1.2);
    }
  }

  updateArms(dt, o, ph, wa) {
    const post = POSTURES[this.emotion];
    const t = this.t;
    for (const arm of this.arms) {
      const i = arm.side < 0 ? 0 : 1;
      const name = post.arms[i];
      let pose = ARM_POSES[name];
      if (this.sit > 0.01 && SWINGY.has(name)) pose = blendPose(pose, ARM_POSES.sit, this.sit);
      if (this.dangle > 0.01) pose = blendPose(pose, this.dangle > 0.6 ? ARM_POSES.dangle : ARM_POSES.flail, this.dangle);
      if (o.arms[i]) pose = blendPose(pose, o.arms[i], o.w);
      const swing = SWINGY.has(name) ? 1 : 0.3;
      const legPhase = ph + (arm.side > 0 ? Math.PI : 0);
      let fwd = pose.fwd + wa * swing * 0.5 * Math.cos(legPhase) + noise(t * 0.6, arm.side * 4) * 0.04;
      let out = pose.out + noise(t * 0.5, arm.side * 7) * 0.03 + arm.side * this.legSwing.value * 0.3 * this.dangle;
      if (this.emotion === 'excited' && !o.arms[i]) out += Math.sin(t * 9 + i) * 0.22;
      fwd -= this.anticipate * 0.4;
      const c = arm.cur;
      c.fwd = damp(c.fwd, fwd, 12, dt);
      c.out = damp(c.out, out, 12, dt);
      c.bend = damp(c.bend, pose.bend, 12, dt);
      c.inw = damp(c.inw, pose.inw, 12, dt);
      arm.shoulder.rotation.set(-c.fwd, 0, arm.side * c.out);
      arm.elbow.rotation.set(-c.bend, 0, -arm.side * c.inw);
    }
  }

  updateLegs(ph, wa, sy) {
    this.root.updateMatrixWorld(true);
    const hip = new THREE.Vector3();
    const ground = new THREE.Vector3();
    const hang = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (const leg of this.legs) {
      const s = leg.side;
      leg.hip.getWorldPosition(hip);
      this.yawGroup.worldToLocal(hip);
      const phs = ph + (s > 0 ? Math.PI : 0);
      const lift = Math.max(0, Math.sin(phs)) * 0.085 * wa;
      ground.set(s * (0.245 + this.sit * 0.03), ANKLE_Y + lift, -0.1 * wa * Math.cos(phs) + this.sit * 0.2);
      // held up: legs hang under the hips, trail the motion and kick a little
      const sw = this.legSwing.value;
      hang.set(hip.x + s * 0.06 + Math.sin(sw) * 0.27, hip.y - Math.cos(sw) * 0.27, hip.z + 0.05 + Math.sin(this.t * 9 + s * 1.6) * 0.07 * this.dangle);
      const ankle = ground.lerp(hang, this.dangle);
      dir.subVectors(ankle, hip);
      const len = Math.max(dir.length(), 0.05);
      dir.divideScalar(len);
      leg.leg.position.copy(hip);
      leg.leg.quaternion.setFromUnitVectors(DOWN, dir);
      leg.bellows.scale.set(1, len, 1);
      leg.knee.position.y = -len * 0.48;
      leg.foot.position.copy(ankle);
      leg.foot.rotation.set(-Math.max(0, Math.sin(phs)) * 0.35 * wa + this.dangle * 0.5 - this.sit * 0.15, 0, 0);
    }
  }

  updateAntenna(dt, ax, az) {
    // a stiff-but-wobbly spring: the antenna tip trails every movement of the head
    this.antX.vel += (ax * 1.1 + this.headYaw.vel * 0.6) * dt;
    this.antZ.vel -= az * 1.1 * dt;
    this.antX.update(dt);
    this.antZ.update(dt);
    const droop = this.post.droop + this.sleep * 0.5;
    this.antenna.rotation.set(clamp(this.antZ.value, -0.9, 0.9) + droop * 0.6, 0, clamp(this.antX.value, -0.9, 0.9) + noise(this.t * 0.7, 2) * 0.05);
  }

  updateFace(t, o) {
    const ex = this.expr;
    // real lip sync when the voice is speaking, otherwise plausible flapping
    this.flap = this.talkLevel ?? this.talk * (0.25 + 0.75 * Math.abs(noise(t * 9, 7)));
    this.face.update({ smile: ex.smile, open: clamp(ex.open + this.flap * 0.6 + o.mouth, 0, 1), round: ex.round, teeth: ex.teeth, blush: ex.blush, wobble: ex.wobble }, t);

    const glowCss = `#${this.glow.getHexString()}`;
    const screen = this.listen > 0.5 ? 'listen' : this.talk > 0.5 ? 'talk' : SCREEN_MODES[this.emotion];
    this.chest.update(screen, glowCss, t, this.listen > 0.5 ? this.listenLevel : this.flap);

    const pulse = this.sleep > 0.5 ? 0.4 + 0.3 * Math.sin(t * 1.2) : 1 + this.flap * 0.8;
    this.M.glow.color.copy(this.glow);
    this.M.glow.emissive.copy(this.glow);
    this.M.glow.emissiveIntensity = 1.4 * pulse;
    this.antennaLight.color.copy(this.glow);
    this.antennaLight.intensity = 0.35 * pulse;
    // the ear lights glow with your voice while it listens
    this.M.orange.emissiveIntensity = 0.5 + this.flap * 0.9 + this.listen * this.listenLevel * 2.5;
  }
}
