#!/usr/bin/env bash
# Idempotently launch configured bindings. Review first-run prompts in each TUI.
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT_DIR/scripts/start-all.sh" "${1:-$ROOT_DIR/config/global.env}"
