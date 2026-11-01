import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Robot, HEAD_Y } from './robot3d.js';
import { Particles } from './fx.js';
import { ChatUI } from './chatui.js';
import { Sound, Voice } from './sound.js';
import { Listener } from './listen.js';
import { clamp, damp, rand, pick } from './springs.js';

// The window covers the whole work area; the WebGL canvas is only as big as the robot
// and follows it around. World positions below are screen pixels, S.y is the feet.

const api = window.blu ?? previewApi();
const UNIT = 95; // px per scene unit at scale 1
const VIEW = { w: 420, h: 480, ground: 48 }; // canvas size at scale 1, ground offset from its bottom
const GRAVITY = 30; // units/s^2
const ROBOT_H = 2.5; // units, feet to antenna tip
const SLEEP_AFTER = 150; // seconds without interaction (60 at night)
const TILT = 0.17; // camera looks slightly down

main();

async function main() {
  const cfg = await api.getConfig();
  const scale = cfg.scale;
  const ppu = UNIT * scale;

  // ---------------------------------------------------------------- stage
  const canvas = document.getElementById('stage');
  const cw = Math.round(VIEW.w * scale);
  const ch = Math.round(VIEW.h * scale);
  const groundPx = VIEW.ground * scale;
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(cw, ch, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // refreshed manually, see frame()

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.OrthographicCamera(-cw / 2 / ppu, cw / 2 / ppu, (ch - groundPx) / ppu, -groundPx / ppu, 0.1, 60);
  camera.position.set(0, Math.sin(TILT) * 25, Math.cos(TILT) * 25);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x3a4660, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-1.6, 6, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3.2, bottom: -1, near: 0.5, far: 15 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfe4ff, 1.6);
  rim.position.set(3, 3, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffeedd, 0.5);
  fill.position.set(4, 1, 3);
  scene.add(fill);

  // floor: a shadow catcher plus a soft contact blob, both invisible otherwise
  const floor = new THREE.Group();
  scene.add(floor);
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(5, 3), new THREE.ShadowMaterial({ opacity: 0.13 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  floor.add(catcher);
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.8),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.45 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.003;
  floor.add(blob);

  const robot = new Robot();
  scene.add(robot.root);
  const fx = new Particles(scene);
  const sound = new Sound();
  const voice = new Voice(api, sound);
  const applySettings = (s) => {
    sound.enabled = s.sounds;
    voice.enabled = s.voice && Boolean(api.tts);
    voice.setVolume(s.voiceVolume ?? 1);
  };
  applySettings(cfg.settings ?? { voice: false, sounds: true });
  api.on('settings', applySettings);

  // ---------------------------------------------------------------- state
  const floorY = () => innerHeight - 4;
  const margin = 0.8 * ppu;
  const S = {
    x: innerWidth * 0.72,
    y: -40,
    vx: 0,
    vy: 0,
    mode: 'air', // idle | walk | sit | sleep | drag | air
    modeT: 0,
    targetX: 0,
    facing: 0,
    decideIn: 3,
    sitFor: 0,
    mood: 'neutral',
    moodUntil: 0,
    lastInteraction: performance.now(),
    cursor: { x: -9999, y: -9999, movedAt: 0 },
    press: null,
    grab: { dx: 0, dy: 0 },
    hovering: false,
    hoverT: 0,
    petting: 0,
    interactive: false,
    vel: { x: 0, y: 0 },
    acc: { x: 0, y: 0 },
    prev: { x: 0, y: 0 },
    jumpCharge: 0,
    thrown: false,
    entered: false,
    dizzy: 0,
    danceT: 0,
    clicks: [],
    wander: new THREE.Vector3(0, HEAD_Y, 8),
    wanderIn: 0,
    emitT: 0,
    startledAt: 0,
    listen: 'off', // 'off' | 'listening' | 'transcribing'
  };
  S.prev = { x: S.x, y: S.y };

  const isGround = () => ['idle', 'walk', 'sit', 'sleep'].includes(S.mode);
  const setMode = (mode) => {
    S.mode = mode;
    S.modeT = 0;
  };
  const touch = () => (S.lastInteraction = performance.now());
  const setMood = (name, seconds = 6) => {
    S.mood = name;
    S.moodUntil = performance.now() + seconds * 1000;
  };
  const toPx = (v) => ({ x: S.x + v.x * ppu, y: S.y - v.y * ppu });
  const anchorPx = (name) => toPx(robot.anchor(name));

  // ---------------------------------------------------------------- chat
  const chat = new ChatUI(api, {
    name: cfg.name,
    canListen: Boolean(cfg.asr),
    onMic: () => listen(),
    onChars: () => sound.babble(robot.emotion),
    onShow: () => sound.play('pop'),
    onEmotion: (name, seconds) => setMood(name, seconds),
    onGesture: (name) => doGesture(name),
    onFirstText: () => {
      if (S.mood === 'thinking') setMood('neutral', 6);
    },
    onOpen: () => {
      touch();
      if (S.mode === 'sleep') wake();
      if (S.mode === 'walk' || S.mode === 'sit') setMode('idle');
    },
  }, voice);

  // ---------------------------------------------------------------- voice input
  const listener = new Listener(sound);
  const setListen = (state) => {
    S.listen = state;
    chat.setListening(state);
  };

  // Press once to talk; recording stops by itself when you pause (or press again).
  async function listen() {
    if (S.listen === 'listening') return listener.stop();
    if (S.listen === 'transcribing') return;
    if (!cfg.asr) return chat.say('[sad] ยังไม่ได้ติดตั้งระบบฟังเสียง (Typhoon ASR ใน .venv) นะ');
    touch();
    voice.stop(); // don't record our own voice
    if (!chat.isOpen) chat.open();
    if (!(await api.micAccess())) {
      return chat.say('[sad] เข้าถึงไมค์ไม่ได้ ช่วยอนุญาตไมค์ให้แอปใน System Settings → Privacy & Security → Microphone หน่อยนะ');
    }
    setListen('listening');
    sound.play('listenOn');
    let wav;
    try {
      wav = await listener.record();
    } catch (err) {
      setListen('off');
      return chat.say(`[sad] เปิดไมค์ไม่ได้ (${err.message})`);
    }
    sound.play('listenOff');
    if (!wav) {
      setListen('off');
      return chat.say('[confused] ไม่ได้ยินอะไรเลย ลองพูดอีกทีนะ');
    }
    setListen('transcribing');
    setMood('thinking', 15);
    const res = await api.transcribe(wav);
    setListen('off');
    if (res.error) return chat.say(`[sad] ฟังไม่ออก (${res.error})`);
    if (!res.text) return chat.say('[confused] ไม่ได้ยินชัดเลย พูดอีกทีได้ไหม');
    chat.send(res.text);
  }

  function doGesture(name) {
    if (name === 'jump') return hop();
    if (robot.play(name) && name === 'dance') S.danceT = 4.2;
  }

  function hop() {
    if ((S.mode === 'idle' || S.mode === 'walk') && S.jumpCharge <= 0) S.jumpCharge = 0.14;
  }

  function sleep() {
    setMode('sleep');
    sound.play('sleep');
  }

  const isNight = () => {
    const h = new Date().getHours();
    return h >= 22 || h < 6;
  };

  function wake() {
    setMode('idle');
    setMood('surprised', 1.2);
    sound.play('wake');
    setTimeout(() => {
      robot.play('stretch');
      setMood('happy', 4);
    }, 1200);
  }

  function walkTo(x) {
    S.targetX = clamp(x, margin, innerWidth - margin);
    if (Math.abs(S.targetX - S.x) > 10) setMode('walk');
  }

  // ---------------------------------------------------------------- behaviour
  function decide() {
    S.decideIn = rand(3, 8);
    const recent = performance.now() - S.cursor.movedAt < 4000;
    const near = recent && Math.hypot(S.cursor.x - S.x, S.cursor.y - S.y) < 400;
    const r = Math.random();
    if (near && r < 0.25) return robot.play('wave');
    // curious: wander over to where you're working near the bottom of the screen
    const cursorLow = S.cursor.y > innerHeight - 3.5 * ppu;
    if (recent && cursorLow && Math.abs(S.cursor.x - S.x) > 3 * ppu && Math.random() < 0.35) {
      return walkTo(S.cursor.x - Math.sign(S.cursor.x - S.x) * 1.3 * ppu);
    }
    if (isNight() && r < 0.2) return robot.play('stretch');
    if (r < 0.45) {
      let x;
      do x = rand(margin, innerWidth - margin);
      while (Math.abs(x - S.x) < 160 && innerWidth > 600);
      return walkTo(x);
    }
    if (r < 0.57) return robot.play('lookaround');
    if (r < 0.64) return robot.play('stretch');
    if (r < 0.74) {
      setMode('sit');
      S.sitFor = rand(8, 20);
      return;
    }
    if (r < 0.78) return doGesture('dance');
    if (r < 0.82) return hop();
  }

  function behave(dt) {
    const now = performance.now();
    const idleFor = (now - S.lastInteraction) / 1000;
    const busy = chat.isOpen || chat.busy;
    const sleepAfter = isNight() ? 60 : SLEEP_AFTER;
    S.modeT += dt;

    switch (S.mode) {
      case 'idle':
        S.facing = 0;
        S.vx = damp(S.vx, 0, 8, dt);
        if (busy) break;
        if (idleFor > sleepAfter) {
          sleep();
          break;
        }
        if ((S.decideIn -= dt) <= 0) decide();
        break;
      case 'walk': {
        const dx = S.targetX - S.x;
        S.facing = Math.sign(dx) || S.facing;
        if (Math.abs(dx) < 4 || busy) {
          setMode('idle');
          break;
        }
        const speed = 0.95 * ppu;
        // don't stride off until the body has turned toward where it's going
        const go = robot.isFacing(S.facing) ? 1 : 0.1;
        S.vx = damp(S.vx, Math.sign(dx) * speed * clamp(Math.abs(dx) / (0.7 * ppu), 0.3, 1) * go, 4, dt);
        break;
      }
      case 'sit':
        S.facing = 0;
        S.vx = 0;
        if (busy || S.modeT > S.sitFor) setMode('idle');
        if (idleFor > sleepAfter) sleep();
        break;
      case 'sleep':
        S.facing = 0;
        S.vx = 0;
        break;
    }

    if (S.jumpCharge > 0 && (S.jumpCharge -= dt) <= 0) {
      S.vy = -Math.sqrt(2 * GRAVITY * 0.6) * ppu;
      S.thrown = false;
      setMode('air');
      robot.kick(-2.4);
      robot.play('jump');
    }
  }

  function physics(dt) {
    const floor = floorY();
    if (isGround()) {
      S.x = clamp(S.x + S.vx * dt, margin, innerWidth - margin);
      S.y = floor;
      return;
    }
    if (S.mode === 'drag') {
      S.x = damp(S.x, S.cursor.x + S.grab.dx, 30, dt);
      S.y = Math.min(damp(S.y, S.cursor.y + S.grab.dy, 30, dt), floor);
      return;
    }
    // airborne
    S.vy += GRAVITY * ppu * dt;
    S.x += S.vx * dt;
    S.y += S.vy * dt;
    const minX = 0.5 * ppu;
    const maxX = innerWidth - 0.5 * ppu;
    if (S.x < minX || S.x > maxX) {
      S.x = clamp(S.x, minX, maxX);
      S.vx = -S.vx * 0.5;
      robot.kick(0.8);
    }
    if (S.y - ROBOT_H * ppu < 0 && S.vy < 0 && S.entered) {
      S.y = ROBOT_H * ppu;
      S.vy = -S.vy * 0.3;
    }
    if (S.y >= floor) {
      S.y = floor;
      const impact = S.vy / ppu;
      robot.kick(Math.min(impact * 0.2, 5));
      if (impact > 7) {
        S.vy = -S.vy * 0.32;
        S.vx *= 0.6;
        sound.play('boing');
        return;
      }
      if (impact > 2) sound.play('land');
      S.vy = 0;
      S.vx = 0;
      setMode('idle');
      S.decideIn = rand(2, 4);
      if (S.thrown && S.peakSpeed > 20 * ppu) {
        S.dizzy = 2.8;
        spawnDizzyStars();
        sound.play('dizzy');
        setTimeout(() => chat.say('[confused] โลกหมุนติ้วเลย... [shy] อย่าโยนแรงสิ'), 600);
      }
      if (!S.entered) {
        S.entered = true;
        setTimeout(greet, 500);
      }
      S.thrown = false;
    }
    S.peakSpeed = Math.max(S.peakSpeed || 0, Math.hypot(S.vx, S.vy));
  }

  // While the voice is still loading, the bubble shows "waking up…" until it can speak.
  function greet() {
    const how = cfg.asr && cfg.doubleCtrl ? 'คลิกที่ตัวเรา หรือกด Ctrl ซ้ายสองครั้ง' : 'คลิกที่ตัวเรา';
    chat.say(`[happy][wave] สวัสดี! เราชื่อ ${cfg.name} ${how}เพื่อคุยกันได้เลยนะ`);
  }

  // ---------------------------------------------------------------- speech models
  // The models unload after a long idle and reload on demand; say so while they do.
  let speechState = cfg.speech ?? 'off';
  let speechSince = performance.now();
  api.on('speech-state', (state) => {
    // reloading after a nap: yawn and stretch so the wait reads as "waking up"
    if (state === 'loading' && speechState === 'asleep' && isGround() && S.mode !== 'sleep') {
      robot.play('stretch');
      setMood('sleepy', 4);
    }
    speechState = state;
    speechSince = performance.now();
  });

  function wakeStatus(now) {
    const secs = Math.round((now - speechSince) / 1000);
    if (speechState === 'loading' && voice.enabled && chat.busy) return `กำลังตื่น… โหลดเสียงพูด ${secs} วิ`;
    if (speechState !== 'ready' && S.listen === 'transcribing') return `กำลังตื่น… โหลดระบบฟัง ${secs} วิ`;
    return '';
  }

  function spawnDizzyStars() {
    for (let i = 0; i < 3; i++) {
      fx.emit('star', 0, 0, {
        life: 2.8,
        size: 0.17,
        orbit: {
          rx: 0.55 * ppu,
          ry: 0.12 * ppu,
          speed: 5,
          center: () => {
            const p = anchorPx('head');
            return { x: p.x, y: p.y - 0.62 * ppu };
          },
        },
      });
      fx.items.at(-1).phase = (i / 3) * Math.PI * 2;
    }
  }

  // ---------------------------------------------------------------- emotes
  const EMITS = {
    love: ['heart', 0.5, 'top'],
    sad: ['tear', 2.2, 'eye'],
    angry: ['steam', 0.38, 'top'],
    confused: ['question', 1.7, 'top'],
    excited: ['spark', 0.22, 'head'],
    happy: ['spark', 1.5, 'head'],
    thinking: ['dot', 0.7, 'top'],
  };
  let shownEmotion = 'neutral';

  function emotes(dt, emotion) {
    if (emotion !== shownEmotion) {
      if (emotion === 'surprised') fx.emit('bang', anchorPx('top').x + 0.4 * ppu, anchorPx('top').y);
      if (emotion === 'love') sound.play('love');
      shownEmotion = emotion;
      S.emitT = 0;
    }
    let spec = EMITS[emotion];
    if (S.mode === 'sleep') spec = ['z', 1.2, 'top'];
    if (S.danceT > 0) spec = ['note', 0.35, 'top'];
    if (!spec || (S.emitT -= dt) > 0) return;
    const [kind, every, where] = spec;
    S.emitT = every * rand(0.8, 1.2);
    if (where === 'eye') {
      const p = anchorPx(Math.random() < 0.5 ? 'eyeL' : 'eyeR');
      fx.emit(kind, p.x, p.y + 0.1 * ppu);
    } else if (where === 'head') {
      const p = anchorPx('head');
      fx.emit(kind, p.x + rand(-0.7, 0.7) * ppu, p.y + rand(-0.6, 0.3) * ppu);
    } else {
      const p = anchorPx('top');
      fx.emit(kind, p.x + rand(-0.25, 0.4) * ppu, p.y - 0.1 * ppu);
    }
  }

  // ---------------------------------------------------------------- input
  const hitRobot = (x, y) => Math.abs(x - S.x) < 0.62 * ppu && y > S.y - ROBOT_H * ppu && y < S.y + 6;

  function setInteractive(on) {
    if (on === S.interactive) return;
    S.interactive = on;
    api.setIgnoreMouse(!on);
  }

  function onCursor(x, y) {
    const now = performance.now();
    if (x !== S.cursor.x || y !== S.cursor.y) {
      const dist = Math.hypot(x - S.cursor.x, y - S.cursor.y);
      const gap = now - S.cursor.movedAt;
      if (S.hovering) S.petting += dist;
      const calm = isGround() && S.mode !== 'sleep' && !chat.busy;
      // you came back after a while away: say hi
      if (gap > 60000 && calm) {
        robot.play('wave');
        sound.play('hello');
        setMood('happy', 3);
      }
      // a fast swipe right past its face makes it flinch
      const swipe = gap < 100 && (dist / Math.max(gap, 16)) * 1000 > 2500;
      if (swipe && calm && now - S.startledAt > 6000 && Math.hypot(x - S.x, y - (S.y - 1.6 * ppu)) < 1.6 * ppu) {
        S.startledAt = now;
        setMood('surprised', 1.2);
        robot.kick(-1.2);
        sound.play('pop');
      }
      S.cursor.movedAt = now;
    }
    S.cursor.x = x;
    S.cursor.y = y;
    if (S.press && S.mode !== 'drag' && Math.hypot(x - S.press.x, y - S.press.y) > 6) startDrag();
    S.hovering = S.mode !== 'drag' && hitRobot(x, y);
    const overChat = chat.hit(x, y);
    setInteractive(Boolean(S.press) || S.mode === 'drag' || S.hovering || overChat);
  }

  function startDrag() {
    if (S.mode === 'sleep') S.lastInteraction = 0;
    setMode('drag');
    S.grab = { dx: S.press.ox, dy: S.press.oy };
    S.jumpCharge = 0;
    robot.wobble(1);
    sound.play('pickup');
    touch();
  }

  function onClickRobot() {
    touch();
    robot.wobble(1.4, new THREE.Vector3(0, 0.3, 1));
    sound.play('boop');
    const now = performance.now();
    S.clicks = S.clicks.filter((t) => now - t < 1400).concat(now);
    if (S.mode === 'sleep') {
      wake();
      chat.say('[surprised] หา! เราไม่ได้หลับนะ... [sleepy] แค่พักสายตาเฉยๆ');
      return;
    }
    if (S.clicks.length >= 4) {
      S.clicks = [];
      setMood('angry', 3);
      robot.play('shake');
      sound.play('angry');
      chat.say(pick(['[angry] จิ้มบ่อยๆ ก็เจ็บนะ!', '[angry] เฮ้! พอได้แล้ว', '[angry] จั๊กจี้นะ! หยุดเลย']));
      return;
    }
    if (S.mode === 'sit' || S.mode === 'walk') setMode('idle');
    robot.play('nod');
    if (chat.isOpen) chat.input.focus();
    else chat.open();
  }

  api.on('cursor', ({ x, y }) => onCursor(x, y));
  addEventListener('mousemove', (e) => onCursor(e.clientX, e.clientY));
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !hitRobot(e.clientX, e.clientY)) return;
    e.preventDefault();
    S.press = { x: e.clientX, y: e.clientY, ox: S.x - e.clientX, oy: S.y - e.clientY };
    setInteractive(true);
  });
  addEventListener('mouseup', () => {
    if (!S.press) return;
    const wasDrag = S.mode === 'drag';
    S.press = null;
    if (wasDrag) {
      S.vx = clamp(S.vel.x, -40 * ppu, 40 * ppu);
      S.vy = clamp(S.vel.y, -40 * ppu, 40 * ppu);
      S.thrown = Math.hypot(S.vx, S.vy) > 3 * ppu;
      S.peakSpeed = Math.hypot(S.vx, S.vy);
      if (S.thrown) sound.play('whee');
      setMode('air');
    } else onClickRobot();
    onCursor(S.cursor.x, S.cursor.y);
  });
  addEventListener('contextmenu', (e) => {
    if (!hitRobot(e.clientX, e.clientY)) return;
    e.preventDefault();
    api.showMenu();
  });

  api.on('window-blur', () => chat.close());
  api.on('command', (cmd) => {
    touch();
    if (cmd === 'chat') return chat.open();
    if (cmd === 'listen') return listen();
    if (cmd === 'keytap-ready') return chat.say('[excited] ได้สิทธิ์แล้ว! กด Ctrl ซ้ายสองครั้งเพื่อคุยกับเราได้เลย');
    if (cmd === 'keytap-permission') {
      return setTimeout(
        () => chat.say('[shy] ถ้าอยากกด Ctrl ซ้ายสองครั้งเพื่อเรียกเรา ต้องเปิดสิทธิ์ Input Monitoring ให้ "keytap" ก่อนนะ (System Settings → Privacy & Security → Input Monitoring)'),
        14000,
      );
    }
    if (S.mode === 'sleep' && cmd !== 'sleep') wake();
    if (cmd === 'dance') doGesture('dance');
    if (cmd === 'come') walkTo(innerWidth / 2);
    if (cmd === 'sleep') S.mode === 'sleep' ? wake() : sleep();
    if (cmd === 'forget') chat.say('[confused] เอ๊ะ... เมื่อกี้เราคุยอะไรกันอยู่นะ? [happy] เริ่มใหม่กันเลย!');
  });

  // ---------------------------------------------------------------- frame
  const lookAt = new THREE.Vector3();

  function currentEmotion(now) {
    if (S.mode === 'sleep') return 'sleepy';
    if (S.mode === 'drag') return S.modeT < 0.45 ? 'surprised' : 'excited';
    if (S.mode === 'air' && S.thrown) return 'excited';
    if (S.dizzy > 0) return 'confused';
    if (now > S.moodUntil && !chat.busy) S.mood = 'neutral';
    if (S.hovering && !chat.busy) {
      if (S.petting > 900) return 'love';
      if (S.mood === 'neutral' && S.hoverT > 0.25) return 'happy';
    }
    return S.mood;
  }

  function chooseLook(dt, now) {
    // listening: look right at you
    if (S.listen === 'listening') return lookAt.set(0, HEAD_Y + 0.2, 8);
    if (chat.isOpen) {
      // watch the words appear while you type, otherwise look at the box
      const c = now - chat.typedAt < 1500 ? chat.caretPoint() : chat.inputCenter();
      return lookAt.set((c.x - S.x) / ppu, (S.y - c.y) / ppu, 3);
    }
    const fresh = now - S.cursor.movedAt < 4000;
    if (fresh && Math.abs(S.cursor.x - S.x) < 1400) {
      return lookAt.set((S.cursor.x - S.x) / ppu, (S.y - S.cursor.y) / ppu, 3.2);
    }
    if ((S.wanderIn -= dt) <= 0) {
      S.wanderIn = rand(1.5, 4);
      if (Math.random() < 0.35) S.wander.set(0, HEAD_Y, 8); // look at the viewer
      else S.wander.set(rand(-3, 3), HEAD_Y + rand(-0.6, 1.2), rand(2, 5));
    }
    return lookAt.copy(S.wander);
  }

  // Drawing is nearly all of the cost, so only run at full rate while something is
  // moving quickly; standing around (breathing, blinking) looks the same at 30fps.
  function frameInterval(now) {
    if (S.mode === 'sleep') return 64;
    const busy =
      S.mode === 'walk' || S.mode === 'drag' || S.mode === 'air' || S.jumpCharge > 0 || S.dizzy > 0 ||
      chat.talking || S.listen !== 'off' || robot.gesture || now - S.cursor.movedAt < 1500 || robot.jellyAmp > 0.004 || Math.abs(robot.yaw.vel) > 0.05;
    return busy ? 0 : 30;
  }

  let last = performance.now();
  let shadowTick = 0;
  function frame(now) {
    if (now - last < frameInterval(now)) return requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000) || 1 / 60;
    last = now;
    // the shadow map only needs refreshing every other frame
    renderer.shadowMap.needsUpdate = shadowTick++ % 2 === 0;

    behave(dt);
    physics(dt);

    // velocity & acceleration from actual motion (covers walking, dragging, flying)
    S.vel.x = damp(S.vel.x, (S.x - S.prev.x) / dt, 25, dt);
    S.vel.y = damp(S.vel.y, (S.y - S.prev.y) / dt, 25, dt);
    const ax = (S.vel.x - (S.prevVel?.x ?? 0)) / dt;
    const ay = (S.vel.y - (S.prevVel?.y ?? 0)) / dt;
    S.acc.x = damp(S.acc.x, ax, 30, dt);
    S.acc.y = damp(S.acc.y, ay, 30, dt);
    S.prev = { x: S.x, y: S.y };
    S.prevVel = { x: S.vel.x, y: S.vel.y };

    S.dizzy = Math.max(0, S.dizzy - dt);
    S.danceT = Math.max(0, S.danceT - dt);
    S.hoverT = S.hovering ? S.hoverT + dt : 0;
    if (!S.hovering) S.petting = Math.max(0, S.petting - 400 * dt);
    if (S.hovering) touch();

    const emotion = currentEmotion(now);
    robot.setEmotion(emotion);
    chat.setStatus(wakeStatus(now));
    chat.update(dt, now);

    robot.update(dt, {
      speed: isGround() ? S.vx / ppu : 0,
      accel: { x: S.acc.x / ppu, y: -S.acc.y / ppu },
      facing: S.mode === 'walk' ? S.facing : 0,
      lookAt: chooseLook(dt, now),
      mode: S.mode === 'drag' ? 'drag' : S.mode === 'air' ? 'air' : S.mode === 'sit' ? 'sit' : S.mode === 'sleep' ? 'sleep' : 'ground',
      talking: chat.talking,
      talkLevel: chat.level,
      listening: S.listen === 'listening',
      listenLevel: listener.level,
      anticipate: S.jumpCharge > 0,
    });
    emotes(dt, emotion);
    fx.update(dt, S.x, S.y, ppu);

    // floor stays on the real floor when the robot is in the air
    const lift = (floorY() - S.y) / ppu;
    floor.position.y = -lift;
    const near = clamp(1 - lift / 3, 0, 1);
    blob.material.opacity = 0.45 * near;
    blob.scale.setScalar(0.6 + 0.4 * near);

    canvas.style.transform = `translate3d(${S.x - cw / 2}px, ${S.y - (ch - groundPx)}px, 0)`;
    renderer.render(scene, camera);
    chat.layout(S.x, S.y, ppu, dt);
    if (S.listen === 'listening') chat.setMicLevel(listener.level);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (!window.blu || location.search.includes('debug')) enableDevKeys({ robot, S, setMood, doGesture, chat, setMode, renderer, scene, voice });
}

function blobTexture() {
  const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(10, 20, 40, 0.9)');
  g.addColorStop(0.5, 'rgba(10, 20, 40, 0.35)');
  g.addColorStop(1, 'rgba(10, 20, 40, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Lets index.html run in a normal browser (no Electron) with a canned reply, for
// working on the visuals.
function previewApi() {
  const handlers = {};
  return {
    getConfig: async () => ({ name: 'Blu', scale: Number(new URLSearchParams(location.search).get('scale')) || 1, model: 'preview' }),
    setIgnoreMouse() {},
    focus() {},
    showMenu() {},
    abort() {},
    chat(id) {
      const reply = '[happy][wave] สวัสดี! นี่คือโหมดพรีวิว ยังไม่ได้ต่อ Ollama [thinking] ลองรันผ่าน Electron ด้วย npm start ดูนะ';
      let i = 0;
      const timer = setInterval(() => {
        if (i >= reply.length) {
          clearInterval(timer);
          handlers['chat:done']?.({ id });
          return;
        }
        handlers['chat:chunk']?.({ id, content: reply.slice(i, (i += 5)) });
      }, 60);
    },
    on(channel, fn) {
      handlers[channel] = fn;
    },
  };
}

function enableDevKeys(ctx) {
  const emotions = ['neutral', 'happy', 'excited', 'love', 'sad', 'angry', 'surprised', 'thinking', 'confused', 'sleepy', 'shy'];
  const gestures = { w: 'wave', n: 'nod', s: 'shake', d: 'dance', j: 'jump', h: 'shrug', p: 'spin', t: 'stretch', l: 'lookaround' };
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const i = '1234567890-'.indexOf(e.key);
    if (i >= 0) ctx.setMood(emotions[i], 30);
    if (gestures[e.key]) ctx.doGesture(gestures[e.key]);
  });
  window.__blu = ctx;
}
