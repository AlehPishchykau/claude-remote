# claude-remote-agent

Agent for [Claude Remote](https://github.com/AlehPishchykau/claude-remote) — connects your machine to the relay server so you can access Claude Code from any browser.

## Quick start

```bash
npx claude-remote-agent --key <YOUR_KEY> --name MyMachine
```

Or install globally:

```bash
npm install -g claude-remote-agent
claude-remote-agent --key <YOUR_KEY>
```

## Options

| Flag | Env variable | Description |
|---|---|---|
| `--key` | `AGENT_KEY` | Access key for authentication (required) |
| `--name` | `AGENT_NAME` | Agent display name (default: hostname) |
| `--server` | `SERVER_URL` | Relay server URL (default: `wss://claude.pishchykau.eu`) |

## Requirements

- Node.js 18+
- Python 3 (for PTY terminal sessions)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed

## How it works

```
Browser  ←WebSocket→  Relay Server  ←WebSocket→  Agent (this)  →  Claude Code
```

The agent runs on your machine, connects to the relay server via WebSocket, and spawns Claude Code processes on demand. You access it through the web UI at your relay server's URL using the access key.

## Running with PM2

```bash
npm install -g claude-remote-agent pm2
pm2 start claude-remote-agent -- --key <YOUR_KEY> --name MyServer
pm2 save
```
