(function () {
  let token = localStorage.getItem('cr_token');
  let currentSessionId = null;
  let terminal = null;
  let fitAddon = null;
  let ws = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function api(method, path, body) {
    const opts = {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch('/api' + path, opts).then((r) => {
      if (r.status === 401) {
        logout();
        throw new Error('Unauthorized');
      }
      return r.json();
    });
  }

  function showApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    loadSessions();
  }

  function logout() {
    localStorage.removeItem('cr_token');
    token = null;
    location.reload();
  }

  async function loadSessions() {
    const sessions = await api('GET', '/sessions');
    const list = $('#session-list');
    list.innerHTML = '';
    sessions.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      const shortCwd = s.cwd.replace(new RegExp('^/Users/[^/]+'), '~');
      const time = new Date(s.createdAt).toLocaleTimeString();
      div.innerHTML = `
        <div class="session-cwd">
          <span class="session-status ${s.alive ? 'alive' : 'dead'}"></span>
          ${shortCwd}
        </div>
        <div class="session-meta">${time} · ${s.alive ? 'running' : 'exited'}</div>
      `;
      div.addEventListener('click', () => connectToSession(s.id, s));
      list.appendChild(div);
    });
  }

  function connectToSession(id, info) {
    if (ws) {
      ws.close();
      ws = null;
    }

    currentSessionId = id;

    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
    $('#session-bar').classList.remove('hidden');

    const shortCwd = info.cwd.replace(new RegExp('^/Users/[^/]+'), '~');
    $('#session-info').textContent = `${shortCwd} · ${info.id.slice(0, 8)}`;

    if (terminal) {
      terminal.dispose();
    }

    terminal = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 14,
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
    ws = new WebSocket(`${proto}//${location.host}?token=${encodeURIComponent(token)}&session=${id}`);

    ws.addEventListener('open', () => {
      sendResize();
    });

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
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    terminal.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    loadSessions();
  }

  function sendResize() {
    if (fitAddon) {
      fitAddon.fit();
    }
    if (terminal && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'resize',
        cols: terminal.cols,
        rows: terminal.rows,
      }));
    }
  }

  // Auth
  $('#auth-btn').addEventListener('click', () => {
    token = $('#token-input').value.trim();
    if (!token) return;
    localStorage.setItem('cr_token', token);
    api('GET', '/sessions')
      .then(() => showApp())
      .catch(() => {
        alert('Invalid token');
        localStorage.removeItem('cr_token');
      });
  });

  $('#token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-btn').click();
  });

  // New session
  $('#new-session-btn').addEventListener('click', () => {
    $('#new-session-modal').classList.remove('hidden');
    $('#cwd-input').focus();
  });

  $('#cancel-modal').addEventListener('click', () => {
    $('#new-session-modal').classList.add('hidden');
  });

  $('#create-session-btn').addEventListener('click', async () => {
    const cwd = $('#cwd-input').value.trim() || undefined;
    try {
      const session = await api('POST', '/sessions', { cwd: cwd });
      if (session.error) {
        alert('Error: ' + session.error);
        return;
      }
      $('#new-session-modal').classList.add('hidden');
      $('#cwd-input').value = '';
      connectToSession(session.id, session);
    } catch (err) {
      alert('Failed to create session: ' + err.message);
    }
  });

  $('#cwd-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#create-session-btn').click();
    if (e.key === 'Escape') $('#cancel-modal').click();
  });

  // Kill session
  $('#kill-session-btn').addEventListener('click', async () => {
    if (!currentSessionId) return;
    if (!confirm('Kill this session?')) return;
    await api('DELETE', '/sessions/' + currentSessionId);
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

  // Resize
  window.addEventListener('resize', () => {
    if (fitAddon && terminal) {
      fitAddon.fit();
    }
  });

  // Auto-login
  if (token) {
    api('GET', '/sessions')
      .then(() => showApp())
      .catch(() => {
        localStorage.removeItem('cr_token');
        token = null;
      });
  }

  // Refresh sessions periodically
  setInterval(() => {
    if (token && !$('#app').classList.contains('hidden')) {
      loadSessions();
    }
  }, 5000);
})();
