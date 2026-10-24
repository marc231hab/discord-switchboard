#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$1"
source "$2"
set +a
export SOCKET_DIR="${SOCKET_DIR:-/tmp/discord-agent-router}"
export CHANNEL_NAME="${CHANNEL_NAME:-$TMUX_SESSION}"
cd "$PROJECT_DIR"
MCP_JSON=$(node -e 'console.log(JSON.stringify({command:process.execPath,args:[process.argv[1]]}))' "$ROOT_DIR/src/channel.js")
"${CLAUDE_BINARY:-claude}" mcp remove --scope local custom-discord >/dev/null 2>&1 || true
"${CLAUDE_BINARY:-claude}" mcp add-json --scope local custom-discord "$MCP_JSON" >/dev/null
CLAUDE_ARGS=(--append-system-prompt 'Use custom-discord discord_reply for all user-facing replies. After a successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap. After a progress update, continue the authorized work. If delivery fails, recover before claiming it was sent.' --dangerously-load-development-channels server:custom-discord)
[[ -z "${CLAUDE_MODEL:-}" ]] || CLAUDE_ARGS+=(--model "$CLAUDE_MODEL")
[[ -z "${CLAUDE_EFFORT:-}" ]] || CLAUDE_ARGS+=(--effort "$CLAUDE_EFFORT")
[[ "${AGENT_UNATTENDED:-off}" != on ]] || CLAUDE_ARGS+=(--dangerously-skip-permissions)
if [[ -n "${3:-}" ]]; then
  TRANSCRIPT_DIR="$HOME/.claude/projects/$(python3 -c 'import re,sys; print(re.sub(r"[^a-zA-Z0-9]", "-", sys.argv[1]))' "$PROJECT_DIR")"
  if [[ -s "$TRANSCRIPT_DIR/$3.jsonl" ]]; then CLAUDE_ARGS+=(--resume "$TRANSCRIPT_DIR/$3.jsonl"); fi
fi
exec "${CLAUDE_BINARY:-claude}" "${CLAUDE_ARGS[@]}"
