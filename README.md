# Claude Remote

Remote web access to Claude Code sessions. Run an agent on your Mac, connect from any browser — phone, tablet, another computer.

## Architecture

```
Browser  ←WebSocket→  VPS Server  ←WebSocket→  Agent (Mac)  →  Claude Code PTY
```

- **Agent** (`agent.js`) — runs on your machine, spawns Claude Code processes via a Python PTY bridge, reads conversation history from `~/.claude/projects/`
- **Server** (`server.js`) — relay deployed on a VPS, routes WebSocket traffic between browsers and agents, serves the web UI
- **PTY Bridge** (`pty-bridge.py`) — spawns Claude Code in a real terminal with proper signal handling and resize support

## Setup

### Prerequisites

- Node.js 18+
- Python 3
- Claude Code CLI installed (`~/.local/bin/claude`)
- A VPS with a domain and SSL (nginx reverse proxy recommended)

### Server (VPS)

```bash
npm install
cp .env.example .env
# Edit .env — set PORT if needed
npm run server
```

Use PM2 for persistence:

```bash
pm2 start server.js --name claude-remote
pm2 save
```

Nginx config (proxy WebSocket + HTTP):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

### Agent (any machine)

Quick install with npx (no cloning needed):

```bash
npx claude-remote-agent --key <YOUR_KEY> --name MyMac
```

Or install globally:

```bash
npm install -g claude-remote-agent
claude-remote-agent --key <YOUR_KEY> --name DevContainer --server wss://your-domain.com
```

Or from the repo:

```bash
cp .env.example .env
# Set SERVER_URL=wss://your-domain.com
# Optionally set AGENT_KEY for a stable access key
npm run agent
```

The agent prints an access key on startup — use it to log in from the browser.

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `PORT` | Server | HTTP port (default: 3000) |
| `ADMIN_KEY` | Server | Optional key for `/api/admin/agents` |
| `SERVER_URL` | Agent | WebSocket URL of the relay server |
| `AGENT_KEY` | Agent | Fixed access key (random if unset) |
| `AGENT_NAME` | Agent | Display name (default: `username's machine`) |

## Features

- **Terminal** — full xterm.js terminal with real PTY, color, resize
- **Voice input** — dictate commands via Web Speech API (microphone button)
- **Conversation history** — browse past Claude Code sessions from any client (VS Code, terminal, remote)
- **Resume** — continue a previous conversation with `claude --resume`
- **Mobile** — responsive layout, keyboard-aware viewport handling
- **Multi-session** — run multiple Claude Code sessions in parallel
- **Auto-reconnect** — agent reconnects to server with exponential backoff

## Usage

1. Start the server on your VPS
2. Start the agent on your Mac
3. Open `https://your-domain.com` in a browser
4. Enter the access key
5. Click **+** to create a new session (specify a working directory)
6. Type directly in the terminal

To resume a past conversation: open **History** in the sidebar, select a conversation, click **Resume**.
