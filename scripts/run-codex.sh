#!/usr/bin/env bash
set -euo pipefail
set -a
source "${1:?Global configuration is required}"
source "${2:?Channel configuration is required}"
set +a
args=(-C "$PROJECT_DIR")
[[ "${AGENT_UNATTENDED:-off}" != on ]] || args+=(--dangerously-bypass-approvals-and-sandbox)
if [[ -n "${3:-}" ]]; then args=(resume "$3" "${args[@]}"); fi
exec "${CODEX_BINARY:-codex}" "${args[@]}"
