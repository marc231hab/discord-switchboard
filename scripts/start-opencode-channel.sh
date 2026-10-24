#!/usr/bin/env bash
# Install/refresh the systemd user units (server + Discord bridge) for an opencode
# binding and make sure its tmux TUI session exists. Idempotent.
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL_CONFIG="$(realpath "${1:?opencode channel configuration is required}")"
set -a
source "$CHANNEL_CONFIG"
set +a
GLOBAL_ENV_FILE="${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"
: "${OPENCODE_UNIT:?OPENCODE_UNIT is required}" "${OPENCODE_SESSION_ID:?OPENCODE_SESSION_ID is required}" "${OPENCODE_TMUX_SESSION:?OPENCODE_TMUX_SESSION is required}"
[[ "$OPENCODE_UNIT" =~ ^[a-z0-9-]+$ && "$OPENCODE_TMUX_SESSION" =~ ^[a-z0-9-]+$ ]] || { echo 'Invalid opencode unit or tmux name' >&2; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$OPENCODE_UNIT-server.service" <<UNIT
[Unit]
Description=opencode server for Discord #$CHANNEL_NAME
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment="PATH=$PATH"
Environment="GLOBAL_ENV_FILE=$GLOBAL_ENV_FILE"
ExecStart=/bin/bash "$ROOT_DIR/scripts/run-opencode-server.sh" "$CHANNEL_CONFIG"
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
cat > "$UNIT_DIR/$OPENCODE_UNIT-discord.service" <<UNIT
[Unit]
Description=Discord binding for the pinned opencode session (#$CHANNEL_NAME)
After=network-online.target $OPENCODE_UNIT-server.service
Wants=$OPENCODE_UNIT-server.service

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
Environment="PATH=$PATH"
Environment="GLOBAL_ENV_FILE=$GLOBAL_ENV_FILE"
ExecStart=/bin/bash "$ROOT_DIR/scripts/run-opencode-bridge.sh" "$CHANNEL_CONFIG"
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$OPENCODE_UNIT-server.service" "$OPENCODE_UNIT-discord.service"
if ! tmux has-session -t "$OPENCODE_TMUX_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$OPENCODE_TMUX_SESSION" -n tui -c "$PROJECT_DIR" -x 200 -y 50 "bash '$ROOT_DIR/scripts/opencode-tui.sh' '$CHANNEL_CONFIG'"
  tmux new-window -d -t "$OPENCODE_TMUX_SESSION" -n logs "journalctl --user -f -u '$OPENCODE_UNIT-server' -u '$OPENCODE_UNIT-discord'"
fi
