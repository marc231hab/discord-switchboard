#!/usr/bin/env bash
# Watchdog for cc-* Claude Code tmux sessions.
# Detects crashes, API errors, auth failures, and stalled sessions.
# Sends alerts to Discord via webhook.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="/tmp/cc-watchdog-state.json"
DISCORD_WEBHOOK="${CC_WATCHDOG_WEBHOOK:-}"

# Initialize state file if missing
[[ -f "$STATE_FILE" ]] || echo '{}' > "$STATE_FILE"

alert() {
  local session="$1"
  local status="$2"
  local detail="$3"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%d %H:%M UTC")

  # Check if we already alerted for this session+status (avoid spam)
  local last_alert
  last_alert=$(python3 -c "
import json, sys
with open('$STATE_FILE') as f:
    state = json.load(f)
key = '${session}:${status}'
print(state.get(key, ''))
" 2>/dev/null)

  local now_epoch
  now_epoch=$(date +%s)
  if [[ -n "$last_alert" ]]; then
    local diff=$(( now_epoch - last_alert ))
    # Don't re-alert within 15 minutes for same issue
    if [[ $diff -lt 900 ]]; then
      return
    fi
  fi

  # Record this alert
  python3 -c "
import json
with open('$STATE_FILE') as f:
    state = json.load(f)
state['${session}:${status}'] = $now_epoch
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f)
"

  local emoji="⚠️"
  case "$status" in
    dead) emoji="💀" ;;
    auth) emoji="🔑" ;;
    error) emoji="❌" ;;
    stalled) emoji="⏸️" ;;
    permission) emoji="🔒" ;;
  esac

  local msg="${emoji} **${session}** — ${detail} _(${timestamp})_"
  echo "$msg"

  # Send to Discord if webhook is configured, otherwise use openclaw messaging
  if [[ -n "$DISCORD_WEBHOOK" ]]; then
    curl -s -X POST "$DISCORD_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"content\": \"${msg}\"}" > /dev/null 2>&1
  fi
}

clear_alert() {
  local session="$1"
  python3 -c "
import json
with open('$STATE_FILE') as f:
    state = json.load(f)
to_remove = [k for k in state if k.startswith('${session}:')]
for k in to_remove:
    del state[k]
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f)
" 2>/dev/null
}

alerts=()

# Check each cc-* session
for env_file in "$ROOT_DIR/config"/*.env; do
  [[ -f "$env_file" ]] || continue
  [[ "$env_file" == *global.env ]] && continue
  [[ "$env_file" == *.example ]] && continue

  session_name=$(grep '^TMUX_SESSION=' "$env_file" | cut -d= -f2)
  [[ -z "$session_name" ]] && continue

  # Check if tmux session exists
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    alerts+=("$(alert "$session_name" "dead" "Session is dead — tmux session doesn't exist")")
    continue
  fi

  # Capture the last 30 lines
  pane_output=$(tmux capture-pane -t "$session_name" -p -S -30 2>&1)

  # Check for auth errors (most critical — needs manual intervention)
  if echo "$pane_output" | grep -q "Please run /login\|authentication_error\|API Error: 401"; then
    alerts+=("$(alert "$session_name" "auth" "Auth expired — needs \`/login\` in tmux session")")
    continue
  fi

  # Check for API errors (500s, rate limits)
  if echo "$pane_output" | grep -q "API Error: 5\|Internal server error\|overloaded_error"; then
    # Check if it's actively waiting or stalled
    last_line=$(echo "$pane_output" | grep -v '^$' | tail -1)
    if echo "$last_line" | grep -q "^❯"; then
      alerts+=("$(alert "$session_name" "error" "Hit API error and stalled at prompt")")
    fi
    continue
  fi

  # Check for permission prompts (blocking)
  if echo "$pane_output" | grep -q "Do you want to proceed\|permission.*edit\|Esc to cancel.*Tab to amend"; then
    alerts+=("$(alert "$session_name" "permission" "Stuck on a permission prompt — needs approval")")
    continue
  fi

  # Check for rate limit / capacity messages
  if echo "$pane_output" | grep -q "rate_limit\|Too many requests\|capacity"; then
    alerts+=("$(alert "$session_name" "error" "Rate limited or at capacity")")
    continue
  fi

  # Session seems healthy — clear any previous alerts
  clear_alert "$session_name"
done

# Codex-bound channels: alert if the session or its bridge window is gone
for env_file in "$ROOT_DIR/config/codex"/*.env; do
  [[ -f "$env_file" ]] || continue
  session_name=$(grep '^TMUX_SESSION=' "$env_file" | cut -d= -f2)
  [[ -z "$session_name" ]] && continue
  if ! tmux has-session -t "$session_name" 2>/dev/null; then
    alerts+=("$(alert "$session_name" "dead" "Session is dead — tmux session doesn't exist")")
    continue
  fi
  if ! tmux list-windows -t "$session_name" -F '#{window_name}' | grep -qx bridge; then
    alerts+=("$(alert "$session_name" "dead" "Discord bridge window is gone — inbound messages won't arrive")")
    continue
  fi
  clear_alert "$session_name"
done

# Print summary
if [[ ${#alerts[@]} -eq 0 ]]; then
  echo "$(date -u +"%H:%M UTC") All cc-* sessions healthy"
else
  echo "$(date -u +"%H:%M UTC") ${#alerts[@]} issue(s) detected"
fi
