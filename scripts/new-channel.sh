#!/usr/bin/env bash
# Create a Discord text channel for a new agent session, write its channel config and start it.
#
#   scripts/new-channel.sh <name> <claude|codex> <project-dir> [--category <category-id>] [--topic <text>] [--no-start]
#
# Needs DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in config/global.env, and the bot needs the Manage Channels
# permission (in the category, when one is given). The token is read inside node and never printed.
# Writes config/<name>.env (Claude) or config/codex/<name>.env (Codex), then runs the matching start script.
# Claude asks once for the "development channels" confirmation in the new tmux session: open it with
# `tmux attach -t <name>` and choose "I am using this for local development".
set -euo pipefail
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_ENV_FILE="${GLOBAL_ENV_FILE:-$ROOT_DIR/config/global.env}"

usage() { sed -n '4p' "$0" | sed 's/^# *//' >&2; exit 2; }
[[ $# -ge 3 ]] || usage
NAME=$1 KIND=$2 PROJECT=$3; shift 3
CATEGORY="" TOPIC="" START=1
while [[ $# -gt 0 ]]; do
  case $1 in
    --category) CATEGORY=$2; shift 2;;
    --topic) TOPIC=$2; shift 2;;
    --no-start) START=0; shift;;
    *) usage;;
  esac
done
[[ $NAME =~ ^[a-z0-9][a-z0-9-]{0,99}$ ]] || { echo "name must be lowercase letters, digits and dashes" >&2; exit 2; }
[[ $KIND == claude || $KIND == codex ]] || { echo "kind must be claude or codex" >&2; exit 2; }
[[ -d $PROJECT ]] || { echo "project dir not found: $PROJECT" >&2; exit 2; }
PROJECT=$(cd "$PROJECT" && pwd)
[[ -f $GLOBAL_ENV_FILE ]] || { echo "missing $GLOBAL_ENV_FILE" >&2; exit 2; }

if [[ $KIND == claude ]]; then ENV_FILE="$ROOT_DIR/config/$NAME.env"; else mkdir -p "$ROOT_DIR/config/codex"; ENV_FILE="$ROOT_DIR/config/codex/$NAME.env"; fi
[[ ! -e $ENV_FILE ]] || { echo "already exists: $ENV_FILE" >&2; exit 2; }
if tmux has-session -t "$NAME" 2>/dev/null; then echo "tmux session already exists: $NAME" >&2; exit 2; fi

# Create the channel. Reads the token and guild from global.env in a subshell; prints only the new channel id.
CHANNEL_ID=$(set -a; source "$GLOBAL_ENV_FILE"; set +a
  : "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN missing in global.env}" "${DISCORD_GUILD_ID:?DISCORD_GUILD_ID missing in global.env}"
  NAME="$NAME" CATEGORY="$CATEGORY" TOPIC="$TOPIC" node --no-warnings -e '
    const body = { name: process.env.NAME, type: 0 }
    if (process.env.CATEGORY) body.parent_id = process.env.CATEGORY
    if (process.env.TOPIC) body.topic = process.env.TOPIC.slice(0, 1024)
    fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/channels`, {
      method: "POST", body: JSON.stringify(body),
      headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (discord-switchboard, 1)" },
    }).then(async r => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { console.error(`Discord ${r.status}: ${j.message || "request failed"}${r.status === 403 ? " (the bot needs Manage Channels)" : ""}`); process.exit(1) }
      console.log(j.id)
    }).catch(e => { console.error(e.message); process.exit(1) })')
echo "created #$NAME ($CHANNEL_ID)"

if [[ $KIND == claude ]]; then
  cat > "$ENV_FILE" <<EOF
# Created by scripts/new-channel.sh on $(date -u +%Y-%m-%d).
DISCORD_CHANNEL_ID="$CHANNEL_ID"
CHANNEL_NAME=$NAME
CLAUDE_CHANNEL_SOURCE=$NAME
PROJECT_DIR="$PROJECT"
TMUX_SESSION=$NAME
CLAUDE_MODEL=""
CLAUDE_EFFORT=""
EOF
else
  cat > "$ENV_FILE" <<EOF
# Created by scripts/new-channel.sh on $(date -u +%Y-%m-%d).
DISCORD_CHANNEL_ID="$CHANNEL_ID"
CHANNEL_NAME=$NAME
PROJECT_DIR="$PROJECT"
TMUX_SESSION=$NAME
CODEX_HOME="\$HOME/.config/discord-switchboard/codex-$NAME"
CODEX_AUTH_FILE="\$HOME/.codex/auth.json"
CODEX_MODEL=""
CODEX_EFFORT=""
CODEX_THREAD_ID=""
EOF
fi
echo "wrote $ENV_FILE"

if [[ $START == 1 ]]; then
  bash "$ROOT_DIR/scripts/start-$KIND-channel.sh" "$GLOBAL_ENV_FILE" "$ENV_FILE"
  [[ $KIND == claude ]] && echo "next: tmux attach -t $NAME, confirm the development-channels prompt once, then post a test message in #$NAME"
fi
