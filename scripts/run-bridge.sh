#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$1"
set -a
source "$2"
source "$3"
set +a
if [[ "$BACKEND" != codex && "$BACKEND" != claude ]]; then
  echo 'Backend must be codex or claude' >&2
  exit 1
fi
export SOCKET_DIR="${SOCKET_DIR:-/tmp/discord-agent-router}"
exec node --no-warnings "$ROOT_DIR/src/$BACKEND-bridge.js"
