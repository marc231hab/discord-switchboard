import { clip, redact, terminalStates } from './presentation.js'
import { randomUUID } from 'node:crypto'

export function envelope(channelId, messageId) { return `[Discord binding: channel_id=${channelId}, message_id=${messageId}]` }
export function promptFor(input, channelName) {
  return `${envelope(input.channelId, input.messageId)}\n[discord #${channelName} from ${input.authorName || 'user'} msg=${input.sourceMessageId || input.messageId}]\n${input.content}${input.transportContext ? `\n\n[Transport context: ${input.transportContext}]` : ''}\n\n[Transport: Your final reply will be sent to this Discord channel automatically. Do not send a second copy through another tool. Tool permissions are answered in Discord; preserve existing permissions.]`
}
export async function acknowledgeInbox(state, router, channelId) {
  for (const row of state.all('inbox')) {
    if (row.routerAcknowledged || row.setup) continue
    await router.request({ type: 'received', channelId, messageId: row.messageId })
    // Native updates may have advanced the same row while the RPC was pending.
    const fresh = state.get('inbox', row.messageId)
    if (fresh) { fresh.routerAcknowledged = true; state.put('inbox', row.messageId, fresh) }
  }
}

// Durable input/outbox, pinned native session, one dispatch at a time. Ambiguous
// dispatches are reconciled from native history, never blindly submitted again.
export class GrokController {
  constructor({ state, client, channelId, channelName, sessionId }) {
    Object.assign(this, { state, client, channelId, channelName, sessionId })
    this.ready = false; this.loading = true; this.externalBusy = false; this.activeId = null; this.permission = null
    this.connectionId = randomUUID()
  }
  put(input) { this.state.put('inbox', input.messageId, input); return input }
  receive(msg) {
    if (msg.channelId !== this.channelId) throw Error('Wrong Grok channel')
    return this.state.insert('inbox', msg.messageId, { ...msg, status: 'queued', receivedAt: Date.now(), text: '', messageIds: [msg.messageId] })
  }
  outbox(id, value) { this.state.insert('outbox', id, { channelId: this.channelId, ...value }) }
  event(input, phase, activity, tag = phase) {
    if (!input.taskId) return
    this.outbox(`grok:${input.messageId}:${tag}`, { type: 'event', eventId: `grok:${input.messageId}:${tag}`, taskId: input.taskId, messageIds: input.messageIds, status: phase, activity, startedAt: input.startedAt })
  }
  update(msg) {
    const p = msg.params || {}; if (p.sessionId !== this.sessionId) return
    // Grok's live leader publishes the accepted source on its queue update,
    // while session/load replays a user_message_chunk for the same source.
    if (msg.method === '_x.ai/queue/changed' && p.runningPromptId && p.runningText) {
      const prefix = /^\[Discord binding: channel_id=([^,]+), message_id=([^\]]+)\]/.exec(p.runningText)
      const active = this.dispatching && this.activeId && this.state.get('inbox', this.activeId)
      const owned = prefix?.[1] === this.channelId && this.state.get('inbox', prefix[2]) || active && promptFor(active, this.channelName).startsWith(p.runningText) && active
      if (owned && (p.runningText.includes(owned.content) && p.runningText.startsWith(envelope(this.channelId, owned.messageId)) || promptFor(owned, this.channelName).startsWith(p.runningText))) {
        this.activeId = owned.messageId; this.externalBusy = false
        if (!terminalStates.has(owned.status)) {
          owned.nativeObserved = true; owned.nativePromptId = p.runningPromptId; owned.status = 'working'; this.put(owned)
          this.event(owned, 'working', 'Grok is working on your request')
        }
      } else { this.activeId = null; this.externalBusy = true }
      return
    }
    if (msg.method === '_x.ai/queue/changed' && !p.runningPromptId && !this.activeId) this.externalBusy = false
    const u = p.update || {}; const kind = u.sessionUpdate
    if (kind === 'user_message_chunk') {
      const text = u.content?.text || ''
      const prefix = /^\[Discord binding: channel_id=([^,]+), message_id=([^\]]+)\]/.exec(text)
      const input = prefix?.[1] === this.channelId && this.state.get('inbox', prefix[2])
      if (input && text.startsWith(envelope(this.channelId, input.messageId)) && text.includes(input.content)) {
        this.activeId = input.messageId; this.externalBusy = false
        if (!terminalStates.has(input.status)) {
          input.status = 'working'; input.nativeObserved = true; input.startedAt ||= Date.now(); input.text = ''; input.sawTools = false; this.put(input)
          if (!this.loading) this.event(input, 'working', 'Grok is working on your request')
        }
      } else { this.activeId = null; this.externalBusy = true }
      return
    }
    const input = this.activeId && this.state.get('inbox', this.activeId)
    const incomingPromptId = p._meta?.promptId || p.promptId || u.prompt_id
    if (input?.nativePromptId && incomingPromptId && input.nativePromptId !== incomingPromptId) return
    // ACP does not have to echo the caller's own user_message_chunk. A live
    // stream on the one outstanding, pinned session/prompt is its acceptance.
    // History recovery still requires the exact saved source envelope.
    if (input && !input.nativeObserved && this.dispatching && !this.loading && !this.externalBusy && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(kind)) {
      input.nativeObserved = true; input.status = 'working'; this.put(input)
      this.event(input, 'working', 'Grok is working on your request')
    }
    if (kind === 'turn_completed') {
      this.externalBusy = false
      if (input?.nativeObserved && !terminalStates.has(input.status)) this.finish(input, u.stop_reason || u.stopReason)
      this.activeId = null; return
    }
    if (!input?.nativeObserved || terminalStates.has(input.status)) return
    if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
      input.text += u.content.text || ''; this.put(input)
    } else if (kind === 'tool_call') {
      // Text before tools is interim narration. Only the final response is sent.
      input.text = ''; input.sawTools = true; this.put(input)
      if (!this.loading && input.taskId) this.outbox(`grok:${input.messageId}:tool:${u.toolCallId || Date.now()}`, {
        type: 'event', eventId: `grok:${input.messageId}:tool:${u.toolCallId || Date.now()}`, taskId: input.taskId, status: 'working', activity: 'Grok is using tools'
      })
    }
    // agent_thought_chunk and raw tool inputs/results remain private.
  }
  finish(input, reason) {
    if (terminalStates.has(input.status)) return
    const cancelled = /cancel/i.test(reason || '')
    const complete = reason === 'end_turn' && !!input.text.trim()
    input.status = cancelled ? 'interrupted' : complete ? 'complete' : 'failed'
    input.stopReason = reason || 'unknown'; input.finishedAt = Date.now(); this.put(input)
    if (this.permission?.messageId === input.messageId) {
      this.outbox(`grok:${input.messageId}:permission-close`, { type: 'question_cancel', operationId: `grok:${input.messageId}:permission-close`, questionId: this.permission.questionId })
      this.permission = null
    }
    if (complete) this.outbox(`grok:${input.messageId}:reply`, { type: 'reply', operationId: `grok:${input.messageId}:reply`, taskId: input.taskId, replyToMessageId: input.setup ? undefined : input.sourceMessageId || input.messageId, text: input.text.trim() })
    this.event(input, input.status, complete ? 'Grok finished' : cancelled ? 'Grok stopped' : 'Grok did not return a completed response')
    if (!complete && !input.setup) this.outbox(`grok:${input.messageId}:notice`, { type: 'reply', operationId: `grok:${input.messageId}:notice`, taskId: input.taskId, text: cancelled ? 'Grok stopped this request.' : 'Grok could not complete this request. Use `!status` to inspect the binding.' })
  }
  loaded() {
    this.loading = false; this.ready = true
    for (const input of this.state.all('inbox')) {
      if (input.status === 'dispatching' && !input.nativeObserved) this.uncertain(input)
      else if (input.status === 'working') this.activeId = input.messageId
    }
  }
  uncertain(input) {
    input.status = 'failed'; input.uncertain = true; this.put(input)
    this.event(input, 'failed', 'Native dispatch could not be confirmed; no automatic retry')
    this.outbox(`grok:${input.messageId}:uncertain`, { type: 'reply', operationId: `grok:${input.messageId}:uncertain`, taskId: input.taskId, text: 'Grok’s connection was interrupted and delivery is uncertain. I have not resent the request, to avoid duplicate work. Check `!status` before trying again.' })
  }
  async dispatch() {
    if (!this.ready || this.loading || this.externalBusy || this.activeId || this.dispatching) return
    const input = this.state.all('inbox').find(i => i.status === 'queued')
    if (!input) return
    input.status = 'dispatching'; input.startedAt = Date.now(); this.put(input); this.activeId = input.messageId; this.dispatching = true
    this.event(input, 'queued', 'Request queued for Grok')
    try {
      const result = await this.client.prompt(promptFor(input, this.channelName))
      const fresh = this.state.get('inbox', input.messageId)
      this.finish(fresh, result?.stopReason)
    } catch {
      const fresh = this.state.get('inbox', input.messageId)
      // The caller reconnects and loads persisted native history to reconcile.
      if (!terminalStates.has(fresh.status)) { fresh.transportInterrupted = true; this.put(fresh) }
      this.ready = false
    } finally { if (this.activeId === input.messageId) this.activeId = null; this.dispatching = false }
  }
  async control(action) {
    if (action === 'stop') {
      if (!this.activeId && !this.externalBusy) return { text: 'Grok is idle.' }
      this.client.cancel(); return { text: 'Stop requested from Grok; completion will confirm when it has stopped.' }
    }
    if (action === 'logs') {
      const rows = this.state.all('inbox').slice(-5)
      return { text: rows.map(i => `${i.messageId}: ${i.status}${i.uncertain ? ' (uncertain; not retried)' : ''}`).join('\n') || 'No Discord requests yet.' }
    }
    if (action === 'diff') return { text: 'Grok runs in its own session. Ask it to show the current diff in this channel.' }
    return { text: `Grok session is pinned to ${this.sessionId}. Use !status for connection and queue details.` }
  }
  async permissionAnswer(input) {
    const permission = this.permission
    const match = /^\[Discord question (answered|dismissed): ([^\]]+)\]/.exec(input.content || '')
    if (match && this.state.get('permission', match[2]) && (!permission || permission.questionId !== match[2])) {
      input.status = 'complete'; this.put(input)
      this.outbox(`grok:${input.messageId}:permission-expired`, { type: 'reply', operationId: `grok:${input.messageId}:permission-expired`, taskId: input.taskId, text: 'That permission request expired after reconnection. No approval was sent to Grok.' })
      return true
    }
    if (!permission || !match || match[2] !== permission.questionId || input.taskId !== permission.taskId) return false
    let answers
    try { answers = JSON.parse(input.content.split('Structured answers: ')[1]) } catch { answers = {} }
    const allow = match[1] === 'answered' && answers.grok_permission?.length === 1 && answers.grok_permission[0] === 'Allow once'
    const option = allow ? permission.allow : permission.deny
    this.client.respond(permission.id, { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } })
    const current = this.state.get('inbox', permission.messageId)
    if (current) { current.messageIds = [...new Set([...current.messageIds, input.messageId])]; this.put(current); this.event(current, 'working', allow ? 'Permission granted once; Grok is continuing' : 'Permission declined', `permission-answer:${input.messageId}`) }
    input.status = 'complete'; this.put(input); this.permission = null; return true
  }
  async permissionRequest(msg, router) {
    const current = this.activeId && this.state.get('inbox', this.activeId)
    if (msg.method !== 'session/request_permission') { this.client.reject(msg.id); return }
    if (msg.params?.sessionId !== this.sessionId || !current?.nativeObserved || !current?.taskId || this.permission) {
      this.client.respond(msg.id, { outcome: { outcome: 'cancelled' } }); return
    }
    const options = msg.params.options || []
    const allow = options.find(o => o.kind === 'allow_once'), deny = options.find(o => o.kind === 'reject_once')
    if (!allow) { this.client.respond(msg.id, { outcome: { outcome: 'cancelled' } }); return }
    const tool = msg.params.toolCall || {}, detail = tool.rawInput?.command || tool.rawInput?.path || ''
    const description = `Grok needs permission for: ${tool.title || 'a tool action'}${detail ? `\n${detail}` : ''}`
    const operationId = `grok:${current.messageId}:permission:${this.connectionId}:${msg.id}`
    // The common form accepts at most 350 characters. Keep the complete,
    // redacted action visible separately instead of silently clipping its scope.
    if (redact(description).length > 350) await router.request({ type: 'reply', channelId: this.channelId, taskId: current.taskId, operationId: `${operationId}:details`, text: redact(description) })
    const result = await router.request({ type: 'question', channelId: this.channelId, taskId: current.taskId, operationId, questions: [{ id: 'grok_permission', question: clip(description, 350), options: ['Allow once', 'Deny'] }] })
    this.permission = { id: msg.id, questionId: result.questionId, taskId: current.taskId, messageId: current.messageId, allow, deny }
    this.state.put('permission', result.questionId, { taskId: current.taskId, connectionId: this.connectionId })
  }
}
