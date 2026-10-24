#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "${1:-$ROOT_DIR/config/global.env}"
set +a
exec node --no-warnings "$ROOT_DIR/src/router.js"
