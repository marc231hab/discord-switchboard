#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"
source "${1:?Grok channel configuration is required}"
set +a
exec node --no-warnings "$ROOT_DIR/src/grok-bridge.js"
