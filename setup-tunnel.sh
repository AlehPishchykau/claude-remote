#!/bin/bash
set -e

echo "=== Claude Remote — Cloudflare Tunnel Setup ==="
echo ""

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "Installing cloudflared..."
  brew install cloudflared
fi

# Login if needed
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "Logging into Cloudflare (browser will open)..."
  cloudflared tunnel login
fi

TUNNEL_NAME="claude-remote"

# Create tunnel if not exists
if ! cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
  echo "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "Tunnel '$TUNNEL_NAME' already exists."
fi

TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

# Ask for domain
echo ""
read -p "Enter your domain (e.g. claude.example.com): " DOMAIN

if [ -z "$DOMAIN" ]; then
  echo "No domain specified. You can use quick tunnel mode instead (npm run tunnel)."
  exit 0
fi

# Create config
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config-claude-remote.yml"

cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:3000
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

echo "Config written to $CONFIG_FILE"

# Create DNS record
echo ""
echo "Creating DNS record for $DOMAIN..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>/dev/null || true

# Update .env
if [ -f .env ]; then
  if grep -q "TUNNEL_NAME" .env; then
    sed -i '' "s/^.*TUNNEL_NAME.*/TUNNEL_NAME=$TUNNEL_NAME/" .env
  else
    echo "TUNNEL_NAME=$TUNNEL_NAME" >> .env
  fi

  if grep -q "TUNNEL_CONFIG" .env; then
    sed -i '' "s|^.*TUNNEL_CONFIG.*|TUNNEL_CONFIG=$CONFIG_FILE|" .env
  else
    echo "TUNNEL_CONFIG=$CONFIG_FILE" >> .env
  fi
fi

echo ""
echo "=== Setup complete ==="
echo "Your Claude Remote will be available at: https://$DOMAIN"
echo "Run: npm run tunnel"
