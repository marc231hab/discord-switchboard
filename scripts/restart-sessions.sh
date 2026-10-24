#!/usr/bin/env bash
# Restart only the Claude/Codex sessions declared by this installation.
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_ENV_FILE="$(realpath "${1:-$ROOT_DIR/config/global.env}")"
for file in "$ROOT_DIR/config"/*.env "$ROOT_DIR/config/codex"/*.env; do
 [[ -f "$file" && "$file" != "$GLOBAL_ENV_FILE" ]] || continue
 session=$(bash -c 'source "$1"; printf "%s" "${TMUX_SESSION:-}"' _ "$file")
 [[ "$session" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
 tmux kill-session -t "$session" 2>/dev/null || true
done
exec bash "$ROOT_DIR/scripts/start-all.sh" "$GLOBAL_ENV_FILE"
