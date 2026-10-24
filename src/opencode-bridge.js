import { join } from 'node:path'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { State } from './state.js'
import { RouterClient } from './router-client.js'
import { OpencodeClient } from './opencode-client.js'
import { OpencodeController } from './opencode-controller.js'
import { acknowledgeInbox } from './grok-controller.js'
import { clip } from './presentation.js'

// Discord binding for one pinned session on a local `opencode serve` instance.
// The same server backs an attached TUI (`opencode attach`), so Discord turns
// and terminal turns share one visible conversation.
const channelId = process.env.DISCORD_CHANNEL_ID, channelName = process.env.CHANNEL_NAME || 'opencode'
const sessionId = process.env.OPENCODE_SESSION_ID, projectDir = process.env.PROJECT_DIR, baseUrl = process.env.OPENCODE_URL
const alwaysApprove = process.env.OPENCODE_ALWAYS_APPROVE === 'on'
if (!channelId || !sessionId || !projectDir || !baseUrl) throw Error('Missing pinned opencode binding configuration')
const password = process.env.OPENCODE_PASSWORD_FILE ? readFileSync(process.env.OPENCODE_PASSWORD_FILE, 'utf8').trim() : ''
const logs = join(process.env.HOME || '/tmp', '.claude/channel-logs'); mkdirSync(logs, { recursive: true })
const log = text => { const line = `[opencode-bridge] ${new Date().toISOString()} ${clip(text, 400)}`; console.error(line); try { appendFileSync(join(logs, `${channelName}.log`), line + '\n') } catch {} }
const state = new State(join(process.env.OPENCODE_BRIDGE_HOME || join(process.env.HOME, '.local/state/opencode-discord'), 'bridge.sqlite'))
const client = new OpencodeClient({ baseUrl, directory: projectDir, password })
const controller = new OpencodeController({ state, client, channelId, channelName, sessionId })
const router = new RouterClient(join(process.env.SOCKET_DIR || '/tmp/discord-agent-router', 'router.sock'), { role: 'opencode_bridge', channelId, channelName })
let busy = false, flushing = false, heartbeatAt = 0, health = 'starting', model, shuttingDown = false, lastError = ''

async function flush() {
  if (flushing || !router.socket || router.socket.connecting) return
  flushing = true
  try {
    await acknowledgeInbox(state, router, channelId)
    for (const row of state.all('outbox')) { await router.request(row); state.delete('outbox', row.operationId || row.eventId) }
  } catch (e) { log(`Router delivery interrupted; retrying stable outbox operations (${e.message})`) }
  finally { flushing = false }
}
async function approvePermissions() {
  // The binding runs with permission "allow"; this answers anything that still asks
  // (for example a session-level rule), mirroring GROK_ALWAYS_APPROVE.
  if (!alwaysApprove) return
  for (const request of await client.permissions() || []) {
    await client.replyPermission(request.id, 'once').then(() => log(`Auto-approved ${request.permission} for ${request.sessionID}`), e => log(`Permission reply failed: ${e.message}`))
  }
}
async function heartbeat() {
  if (Date.now() - heartbeatAt < 15000 || !router.socket || router.socket.connecting) return
  const active = controller.active()
  await router.request({ type: 'binding', channelId, binding: {
    kind: 'opencode', engine: 'opencode', channelName, projectDir, tmuxSession: process.env.OPENCODE_TMUX_LABEL || process.env.OPENCODE_TMUX_SESSION || 'opencode', codexThreadId: sessionId,
    model, effort: 'default', health, currentTask: active?.taskId || null,
    activity: active ? 'opencode is working' : controller.externalBusy ? 'opencode is working (terminal)' : 'Idle'
  } }).catch(() => {})
  heartbeatAt = Date.now()
}
async function tick() {
  if (busy || shuttingDown) return
  busy = true
  try {
    if (!model) {
      const session = await client.session(sessionId)
      if (session.directory !== projectDir) throw Error(`Pinned session belongs to ${session.directory}`)
      const config = await client.config(); model = config.model
      log(`Bound to opencode session ${sessionId} (${model})`); heartbeatAt = 0
    }
    await approvePermissions()
    await controller.poll()
    await controller.dispatch()
    health = alwaysApprove ? 'healthy · always-approve' : 'healthy'; lastError = ''
  } catch (e) {
    health = clip(`opencode server unavailable: ${e.message}`, 180)
    if (e.message !== lastError) log(e.message); lastError = e.message
  } finally {
    await flush(); await heartbeat(); busy = false
  }
}
router.on('message', msg => {
  if (msg.type === 'registered') { heartbeatAt = 0; return }
  if (msg.type === 'message') {
    // Persist before acknowledging receipt to the router.
    try { controller.receive(msg) } catch (e) { log(e.message); return }
    flush()
  } else if (msg.type === 'control') {
    Promise.resolve().then(() => controller.control(msg.action)).then(
      result => router.send({ type: 'control_result', id: msg.id, ...result }),
      e => router.send({ type: 'control_result', id: msg.id, text: `Control failed: ${clip(e.message, 500)}` }))
  }
})
router.on('connectionError', () => log('Router unavailable; durable queue retained'))
router.start()
const timer = setInterval(() => tick(), 1000)
tick()
function shutdown() { shuttingDown = true; clearInterval(timer); router.close(); state.close(); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
