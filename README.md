# Discord Switchboard

Use Discord to talk to persistent Claude Code, Codex, OpenCode and Grok sessions running on your Linux machine. Each channel is bound to a particular project and session. You can watch work, steer it, answer questions and receive files without exposing an agent's terminal or private reasoning.

One router owns the Discord connection. Local bridges communicate with it over a private Unix socket, and SQLite records pending messages and replies before acknowledging them.

## What it does

- Routes each configured channel to one delivery owner and its existing conversation.
- Creates task threads, status cards, lifecycle reactions and a shared session overview.
- Delivers follow-ups as steering while work continues; unrelated requests stay queued.
- Recovers missed gateway messages with a bounded history sweep every two minutes.
- Persists queues, stable operation IDs and transcript cursors across restarts.
- Supports incoming attachments, outgoing files, buttons, selections and text questions.
- Uses native CLI authentication. No model subscriptions, credentials or projects are included.

## Start with one Claude Code channel

You need Node **22.13 or newer in the 22.x line**, npm, tmux, Git, Python 3, and an authenticated Claude Code CLI. Install Codex too if you want its bridge. The optional OpenCode/Grok backends require their native CLIs. Core launchers work without systemd; the optional service launchers use a systemd user manager, or their runner scripts can be started in tmux.

```bash
git clone https://github.com/marc231hab/discord-switchboard
cd discord-switchboard
npm ci
cp config/global.env.example config/global.env
cp config/project.env.example config/assistant.env
chmod 600 config/global.env config/assistant.env
mkdir -p "$HOME/projects/example-project"
```

Create a Discord bot, invite it with the permissions below, and edit both local environment files. Set the bot token and your allowed user ID in `global.env`; set the target channel ID, project directory and tmux name in `assistant.env`. These are trusted Bash configuration files, so use the quoted example syntax.

```bash
bash scripts/start-router.sh
bash scripts/start-claude-channel.sh config/global.env config/assistant.env
tmux attach -t assistant-claude
```

Complete Claude's login/project-trust steps if shown. Review the first-run **development channels** prompt for `server:custom-discord`, select the local-development confirmation and press Enter. Do not assume that seeing an MCP tool means inbound channels have been enabled. Detach with `Ctrl-b`, then `d`.

Send a normal message from your allowed Discord account: “Reply with SETUP_OK.” You should receive a task thread, status updates and the agent's reply there. See [SETUP-FOR-CLAUDE.md](SETUP-FOR-CLAUDE.md) for a full agent-run installation and verification procedure.

## Discord bot configuration

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), add its bot and copy the bot token into the private local configuration. Enable the **Message Content Intent**. This application also requests the ordinary Guilds, Guild Messages and Direct Messages gateway intents; it does not require presence or member-list privileged intents.

Invite it using the `bot` OAuth2 scope. Grant these permissions in every bound channel:

- View Channels, Send Messages and Read Message History.
- Create Public Threads, Send Messages in Threads and Manage Threads.
- Attach Files, Embed Links and Add Reactions.
- Pin Messages for the status card; Manage Messages for removal of stale lifecycle reactions.

Also allow the configured users to view and write in those channels/threads. Channel overrides can deny permissions that the server role allows. No Administrator permission or public HTTP callback endpoint is required; message components are handled through the gateway.

## Configuration

| File or variable | Purpose |
|---|---|
| `config/global.env` | Bot token, allowed user IDs, router socket/state locations and optional overview channel. |
| `config/assistant.env` | One Claude binding; copy `project.env.example`. |
| `config/codex/*.env` | Codex bindings; copy `codex.env.example`. |
| `config/grok/*.env` | Pinned Grok bindings; copy `grok.env.example`. |
| `config/opencode/*.env` | Pinned OpenCode bindings; copy `opencode.env.example`. |
| `SOCKET_DIR` | Must be identical for the router, MCP server and all bridges. |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated users allowed to drive the agent; fill this explicitly. |
| `DISCORD_TASK_THREADS=off` | Keep replies in the main channel instead of task threads. |
| `DISCORD_OVERVIEW_CHANNEL_ID` | Optional destination for the shared overview card. |
| `AGENT_UNATTENDED=on` | Explicitly enables the native CLI permission-bypass flags; default is native approvals. |

Real environment files, disabled environment files, databases, logs and installed dependencies are ignored by Git. Only placeholder examples belong in the repository. Model/effort fields are optional and otherwise use the native CLI's defaults.

## Other backends

### Codex

Authenticate using `codex login`. Create a dedicated channel configuration and home:

```bash
mkdir -p config/codex
cp config/codex.env.example config/codex/assistant.env
chmod 600 config/codex/assistant.env
# Edit the new file with a different channel ID and tmux session name.
bash scripts/start-codex-channel.sh config/global.env config/codex/assistant.env
```

The launcher generates `config.toml` in that dedicated `CODEX_HOME`, shares your existing default login only if no channel-specific auth file exists, and starts an interactive TUI plus a bridge window. Do not point it at a home whose configuration you want to preserve. The bridge requires the shared app-server Unix control socket and `thread/queue/*` APIs; an older CLI without those APIs will not work. `CODEX_THREAD_ID` can pin an existing session explicitly. Otherwise only a matching project session is resumed.

### Grok

Use an authenticated ACP-compatible Grok CLI and an existing conversation ID. Fill `config/grok.env.example`, saving it under `config/grok/`. `GROK_HOST=local` runs the binary on this host; a remote binding uses SSH by default, or Tailscale SSH when `GROK_TRANSPORT=tailscale`. Set `GROK_BINARY` to a command on PATH or an absolute path on that host.

```bash
bash scripts/start-grok-channel.sh config/grok/assistant.env
```

The service loads only `GROK_SESSION_ID`; it does not guess the newest conversation. Native tool permission questions are relayed into Discord. Leave `GROK_ALWAYS_APPROVE=off` unless you deliberately choose automatic approvals. Without systemd, run `scripts/run-grok-bridge.sh` in a tmux window instead.

### OpenCode

This bridge attaches to one session on an authenticated, loopback-only `opencode serve` instance. It shares that server with the terminal UI. Create a private password file, start the server, create or select a session, then put its exact ID in the channel configuration. Detailed commands are in the setup guide.

```bash
bash scripts/start-opencode-channel.sh config/opencode/assistant.env
```

The service launcher starts the server and bridge and attaches a tmux TUI to the pinned session. Without systemd, use the three runner scripts in separate tmux windows. `OPENCODE_ALWAYS_APPROVE=off` preserves Discord permission questions.

## Operation and troubleshooting

`bash scripts/start-all.sh config/global.env` starts the router and all enabled configurations. Launching an existing Claude/Codex binding is idempotent. `ensure-sessions.sh` uses the same entrypoint; it does not accept first-run prompts for you. `restart-sessions.sh` restarts only the Claude/Codex session names declared in this copy's configurations. Idle-only tool refresh helpers are also available under `scripts/`.

Use `tmux ls`, then attach to the router or the relevant bridge window to inspect errors. Claude/Codex bridge logs are under `$HOME/.claude/channel-logs/`; the router's SQLite state is under `DISCORD_STATE_DIR`. Do not erase state to retry an uncertain delivery: it contains deduplication and pending-reply records.

| Symptom | Check |
|---|---|
| Bot offline | Token, outbound network access and the router pane. |
| Bot online but ignores you | Allowed user ID, channel ID, Message Content Intent, channel overrides and a registered bridge. |
| Claude tools work but inbound messages do not | Development-channel prompt, native channel registration and organization channel settings. |
| Codex waits for its control socket | CLI version, dedicated `CODEX_HOME`, running TUI and shared daemon mode; do not use embedded `--no-daemon` mode. |
| Agent waits for approval | Open its native TUI and approve there, or answer a relayed permission question when available. |
| Session selection is ambiguous | Pin its ID explicitly instead of selecting an arbitrary recent session. |
| User service exits immediately | Check `journalctl --user`, PATH and the private environment/password files; tmux runners are an alternative. |
| A gateway event was missed | Leave the router running for the periodic recovery sweep; retain its SQLite state. |

## Development

```bash
npm ci
node scripts/check.js
node --test test/*.test.js
```

Tests use temporary state, fake Discord clients and mocked native transports. They do not need a real bot token or paid model calls. `scripts/verify-features.js` and `verify-live.js` are optional **live** diagnostics: configure `DISCORD_CHANNEL_ID` explicitly before running them. The feature diagnostic can update the overview or post a clearly labelled form when `--form-check` is supplied.

`src/index.js` remains the legacy direct single-channel MCP entrypoint (`npm run start:direct`); the shared router and `src/channel.js` are the normal multi-backend setup. Existing internal module names are retained.

References: [Claude channels](https://code.claude.com/docs/en/channels), [Codex CLI](https://developers.openai.com/codex/cli/reference), [Codex app-server](https://developers.openai.com/codex/app-server), [Discord intents](https://docs.discord.com/developers/events/gateway#privileged-intents), [Discord permissions](https://docs.discord.com/developers/topics/permissions), [OpenCode server](https://opencode.ai/docs/server/).
