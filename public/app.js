(function () {
  let accessKey = localStorage.getItem('cr_key');
  let agentInfo = null;
  let currentSessionId = null;
  let sessionMode = null; // 'chat' or 'terminal'
  let terminal = null;
  let fitAddon = null;
  let ws = null;
  let recognition = null;
  let isRecording = false;
  let chatBusy = false;
  let pendingImages = [];

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

  function getSavedKeys() {
    try { return JSON.parse(localStorage.getItem('cr_keys') || '[]'); } catch { return []; }
  }

  function saveKeyEntry(key, agentName) {
    const keys = getSavedKeys().filter(k => k.key !== key);
    keys.unshift({ key, name: agentName, ts: Date.now() });
    if (keys.length > 10) keys.length = 10;
    localStorage.setItem('cr_keys', JSON.stringify(keys));
  }

  function removeKeyEntry(key) {
    const keys = getSavedKeys().filter(k => k.key !== key);
    localStorage.setItem('cr_keys', JSON.stringify(keys));
    renderSavedKeys();
  }

  function renderSavedKeys() {
    const container = $('#saved-keys');
    const keys = getSavedKeys();
    if (keys.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = keys.map(k => {
      const masked = k.key.slice(0, 4) + '····' + k.key.slice(-4);
      const label = k.name || masked;
      return '<div class="saved-key-item" data-key="' + escapeHtml(k.key) + '">' +
        '<div class="saved-key-info">' +
          '<span class="saved-key-name">' + escapeHtml(label) + '</span>' +
          '<span class="saved-key-masked">' + escapeHtml(masked) + '</span>' +
        '</div>' +
        '<button class="saved-key-remove" title="Remove">&times;</button>' +
      '</div>';
    }).join('');
    container.querySelectorAll('.saved-key-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.saved-key-remove')) return;
        $('#token-input').value = el.dataset.key;
        $('#auth-btn').click();
      });
      el.querySelector('.saved-key-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeKeyEntry(el.dataset.key);
      });
    });
  }

  // ── Agent ──

  function updateAgentCard() {
    if (!agentInfo) return;
    $('#agent-name').textContent = agentInfo.name;
    $('#agent-dot').className = 'dot online';
    $('#agent-meta').textContent = '· ' + agentInfo.hostname;
    if (!currentSessionId) {
      $('#topbar-title').textContent = 'Claude Remote';
    }
  }

  function showSessionTopbar(text) {
    $('#topbar-title').textContent = text;
    $('#topbar-new-btn').classList.add('hidden');
    $('#kill-session-btn').classList.remove('hidden');
  }

  function hideSessionTopbar() {
    $('#topbar-title').textContent = 'Claude Remote';
    $('#topbar-new-btn').classList.remove('hidden');
    $('#kill-session-btn').classList.add('hidden');
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
        if (s.mode === 'chat') {
          openChatSession(s.id, s);
        } else {
          openSession(s.id, s);
        }
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

    // Mobile touch scroll — sends Page Up/Down to the app
    let touchStartY = 0;
    let touchAccum = 0;
    const screen = container.querySelector('.xterm-screen');
    if (screen) {
      screen.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        touchAccum = 0;
      }, { passive: false });
      screen.addEventListener('touchmove', (e) => {
        e.preventDefault();
        const dy = touchStartY - e.touches[0].clientY;
        touchStartY = e.touches[0].clientY;
        touchAccum += dy;
        if (Math.abs(touchAccum) > 60) {
          sendTextToTerminal(touchAccum > 0 ? '\x1b[5~' : '\x1b[6~');
          touchAccum = 0;
        }
      }, { passive: false });
    }

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
    sessionMode = 'terminal';

    $('#no-session').classList.add('hidden');
    $('#chat-container').classList.add('hidden');
    $('#terminal-container').classList.remove('hidden');
        $('#input-bar').classList.remove('hidden');

    const shortCwd = shortenPath(info.cwd);
    showSessionTopbar(shortCwd);

    setupTerminal();
    connectWebSocket(id);
    loadSessions();
  }

  async function openChatSession(id, info) {
    currentSessionId = id;
    sessionMode = 'chat';

    $('#no-session').classList.add('hidden');
    $('#terminal-container').classList.add('hidden');
    $('#chat-container').classList.remove('hidden');
    $('#input-bar').classList.remove('hidden');
    $('#chat-messages').innerHTML = '';

    const shortCwd = shortenPath(info.cwd);
    showSessionTopbar(shortCwd);

    if (info.conversationFile) {
      try {
        const data = await api('GET', '/conversations/' + encodeURIComponent(info.conversationFile));
        for (const msg of data.messages) {
          if (msg.role === 'tool') {
            appendToolMessage(msg);
          } else {
            const text = (msg.text || '').trim();
            if (text) appendChatMessage(msg.role, text, true);
          }
        }
      } catch {}
    }

    connectChatWebSocket(id);
    loadSessions();
  }

  function sendTextToTerminal(text) {
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }

  // ── Chat mode ──

  function connectChatWebSocket(sessionId) {
    if (ws) { ws.close(); ws = null; }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '?token=' + encodeURIComponent(accessKey) + '&session=' + sessionId);

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'chat-history') {
        for (const m of msg.messages) {
          if (m.type === 'chat-user') {
            appendChatMessage('user', m.text, true);
          } else if (m.type === 'chat-text') {
            appendChatMessage('assistant', m.text, m.done);
          } else if (m.type === 'chat-tool') {
            appendToolMessage({ tool: m.tool, input: JSON.stringify(m.input || {}).slice(0, 300) });
          }
        }
      } else if (msg.type === 'chat-text') {
        appendChatMessage('assistant', msg.text, msg.done);
      } else if (msg.type === 'chat-tool') {
        appendToolMessage({ tool: msg.tool, input: JSON.stringify(msg.input || {}).slice(0, 300) });
      } else if (msg.type === 'chat-thinking') {
        appendChatMessage('thinking', 'Thinking...');
      } else if (msg.type === 'chat-done') {
        chatBusy = false;
        updateChatInput();
      } else if (msg.type === 'chat-error') {
        appendChatMessage('tool', 'Error: ' + msg.error);
        chatBusy = false;
        updateChatInput();
      }
    });

    ws.addEventListener('close', () => {
      chatBusy = false;
      updateChatInput();
    });
  }

  function appendChatMessage(role, text, done) {
    const container = $('#chat-messages');
    if (role === 'assistant') {
      let last = container.querySelector('.chat-msg.assistant:last-child');
      if (last && !last.dataset.done) {
        last.textContent += text;
        if (done) last.dataset.done = '1';
      } else {
        const div = document.createElement('div');
        div.className = 'chat-msg assistant';
        div.textContent = text;
        if (done) div.dataset.done = '1';
        container.appendChild(div);
      }
    } else if (role === 'thinking') {
      // Remove previous thinking indicator
      const prev = container.querySelector('.chat-msg.thinking');
      if (prev) prev.remove();
      const div = document.createElement('div');
      div.className = 'chat-msg thinking';
      div.textContent = text;
      container.appendChild(div);
    } else {
      // Remove thinking indicator when real content arrives
      const thinking = container.querySelector('.chat-msg.thinking');
      if (thinking) thinking.remove();
      const div = document.createElement('div');
      div.className = 'chat-msg ' + role;
      div.textContent = text;
      container.appendChild(div);
    }
    $('#chat-container').scrollTop = $('#chat-container').scrollHeight;
  }

  function appendToolMessage(msg) {
    const container = $('#chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-tool-block';

    const header = document.createElement('div');
    header.className = 'chat-tool-header';
    header.innerHTML = '<span class="tool-dot"></span><b>' + escapeHtml(msg.tool) + '</b>' +
      (msg.description ? ' <span class="tool-desc">' + escapeHtml(msg.description) + '</span>' : '');
    div.appendChild(header);

    if (msg.input) {
      const inp = document.createElement('div');
      inp.className = 'chat-tool-section';
      inp.innerHTML = '<span class="chat-tool-label">IN</span><pre>' + escapeHtml(msg.input) + '</pre>';
      div.appendChild(inp);
    }

    if (msg.output) {
      const out = document.createElement('div');
      out.className = 'chat-tool-section';
      out.innerHTML = '<span class="chat-tool-label">OUT</span><pre>' + escapeHtml(msg.output) + '</pre>';
      div.appendChild(out);
    }

    container.appendChild(div);
    $('#chat-container').scrollTop = $('#chat-container').scrollHeight;
  }

  function appendChatImage(role, dataUrl) {
    const container = $('#chat-messages');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    const img = document.createElement('img');
    img.className = 'chat-image';
    img.src = dataUrl;
    div.appendChild(img);
    container.appendChild(div);
    $('#chat-container').scrollTop = $('#chat-container').scrollHeight;
  }

  function handleImageSelect(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 10 * 1024 * 1024) continue;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        pendingImages.push({ base64, mimeType: file.type, name: file.name, dataUrl });
        updateImagePreviews();
      };
      reader.readAsDataURL(file);
    }
  }

  function updateImagePreviews() {
    const bar = $('#image-preview-bar');
    const container = $('#image-previews');
    container.innerHTML = '';
    if (pendingImages.length === 0) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    pendingImages.forEach((img, i) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';
      item.innerHTML = '<img src="' + img.dataUrl + '"><button class="image-preview-remove">x</button>';
      item.querySelector('button').addEventListener('click', () => {
        pendingImages.splice(i, 1);
        updateImagePreviews();
      });
      container.appendChild(item);
    });
  }

  function sendChatMessage(text) {
    if ((!text && pendingImages.length === 0) || !ws || ws.readyState !== 1 || chatBusy) return;
    chatBusy = true;
    updateChatInput();

    const images = pendingImages.slice();
    pendingImages = [];
    updateImagePreviews();

    if (text) appendChatMessage('user', text);
    for (const img of images) {
      appendChatImage('user', img.dataUrl);
    }

    const msg = { type: 'chat-message', text: text || '' };
    if (images.length > 0) {
      msg.images = images.map(i => ({ base64: i.base64, mimeType: i.mimeType, name: i.name }));
    }
    ws.send(JSON.stringify(msg));
  }

  function updateChatInput() {
    const input = $('#chat-input');
    const btn = $('#send-btn');
    if (chatBusy) {
      input.disabled = true;
      input.placeholder = 'Waiting...';
      btn.disabled = true;
    } else {
      input.disabled = false;
      input.placeholder = 'Message...';
      btn.disabled = false;
    }
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
      if ($('#voice-btn')) $('#voice-btn').style.display = 'none';
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
      if (finalText) {
        if (sessionMode === 'chat') {
          sendChatMessage(finalText);
        } else {
          sendTextToTerminal(finalText);
        }
      }
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
  }

  function stopRecording() {
    if (!recognition) return;
    isRecording = false;
    try { recognition.stop(); } catch {}
    $('#voice-btn').classList.remove('recording');
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
    $('#chat-container').classList.add('hidden');
    hideSessionTopbar();
    $('#input-bar').classList.add('hidden');
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
      if (msg.role === 'tool') continue;
      const text = (msg.text || '').trim();
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
      if (sessionMode === 'chat') {
        $('#chat-container').classList.remove('hidden');
      } else {
        $('#terminal-container').classList.remove('hidden');
      }
            $('#input-bar').classList.remove('hidden');
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
      saveKeyEntry(key, result.agent.name);
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

    $('#no-session').classList.add('hidden');
    $('#chat-container').classList.remove('hidden');
        $('#input-bar').classList.remove('hidden');
    $('#chat-messages').innerHTML = '';
    sessionMode = 'chat';

    try {
      const session = await api('POST', '/chat-sessions', { cwd });
      currentSessionId = session.id;
      showSessionTopbar(shortenPath(session.cwd));
      connectChatWebSocket(session.id);
      loadSessions();
    } catch (err) {
      alert(err.message);
      $('#chat-container').classList.add('hidden');
      hideSessionTopbar();
      $('#input-bar').classList.add('hidden');
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
    sessionMode = null;
    if (ws) ws.close();
    if (terminal) terminal.dispose();
    terminal = null;
    $('#terminal-container').classList.add('hidden');
    $('#chat-container').classList.add('hidden');
    hideSessionTopbar();
    $('#input-bar').classList.add('hidden');
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
    const resumeId = currentConvoFile.split('/').pop().replace('.jsonl', '');
    const cwd = currentConvoCwd;
    const file = currentConvoFile;

    closeHistory();

    $('#no-session').classList.add('hidden');
    $('#chat-container').classList.remove('hidden');
        $('#input-bar').classList.remove('hidden');
    $('#chat-messages').innerHTML = '';
    sessionMode = 'chat';

    // Load previous messages into chat
    try {
      const data = await api('GET', '/conversations/' + encodeURIComponent(file));
      for (const msg of data.messages) {
        if (msg.role === 'tool') {
          appendToolMessage(msg);
        } else {
          const text = (msg.text || '').trim();
          if (text) appendChatMessage(msg.role, text, true);
        }
      }
    } catch {}

    try {
      const session = await api('POST', '/chat-sessions', { cwd, resumeId, conversationFile: file });
      currentSessionId = session.id;
      showSessionTopbar(shortenPath(cwd));
      connectChatWebSocket(session.id);
      loadSessions();
    } catch (err) {
      alert(err.message);
    }
  });

  // Input bar
  $('#voice-btn').addEventListener('click', toggleRecording);
  $('#attach-btn').addEventListener('click', () => $('#image-input').click());
  $('#image-input').addEventListener('change', (e) => {
    handleImageSelect(e.target.files);
    e.target.value = '';
  });
  $('#send-btn').addEventListener('click', () => {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (text || pendingImages.length > 0) {
      sendChatMessage(text);
      input.value = '';
    }
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#send-btn').click();
    }
  });

  // Drag & drop images
  const chatArea = $('#chat-container');
  chatArea.addEventListener('dragover', (e) => { e.preventDefault(); });
  chatArea.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) handleImageSelect(e.dataTransfer.files);
  });

  // Paste images
  document.addEventListener('paste', (e) => {
    if (sessionMode !== 'chat') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) handleImageSelect(files);
  });

  // Resize
  window.addEventListener('resize', () => {
    if (fitAddon && terminal) fitAddon.fit();
  });

  if (window.visualViewport) {
    const onViewportResize = () => {
      const h = window.visualViewport.height;
      document.documentElement.style.setProperty('--vh', h + 'px');
      if (fitAddon && terminal) {
        setTimeout(() => {
          fitAddon.fit();
          terminal.scrollToBottom();
        }, 100);
      }
    };
    window.visualViewport.addEventListener('resize', onViewportResize);
    window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
    onViewportResize();
  }

  // ── Init ──

  initVoice();
  renderSavedKeys();

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
