# Set up Discord Switchboard with Claude Code

This is a procedure for a Claude Code agent helping an owner install Discord Switchboard on a new Linux machine. Finish one Claude channel before adding other backends. Work in the owner's chosen installation/project directories and retain unrelated sessions and configuration.

## 1. Check the machine and prerequisites

Run these read-only checks:

```bash
node --version
npm --version
tmux -V
python3 --version
git --version
claude --version
codex --version
```

Use Node **22.13+ in the 22.x line** for `node:sqlite`. The reference development environment uses Node 22.22.1; native bridge schemas were inspected with Claude Code 2.1.308 and Codex CLI 0.162.1. The test suite mocks native transports, so verify the installed CLI capabilities rather than assuming every release has the same private state schema.

If needed, install Git, tmux and Python 3 using the Linux distribution's package manager, and Node 22 from [Node.js](https://nodejs.org/en/download). Follow the official [Claude Code installation](https://code.claude.com/docs/en/setup) and [Codex installation](https://developers.openai.com/codex/quickstart) instructions. Make sure `node`, `npm`, `claude` and `codex` are on PATH. Ask the owner to complete native account login in the terminal; do not obtain their provider credentials through Discord.

Verify Codex queue support without starting a paid task:

```bash
codex queue --help
```

Its bridge also needs the local shared app-server control socket and queue APIs. Do not start Codex with `--no-daemon`. Organization-managed Claude accounts may require an administrator to enable channels; ordinary MCP connectivity alone does not enable inbound messages.

## 2. Obtain and install the source

```bash
git clone https://github.com/marc231hab/discord-switchboard
cd discord-switchboard
npm ci
node scripts/check.js
node --test test/*.test.js
```

If the owner supplied a local source folder instead, use that folder. Do not download or copy someone else's private environment files, session databases, transcripts or credentials. Record the installation directory for the following commands.

## 3. Have the owner create and invite a Discord bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application named for the owner's assistant and open its **Bot** settings.
2. Create/reset its bot token as needed. The owner should enter it directly into the local private `global.env` file; never print it or paste it into chat.
3. Enable **Message Content Intent**. Presence and member-list privileged intents are not needed by this connector.
4. Use the installation/OAuth2 URL generator to invite it to the owner's server with the `bot` scope.
5. Grant View Channels, Send Messages, Read Message History, Create Public Threads, Send Messages in Threads, Manage Threads, Attach Files, Embed Links and Add Reactions. Grant Pin Messages for status cards and Manage Messages for stale reaction cleanup. Optionally grant **Manage Channels** if you want the agent to create a new Discord channel for each new project or session itself; the connector does not need it to run in channels that already exist.
6. Check the target channel's permission overrides too. There is no need for Administrator or a public interactions endpoint.

Enable Discord **Developer Mode** under the user's advanced settings. Copy the owner's user ID and the target text channel ID. An optional overview channel can have its own ID. These are configuration values, not channel names.

## 4. Prepare local configuration

```bash
cp config/global.env.example config/global.env
cp config/project.env.example config/assistant.env
chmod 600 config/global.env config/assistant.env
mkdir -p "$HOME/projects/example-project"
```

Use the owner's real project directory instead of the example project if one already exists. Edit the local files:

- `global.env`: replace the bot-token and allowed-user-ID placeholders. Multiple allowed IDs are comma-separated. Keep threads enabled for the first test.
- `assistant.env`: replace the channel-ID placeholder; choose a channel name, existing project directory and unique `TMUX_SESSION` such as `assistant-claude`.
- Leave optional model/effort fields empty to use the native account's defaults.
- Keep `AGENT_UNATTENDED=off` unless the owner explicitly chooses the CLI permission-bypass mode.

The files are sourced as Bash. Preserve the quoted `$HOME` examples; source only files the owner controls. Confirm configuration is present **without displaying values**:

```bash
bash -n config/global.env config/assistant.env
bash -c 'set -a; source config/global.env; source config/assistant.env; : "${DISCORD_BOT_TOKEN:?missing token}" "${DISCORD_ALLOWED_USER_IDS:?missing allowed user}" "${DISCORD_CHANNEL_ID:?missing channel}" "${PROJECT_DIR:?missing project}" "${TMUX_SESSION:?missing session}"; test -d "$PROJECT_DIR"; echo "Required fields present"'
```

Presence checks do not prove placeholders were replaced; inspect that privately. Real environment files are ignored by Git. Do not commit them or include them in support logs.

## 5. Start the router and channel

From the installation directory:

```bash
bash scripts/start-router.sh
bash scripts/start-claude-channel.sh config/global.env config/assistant.env
tmux ls
tmux attach -t assistant-claude
```

The router holds the Discord gateway connection. The channel has a `claude` window and a `bridge` window. Core launchers use a user systemd scope when available and otherwise launch directly in tmux.

In the Claude window, complete any account login or project-trust step. When the **development channels** warning appears for `Channels: server:custom-discord`, have the owner review it, select **I am using this for local development**, and press Enter. Do not blindly accept a different prompt. The launch script enables this custom channel with `--dangerously-load-development-channels server:custom-discord`; the flag is separate from permission bypass and may be absent from preview-version help output.

Run `/mcp` in Claude and verify `custom-discord` is connected. If managed account policy blocks channels, follow the administrator's policy rather than trying to bypass it. The router and every bridge must share the configured `SOCKET_DIR`.

Detach using `Ctrl-b`, then `d`. You can inspect the router with `tmux attach -t discord-router` and choose the bridge window with tmux's window controls.

## 6. Verify from Discord

Ask the owner to send the following normal user message from their allowed account in the bound channel:

> Reply with SETUP_OK using the Discord reply tool.

Confirm:

1. The bot creates a task thread/status card and shows receipt/progress reactions.
2. Claude incorporates the message in the same bound project/session.
3. The reply appears in that task thread, without a duplicate terminal-only answer.
4. A follow-up in the thread continues that task. A separate main-channel request is a separate task.
5. An innocuous text attachment reaches the agent; an outgoing text file can be attached through `discord_reply`.
6. Asking the agent to use `discord_question` with two choices produces a working question card and incorporates the selected answer.

Do not run paid or destructive project work just to verify connectivity. Do not simulate another person or bot as the allowed user. If an event was dropped, allow the periodic recovery sweep roughly two minutes before diagnosing it as lost.

## 7. Add Codex when the first channel works

```bash
codex login
mkdir -p config/codex
cp config/codex.env.example config/codex/assistant.env
chmod 600 config/codex/assistant.env
```

Fill a **different** channel ID/session name, the project directory and a dedicated `CODEX_HOME`. The launcher owns that home's generated `config.toml`; it must not replace the owner's main Codex configuration. Existing default login is shared only when the dedicated home has no `auth.json`. Optional `CODEX_THREAD_ID` pins an existing conversation; otherwise startup resolves a matching project session.

```bash
bash scripts/start-codex-channel.sh config/global.env config/codex/assistant.env
tmux attach -t assistant-codex
```

Complete native prompts, then repeat the Discord test in that channel. Check the `bridge` window if no session is selected. Do not point two bindings at one channel or guess among ambiguous native sessions.

## 8. Optional OpenCode binding

Install/authenticate OpenCode using its official instructions. Copy `opencode.env.example` into `config/opencode/assistant.env`, edit the paths and unique channel/service names, and create its password file without printing the password:

```bash
mkdir -p config/opencode "$HOME/.config/discord-switchboard"
cp config/opencode.env.example config/opencode/assistant.env
chmod 600 config/opencode/assistant.env
node -e 'const fs=require("node:fs"),p=require("node:path").join(process.env.HOME,".config/discord-switchboard/opencode-password");if(!fs.existsSync(p))fs.writeFileSync(p,require("node:crypto").randomBytes(32).toString("hex"),{mode:0o600})'
```

Set `OPENCODE_CONFIG` to a real native config, or leave it empty to use OpenCode's native defaults. Before the session ID is known, start the loopback server in a dedicated tmux session:

```bash
tmux new-session -d -s opencode-bootstrap 'bash scripts/run-opencode-server.sh config/opencode/assistant.env'
```

Create a session against that server with the password read locally. Run this from the installation directory; it prints only the new session ID:

```bash
bash -c 'source scripts/opencode-env.sh config/opencode/assistant.env; node --input-type=module - <<'"'"'JS'"'"'
import { OpencodeClient } from "./src/opencode-client.js";
const c = new OpencodeClient({baseUrl:process.env.OPENCODE_URL,directory:process.env.PROJECT_DIR,password:process.env.OPENCODE_SERVER_PASSWORD});
console.log((await c.request("POST","/session",{body:{title:"Discord assistant"}})).id);
JS'
```

Wait for server health if that request initially refuses the connection; do not switch servers. Put the ID into `OPENCODE_SESSION_ID`. Stop only the bootstrap server you just created (`tmux kill-session -t opencode-bootstrap`), then run `bash scripts/start-opencode-channel.sh config/opencode/assistant.env`. It starts user services plus an attached TUI. Without a user systemd manager, keep the bootstrap server and run `run-opencode-bridge.sh` and `opencode-tui.sh` in two additional tmux windows instead. All three must use the same configuration and server.

See the [OpenCode server documentation](https://opencode.ai/docs/server/) for server authentication. Keep the server on loopback and provider credentials in the owner's native config. Leave automatic permission approval off for the initial test.

## 9. Optional Grok binding

Use a native Grok CLI that supports the ACP leader interface and loading an existing session. Authenticate it on its host, create/select the desired project conversation in its native UI, and obtain that exact session ID using the CLI's own session information/help. Do not choose an arbitrary recent conversation.

Copy `grok.env.example` into `config/grok/assistant.env`. Set the new channel ID, project directory, `GROK_SESSION_ID` and `GROK_BINARY`. Use `GROK_HOST=local` for this machine; otherwise use the intended SSH host and choose `ssh` or `tailscale` as the transport. Remote authentication stays on that host.

Start `bash scripts/start-grok-channel.sh config/grok/assistant.env`, or run `run-grok-bridge.sh` in tmux when systemd user services are unavailable. Keep `GROK_ALWAYS_APPROVE=off`. Repeat the Discord test and verify a permission request can be answered without replaying the task as a second prompt.

## 10. Troubleshoot and finish

- **Bot offline:** inspect the router pane; check token privately and outbound Discord access.
- **No inbound delivery:** check allowed user/channel IDs, Message Content Intent, channel overrides, the development warning and Claude organization channel policy.
- **MCP connected but no messages:** confirm the channel was actually enabled in this native session; restarting only the router cannot enable a disabled Claude channel.
- **Waiting for approval:** inspect the native TUI or answer a relayed permission card; do not restart an active agent to dismiss a prompt.
- **Codex socket absent:** check the dedicated home, shared-daemon mode and CLI/API compatibility.
- **Duplicate/offline owner:** one router per socket and one delivery owner per channel; use unique tmux names and retain state.
- **Services cannot find Node or the CLI:** check the exported PATH captured by the optional service launcher, or use the tmux runners.
- **Missing thread/card/file:** inspect channel-level permissions and thread visibility, not just the server role.

Report installed versions, directory, configured non-secret session names and the results of the owner's test. Never report tokens or password contents. Keep SQLite state for queued messages, transcript cursors and retry reconciliation. No automatic cron entry, public listener or system-wide service is installed by the core setup.

## Add more agent channels (optional, one command)

Once the first channel works, the agent can create a new Discord channel for each new project and start its session in one step:

```bash
bash scripts/new-channel.sh <name> claude|codex <project-dir> [--category <category-id>] [--topic "<text>"]
```

This creates the text channel with the bot, writes `config/<name>.env` (or `config/codex/<name>.env`), and starts the tmux session and bridge. It needs `DISCORD_GUILD_ID` in `global.env` and the **Manage Channels** permission for the bot. For Claude, attach once (`tmux attach -t <name>`) to confirm the development-channels prompt, then post a test message in the new channel. Use `--no-start` to only create the channel and config.
