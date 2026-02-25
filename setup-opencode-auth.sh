#!/bin/bash

AUTH_DIR="$HOME/.pi/agent"
AUTH_FILE="$AUTH_DIR/auth.json"

read -p "Enter your OpenCode API key: " API_KEY

mkdir -p "$AUTH_DIR"

cat > "$AUTH_FILE" << 'EOF'
{
  "opencode": { "type": "api_key", "key": "API_KEY_PLACEHOLDER" }
}
EOF

sed -i "s/API_KEY_PLACEHOLDER/$API_KEY/" "$AUTH_FILE"

chmod 600 "$AUTH_FILE"

echo "Auth file written to $AUTH_FILE"
