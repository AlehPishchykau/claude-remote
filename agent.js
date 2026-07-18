require('dotenv').config();
const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'wss://claude.pishchykau.eu';
const AGENT_NAME = process.env.AGENT_NAME || os.userInfo().username + "'s machine";
const AGENT_KEY = process.env.AGENT_KEY || crypto.randomBytes(24).toString('base64url');
const PTY_BRIDGE = path.join(__dirname, 'pty-bridge.py');

const sessions = new Map();
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║         Claude Remote Agent           ║');
console.log('  ╠══════════════════════════════════════╣');
console.log(`  ║  Name:  ${pad(AGENT_NAME, 28)}║`);
console.log(`  ║  Host:  ${pad(os.hostname(), 28)}║`);
console.log(`  ║  Key:   ${pad(AGENT_KEY, 28)}║`);
console.log('  ╠══════════════════════════════════════╣');
console.log(`  ║  Server: ${pad(SERVER_URL, 27)}║`);
console.log('  ╚══════════════════════════════════════╝');
console.log('');
console.log('  Use the key above to connect at the web UI.');
console.log('');

function pad(str, len) {
  if (str.length > len) return str.substring(0, len - 1) + '…';
  return str + ' '.repeat(len - str.length);
}

function connect() {
  const params = new URLSearchParams({
    role: 'agent',
    key: AGENT_KEY,
    name: AGENT_NAME,
    hostname: os.hostname(),
    platform: `${os.platform()}/${os.arch()}`,
  });

  ws = new WebSocket(`${SERVER_URL}?${params}`);

  ws.on('open', () => {
    console.log(`[${ts()}] Connected to server`);
    reconnectDelay = 1000;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'registered':
          console.log(`[${ts()}] Registered as agent ${msg.id}`);
          break;
        case 'create-session':
          createSession(msg.id, msg.cwd, msg.cols, msg.rows);
          break;
        case 'kill-session':
          killSession(msg.id);
          break;
        case 'input': {
          const s = sessions.get(msg.sessionId);
          if (s && s.proc.stdin.writable) s.proc.stdin.write(msg.data);
          break;
        }
        case 'resize': {
          const s = sessions.get(msg.sessionId);
          if (s && s.proc.stdin.writable) {
            s.proc.stdin.write(`\x1b_RESIZE:${msg.cols},${msg.rows}\x1b\\`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[${ts()}] Message error:`, err.message);
    }
  });

  ws.on('close', (code) => {
    ws = null;
    if (code === 4009) {
      console.log(`[${ts()}] Replaced by another agent with the same key`);
    }
    console.log(`[${ts()}] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  });

  ws.on('error', (err) => {
    if (err.code !== 'ECONNREFUSED') {
      console.error(`[${ts()}] Error:`, err.message);
    }
  });
}

function createSession(id, cwd, cols, rows) {
  let workDir = cwd || process.env.HOME;
  if (workDir.startsWith('~')) {
    workDir = workDir.replace(/^~/, process.env.HOME);
  }

  const env = { ...process.env, TERM: 'xterm-256color', PTY_CWD: workDir };
  const localBin = path.join(process.env.HOME, '.local', 'bin');
  if (!env.PATH?.includes(localBin)) {
    env.PATH = localBin + ':' + (env.PATH || '');
  }

  let proc;
  try {
    proc = spawn('python3', [PTY_BRIDGE, String(cols), String(rows), 'claude'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    console.error(`[${ts()}] Session ${id} spawn error:`, err.message);
    send({ type: 'exit', sessionId: id, exitCode: -1 });
    return;
  }

  sessions.set(id, { id, proc, cwd: workDir });
  console.log(`[${ts()}] Session ${id.slice(0, 8)} started in ${workDir}`);

  proc.stdout.on('data', (data) => {
    send({ type: 'output', sessionId: id, data: data.toString('utf-8') });
  });

  proc.stderr.on('data', (data) => {
    send({ type: 'output', sessionId: id, data: data.toString('utf-8') });
  });

  proc.on('exit', (exitCode) => {
    console.log(`[${ts()}] Session ${id.slice(0, 8)} exited (${exitCode})`);
    sessions.delete(id);
    send({ type: 'exit', sessionId: id, exitCode });
  });
}

function killSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.proc.kill('SIGTERM');
    sessions.delete(id);
    console.log(`[${ts()}] Session ${id.slice(0, 8)} killed`);
  }
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function ts() {
  return new Date().toLocaleTimeString();
}

process.on('SIGINT', () => {
  console.log(`\n[${ts()}] Shutting down...`);
  for (const [, session] of sessions) session.proc.kill('SIGTERM');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit();
});

process.on('SIGTERM', () => {
  for (const [, session] of sessions) session.proc.kill('SIGTERM');
  if (ws) ws.close();
  process.exit();
});

connect();
