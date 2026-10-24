import { join } from 'node:path'
import { State } from './state.js'
import { RouterClient } from './router-client.js'
import { GrokClient, grokTransport } from './grok-client.js'
import { GrokController, acknowledgeInbox } from './grok-controller.js'

const channelId = process.env.DISCORD_CHANNEL_ID, channelName = process.env.CHANNEL_NAME || 'grok'
const sessionId = process.env.GROK_SESSION_ID, projectDir = process.env.PROJECT_DIR
const alwaysApprove = process.env.GROK_ALWAYS_APPROVE === 'on'
if (!channelId || !sessionId || !projectDir || !process.env.GROK_HOST) throw Error('Missing pinned Grok binding configuration')
const state = new State(join(process.env.GROK_BRIDGE_HOME || join(process.env.HOME, '.local/state/cc-grok-bridge'), 'bridge.sqlite'))
const router = new RouterClient(join(process.env.SOCKET_DIR || '/tmp/discord-agent-router', 'router.sock'), { role: 'grok_bridge', channelId, channelName })
const log = text => console.error(`[grok-bridge] ${new Date().toISOString()} ${text}`)
let client, controller, connecting = false, flushing = false, heartbeatAt = 0, shuttingDown = false

async function connect() {
  if (connecting || shuttingDown || controller?.ready) return
  connecting = true
  try {
    client?.close()
    const binary = process.env.GROK_BINARY || 'grok'
    const transport = grokTransport({ host: process.env.GROK_HOST, binary, alwaysApprove,
      transport: process.env.GROK_TRANSPORT || 'ssh' })
    client = new GrokClient({ ...transport, sessionId, cwd: projectDir })
    controller = new GrokController({ state, client, channelId, channelName, sessionId })
    const native = client, current = controller
    native.on('notification', msg => {
      if (process.env.GROK_PROTOCOL_DIAGNOSTICS === 'on') {
        const u = msg.params?.update
        log(`Native notification ${msg.method}: ${u?.sessionUpdate || 'metadata'}; pinned=${msg.params?.sessionId === sessionId}; textLength=${u?.content?.text?.length || 0}`)
      }
      current.update(msg)
    })
    native.on('request', msg => {
      // The leader asks the prompting client even when the TUI is in
      // always-approve mode; honor GROK_ALWAYS_APPROVE here instead of Discord.
      const options = msg.params?.options || []
      const allow = options.find(o => o.kind === 'allow_always') || options.find(o => o.kind === 'allow_once')
      if (alwaysApprove && msg.method === 'session/request_permission' && msg.params?.sessionId === sessionId && allow) {
        native.respond(msg.id, { outcome: { outcome: 'selected', optionId: allow.optionId } }); return
      }
      current.permissionRequest(msg, router).catch(error => {
        native.respond(msg.id, { outcome: { outcome: 'cancelled' } })
        log(`Permission request could not be presented: ${error.message}`)
      })
    })
    native.on('disconnected', () => {
      current.ready = false
      if (current.permission) router.request({ type: 'question_cancel', channelId, questionId: current.permission.questionId }).catch(() => {})
      log('Native connection interrupted; preserving input and outbox')
    })
    await native.connect(); current.loaded(); heartbeatAt = 0
    log('Pinned native session loaded')
  } catch { client?.close(); log('Native connection unavailable; reconnecting without replaying uncertain prompts') }
  finally { connecting = false }
}
async function flush() {
  if (flushing || !router.socket || router.socket.connecting) return
  flushing = true
  try {
    await acknowledgeInbox(state, router, channelId)
    for (const row of state.all('outbox')) {
      await router.request(row); state.delete('outbox', row.operationId || row.eventId)
    }
  } catch { log('Router delivery interrupted; retrying stable outbox operations') }
  finally { flushing = false }
}
router.on('message', msg => {
  if (msg.type === 'message') {
    // Save before receipt. Permission answers stay in the same task and are
    // consumed as native decisions, not as another paid model prompt.
    const c = controller || new GrokController({ state, channelId, channelName, sessionId })
    c.receive(msg)
    if (controller) controller.permissionAnswer(state.get('inbox', msg.messageId)).catch(() => log('Permission answer failed'))
    flush()
  } else if (msg.type === 'control') {
    Promise.resolve(controller?.control(msg.action) || { text: 'Native Grok connection is reconnecting.' }).then(result => router.send({ type: 'control_result', id: msg.id, ...result }))
  }
})
router.on('connectionError', () => log('Router unavailable; durable queue retained'))

async function tick() {
  if (!controller?.ready) await connect()
  if (Date.now() - heartbeatAt > 15000 && router.socket && !router.socket.connecting) {
    const config = client?.loaded?.configOptions || []
    await router.request({ type: 'binding', channelId, binding: {
      kind: 'grok', engine: 'grok', channelName, projectDir, tmuxSession: process.env.GROK_TMUX_LABEL || process.env.TMUX_SESSION || 'grok', codexThreadId: sessionId,
      model: config.find(o => o.id === 'model')?.currentValue || client?.initialized?._meta?.modelState?.currentModelId,
      effort: config.find(o => o.id === 'reasoning_effort')?.currentValue,
      health: controller?.ready ? alwaysApprove ? 'healthy · always-approve' : 'healthy' : 'native connection reconnecting',
      activity: controller?.activeId || controller?.externalBusy ? 'Grok is working' : 'Idle'
    } }).catch(() => {})
    heartbeatAt = Date.now()
  }
  await flush()
  if (controller?.ready) controller.dispatch().catch(() => log('Dispatch paused for reconciliation'))
}
router.start()
const timer = setInterval(() => tick().catch(() => log('Tick deferred')), 1000)
tick()
function shutdown() {
  shuttingDown = true; clearInterval(timer); router.close(); client?.close(); state.close(); process.exit(0)
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
