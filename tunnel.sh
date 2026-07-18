#!/bin/bash
# SSH reverse tunnel: VPS:8080 → Mac:3000
# Keeps connection alive and auto-reconnects

VPS_HOST="root@95.217.154.208"
REMOTE_PORT=8080
LOCAL_PORT=${PORT:-3000}

echo "Starting SSH reverse tunnel..."
echo "  VPS :${REMOTE_PORT} → localhost:${LOCAL_PORT}"
echo "  Press Ctrl+C to stop"
echo ""

while true; do
  ssh -N -R ${REMOTE_PORT}:localhost:${LOCAL_PORT} \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    ${VPS_HOST}

  echo "[tunnel] Connection lost, reconnecting in 3s..."
  sleep 3
done
