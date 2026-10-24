#!/usr/bin/env bash
# Headless opencode server shared by the Discord bridge and the attached TUI.
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/opencode-env.sh" "$1"
cd "$PROJECT_DIR"
exec "${OPENCODE_BINARY:-opencode}" serve --hostname 127.0.0.1 --port "$OPENCODE_PORT"
