import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FaceDecal, ChestScreen, FACE_SLICE } from './face.js';
import { Spring, TAU, clamp, damp, easeInOut, lerp, noise, rand, smoothstep } from './springs.js';

// A procedural 3D take on ref/robo.jpeg. Scene units: ground at y = 0, the robot faces +z,
// about 2.4 units from feet to antenna tip. Nothing is keyframed; poses are targets that
// joints chase through damping and springs, so every transition stays smooth.

const DOWN = new THREE.Vector3(0, -1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

const HIP_Y = 0.5;
const SHOULDER = { x: 0.37, y: 0.98 };
const NECK_Y = 1.1;
export const HEAD_Y = 1.62;
const HEAD = { rx: 0.58, rz: 0.52, top: 0.47, bot: 0.42, exp: 0.78 };
const EYE = { r: 0.17, angle: 0.47, lat: -0.03, sink: 0.84 };
const ANKLE_Y = 0.13;
const STEP = 0.2; // ground covered per half walk cycle
const WALK_YAW = 1.05; // body turn toward the walking direction (a readable 3/4 view)

// ---------------------------------------------------------------- expressions

//  lidTop/lidBot: 0 open .. 1 closed   tilt: + angry brows, - worried   pupil/eye: scale
//  heart: heart-shaped pupils   smile: -1 frown .. 1 grin   open/round/teeth/wobble: mouth
export const EXPRESSIONS = {
  neutral: { lidTop: 0.1, lidBot: 0.05, tilt: 0, pupil: 1, eye: 1, heart: 0, sparkle: 0, asym: 0, smile: 0.45, open: 0, round: 0, teeth: 0, wobble: 0, blush: 0, glow: 0x5ee0ff },
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
  rest: { fwd: 0.08, out: 0.16, bend: 0.35, inw: 0 },
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

function headPoint(dir, out, inflate = 1) {
  // Map a unit direction onto a soft superellipsoid: rounder-squarer than a sphere,
  // flatter underneath, like the reference head.
  const f = (c) => Math.sign(c) * Math.abs(c) ** HEAD.exp;
  const x = f(dir.x) * HEAD.rx;
  const y = f(dir.y) * (dir.y > 0 ? HEAD.top : HEAD.bot);
  const z = f(dir.z) * HEAD.rz;
  return out.set(x, y, z).multiplyScalar(inflate);
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

function headGeometry() {
  let g = deformToHead(new THREE.SphereGeometry(1, 72, 48), 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g); // weld the UV seam so normals are smooth all round
  g.computeVertexNormals();
  return g;
}

function faceGeometry() {
  const s = FACE_SLICE;
  const g = deformToHead(new THREE.SphereGeometry(1, 56, 36, s.phiStart, s.phiLength, s.thetaStart, s.thetaLength), 1.004);
  g.computeVertexNormals();
  return g;
}

const TORSO_PROFILE = [
  [0.01, 0.44], [0.2, 0.448], [0.272, 0.52], [0.318, 0.63], [0.34, 0.76],
  [0.336, 0.88], [0.31, 0.99], [0.25, 1.07], [0.14, 1.115], [0.01, 1.125],
];

function torsoPoints() {
  return new THREE.SplineCurve(TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(60);
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

// Spherical cap pointing along +z (iris, pupil).
function capGeometry(r, angle) {
  return new THREE.SphereGeometry(r, 28, 6, 0, TAU, 0, angle).rotateX(Math.PI / 2);
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
  return {
    blue: phys({ color: 0x3f9be0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 }),
    lid: phys({ color: 0x3f9be0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12, side: THREE.DoubleSide }),
    blueSoft: phys({ color: 0x7cc0ee, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    navy: phys({ color: 0x1b2d4a, roughness: 0.45, clearcoat: 0.4 }),
    joint: phys({ color: 0x283246, roughness: 0.55, metalness: 0.3 }),
    silver: phys({ color: 0xd3dde6, roughness: 0.25, metalness: 0.6, clearcoat: 0.6 }),
    steel: phys({ color: 0x8e9fb2, roughness: 0.35, metalness: 0.7 }),
    white: phys({ color: 0xffffff, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 }),
    iris: phys({ color: 0x86993a, roughness: 0.25, clearcoat: 1 }),
    pupil: phys({ color: 0x06080c, roughness: 0.1, clearcoat: 1 }),
    heart: phys({ color: 0xff4f8e, emissive: 0xff2470, emissiveIntensity: 0.45, roughness: 0.25, clearcoat: 1 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xffae2e, emissive: 0xff8a00, emissiveIntensity: 0.6, roughness: 0.3 }),
    glow: new THREE.MeshStandardMaterial({ color: 0x5ee0ff, emissive: 0x5ee0ff, emissiveIntensity: 1.6, roughness: 0.2 }),
    catchlight: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
}

// Soft-body ripple: vertices slide along their normals in a travelling wave whose
// amplitude is kicked by impacts and pokes, so the shell jiggles like jelly.
function jellify(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uJellyAmp;\nuniform float uJellyTime;\nuniform vec3 uJellyDir;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += objectNormal * sin(dot(position, uJellyDir) * 9.0 - uJellyTime * 24.0) * uJellyAmp;',
      );
  };
  material.customProgramCacheKey = () => 'jelly';
  return material;
}

function mesh(geo, mat, parent, { pos, rot, scale, shadow = false } = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (rot) m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
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
    this.M.shell = jellify(this.M.blue.clone(), this.jellyU);
    this.M.body = jellify(this.M.blue.clone(), this.jellyU);
    this.jellyAmp = 0;
    this.geo = {
      armBellows: bellowsGeometry(0.04, 0.052, 3),
      legBellows: bellowsGeometry(0.056, 0.074, 4),
      neckBellows: bellowsGeometry(0.085, 0.105, 2),
      finger: new THREE.CapsuleGeometry(0.02, 0.04, 4, 10),
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
    this.torso = mesh(new THREE.LatheGeometry(torsoPoints(), 48), M.body, B, { scale: [1, 1, 0.85], shadow: true });
    this.chest = new ChestScreen();
    const screenMat = new THREE.MeshBasicMaterial({ map: this.chest.texture, toneMapped: false, transparent: true });
    mesh(new THREE.PlaneGeometry(0.31, 0.18), screenMat, B, { pos: [0, 0.87, 0.292] });

    const parts = new Batch();
    const pelvis = torsoPoints()
      .filter((p) => p.y <= 0.6)
      .map((p) => new THREE.Vector2(p.x * 1.025, p.y));
    parts.add(new THREE.LatheGeometry(pelvis, 48), M.navy, { scale: [1, 1, 0.86] });
    parts.add(new RoundedBoxGeometry(0.2, 0.085, 0.05, 3, 0.02), M.blueSoft, { pos: [0, 0.53, 0.23] });
    parts.add(new RoundedBoxGeometry(0.38, 0.25, 0.07, 4, 0.035), M.silver, { pos: [0, 0.87, 0.255] });
    parts.add(new RoundedBoxGeometry(0.14, 0.07, 0.05, 3, 0.022), M.orange, { pos: [0, 0.665, 0.27] });
    parts.add(new RoundedBoxGeometry(0.3, 0.22, 0.06, 3, 0.03), M.steel, { pos: [0, 0.84, -0.255] });
    for (let i = 0; i < 3; i++) {
      parts.add(new THREE.BoxGeometry(0.16, 0.018, 0.02), M.navy, { pos: [0, 0.8 + i * 0.04, -0.287] });
    }
    parts.add(this.geo.neckBellows, M.joint, { pos: [0, NECK_Y + 0.14, 0], scale: [1, 0.22, 1] });
    parts.into(B, { shadow: true });
  }

  buildHead() {
    const { M } = this;
    const H = this.head;
    mesh(headGeometry(), M.shell, H, { shadow: true });

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
    mesh(faceGeometry(), faceMat, H, { shadow: false });

    const parts = new Batch();
    const v = new THREE.Vector3();
    const onHead = (x, y, z, inflate = 1) => headPoint(v.set(x, y, z).normalize(), new THREE.Vector3(), inflate).toArray();
    const rivet = new THREE.SphereGeometry(0.016, 12, 8);
    for (const s of [-1, 1]) {
      for (const [x, y, z] of [[0.62, 0.52, 0.55], [0.78, -0.4, 0.5], [0.4, -0.8, -0.45]]) {
        parts.add(rivet, M.silver, { pos: onHead(s * x, y, z) });
      }
      // headphone-style ear cup with an orange light
      const ear = new THREE.Matrix4().compose(
        new THREE.Vector3(s * 0.545, -0.02, -0.03),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * (Math.PI / 2))),
        new THREE.Vector3(1, 1, 1),
      );
      parts.add(new THREE.CylinderGeometry(0.16, 0.185, 0.16, 36), M.silver, { pos: [0, 0.03, 0] }, ear);
      parts.add(new THREE.TorusGeometry(0.15, 0.022, 8, 36), M.navy, { pos: [0, 0.112, 0], rot: [Math.PI / 2, 0, 0] }, ear);
      parts.add(new THREE.CylinderGeometry(0.105, 0.105, 0.03, 40), M.orange, { pos: [0, 0.11, 0] }, ear);
    }
    parts.add(rivet, M.orange, { pos: onHead(0, 0.82, 0.58) });
    // dark plate on the back of the head, like the reference's back view
    parts.add(new RoundedBoxGeometry(0.46, 0.13, 0.08, 3, 0.035), M.navy, { pos: onHead(0, -0.5, -1, 0.94), rot: [-0.45, 0, 0] });
    parts.add(new THREE.CylinderGeometry(0.05, 0.085, 0.07, 28), M.steel, { pos: [0, HEAD.top - 0.015, 0] }); // antenna base
    parts.into(H, { shadow: true });
  }

  buildEye(side) {
    const { M } = this;
    const dir = new THREE.Vector3(Math.sin(EYE.angle) * side, EYE.lat, Math.cos(EYE.angle)).normalize();
    const surface = headPoint(dir, new THREE.Vector3());
    const socket = new THREE.Group();
    socket.position.copy(surface).multiplyScalar(EYE.sink);
    socket.quaternion.setFromUnitVectors(FWD, new THREE.Vector3(side * 0.3, -0.04, 1).normalize());
    this.head.add(socket);

    // dark rim where the eyeball meets the head shell
    const lip = surface.length() * (1 - EYE.sink);
    const ringR = Math.sqrt(Math.max(EYE.r ** 2 - lip ** 2, 0.01));
    mesh(new THREE.TorusGeometry(ringR + 0.014, 0.032, 12, 40), M.navy, socket, { pos: [0, 0, lip] });

    const ball = new THREE.Group();
    socket.add(ball);
    mesh(new THREE.SphereGeometry(EYE.r, 32, 24), M.white, ball);
    const iris = mesh(capGeometry(EYE.r * 1.004, 0.6), M.iris, ball, { shadow: false });
    const pupil = new THREE.Group();
    ball.add(pupil);
    mesh(capGeometry(EYE.r * 1.008, 0.33), M.pupil, pupil, { shadow: false });
    const heart = mesh(heartGeometry(0.075), M.heart, ball, { pos: [0, 0, EYE.r - 0.01], shadow: false });
    heart.visible = false;

    // Eyelids are hemispherical shells that roll down over the eyeball.
    const lidR = EYE.r * 1.1;
    const upperPivot = new THREE.Group();
    const lowerPivot = new THREE.Group();
    socket.add(upperPivot, lowerPivot);
    const upper = mesh(new THREE.SphereGeometry(lidR, 32, 12, 0, TAU, 0, Math.PI / 2), M.lid, upperPivot);
    const lower = mesh(new THREE.SphereGeometry(lidR, 32, 12, 0, TAU, Math.PI / 2, Math.PI / 2), M.lid, lowerPivot);

    // Catchlights stay fixed while the eyeball rolls: that is what makes eyes look wet.
    const at = (x, y, z, r) => new THREE.Vector3(x, y, z).normalize().multiplyScalar(r).toArray();
    const c1 = mesh(new THREE.SphereGeometry(0.022, 16, 10), M.catchlight, socket, { pos: at(-0.38, 0.42, 0.82, EYE.r * 0.96), shadow: false });
    const c2 = mesh(new THREE.SphereGeometry(0.011, 12, 8), M.catchlight, socket, { pos: at(0.3, -0.3, 0.9, EYE.r * 0.97), shadow: false });

    return { side, socket, ball, iris, pupil, heart, upper, lower, upperPivot, lowerPivot, catchlights: [c1, c2] };
  }

  buildAntenna() {
    const { M } = this;
    this.antenna = new THREE.Group();
    this.antenna.position.y = HEAD.top + 0.015;
    this.head.add(this.antenna);
    mesh(new THREE.CylinderGeometry(0.016, 0.022, 0.26, 12), M.navy, this.antenna, { pos: [0, 0.13, 0] });
    this.antennaBall = mesh(new THREE.SphereGeometry(0.068, 32, 20), M.glow, this.antenna, { pos: [0, 0.29, 0], shadow: false });
    this.antennaLight = new THREE.PointLight(0x5ee0ff, 0.35, 1.6, 2);
    this.antennaLight.position.y = 0.29;
    this.antenna.add(this.antennaLight);
  }

  buildArm(side) {
    const { M, geo } = this;
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER.x, SHOULDER.y, 0);
    this.bodyInner.add(shoulder);
    mesh(new THREE.SphereGeometry(0.09, 24, 16), M.blue, shoulder, { shadow: true });
    mesh(geo.armBellows, M.joint, shoulder, { pos: [0, -0.04, 0], scale: [1, 0.17, 1], shadow: true });

    const elbow = new THREE.Group();
    elbow.position.y = -0.22;
    shoulder.add(elbow);
    const parts = new Batch();
    parts.add(new THREE.SphereGeometry(0.052, 24, 16), M.silver);
    parts.add(new THREE.CapsuleGeometry(0.056, 0.11, 6, 14), M.blueSoft, { pos: [0, -0.1, 0] });
    parts.add(new THREE.CylinderGeometry(0.066, 0.066, 0.045, 28), M.silver, { pos: [0, -0.15, 0] });
    const hand = new THREE.Matrix4().makeTranslation(0, -0.22, 0);
    parts.add(new THREE.SphereGeometry(0.068, 20, 14), M.blue, { scale: [1, 0.9, 0.85] }, hand);
    for (const [x, z, a] of [[-0.035, 0.02, -0.25], [0, 0.03, 0], [0.035, 0.02, 0.25]]) {
      parts.add(geo.finger, M.silver, { pos: [x, -0.07, z], rot: [0.25, 0, a] }, hand);
    }
    parts.add(geo.finger, M.silver, { pos: [-side * 0.05, -0.03, 0.045], rot: [0.6, 0, -side * 0.6] }, hand);
    parts.into(elbow, { shadow: true });
    return { side, shoulder, elbow, cur: { ...ARM_POSES.rest } };
  }

  buildLeg(side) {
    const { M, geo } = this;
    const hip = new THREE.Object3D();
    hip.position.set(side * 0.14, HIP_Y + 0.02, 0);
    this.bodyInner.add(hip);
    const leg = new THREE.Group();
    this.yawGroup.add(leg);
    const bellows = mesh(geo.legBellows, M.joint, leg, { shadow: true });
    const ankle = mesh(new THREE.SphereGeometry(0.055, 20, 14), M.navy, this.yawGroup);

    const foot = new THREE.Group();
    this.yawGroup.add(foot);
    mesh(new RoundedBoxGeometry(0.25, 0.12, 0.34, 4, 0.055), M.blue, foot, { pos: [0, -0.06, 0.04], shadow: true });
    mesh(new RoundedBoxGeometry(0.27, 0.045, 0.37, 3, 0.02), M.steel, foot, { pos: [0, -0.11, 0.04] });
    mesh(new RoundedBoxGeometry(0.2, 0.07, 0.1, 3, 0.03), M.blueSoft, foot, { pos: [0, -0.07, 0.19] });
    mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 24), M.silver, foot, { pos: [side * 0.13, -0.075, -0.04], rot: [0, 0, Math.PI / 2] });
    mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.025, 12), M.navy, foot, { pos: [side * 0.135, -0.075, -0.04], rot: [0, 0, Math.PI / 2] });
    return { side, hip, leg, bellows, ankle, foot };
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
    this.torso.scale.set(br, 1 + breathe * 0.012, 0.85 * br);

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
      // upper lid follows the gaze a little, like a real eyelid
      eye.upper.rotation.x = -Math.PI / 2 + top * Math.PI - this.eyePitch * 0.35 * (1 - top);
      eye.lower.rotation.x = Math.PI / 2 - bot * Math.PI;
      eye.upperPivot.rotation.z = eye.side * ex.tilt * 0.45;
      eye.lowerPivot.rotation.z = -eye.side * ex.tilt * 0.12;
      eye.ball.rotation.set(-this.eyePitch, this.eyeYaw, 0, 'YXZ');
      eye.socket.scale.setScalar(ex.eye * (1 + (eye.side < 0 ? ex.asym * 0.06 : 0) + this.listen * 0.05));
      const irisScale = Math.max(0.001, 1 - ex.heart);
      eye.iris.scale.set(irisScale, irisScale, 1);
      const pupil = ex.pupil * irisScale;
      eye.pupil.scale.set(pupil, pupil, 1);
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
      ground.set(s * (0.18 + this.sit * 0.05), ANKLE_Y + lift, -0.1 * wa * Math.cos(phs) + this.sit * 0.2);
      // held up: legs hang under the hips, trail the motion and kick a little
      const sw = this.legSwing.value;
      hang.set(hip.x + s * 0.03 + Math.sin(sw) * 0.36, hip.y - Math.cos(sw) * 0.36, hip.z + 0.05 + Math.sin(this.t * 9 + s * 1.6) * 0.08 * this.dangle);
      const ankle = ground.lerp(hang, this.dangle);
      dir.subVectors(ankle, hip);
      const len = Math.max(dir.length(), 0.05);
      dir.divideScalar(len);
      leg.leg.position.copy(hip);
      leg.leg.quaternion.setFromUnitVectors(DOWN, dir);
      leg.bellows.scale.set(1, len, 1);
      leg.ankle.position.copy(ankle);
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
