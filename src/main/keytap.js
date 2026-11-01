'use strict';
// Double-tapping the left Control key starts voice input. Electron's shortcuts can't see
// a lone modifier key, so a small Swift helper (build/keytap, from src/native/keytap.swift)
// watches the keyboard and prints a line per double tap.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, config } = require('./config');

const KEYTAP = path.join(ROOT, 'build', 'keytap');
let proc = null;

// `send` delivers commands to the renderer: 'listen', and the permission notices.
function start(send) {
  if (!config.doubleCtrl || process.platform !== 'darwin' || !fs.existsSync(KEYTAP)) return;
  proc = spawn(KEYTAP, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  proc.stdout.setEncoding('utf8');
  let waitingForPermission = false;
  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.split('\n').filter(Boolean)) {
      if (line === 'double-ctrl') send('command', 'listen');
      else if (line === 'need-permission') {
        console.log('keytap: waiting for Input Monitoring permission');
        waitingForPermission = true;
        send('command', 'keytap-permission');
      } else if (line === 'ready' && waitingForPermission) send('command', 'keytap-ready');
    }
  });
  proc.on('exit', () => (proc = null));
}

function stop() {
  proc?.kill();
}

module.exports = { start, stop };
