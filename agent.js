require('dotenv').config();
const crypto = require('crypto');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'wss://claude.pishchykau.eu';
const AGENT_TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(24).toString('base64url');
const PTY_BRIDGE = path.join(__dirname, 'pty-bridge.py');

const sessions = new Map();
let ws = null;
let reconnectTimer = null;

console.log('');
console.log('  Claude Remote Agent');
console.log('  ───────────────────────────────────');
console.log(`  Server:     ${SERVER_URL}`);
console.log(`  Access key: ${AGENT_TOKEN}`);
console.log('  ───────────────────────────────────');
console.log('  Use this key to log in at the web UI');
console.log('');

function connect() {
  const url = `${SERVER_URL}?role=agent&token=${encodeURIComponent(AGENT_TOKEN)}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[agent] Connected to server');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'create-session') {
        createSession(msg.id, msg.cwd, msg.cols, msg.rows);
      } else if (msg.type === 'kill-session') {
        killSession(msg.id);
      } else if (msg.type === 'input') {
        const session = sessions.get(msg.sessionId);
        if (session && session.proc.stdin.writable) {
          session.proc.stdin.write(msg.data);
        }
      } else if (msg.type === 'resize') {
        const session = sessions.get(msg.sessionId);
        if (session && session.proc.stdin.writable) {
          session.proc.stdin.write(`\x1b_RESIZE:${msg.cols},${msg.rows}\x1b\\`);
        }
      }
    } catch (err) {
      console.error('[agent] message error:', err.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[agent] Disconnected (${code}). Reconnecting in 3s...`);
    ws = null;
    reconnectTimer = setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('[agent] WebSocket error:', err.message);
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
    console.error(`[session ${id}] spawn error:`, err.message);
    sendToServer({ type: 'exit', sessionId: id, exitCode: -1 });
    return;
  }

  const session = { id, proc };
  sessions.set(id, session);

  proc.stdout.on('data', (data) => {
    sendToServer({ type: 'output', sessionId: id, data: data.toString('utf-8') });
  });

  proc.stderr.on('data', (data) => {
    sendToServer({ type: 'output', sessionId: id, data: data.toString('utf-8') });
  });

  proc.on('exit', (exitCode) => {
    console.log(`[session ${id}] exited (${exitCode})`);
    sessions.delete(id);
    sendToServer({ type: 'exit', sessionId: id, exitCode });
  });

  console.log(`[session ${id}] started in ${workDir}`);
}

function killSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.proc.kill('SIGTERM');
    sessions.delete(id);
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  for (const [, session] of sessions) {
    session.proc.kill('SIGTERM');
  }
  if (ws) ws.close();
  process.exit();
});

connect();
