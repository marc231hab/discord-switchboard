#!/usr/bin/env bash
# Terminal view of the pinned session: attaches to the shared server, re-attaching if it restarts.
set -uo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/opencode-env.sh" "$1"
while true; do
  "${OPENCODE_BINARY:-opencode}" attach "$OPENCODE_URL" --dir "$PROJECT_DIR" --session "$OPENCODE_SESSION_ID"
  echo "opencode attach exited; re-attaching in 3s (Ctrl-C to stop)"; sleep 3
done
