#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"
source "${1:?opencode channel configuration is required}"
set +a
exec "${NODE_BINARY:-node}" --no-warnings "$ROOT_DIR/src/opencode-bridge.js"
