(function () {
  let accessKey = localStorage.getItem('cr_key');
  let agentInfo = null;
  let currentSessionId = null;
  let terminal = null;
  let fitAddon = null;
  let ws = null;
  let recognition = null;
  let isRecording = false;

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
    loadHistory();
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
    $('#agent-meta').textContent = '· ' + agentInfo.hostname;
    $('#topbar-title').textContent = agentInfo.name;
  }

  async function checkAgent() {
    try {
      const agent = await api('GET', '/agent');
      agentInfo = agent;
      $('#agent-dot').className = agent.online ? 'dot online' : 'dot offline';
      $('#agent-name').textContent = agent.online ? agent.name : 'Disconnected';
      $('#agent-meta').textContent = agent.online ? '· ' + agent.hostname : '';
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
      list.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--fg-dim)">No sessions</div>';
      return;
    }
    sessions.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === currentSessionId ? ' active' : '');
      const shortCwd = shortenPath(s.cwd);
      const time = new Date(s.createdAt).toLocaleTimeString();
      const status = s.alive ? 'running' : 'exited';
      div.innerHTML =
        '<div class="session-cwd"><span class="dot ' + (s.alive ? 'online' : 'offline') + '"></span>' +
        escapeHtml(shortCwd) + '</div>' +
        '<div class="session-meta">' + time + ' · ' + status + '</div>';
      div.addEventListener('click', () => {
        openSession(s.id, s);
        closeSidebar();
      });
      list.appendChild(div);
    });
  }

  function shortenPath(p) {
    return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Terminal ──

  function setupTerminal() {
    if (terminal) terminal.dispose();

    const isMob = window.innerWidth <= 768;

    terminal = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#444',
        black: '#1a1a1a',
        red: '#e55',
        green: '#6c6',
        yellow: '#ec6',
        blue: '#7c9bf5',
        magenta: '#c79bf5',
        cyan: '#6cc',
        white: '#ccc',
        brightBlack: '#666',
        brightRed: '#f77',
        brightGreen: '#8d8',
        brightYellow: '#fd8',
        brightBlue: '#9ab5f7',
        brightMagenta: '#d9b5f7',
        brightCyan: '#8dd',
        brightWhite: '#e0e0e0',
      },
      fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: isMob ? 11 : 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon.WebLinksAddon());

    const container = $('#terminal-container');
    container.innerHTML = '';
    terminal.open(container);
    fitAddon.fit();

    return { cols: terminal.cols, rows: terminal.rows };
  }

  function connectWebSocket(sessionId) {
    if (ws) { ws.close(); ws = null; }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '?token=' + encodeURIComponent(accessKey) + '&session=' + sessionId);

    ws.addEventListener('open', () => {
      fitAddon.fit();
      // Send correct dimensions immediately
      if (terminal) {
        ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
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
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });

    terminal.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
  }

  function openSession(id, info) {
    currentSessionId = id;

    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
    $('#session-bar').classList.remove('hidden');
    $('#voice-btn').classList.remove('hidden');

    const shortCwd = shortenPath(info.cwd);
    $('#session-info').textContent = shortCwd + ' · ' + id.slice(0, 8);

    setupTerminal();
    connectWebSocket(id);
    loadSessions();
  }

  function sendTextToTerminal(text) {
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }

  // ── Sidebar ──

  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#sidebar-overlay').classList.remove('hidden');
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebar-overlay').classList.add('hidden');
  }

  // ── Voice ──

  function initVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      $('#voice-btn').style.display = 'none';
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalText += event.results[i][0].transcript;
        }
      }
      if (finalText) sendTextToTerminal(finalText);
    };

    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.error('Speech error:', event.error);
      }
      stopRecording();
    };

    recognition.onend = () => {
      if (isRecording) {
        try { recognition.start(); } catch {}
      }
    };
  }

  function startRecording() {
    if (!recognition || isRecording) return;
    isRecording = true;
    try { recognition.start(); } catch { isRecording = false; return; }
    $('#voice-btn').classList.add('recording');
    $('#voice-indicator').classList.remove('hidden');
  }

  function stopRecording() {
    if (!recognition) return;
    isRecording = false;
    try { recognition.stop(); } catch {}
    $('#voice-btn').classList.remove('recording');
    $('#voice-indicator').classList.add('hidden');
  }

  function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
  }

  // ── History ──

  let currentConvoFile = null;
  let currentConvoCwd = null;
  let historyData = null;

  async function loadHistory() {
    try {
      historyData = await api('GET', '/conversations');
      renderHistoryList();
    } catch {}
  }

  function renderHistoryList() {
    const list = $('#history-list');
    list.innerHTML = '';
    if (!historyData || historyData.length === 0) {
      list.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:var(--fg-dim)">No history</div>';
      return;
    }
    for (const proj of historyData) {
      const header = document.createElement('div');
      header.className = 'history-project';
      header.textContent = proj.name;
      list.appendChild(header);

      for (const c of proj.conversations.slice(0, 5)) {
        const div = document.createElement('div');
        div.className = 'history-item';
        div.textContent = c.title;
        div.addEventListener('click', () => {
          openConversation(c, c.cwd);
          closeSidebar();
        });
        list.appendChild(div);
      }
    }
  }

  async function openConversation(convo, cwd) {
    currentConvoFile = convo.file;
    currentConvoCwd = cwd || null;
    // Hide other views
    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.add('hidden');
    $('#session-bar').classList.add('hidden');
    $('#voice-btn').classList.add('hidden');
    $('#voice-indicator').classList.add('hidden');
    // Show history view
    $('#history-view').classList.remove('hidden');
    $('#history-title').textContent = convo.title;
    $('#history-messages').innerHTML = '<div style="padding:20px;color:var(--fg-dim)">Loading...</div>';

    try {
      const data = await api('GET', '/conversations/' + encodeURIComponent(convo.file));
      renderConversation(data);
    } catch (err) {
      $('#history-messages').innerHTML = '<div style="padding:20px;color:var(--red)">' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderConversation(data) {
    const container = $('#history-messages');
    container.innerHTML = '';

    for (const msg of data.messages) {
      // Skip tool-only messages
      const text = msg.text.trim();
      if (!text) continue;

      const div = document.createElement('div');
      div.className = 'msg';

      const role = document.createElement('div');
      role.className = 'msg-role ' + msg.role;
      role.textContent = msg.role === 'user' ? 'You' : 'Claude';

      const body = document.createElement('div');
      body.className = 'msg-text';

      // Replace [tool: xxx] with styled spans
      const processed = escapeHtml(text).replace(
        /\[tool: ([^\]]+)\]/g,
        '<span class="tool-ref">[tool: $1]</span>'
      );
      body.innerHTML = processed;

      div.appendChild(role);
      div.appendChild(body);
      container.appendChild(div);
    }

    container.scrollTop = container.scrollHeight;
  }

  function closeHistory() {
    $('#history-view').classList.add('hidden');
    currentConvoFile = null;
    currentConvoCwd = null;
    if (currentSessionId) {
      $('#terminal-container').classList.remove('hidden');
      $('#session-bar').classList.remove('hidden');
      $('#voice-btn').classList.remove('hidden');
    } else {
      $('#no-session').classList.remove('hidden');
    }
  }

  // ── Events ──

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
    closeSidebar();
    $('#new-session-modal').classList.remove('hidden');
    setTimeout(() => $('#cwd-input').focus(), 100);
  }

  $('#new-session-btn').addEventListener('click', openNewSessionModal);
  $('#empty-new-btn').addEventListener('click', openNewSessionModal);
  $('#topbar-new-btn').addEventListener('click', openNewSessionModal);

  $('#cancel-modal').addEventListener('click', () => {
    $('#new-session-modal').classList.add('hidden');
  });

  $('#create-session-btn').addEventListener('click', async () => {
    const cwd = $('#cwd-input').value.trim() || undefined;
    $('#new-session-modal').classList.add('hidden');
    $('#cwd-input').value = '';

    // Show terminal area and measure real dimensions
    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
    $('#session-bar').classList.remove('hidden');
    $('#voice-btn').classList.remove('hidden');

    const dims = setupTerminal();

    try {
      const session = await api('POST', '/sessions', {
        cwd,
        cols: dims.cols,
        rows: dims.rows,
      });
      currentSessionId = session.id;
      const shortCwd = shortenPath(session.cwd);
      $('#session-info').textContent = shortCwd + ' · ' + session.id.slice(0, 8);
      connectWebSocket(session.id);
      loadSessions();
    } catch (err) {
      alert(err.message);
      if (terminal) terminal.dispose();
      terminal = null;
      $('#terminal-container').classList.add('hidden');
      $('#session-bar').classList.add('hidden');
      $('#voice-btn').classList.add('hidden');
      $('#no-session').classList.remove('hidden');
    }
  });

  $('#cwd-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#create-session-btn').click();
    if (e.key === 'Escape') $('#cancel-modal').click();
  });

  $('#kill-session-btn').addEventListener('click', async () => {
    if (!currentSessionId) return;
    if (!confirm('Kill this session?')) return;
    try { await api('DELETE', '/sessions/' + currentSessionId); } catch {}
    currentSessionId = null;
    if (ws) ws.close();
    if (terminal) terminal.dispose();
    terminal = null;
    $('#terminal-container').classList.add('hidden');
    $('#session-bar').classList.add('hidden');
    $('#voice-btn').classList.add('hidden');
    $('#voice-indicator').classList.add('hidden');
    stopRecording();
    $('#no-session').classList.remove('hidden');
    loadSessions();
  });

  $('#logout-btn').addEventListener('click', () => { closeSidebar(); logout(); });

  $('#menu-btn').addEventListener('click', openSidebar);
  $('#sidebar-close-btn').addEventListener('click', closeSidebar);
  $('#sidebar-overlay').addEventListener('click', closeSidebar);

  // History
  $('#history-back').addEventListener('click', closeHistory);
  $('#history-resume').addEventListener('click', async () => {
    if (!currentConvoFile || !currentConvoCwd) return;
    const sessionId = currentConvoFile.split('/').pop().replace('.jsonl', '');
    const cwd = currentConvoCwd;

    closeHistory();

    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
    $('#session-bar').classList.remove('hidden');
    $('#voice-btn').classList.remove('hidden');

    const dims = setupTerminal();

    try {
      const session = await api('POST', '/sessions', {
        cwd,
        cols: dims.cols,
        rows: dims.rows,
        resumeId: sessionId,
      });
      currentSessionId = session.id;
      $('#session-info').textContent = shortenPath(session.cwd) + ' · ' + session.id.slice(0, 8);
      connectWebSocket(session.id);
      loadSessions();
    } catch (err) {
      alert(err.message);
    }
  });

  // Voice
  $('#voice-btn').addEventListener('click', toggleRecording);
  $('#voice-stop-btn').addEventListener('click', stopRecording);

  // Resize
  window.addEventListener('resize', () => {
    if (fitAddon && terminal) fitAddon.fit();
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (fitAddon && terminal) setTimeout(() => fitAddon.fit(), 100);
    });
  }

  // ── Init ──

  initVoice();

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
