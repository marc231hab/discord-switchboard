#!/usr/bin/env bash
# Bind one interactive Codex session and one durable Discord bridge.
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 GLOBAL_ENV CHANNEL_ENV" >&2; exit 1; }
GLOBAL_ENV_FILE="$(realpath "$1")"; CHANNEL_ENV_FILE="$(realpath "$2")"
set -a
source "$GLOBAL_ENV_FILE"
source "$CHANNEL_ENV_FILE"
set +a
: "${PROJECT_DIR:?PROJECT_DIR is required}" "${TMUX_SESSION:?TMUX_SESSION is required}" "${DISCORD_CHANNEL_ID:?DISCORD_CHANNEL_ID is required}" "${CODEX_HOME:?Use a dedicated CODEX_HOME for this binding}"
[[ "$TMUX_SESSION" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid tmux session name' >&2; exit 1; }
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/common.sh"
export CHANNEL_NAME="${CHANNEL_NAME:-$TMUX_SESSION}"
export SOCKET_DIR="${SOCKET_DIR:-/tmp/discord-agent-router}"
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  if ! tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' | grep -qx bridge; then
    printf -v BRIDGE_COMMAND 'while true; do bash %q codex %q %q; sleep 5; done' "$ROOT_DIR/scripts/run-bridge.sh" "$GLOBAL_ENV_FILE" "$CHANNEL_ENV_FILE"
    tmux new-window -d -t "$TMUX_SESSION" -n bridge -c "$ROOT_DIR" "$BRIDGE_COMMAND"
  fi
  echo "Session already running: $TMUX_SESSION"; exit 0
fi
mkdir -p "$CODEX_HOME"; chmod 700 "$CODEX_HOME"
AUTH_SOURCE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"
if [[ ! -e "$CODEX_HOME/auth.json" && -f "$AUTH_SOURCE" ]]; then ln -s "$AUTH_SOURCE" "$CODEX_HOME/auth.json"; fi
CONNECTOR_ROOT="$ROOT_DIR" node > "$CODEX_HOME/config.toml" <<'NODE'
const e=process.env,q=JSON.stringify
const prompt=`You are running inside the tmux session ${e.TMUX_SESSION}, bound to Discord #${e.CHANNEL_NAME}. Messages arrive with their Discord message id. ALWAYS send user-facing replies with custom_discord discord_reply; it supports absolute local file paths via files and routes into task threads. After a successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap. After a progress update, continue the authorized work. If delivery fails, recover before claiming it was sent. Use discord_progress for milestones and download_attachment for attached files.`
const lines=['# Generated for this dedicated channel home.']
if(e.CODEX_MODEL)lines.push(`model = ${q(e.CODEX_MODEL)}`)
if(e.CODEX_EFFORT)lines.push(`model_reasoning_effort = ${q(e.CODEX_EFFORT)}`)
lines.push('developer_instructions = """'+prompt.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"""',
 `[projects.${q(e.PROJECT_DIR)}]`,'trust_level = "trusted"','[tui]','screen_reader_detection_done = true',
 '[mcp_servers.custom_discord]',`command = ${q(process.execPath)}`,`args = [${q(e.CONNECTOR_ROOT+'/src/channel.js')}]`,
 `env = { DISCORD_CHANNEL_ID = ${q(e.DISCORD_CHANNEL_ID)}, CHANNEL_NAME = ${q(e.CHANNEL_NAME)}, SOCKET_DIR = ${q(e.SOCKET_DIR)}, DISCORD_INBOUND = "off" }`)
console.log(lines.join('\n'))
NODE
LAST_THREAD="${CODEX_THREAD_ID:-}"
if [[ -z "$LAST_THREAD" ]]; then
  LAST_THREAD=$(node --no-warnings -e '
const {DatabaseSync}=require("node:sqlite")
try{const db=new DatabaseSync(process.argv[1]+"/state_5.sqlite",{readOnly:true});const r=db.prepare("SELECT id FROM threads WHERE cwd = ? AND archived = 0 AND thread_source = \x27user\x27 AND agent_path IS NULL ORDER BY created_at_ms DESC LIMIT 1").get(process.argv[2]);if(r)console.log(r.id);db.close()}catch{}' "$CODEX_HOME" "$PROJECT_DIR")
fi
printf -v RUN_COMMAND 'bash %q %q %q %q' "$ROOT_DIR/scripts/run-codex.sh" "$GLOBAL_ENV_FILE" "$CHANNEL_ENV_FILE" "$LAST_THREAD"
start_scoped "$TMUX_SESSION" tmux new-session -d -s "$TMUX_SESSION" -n codex -c "$PROJECT_DIR" -x 200 -y 50 "$RUN_COMMAND"
printf -v BRIDGE_COMMAND 'while true; do bash %q codex %q %q; sleep 5; done' "$ROOT_DIR/scripts/run-bridge.sh" "$GLOBAL_ENV_FILE" "$CHANNEL_ENV_FILE"
tmux new-window -d -t "$TMUX_SESSION" -n bridge -c "$ROOT_DIR" "$BRIDGE_COMMAND"
if [[ -n "$LAST_THREAD" ]]; then tmux set-option -p -t "$TMUX_SESSION:codex" @codex_thread_id "$LAST_THREAD"; fi
echo "Started $TMUX_SESSION for $PROJECT_DIR"
