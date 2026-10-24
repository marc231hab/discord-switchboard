#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then echo "usage: $0 /path/to/global.env /path/to/channel.env" >&2; exit 1; fi
GLOBAL_ENV_FILE="$(realpath "$1")"
CHANNEL_ENV_FILE="$(realpath "$2")"
set -a
source "$GLOBAL_ENV_FILE"
source "$CHANNEL_ENV_FILE"
set +a
: "${PROJECT_DIR:?PROJECT_DIR is required}"
: "${TMUX_SESSION:?TMUX_SESSION is required}"
: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN is required}"
: "${DISCORD_CHANNEL_ID:?DISCORD_CHANNEL_ID is required}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/common.sh"
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  printf -v RUN_COMMAND 'bash %q %q %q' "$ROOT_DIR/scripts/run-claude.sh" "$GLOBAL_ENV_FILE" "$CHANNEL_ENV_FILE"
  start_scoped "$TMUX_SESSION" tmux new-session -d -s "$TMUX_SESSION" -n claude -c "$PROJECT_DIR" "$RUN_COMMAND"
fi
if ! tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' | grep -qx bridge; then
  printf -v BRIDGE_COMMAND 'while true; do bash %q claude %q %q; sleep 5; done' "$ROOT_DIR/scripts/run-bridge.sh" "$GLOBAL_ENV_FILE" "$CHANNEL_ENV_FILE"
  tmux new-window -d -t "$TMUX_SESSION" -n bridge -c "$ROOT_DIR" "$BRIDGE_COMMAND"
fi
echo "running $TMUX_SESSION with Discord visibility"
