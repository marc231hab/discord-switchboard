#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL_CONFIG="$(realpath "${1:?Grok channel configuration is required}")"
set -a
source "$CHANNEL_CONFIG"
set +a
GLOBAL_ENV_FILE="${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"
: "${GROK_BRIDGE_UNIT:?GROK_BRIDGE_UNIT is required}"
[[ "$GROK_BRIDGE_UNIT" =~ ^[a-z0-9-]+$ ]] || { echo 'Invalid Grok service name' >&2; exit 1; }
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$GROK_BRIDGE_UNIT.service" <<UNIT
[Unit]
Description=Discord binding for the pinned Grok session
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment="PATH=$PATH"
Environment="GLOBAL_ENV_FILE=$GLOBAL_ENV_FILE"
ExecStart=/bin/bash "$ROOT_DIR/scripts/run-grok-bridge.sh" "$CHANNEL_CONFIG"
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$GROK_BRIDGE_UNIT.service"
