const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'wss://claude.pishchykau.eu';
const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
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
          createSession(msg.id, msg.cwd, msg.cols, msg.rows, msg.resumeId);
          break;
        case 'kill-session':
          killSession(msg.id);
          break;
        case 'request':
          handleRequest(msg);
          break;
        case 'input': {
          const s = sessions.get(msg.sessionId);
          if (s && s.proc && s.proc.stdin.writable) s.proc.stdin.write(msg.data);
          break;
        }
        case 'resize': {
          const s = sessions.get(msg.sessionId);
          if (s && s.proc && s.proc.stdin.writable) {
            s.proc.stdin.write(`\x1b_RESIZE:${msg.cols},${msg.rows}\x1b\\`);
          }
          break;
        }
        case 'create-chat-session':
          createChatSession(msg.id, msg.cwd, msg.resumeId);
          break;
        case 'chat-message':
          handleChatMessage(msg.sessionId, msg.text, msg.images);
          break;
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

function buildEnv(cwd) {
  const env = { ...process.env, TERM: 'xterm-256color', PTY_CWD: cwd };
  const localBin = path.join(process.env.HOME, '.local', 'bin');
  if (!env.PATH?.includes(localBin)) {
    env.PATH = localBin + ':' + (env.PATH || '');
  }
  return env;
}

function resolveDir(cwd) {
  let workDir = cwd || process.env.HOME;
  if (workDir.startsWith('~')) {
    workDir = workDir.replace(/^~/, process.env.HOME);
  }
  return workDir;
}

function createSession(id, cwd, cols, rows, resumeId) {
  const workDir = resolveDir(cwd);
  const env = buildEnv(workDir);
  const cmd = resumeId ? ['claude', '--resume', resumeId] : ['claude'];

  let proc;
  try {
    proc = spawn('python3', [PTY_BRIDGE, String(cols), String(rows), ...cmd], {
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
  if (session && session.proc) {
    session.proc.kill('SIGTERM');
  }
  sessions.delete(id);
  chatSessions.delete(id);
  console.log(`[${ts()}] Session ${id.slice(0, 8)} killed`);
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

function ts() {
  return new Date().toLocaleTimeString();
}

// ── Conversation history ──

const CLAUDE_PROJECTS = path.join(process.env.HOME, '.claude', 'projects');

function resolveProjectDir(dir) {
  const parts = dir.slice(1).split('-');
  let resolved = '';
  let i = 0;
  while (i < parts.length) {
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const segment = parts.slice(i, j).join('-');
      const test = resolved + '/' + segment;
      if (fs.existsSync(test)) {
        resolved = test;
        i = j;
        found = true;
        break;
      }
    }
    if (!found) {
      resolved += '/' + parts[i];
      i++;
    }
  }
  return resolved;
}

async function handleRequest(msg) {
  const { reqId, action, params } = msg;
  try {
    let data;
    if (action === 'list-conversations') data = await listConversations();
    else if (action === 'get-conversation') data = await getConversation(params.file);
    else if (action === 'delete-conversation') data = deleteConversation(params.file);
    else { sendResponse(reqId, null, 'Unknown action'); return; }
    sendResponse(reqId, data);
  } catch (err) {
    sendResponse(reqId, null, err.message);
  }
}

function sendResponse(reqId, data, error) {
  send({ type: 'response', reqId, data, error });
}

async function listConversations() {
  const projects = [];
  if (!fs.existsSync(CLAUDE_PROJECTS)) return projects;

  for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const jsonls = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    if (jsonls.length === 0) continue;

    const projectPath = resolveProjectDir(dir);
    const projectName = projectPath
      .replace(/^\/Users\/[^/]+\//, '')
      .replace(/^\/home\/[^/]+\//, '');

    const convos = [];
    for (const jf of jsonls) {
      const filePath = path.join(dirPath, jf);
      const sessionId = jf.replace('.jsonl', '');
      const stat = fs.statSync(filePath);
      let aiTitle = '';
      let lastPrompt = '';
      let msgCount = 0;

      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'ai-title') aiTitle = obj.aiTitle || '';
          if (obj.type === 'last-prompt') lastPrompt = obj.lastPrompt || '';
          if (obj.type === 'user' || obj.type === 'assistant') msgCount++;
        } catch {}
      }

      convos.push({
        sessionId,
        file: path.join(dir, jf),
        cwd: projectPath,
        title: aiTitle || lastPrompt.slice(0, 80) || sessionId.slice(0, 8),
        lastPrompt: lastPrompt.slice(0, 100),
        msgCount,
        updatedAt: stat.mtime.toISOString(),
      });
    }

    convos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    projects.push({ name: projectName, dir, conversations: convos });
  }

  projects.sort((a, b) => {
    const aMax = a.conversations[0]?.updatedAt || '';
    const bMax = b.conversations[0]?.updatedAt || '';
    return bMax.localeCompare(aMax);
  });

  return projects;
}

async function getConversation(file) {
  const filePath = path.join(CLAUDE_PROJECTS, file);
  if (!filePath.startsWith(CLAUDE_PROJECTS)) throw new Error('Invalid path');
  if (!fs.existsSync(filePath)) throw new Error('Not found');

  const messages = [];
  let aiTitle = '';

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'ai-title') {
        aiTitle = obj.aiTitle || '';
        continue;
      }
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      if (!obj.message) continue;

      const content = obj.message.content;

      if (typeof content === 'string') {
        if (content.trim()) messages.push({ role: obj.type, text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'thinking') continue;
          if (block.type === 'text') {
            const t = block.text?.trim();
            if (t) messages.push({ role: obj.type === 'user' ? 'user' : 'assistant', text: t });
          } else if (block.type === 'tool_use') {
            let input = '';
            if (block.name === 'Bash') input = block.input?.command || '';
            else if (block.name === 'Read') input = block.input?.file_path || '';
            else if (block.name === 'Edit' || block.name === 'Write') input = block.input?.file_path || '';
            else input = JSON.stringify(block.input || {}).slice(0, 200);
            messages.push({
              role: 'tool',
              tool: block.name,
              toolId: block.id,
              description: block.input?.description || '',
              input: input.slice(0, 500),
            });
          } else if (block.type === 'tool_result') {
            const prev = messages[messages.length - 1];
            if (prev && prev.role === 'tool' && prev.toolId === block.tool_use_id) {
              let out = '';
              if (typeof block.content === 'string') out = block.content;
              else if (Array.isArray(block.content)) {
                out = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
              }
              prev.output = out.slice(0, 1000);
            }
          }
        }
      }
    } catch {}
  }

  return { title: aiTitle, messages };
}

function deleteConversation(file) {
  const filePath = path.join(CLAUDE_PROJECTS, file);
  if (!filePath.startsWith(CLAUDE_PROJECTS)) throw new Error('Invalid path');
  if (!fs.existsSync(filePath)) throw new Error('Not found');
  fs.unlinkSync(filePath);
  return { ok: true };
}

// ── Chat sessions (structured JSON mode) ──

const chatSessions = new Map();

function createChatSession(id, cwd, resumeId) {
  const workDir = resolveDir(cwd);
  chatSessions.set(id, { id, cwd: workDir, claudeSessionId: resumeId || null, busy: false });
  console.log(`[${ts()}] Chat session ${id.slice(0, 8)} created (claude: ${resumeId ? resumeId.slice(0, 8) : 'new'})`);
  send({ type: 'chat-session-ready', sessionId: id, cwd: workDir, claudeSessionId: resumeId || null });
}

function handleChatMessage(sessionId, text, images) {
  const session = chatSessions.get(sessionId);
  if (!session) { send({ type: 'chat-error', sessionId, error: 'Session not found' }); return; }
  if (session.busy) { send({ type: 'chat-error', sessionId, error: 'Busy' }); return; }

  session.busy = true;
  send({ type: 'chat-thinking', sessionId });

  const savedFiles = [];
  if (images && images.length > 0) {
    const tmpDir = path.join(os.tmpdir(), 'claude-remote-images');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    for (const img of images) {
      const ext = img.mimeType.split('/')[1] || 'png';
      const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = path.join(tmpDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(img.base64, 'base64'));
      savedFiles.push(filePath);
    }
  }

  let prompt = text || '';
  if (savedFiles.length > 0) {
    const fileRefs = savedFiles.map(f => f).join(', ');
    if (prompt) {
      prompt = prompt + '\n\n[Attached images: ' + fileRefs + '] Use the Read tool to view them.';
    } else {
      prompt = '[Attached images: ' + fileRefs + '] Use the Read tool to view and describe them.';
    }
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  }

  const env = buildEnv(session.cwd);
  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: session.cwd,
  });

  let buffer = '';
  let lastTextLen = 0;
  let sentToolIds = new Set();

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.content) {
          if (obj.session_id && !session.claudeSessionId) {
            session.claudeSessionId = obj.session_id;
            console.log(`[${ts()}] Chat ${sessionId.slice(0, 8)} got claude session: ${obj.session_id.slice(0, 8)}`);
          }
          let fullText = '';
          for (const block of obj.message.content) {
            if (block.type === 'text') {
              fullText += block.text;
            } else if (block.type === 'tool_use' && !sentToolIds.has(block.id)) {
              sentToolIds.add(block.id);
              send({ type: 'chat-tool', sessionId, tool: block.name, input: block.input });
            }
          }
          if (fullText.length > lastTextLen) {
            const delta = fullText.slice(lastTextLen);
            lastTextLen = fullText.length;
            send({ type: 'chat-text', sessionId, text: delta, done: false });
          }
        } else if (obj.type === 'result') {
          if (obj.session_id && !session.claudeSessionId) {
            session.claudeSessionId = obj.session_id;
            console.log(`[${ts()}] Chat ${sessionId.slice(0, 8)} got claude session: ${obj.session_id.slice(0, 8)}`);
          }
          send({ type: 'chat-text', sessionId, text: '', done: true });
        }
      } catch {}
    }
  });

  proc.stderr.on('data', () => {});

  proc.on('exit', (code) => {
    session.busy = false;
    send({ type: 'chat-done', sessionId, exitCode: code });
  });

  proc.stdin.write(prompt);
  proc.stdin.end();
}

process.on('SIGINT', () => {
  console.log(`\n[${ts()}] Shutting down...`);
  for (const [, session] of sessions) {
    if (session.proc) session.proc.kill('SIGTERM');
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit();
});

process.on('SIGTERM', () => {
  for (const [, session] of sessions) {
    if (session.proc) session.proc.kill('SIGTERM');
  }
  if (ws) ws.close();
  process.exit();
});

connect();
