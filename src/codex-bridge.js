#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { State } from './state.js'
import { RouterClient } from './router-client.js'
import { CodexClient } from './codex-client.js'
import { RolloutMonitor } from './rollout-monitor.js'
import { BridgeController } from './bridge-controller.js'
import { clip } from './presentation.js'
const exec = promisify(execFile)
function required(name) { if (!process.env[name]) throw new Error(`Missing ${name}`); return process.env[name] }
const channelId = required('DISCORD_CHANNEL_ID'), home = required('CODEX_HOME'), tmuxSession = required('TMUX_SESSION'), projectDir = required('PROJECT_DIR')
const channelName = process.env.CHANNEL_NAME || tmuxSession
const logs = join(process.env.HOME || '/tmp', '.claude/channel-logs'); mkdirSync(logs, { recursive: true })
function log(text) { const line = `[${channelName}] ${new Date().toISOString()} ${clip(text, 400)}`; console.error(line); appendFileSync(join(logs, `${channelName}.log`), line + '\n') }
const state = new State(join(home, 'discord-bridge.sqlite'))
const codex = new CodexClient(home)
const router = new RouterClient(join(process.env.SOCKET_DIR || '/tmp/discord-agent-router', 'router.sock'), { role: 'codex_bridge', channelId, channelName })
const controller = new BridgeController({ state, codex, channelId, channelName, projectDir, home, log })
let monitor, polling = false, flushing = false, ready = false, timer, lastHeartbeat = 0
async function resolveThread() {
  let id = process.env.CODEX_THREAD_ID || controller.session.threadId
  if (!id) {
    const { stdout } = await exec('tmux', ['show-options', '-p', '-v', '-t', `${tmuxSession}:codex`, '@codex_thread_id']).catch(() => ({ stdout: '' }))
    id = stdout.trim()
  }
  if (!id) {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', `${tmuxSession}:codex`, '#{pane_start_command}'])
    id = /codex\s+resume\s+([0-9a-f-]{36})/i.exec(stdout)?.[1]
  }
  if (!id) {
    const loaded = await codex.request('thread/loaded/list', {})
    const candidates = []
    for (const value of loaded.data || []) {
      const { thread } = await codex.request('thread/read', { threadId: typeof value === 'string' ? value : value.id, includeTurns: false })
      if (thread.cwd === projectDir && thread.canAcceptDirectInput && !thread.parentThreadId) candidates.push(thread.id)
    }
    if (candidates.length !== 1) throw new Error('No unambiguous loaded session. Set CODEX_THREAD_ID or bind the pane to a session UUID.')
    id = candidates[0]
  }
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true })
  let row
  try { row = db.prepare('SELECT id,cwd,rollout_path FROM threads WHERE id=? AND archived=0 AND agent_path IS NULL').get(id) } finally { db.close() }
  if (!row || row.cwd !== projectDir) throw new Error('Explicit Codex session binding does not match the project')
  controller.session.threadId = id; controller.session.rolloutPath = row.rollout_path; controller.save()
  await exec('tmux', ['set-option', '-p', '-t', `${tmuxSession}:codex`, '@codex_thread_id', id])
  await controller.snapshot()
  return row
}
async function initialize() {
  const row = await resolveThread()
  const first = !state.get('cursor', row.rollout_path)
  monitor = new RolloutMonitor(row.rollout_path, state, (record, id) => controller.record(record, id))
  if (first) {
    controller.bootstrapping = true
    do { const before = state.get('cursor', row.rollout_path)?.offset; await monitor.poll(); if (state.get('cursor', row.rollout_path)?.offset === before) break } while (true)
    controller.bootstrapping = false
    const active = controller.active()
    if (active?.taskId) {
      state.insert('outbox', `adopt:${active.taskId}`, { type: 'adopt', channelId, taskId: active.taskId, codexTurnId: active.id, eventId: `adopt:${active.taskId}` })
      controller.emit({ eventId: `resume:${active.id}`, taskId: active.taskId, status: 'working', startedAt: active.startedAt, codexTurnId: active.id, messageIds: active.messageIds, activity: 'Continuing the current task' })
    }
  }
  ready = true; log(`bound to ${row.id}`)
}
async function flush() {
  if (flushing || !router.socket || router.socket.connecting) return
  flushing = true
  try {
    for (const event of state.all('outbox')) {
      await router.request(event)
      state.delete('outbox', event.eventId)
    }
  } catch (e) { log(`event delivery pending: ${e.message}`) }
  finally { flushing = false }
}
async function heartbeat(health = 'healthy') {
  const active = controller.active()
  const recovery = controller.capacityPending()
  const recoveryActivity = recovery ? `Temporary model capacity; same-model recovery ${recovery.attempts.length + (recovery.status === 'scheduled' ? 1 : 0)}/4 pending` : null
  await router.request({ type: 'binding', channelId, binding: { channelName, projectDir, tmuxSession, codexThreadId: controller.session.threadId, model: controller.session.model, effort: controller.session.effort, currentTask: active?.taskId || recovery?.taskId || null, activity: active ? (active.stopRequested ? 'Stopping the current task' : 'Working on the current task') : recoveryActivity || 'Idle', health: recoveryActivity && health === 'healthy' ? recoveryActivity : health } })
}
router.on('message', msg => {
  if (msg.type === 'registered') { lastHeartbeat = 0; return }
  if (msg.type === 'message') {
    controller.receive(msg)
    router.request({ type: 'received', channelId, messageId: msg.messageId }).catch(e => log(e.message))
  }
  if (msg.type === 'control') {
    // Independent of prompt delivery: Stop remains responsive during a busy turn.
    controller.control(msg.action, msg.taskId, msg.argument).then(async result => {
      if (msg.action === 'bind') {
        monitor = new RolloutMonitor(controller.session.rolloutPath, state, (record, id) => controller.record(record, id))
        controller.bootstrapping = true; await monitor.poll(); controller.bootstrapping = false
        await exec('tmux', ['set-option', '-p', '-t', `${tmuxSession}:codex`, '@codex_thread_id', controller.session.threadId])
      }
      router.send({ type: 'control_result', id: msg.id, ...result }); lastHeartbeat = 0
    }).catch(e => router.send({ type: 'control_result', id: msg.id, text: `Control failed: ${clip(e.message, 500)}` }))
  }
})
router.on('connectionError', e => log(`router: ${e.message}`))
router.on('disconnected', () => log('router disconnected; keeping events and prompts on disk'))
codex.on('disconnected', () => { lastHeartbeat = 0 })
codex.on('notification', msg => {
  const p = msg.params || {}
  if (p.threadId !== controller.session.threadId) return
  const t = controller.session.turns[p.turnId || p.turn?.id]
  if (msg.method === 'turn/completed' && t) controller.finish(t, p.turn.status === 'interrupted' ? 'interrupted' : p.turn.status === 'failed' ? 'failed' : 'complete', `completed:${t.id}`, p.turn.error?.message || t.lastReply, p.turn.error)
  if (msg.method === 'item/started' && t?.taskId && p.item?.type === 'commandExecution') controller.emit({ eventId: `started:${p.item.id}`, taskId: t.taskId, activity: 'Running a command', status: 'working' })
  if (/requestUserInput|elicitation|requestApproval/i.test(msg.method) && t?.taskId) controller.emit({ eventId: `waiting:${p.itemId || t.id}`, taskId: t.taskId, status: 'waiting', activity: 'Waiting for your input in the session' })
})
async function tick() {
  if (polling) return
  polling = true
  try {
    if (!ready) await initialize()
    await monitor.poll()
    await flush()
    await controller.deliverPending()
    await controller.deliverCapacityRecoveries()
    if (Date.now() - lastHeartbeat > 15000) { await controller.snapshot(); await heartbeat(); lastHeartbeat = Date.now() }
  } catch (e) {
    log(e.message)
    if (Date.now() - lastHeartbeat > 15000) { await heartbeat(clip(e.message, 180)).catch(() => {}); lastHeartbeat = Date.now() }
  } finally { polling = false }
}
router.start()
timer = setInterval(() => tick(), 1000)
tick()
function shutdown() { clearInterval(timer); router.close(); codex.close(); state.close(); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
