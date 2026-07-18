(function () {
  let accessKey = localStorage.getItem('cr_key');
  let agentInfo = null;
  let currentSessionId = null;
  let terminal = null;
  let fitAddon = null;
  let ws = null;

  const $ = (sel) => document.querySelector(sel);

  function api(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Bearer ' + accessKey,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch('/api' + path, opts).then(async (r) => {
      const data = await r.json();
      if (r.status === 401) {
        logout();
        throw new Error(data.error || 'Unauthorized');
      }
      if (!r.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
  }

  // ── Auth ──

  async function tryLogin(key) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    return data;
  }

  function showApp(agent) {
    agentInfo = agent;
    $('#auth-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    updateAgentCard();
    loadSessions();
  }

  function logout() {
    localStorage.removeItem('cr_key');
    accessKey = null;
    agentInfo = null;
    location.reload();
  }

  function showAuthError(msg) {
    const el = $('#auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // ── Agent ──

  function updateAgentCard() {
    if (!agentInfo) return;
    $('#agent-name').textContent = agentInfo.name;
    $('#agent-dot').className = 'dot online';
    $('#agent-meta').textContent = `${agentInfo.hostname} · ${agentInfo.platform}`;
  }

  async function checkAgent() {
    try {
      const agent = await api('GET', '/agent');
      agentInfo = agent;
      $('#agent-dot').className = agent.online ? 'dot online' : 'dot offline';
      if (!agent.online) {
        $('#agent-meta').textContent = 'Agent disconnected';
      } else {
        $('#agent-meta').textContent = `${agent.hostname} · ${agent.platform}`;
      }
    } catch {
      $('#agent-dot').className = 'dot offline';
    }
  }

  // ── Sessions ──

  async function loadSessions() {
    try {
      const sessions = await api('GET', '/sessions');
      renderSessions(sessions);
    } catch {}
  }

  function renderSessions(sessions) {
    const list = $('#session-list');
    list.innerHTML = '';
    if (sessions.length === 0) {
      list.innerHTML = '<div style="padding: 12px 12px; font-size: 12px; color: var(--fg-muted)">No sessions</div>';
      return;
    }
    sessions.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      const shortCwd = s.cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
      const time = new Date(s.createdAt).toLocaleTimeString();
      div.innerHTML = `
        <div class="session-cwd">
          <span class="dot ${s.alive ? 'online' : 'offline'}"></span>
          ${escapeHtml(shortCwd)}
        </div>
        <div class="session-meta">${time} · ${s.alive ? 'running' : 'exited'}</div>
      `;
      div.addEventListener('click', () => connectToSession(s.id, s));
      list.appendChild(div);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Terminal ──

  function connectToSession(id, info) {
    if (ws) { ws.close(); ws = null; }
    currentSessionId = id;

    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
    $('#session-bar').classList.remove('hidden');

    const shortCwd = info.cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
    $('#session-info').textContent = `${shortCwd} · ${id.slice(0, 8)}`;

    if (terminal) terminal.dispose();

    terminal = new Terminal({
      theme: {
        background: '#0f1117',
        foreground: '#c8d3f5',
        cursor: '#c8d3f5',
        selectionBackground: '#2d3f76',
        black: '#1b1d2b',
        red: '#ff5370',
        green: '#c3e88d',
        yellow: '#ffcb6b',
        blue: '#82aaff',
        magenta: '#c792ea',
        cyan: '#89ddff',
        white: '#a9b8e8',
        brightBlack: '#444a73',
        brightRed: '#ff5370',
        brightGreen: '#c3e88d',
        brightYellow: '#ffcb6b',
        brightBlue: '#82aaff',
        brightMagenta: '#c792ea',
        brightCyan: '#89ddff',
        brightWhite: '#c8d3f5',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon.WebLinksAddon());

    const container = $('#terminal-container');
    container.innerHTML = '';
    terminal.open(container);
    fitAddon.fit();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(accessKey)}&session=${id}`);

    ws.addEventListener('open', () => fitAddon.fit());

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'output' || msg.type === 'history') {
        terminal.write(msg.data);
      } else if (msg.type === 'exit') {
        terminal.write('\r\n\x1b[31m[Session exited]\x1b[0m\r\n');
        loadSessions();
      }
    });

    ws.addEventListener('close', () => {
      terminal.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
    });

    terminal.onData((data) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });

    terminal.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    loadSessions();
  }

  // ── Event listeners ──

  $('#auth-btn').addEventListener('click', async () => {
    const key = $('#token-input').value.trim();
    if (!key) return;
    try {
      const result = await tryLogin(key);
      accessKey = key;
      localStorage.setItem('cr_key', key);
      showApp(result.agent);
    } catch (err) {
      showAuthError(err.message);
    }
  });

  $('#token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-btn').click();
    $('#auth-error').classList.add('hidden');
  });

  function openNewSessionModal() {
    $('#new-session-modal').classList.remove('hidden');
    $('#cwd-input').focus();
  }

  $('#new-session-btn').addEventListener('click', openNewSessionModal);
  $('#empty-new-btn').addEventListener('click', openNewSessionModal);

  $('#cancel-modal').addEventListener('click', () => {
    $('#new-session-modal').classList.add('hidden');
  });

  $('#create-session-btn').addEventListener('click', async () => {
    const cwd = $('#cwd-input').value.trim() || undefined;
    try {
      const session = await api('POST', '/sessions', { cwd });
      $('#new-session-modal').classList.add('hidden');
      $('#cwd-input').value = '';
      connectToSession(session.id, session);
    } catch (err) {
      alert(err.message);
    }
  });

  $('#cwd-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#create-session-btn').click();
    if (e.key === 'Escape') $('#cancel-modal').click();
  });

  $('#kill-session-btn').addEventListener('click', async () => {
    if (!currentSessionId) return;
    if (!confirm('Kill this session?')) return;
    try {
      await api('DELETE', '/sessions/' + currentSessionId);
    } catch {}
    currentSessionId = null;
    if (ws) ws.close();
    if (terminal) terminal.dispose();
    terminal = null;
    $('#terminal-container').classList.add('hidden');
    $('#session-bar').classList.add('hidden');
    $('#no-session').classList.remove('hidden');
    loadSessions();
  });

  $('#logout-btn').addEventListener('click', logout);

  window.addEventListener('resize', () => {
    if (fitAddon && terminal) fitAddon.fit();
  });

  // ── Init ──

  if (accessKey) {
    tryLogin(accessKey)
      .then((result) => showApp(result.agent))
      .catch(() => {
        localStorage.removeItem('cr_key');
        accessKey = null;
      });
  }

  setInterval(() => {
    if (accessKey && !$('#app').classList.contains('hidden')) {
      loadSessions();
      checkAgent();
    }
  }, 5000);
})();
