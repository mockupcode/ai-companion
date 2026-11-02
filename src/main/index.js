'use strict';
// Blu: a desktop robot companion. One transparent, click-through window covers the
// primary display's work area; the renderer draws the robot and turns mouse capture on
// only while the cursor is over the robot or its chat UI.
const { app, BrowserWindow, screen, ipcMain, Menu, Tray, nativeImage, globalShortcut, systemPreferences } = require('electron');
const path = require('path');
const { config, readState, writeState } = require('./config');
const chat = require('./chat');
const speech = require('./speech');
const keytap = require('./keytap');
const music = require('./music');

let win = null;
let tray = null;
let settings = { voice: true, sounds: true, voiceVolume: 1, musicVolume: 1 }; // menu toggles, remembered

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  writeState('settings.json', settings);
  send('settings', settings);
  tray?.setContextMenu(buildMenu());
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...workArea,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('console-message', (event) => console.log('[renderer]', event.message));
  win.on('blur', () => send('window-blur'));
}

function fitToDisplay() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(screen.getPrimaryDisplay().workArea);
}

// The renderer only receives forwarded mouse events while the pointer is over the
// window, so poll the global cursor too: it drives eye tracking and hover detection.
function startCursorFeed() {
  let last = null;
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    if (last && p.x === last.x && p.y === last.y) return;
    last = p;
    const b = win.getBounds();
    send('cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 33);
}

const volumeMenu = (label, key, levels) => ({
  label,
  submenu: levels.map(([name, v]) => ({ label: name, type: 'radio', checked: settings[key] === v, click: () => setSetting(key, v) })),
});

function buildMenu() {
  const song = music.nowPlaying();
  return Menu.buildFromTemplate([
    { label: `คุยกับ ${config.name}`, accelerator: config.shortcut, click: () => send('command', 'chat') },
    {
      label: config.doubleCtrl ? 'พูดด้วยเสียง 🎤  (Ctrl ซ้าย 2 ครั้ง)' : 'พูดด้วยเสียง 🎤',
      accelerator: config.talkShortcut,
      enabled: speech.asrAvailable(),
      click: () => send('command', 'listen'),
    },
    { label: 'เต้นหน่อย', click: () => send('command', 'dance') },
    { label: 'นอน / ตื่น', click: () => send('command', 'sleep') },
    { label: 'มากลางจอหน่อย', click: () => send('command', 'come') },
    {
      label: song ? `หยุดเพลง: ${song.title.length > 40 ? `${song.title.slice(0, 40)}…` : song.title}` : 'หยุดเพลง',
      enabled: Boolean(song),
      click: () => music.stop(),
    },
    { type: 'separator' },
    { label: 'พูดออกเสียง', type: 'checkbox', checked: settings.voice, click: (item) => setSetting('voice', item.checked) },
    volumeMenu('ความดังเสียงพูด', 'voiceVolume', [['เบา', 0.6], ['ปกติ', 1], ['ดัง', 1.5], ['ดังที่สุด', 1.8]]),
    volumeMenu('ความดังเพลง', 'musicVolume', [['เบา', 0.5], ['ปกติ', 1], ['ดัง', 1.5], ['ดังที่สุด', 2]]),
    { label: 'เสียงเอฟเฟกต์', type: 'checkbox', checked: settings.sounds, click: (item) => setSetting('sounds', item.checked) },
    {
      label: 'ล้างความจำการคุย',
      click: () => {
        chat.forget();
        send('command', 'forget');
      },
    },
    { label: `Model: ${config.model}`, enabled: false },
    { type: 'separator' },
    { label: 'ออก', click: () => app.quit() },
  ]);
}

function registerIpc() {
  ipcMain.handle('get-config', () => ({
    name: config.name,
    scale: config.scale,
    model: config.model,
    settings,
    asr: speech.asrAvailable(),
    doubleCtrl: config.doubleCtrl && process.platform === 'darwin',
    speech: speech.speechState(),
  }));
  ipcMain.handle('tts', (_e, text) => (settings.voice ? speech.synthesize(String(text).slice(0, 600)) : null));
  ipcMain.handle('asr', (_e, wav) => speech.transcribe(wav));
  ipcMain.handle('mic-access', () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true,
  );
  ipcMain.on('set-ignore-mouse', (_e, ignore) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true });
  });
  ipcMain.on('focus', () => {
    if (process.platform === 'darwin') app.focus({ steal: true });
    win?.focus();
  });
  ipcMain.on('context-menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('chat:send', (_e, { id, text }) => chat.streamChat(id, text, send));
  ipcMain.on('chat:abort', () => chat.abort());
  ipcMain.on('music:ended', () => music.ended());
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🤖');
  tray.setToolTip(config.name);
  tray.setContextMenu(buildMenu());
}

function registerShortcuts() {
  const shortcuts = [[config.shortcut, 'chat']];
  if (speech.asrAvailable()) shortcuts.push([config.talkShortcut, 'listen']);
  for (const [accelerator, command] of shortcuts) {
    if (accelerator && !globalShortcut.register(accelerator, () => send('command', command))) {
      console.warn(`Could not register shortcut ${accelerator}`);
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock.hide();
    settings = { ...settings, ...readState('settings.json', {}) };
    chat.loadHistory();
    speech.init(send);
    music.init(send, {
      changed: () => tray?.setContextMenu(buildMenu()),
      volume: () => settings.musicVolume,
      setVolume: (v) => setSetting('musicVolume', v),
    });
    registerIpc();
    createWindow();
    createTray();
    startCursorFeed();
    registerShortcuts();
    speech.start(); // load the voice and ASR models in the background right away
    if (speech.asrAvailable()) keytap.start(send);
    screen.on('display-metrics-changed', fitToDisplay);
    screen.on('display-added', fitToDisplay);
    screen.on('display-removed', fitToDisplay);
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    chat.abort(); // stops a song download too
    speech.stop();
    keytap.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
