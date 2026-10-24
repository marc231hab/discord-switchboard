#!/usr/bin/env bash
# Resume each exact conversation only after its agent becomes idle. Never interrupt active work.
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
for config_path in config/codex/*.env; do
  node --no-warnings scripts/reload-codex-tools.js "$config_path" --wait &
done
for config_path in config/*.env; do
  [[ "$config_path" == config/global.env ]] && continue
  if pgrep -f "^python3 scripts/reload-claude-tools.py $config_path$" >/dev/null; then
    echo "Tool refresh already waiting: $config_path"
    continue
  fi
  python3 scripts/reload-claude-tools.py "$config_path" &
done
wait
