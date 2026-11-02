'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['cursor', 'command', 'settings', 'speech-state', 'window-blur', 'music', 'chat:chunk', 'chat:tool', 'chat:done', 'chat:error'];

contextBridge.exposeInMainWorld('blu', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  focus: () => ipcRenderer.send('focus'),
  showMenu: () => ipcRenderer.send('context-menu'),
  chat: (id, text) => ipcRenderer.send('chat:send', { id, text }),
  abort: () => ipcRenderer.send('chat:abort'),
  tts: (text) => ipcRenderer.invoke('tts', text),
  transcribe: (wav) => ipcRenderer.invoke('asr', wav),
  micAccess: () => ipcRenderer.invoke('mic-access'),
  musicEnded: () => ipcRenderer.send('music:ended'),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
