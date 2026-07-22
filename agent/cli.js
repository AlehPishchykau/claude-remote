#!/usr/bin/env node

const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      opts[arg.slice(2)] = args[++i];
    } else {
      opts[arg.slice(2)] = true;
    }
  }
}

if (opts.help) {
  console.log(`
  claude-remote-agent — connect this machine to Claude Remote

  Usage:
    claude-remote-agent --key <ACCESS_KEY> [options]
    npx claude-remote-agent --key <ACCESS_KEY> [options]

  Options:
    --key <key>       Access key for authentication (required)
    --name <name>     Agent display name (default: hostname)
    --server <url>    Relay server URL (required)
    --help            Show this help

  Environment variables (used as fallbacks):
    AGENT_KEY         Access key
    AGENT_NAME        Agent name
    SERVER_URL        Server URL
`);
  process.exit(0);
}

if (opts.key) process.env.AGENT_KEY = opts.key;
if (opts.name) process.env.AGENT_NAME = opts.name;
if (opts.server) process.env.SERVER_URL = opts.server;

if (!process.env.AGENT_KEY) {
  console.error('Error: --key is required. Run with --help for usage.');
  process.exit(1);
}

require('./agent.js');
