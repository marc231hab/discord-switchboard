#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/global.env" >&2
  exit 1
fi

GLOBAL_ENV_FILE="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="$ROOT_DIR/config"
SCRIPT="$ROOT_DIR/scripts/start-claude-channel.sh"
export GLOBAL_ENV_FILE
bash "$ROOT_DIR/scripts/start-router.sh" "$GLOBAL_ENV_FILE"

for env_file in "$BASE_DIR"/*.env; do
  [[ -f "$env_file" ]] || continue
  [[ "$env_file" == "$GLOBAL_ENV_FILE" ]] && continue
  "$SCRIPT" "$GLOBAL_ENV_FILE" "$env_file"
done

# Grok native ACP bindings run as durable user services.
for env_file in "$BASE_DIR"/grok/*.env; do
  [[ -f "$env_file" ]] || continue
  bash "$ROOT_DIR/scripts/start-grok-channel.sh" "$env_file"
done

# Codex-bound channels
for env_file in "$BASE_DIR"/codex/*.env; do
  [[ -f "$env_file" ]] || continue
  "$ROOT_DIR/scripts/start-codex-channel.sh" "$GLOBAL_ENV_FILE" "$env_file"
done

# Optional OpenCode bindings.
for env_file in "$BASE_DIR"/opencode/*.env; do
  [[ -f "$env_file" ]] || continue
  bash "$ROOT_DIR/scripts/start-opencode-channel.sh" "$env_file"
done
