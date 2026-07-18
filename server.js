require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// agents: Map<accessKey, Agent>
// Agent: { id, name, hostname, platform, accessKey, ws, sessions, connectedAt }
const agents = new Map();

// sessions: Map<sessionId, Session>
// Session: { id, agentKey, cwd, createdAt, alive, history, subscribers }
const sessions = new Map();

// rate limiting per IP
const loginAttempts = new Map();
const LOGIN_WINDOW = 60000;
const MAX_ATTEMPTS = 10;

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

function rateLimit(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter((t) => now - t < LOGIN_WINDOW);
  loginAttempts.set(ip, recent);
  if (recent.length >= MAX_ATTEMPTS) return false;
  recent.push(now);
  return true;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

function findAgentByKey(key) {
  return agents.get(key) || null;
}

function authMiddleware(req, res, next) {
  const key = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  const agent = findAgentByKey(key);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid access key' });
  }
  req.agent = agent;
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth', (req, res) => {
  const ip = getClientIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts, try again later' });
  }
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Key required' });
  const agent = findAgentByKey(key);
  if (!agent || !agent.ws || agent.ws.readyState !== 1) {
    return res.status(401).json({ error: 'Invalid key or agent offline' });
  }
  res.json({
    ok: true,
    agent: {
      id: agent.id,
      name: agent.name,
      hostname: agent.hostname,
      platform: agent.platform,
      connectedAt: agent.connectedAt,
    },
  });
});

app.get('/api/agent', authMiddleware, (req, res) => {
  const a = req.agent;
  res.json({
    id: a.id,
    name: a.name,
    hostname: a.hostname,
    platform: a.platform,
    online: a.ws && a.ws.readyState === 1,
    connectedAt: a.connectedAt,
  });
});

app.get('/api/sessions', authMiddleware, (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    if (s.agentKey === req.agent.accessKey) {
      list.push({
        id,
        cwd: s.cwd,
        createdAt: s.createdAt,
        alive: s.alive,
      });
    }
  }
  res.json(list);
});

app.post('/api/sessions', authMiddleware, (req, res) => {
  const agent = req.agent;
  if (!agent.ws || agent.ws.readyState !== 1) {
    return res.status(503).json({ error: 'Agent is offline' });
  }

  const { cwd, cols = 120, rows = 40 } = req.body;
  const id = uuidv4();

  const session = {
    id,
    agentKey: agent.accessKey,
    cwd: cwd || '~',
    createdAt: new Date().toISOString(),
    alive: true,
    history: [],
    subscribers: new Set(),
  };

  sessions.set(id, session);

  agent.ws.send(JSON.stringify({
    type: 'create-session',
    id,
    cwd: session.cwd,
    cols,
    rows,
  }));

  res.json({ id, cwd: session.cwd, createdAt: session.createdAt });
});

app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session || session.agentKey !== req.agent.accessKey) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const agent = req.agent;
  if (agent.ws && agent.ws.readyState === 1) {
    agent.ws.send(JSON.stringify({ type: 'kill-session', id: req.params.id }));
  }

  session.alive = false;
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

// Admin endpoint: list all connected agents
app.get('/api/admin/agents', (req, res) => {
  const key = req.headers['authorization']?.replace('Bearer ', '');
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const list = [];
  for (const [, a] of agents) {
    list.push({
      id: a.id,
      name: a.name,
      hostname: a.hostname,
      platform: a.platform,
      online: a.ws && a.ws.readyState === 1,
      connectedAt: a.connectedAt,
      sessions: [...sessions.values()].filter((s) => s.agentKey === a.accessKey).length,
    });
  }
  res.json(list);
});

function broadcastToSession(sessionId, msg) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const payload = JSON.stringify(msg);
  for (const ws of session.subscribers) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const role = url.searchParams.get('role');

  if (role === 'agent') {
    handleAgentConnection(ws, url);
  } else {
    handleBrowserConnection(ws, url);
  }
});

function handleAgentConnection(ws, url) {
  const accessKey = url.searchParams.get('key');
  const name = url.searchParams.get('name') || 'Unnamed';
  const hostname = url.searchParams.get('hostname') || 'unknown';
  const platform = url.searchParams.get('platform') || 'unknown';

  if (!accessKey || accessKey.length < 16) {
    ws.close(4001, 'Invalid access key');
    return;
  }

  const existing = agents.get(accessKey);
  if (existing && existing.ws && existing.ws.readyState === 1) {
    existing.ws.close(4009, 'Replaced by new connection');
  }

  const agent = {
    id: existing?.id || uuidv4().slice(0, 8),
    name,
    hostname,
    platform,
    accessKey,
    ws,
    connectedAt: new Date().toISOString(),
  };

  agents.set(accessKey, agent);
  console.log(`[agent] ${name} (${hostname}) connected`);

  ws.send(JSON.stringify({ type: 'registered', id: agent.id }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg.sessionId) return;

      const session = sessions.get(msg.sessionId);
      if (!session || session.agentKey !== accessKey) return;

      if (msg.type === 'output') {
        session.history.push(msg.data);
        if (session.history.length > 10000) {
          session.history = session.history.slice(-5000);
        }
        broadcastToSession(msg.sessionId, { type: 'output', data: msg.data });
      } else if (msg.type === 'exit') {
        session.alive = false;
        broadcastToSession(msg.sessionId, { type: 'exit', exitCode: msg.exitCode });
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log(`[agent] ${name} (${hostname}) disconnected`);
    for (const [, session] of sessions) {
      if (session.agentKey === accessKey && session.alive) {
        session.alive = false;
        broadcastToSession(session.id, { type: 'exit', exitCode: -1 });
      }
    }
  });

  ws.on('error', () => {});
}

function handleBrowserConnection(ws, url) {
  const accessKey = url.searchParams.get('token');
  const sessionId = url.searchParams.get('session');

  const agent = findAgentByKey(accessKey);
  if (!agent) {
    ws.close(4001, 'Invalid access key');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session || session.agentKey !== accessKey) {
    ws.close(4004, 'Session not found');
    return;
  }

  session.subscribers.add(ws);

  const recentHistory = session.history.slice(-2000).join('');
  if (recentHistory) {
    ws.send(JSON.stringify({ type: 'history', data: recentHistory }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!session.alive) return;

      if (agent.ws && agent.ws.readyState === 1) {
        agent.ws.send(JSON.stringify({ ...msg, sessionId }));
      }
    } catch {}
  });

  ws.on('close', () => {
    session.subscribers.delete(ws);
  });

  ws.on('error', () => {});
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of loginAttempts) {
    const recent = attempts.filter((t) => now - t < LOGIN_WINDOW);
    if (recent.length === 0) loginAttempts.delete(ip);
    else loginAttempts.set(ip, recent);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`Claude Remote server on http://localhost:${PORT}`);
});
