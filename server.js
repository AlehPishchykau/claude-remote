require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

const sessions = new Map();
let agentWs = null;
let activeToken = null;

app.use(express.json());

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') ||
    req.query.token;
  if (!activeToken || token !== activeToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', authMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ agentOnline: agentWs !== null && agentWs.readyState === 1 });
});

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
  if (!agentWs || agentWs.readyState !== 1) {
    return res.status(503).json({ error: 'Agent is offline' });
  }

  const { cwd, cols = 120, rows = 40 } = req.body;
  const id = uuidv4();

  const session = {
    id,
    cwd: cwd || '~',
    createdAt: new Date().toISOString(),
    alive: true,
    history: [],
    subscribers: new Set(),
  };

  sessions.set(id, session);

  agentWs.send(JSON.stringify({
    type: 'create-session',
    id,
    cwd: session.cwd,
    cols,
    rows,
  }));

  res.json({ id, cwd: session.cwd, createdAt: session.createdAt });
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (agentWs && agentWs.readyState === 1) {
    agentWs.send(JSON.stringify({ type: 'kill-session', id: req.params.id }));
  }

  session.alive = false;
  sessions.delete(req.params.id);
  res.json({ ok: true });
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
    const token = url.searchParams.get('token');
    if (!token || token.length < 8) {
      ws.close(4001, 'Invalid token');
      return;
    }

    if (agentWs && agentWs.readyState === 1) {
      agentWs.close(4009, 'Replaced by new agent');
    }
    agentWs = ws;
    activeToken = token;
    sessions.clear();
    console.log('[agent] connected, access key set');

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const session = sessions.get(msg.sessionId);
        if (!session) return;

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
      console.log('[agent] disconnected');
      if (agentWs === ws) {
        agentWs = null;
        activeToken = null;
      }
      for (const [, session] of sessions) {
        if (session.alive) {
          session.alive = false;
          broadcastToSession(session.id, { type: 'exit', exitCode: -1 });
        }
      }
    });

    return;
  }

  // Browser client
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('session');

  if (!activeToken || token !== activeToken) {
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

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!session.alive) return;

      if (agentWs && agentWs.readyState === 1) {
        agentWs.send(JSON.stringify({
          ...msg,
          sessionId,
        }));
      }
    } catch {}
  });

  ws.on('close', () => {
    session.subscribers.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Claude Remote server on http://localhost:${PORT}`);
});
