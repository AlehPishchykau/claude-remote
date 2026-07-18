require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const PTY_BRIDGE = path.join(__dirname, 'pty-bridge.py');

const sessions = new Map();

app.use(express.json());

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') ||
    req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      alive: session.alive,
    });
  }
  res.json(list);
});

app.post('/api/sessions', (req, res) => {
  const { cwd, cols = 120, rows = 40 } = req.body;
  const id = uuidv4();
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
    return res.status(500).json({ error: err.message });
  }

  if (!proc.pid) {
    return res.status(500).json({ error: 'Failed to start process' });
  }

  const session = {
    id,
    cwd: workDir,
    createdAt: new Date().toISOString(),
    alive: true,
    proc,
    history: [],
    subscribers: new Set(),
  };

  proc.stdout.on('data', (data) => {
    const str = data.toString('utf-8');
    session.history.push(str);
    if (session.history.length > 10000) {
      session.history = session.history.slice(-5000);
    }
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'output', data: str }));
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const str = data.toString('utf-8');
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'output', data: str }));
      }
    }
  });

  proc.on('exit', (exitCode) => {
    session.alive = false;
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    }
  });

  sessions.set(id, session);
  res.json({ id, cwd: workDir, createdAt: session.createdAt });
});

app.post('/api/sessions/:id/resize', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const { cols, rows } = req.body;
  if (session.alive && session.proc.stdin.writable) {
    session.proc.stdin.write(`\x1b_RESIZE:${cols},${rows}\x1b\\`);
  }
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.proc.kill('SIGTERM');
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('session');

  if (token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(4004, 'Session not found');
    return;
  }

  session.subscribers.add(ws);

  const recentHistory = session.history.slice(-2000).join('');
  if (recentHistory) {
    ws.send(JSON.stringify({ type: 'history', data: recentHistory }));
  }

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'input' && session.alive) {
        session.proc.stdin.write(parsed.data);
      } else if (parsed.type === 'resize' && session.alive) {
        session.proc.stdin.write(`\x1b_RESIZE:${parsed.cols},${parsed.rows}\x1b\\`);
      }
    } catch {}
  });

  ws.on('close', () => {
    session.subscribers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Claude Remote running on http://localhost:${PORT}`);

  if (process.argv.includes('--tunnel')) {
    startTunnel();
  }
});

function startTunnel() {
  const tunnelName = process.env.TUNNEL_NAME;
  const tunnelConfig = process.env.TUNNEL_CONFIG;
  let tunnelArgs;

  if (tunnelName) {
    tunnelArgs = ['tunnel'];
    if (tunnelConfig) tunnelArgs.push('--config', tunnelConfig);
    tunnelArgs.push('run', tunnelName);
    console.log(`[tunnel] Starting named tunnel: ${tunnelName}`);
  } else {
    tunnelArgs = ['tunnel', '--url', `http://localhost:${PORT}`];
    console.log('[tunnel] Starting quick tunnel...');
  }

  const tunnel = spawn('cloudflared', tunnelArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnel.stderr.on('data', (data) => {
    const line = data.toString();
    const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      console.log(`\n  Tunnel URL: ${urlMatch[0]}\n`);
    }
    if (line.includes('ERR') || line.includes('failed')) {
      console.error('[tunnel]', line.trim());
    }
  });

  tunnel.on('exit', (code) => {
    console.error(`[tunnel] cloudflared exited with code ${code}`);
    if (code !== 0) {
      console.log('[tunnel] Retrying in 5s...');
      setTimeout(startTunnel, 5000);
    }
  });

  process.on('SIGINT', () => {
    tunnel.kill();
    process.exit();
  });

  process.on('SIGTERM', () => {
    tunnel.kill();
    process.exit();
  });
}
