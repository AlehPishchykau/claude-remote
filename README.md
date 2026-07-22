# Claude Remote

Remote web access to Claude Code sessions. Run an agent on your machine, connect from any browser — phone, tablet, another computer.

## Architecture

```
Browser  ←WebSocket→  VPS Server  ←WebSocket→  Agent  →  Claude Code
```

- **Server** (`server.js`) — relay deployed on a VPS, routes traffic between browsers and agents, serves the web UI
- **Agent** (`claude-remote-agent` npm package) — runs on any machine with Claude Code, connects to the server via WebSocket
- **Browser** — web UI with terminal, chat, voice input, conversation history

## Self-hosting guide

### 1. Requirements

- A VPS (Ubuntu recommended) with a domain and SSL certificate
- Node.js 18+ on the VPS
- Node.js 18+ and Python 3 on the agent machine
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed on the agent machine

### 2. Server setup (VPS)

Clone the repository and install dependencies:

```bash
git clone https://github.com/AlehPishchykau/claude-remote.git
cd claude-remote
npm install
```

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
# Optional: admin key to view connected agents at /api/admin/agents
# ADMIN_KEY=your-admin-secret
```

Start the server:

```bash
node server.js
```

#### Running with PM2 (recommended)

PM2 keeps the server running after reboot:

```bash
npm install -g pm2
pm2 start server.js --name claude-remote
pm2 save
pm2 startup  # follow the printed command to enable auto-start
```

#### Nginx reverse proxy with SSL

Install nginx and certbot:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/claude-remote`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

Enable the site and get an SSL certificate:

```bash
sudo ln -s /etc/nginx/sites-available/claude-remote /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

### 3. Agent setup (your machine)

The agent runs on the machine where Claude Code is installed. It connects to the server and spawns Claude Code processes on demand.

#### Quick start with npx

```bash
npx claude-remote-agent --key <YOUR_KEY> --server wss://your-domain.com --name MyMachine
```

#### Global install

```bash
npm install -g claude-remote-agent
claude-remote-agent --key <YOUR_KEY> --server wss://your-domain.com
```

The `--key` is the access key you'll use to log in from the browser. Choose any string (16+ characters).

#### Agent options

| Flag | Env variable | Description |
|---|---|---|
| `--key` | `AGENT_KEY` | Access key for browser login (required) |
| `--server` | `SERVER_URL` | Server WebSocket URL (required) |
| `--name` | `AGENT_NAME` | Display name (default: hostname) |

#### Running the agent with PM2

```bash
npm install -g claude-remote-agent pm2
pm2 start claude-remote-agent -- --key <YOUR_KEY> --server wss://your-domain.com --name MyServer
pm2 save
```

#### Running in a devcontainer

Add to your `.devcontainer/devcontainer.json`:

```json
{
  "features": {
    "ghcr.io/devcontainers/features/node:1": {}
  },
  "postCreateCommand": "npm install -g claude-remote-agent",
  "postStartCommand": "bash .devcontainer/start-agent.sh"
}
```

Create `.devcontainer/start-agent.sh`:

```bash
#!/bin/bash
if ! pgrep -f "claude-remote-agent" > /dev/null 2>&1; then
  setsid claude-remote-agent --key <YOUR_KEY> --server wss://your-domain.com --name DevContainer > /tmp/claude-remote-agent.log 2>&1 < /dev/null &
fi
```

### 4. Connect

1. Open `https://your-domain.com` in a browser
2. Enter the access key you set with `--key`
3. Click **+** to create a new session (specify a working directory)
4. Start using Claude Code

## Features

- **Terminal** — full xterm.js terminal with real PTY, color, resize
- **Chat mode** — structured chat with Claude Code (text + tool use)
- **Voice input** — dictate commands via Web Speech API
- **Conversation history** — browse and resume past Claude Code sessions
- **Mobile** — responsive layout, works as a PWA
- **Multi-agent** — connect multiple machines to one server
- **Multi-session** — run multiple Claude Code sessions in parallel
- **Auto-reconnect** — agent reconnects with exponential backoff

## Environment variables

| Variable | Component | Description |
|---|---|---|
| `PORT` | Server | HTTP port (default: 3000) |
| `ADMIN_KEY` | Server | Optional key for `/api/admin/agents` |
| `AGENT_KEY` | Agent | Access key for browser login |
| `SERVER_URL` | Agent | WebSocket URL of the relay server |
| `AGENT_NAME` | Agent | Display name (default: hostname) |
