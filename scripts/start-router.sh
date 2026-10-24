#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_ENV_FILE="$(realpath "${1:-$ROOT_DIR/config/global.env}")"
[[ -f "$GLOBAL_ENV_FILE" ]] || { echo 'Global environment not found' >&2; exit 1; }
set -a
source "$GLOBAL_ENV_FILE"
set +a
source "$ROOT_DIR/scripts/common.sh"
ROUTER_SESSION="${ROUTER_TMUX_SESSION:-discord-router}"
if tmux has-session -t "$ROUTER_SESSION" 2>/dev/null; then echo "Router already running: $ROUTER_SESSION"; exit 0; fi
printf -v RUN_COMMAND 'while true; do bash %q %q; sleep 5; done' "$ROOT_DIR/scripts/run-router.sh" "$GLOBAL_ENV_FILE"
start_scoped "$ROUTER_SESSION" tmux new-session -d -s "$ROUTER_SESSION" -c "$ROOT_DIR" "$RUN_COMMAND"
echo "Started router: $ROUTER_SESSION"
