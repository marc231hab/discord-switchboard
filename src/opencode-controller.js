import { clip, redact, terminalStates } from './presentation.js'

export function envelope(channelId, messageId) { return `[Discord binding: channel_id=${channelId}, message_id=${messageId}]` }
export function promptFor(input, channelName) {
  return `${envelope(input.channelId, input.messageId)}\n[discord #${channelName} from ${input.authorName || 'user'} msg=${input.sourceMessageId || input.messageId}]\n${input.content || '(no text)'}${input.transportContext ? `\n\n[Transport context: ${input.transportContext}]` : ''}\n\n[Transport: Your final response text is posted to this Discord channel automatically. Do not send a second copy with discord_reply; use it only for files.]`
}
const textOf = message => (message?.parts || []).filter(p => p.type === 'text').map(p => p.text || '').join('\n')
// Only the response after the last tool call is the answer; earlier text is narration.
export function finalText(message) {
  const parts = message?.parts || []
  let at = -1
  parts.forEach((p, i) => { if (p.type === 'tool') at = i })
  return parts.slice(at + 1).filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text || '').join('\n').trim()
}
export function toolActivity(tool = '') {
  if (/discord_/.test(tool)) return 'Using Discord tools'
  if (/review_image/.test(tool)) return 'Reviewing an image'
  return { bash: 'Running a command', read: 'Reading files', edit: 'Editing files', write: 'Writing files', patch: 'Editing files', multiedit: 'Editing files',
    grep: 'Searching files', glob: 'Searching files', list: 'Listing files', webfetch: 'Fetching a web page', task: 'Running a subagent', todowrite: 'Updating its plan' }[tool] || `Using ${clip(tool, 60)}`
}
const ack = text => /^\s*delivered\.?\s*$/i.test(text)

// Durable inbox/outbox around one pinned opencode server session. One Discord
// request is dispatched at a time, and only while the shared session is idle,
// so prompts typed in the attached TUI are never interleaved. Requests whose
// delivery is uncertain are reconciled from session history, never resent.
export class OpencodeController {
  constructor({ state, client, channelId, channelName, sessionId, now = Date.now }) {
    Object.assign(this, { state, client, channelId, channelName, sessionId, now })
    this.dispatching = false; this.externalBusy = false; this.idleSince = null; this.sessionStatus = { type: 'idle' }
  }
  put(input) { this.state.put('inbox', input.messageId, input); return input }
  receive(msg) {
    if (msg.channelId !== this.channelId) throw Error('Wrong opencode channel')
    return this.state.insert('inbox', msg.messageId, { ...msg, status: 'queued', receivedAt: this.now(), messageIds: [msg.messageId], seenParts: [], replied: [] })
  }
  outbox(id, value) { this.state.insert('outbox', id, { channelId: this.channelId, ...value }) }
  event(input, status, activity, tag = status, extra = {}) {
    if (!input.taskId) return
    const eventId = `opencode:${input.messageId}:${tag}`
    this.outbox(eventId, { type: 'event', eventId, taskId: input.taskId, messageIds: input.messageIds, status, activity, startedAt: input.startedAt, ...extra })
  }
  notice(input, tag, text) {
    // Nudges injected by the watchdog and the monitor session (ids "cc-…") are
    // routinely aborted to redirect the agent; their stop/failure notices are
    // noise in the channel. Events still record them.
    if (String(input.messageId).startsWith('cc-')) return
    this.outbox(`opencode:${input.messageId}:${tag}`, { type: 'reply', operationId: `opencode:${input.messageId}:${tag}`, taskId: input.taskId, replyToMessageId: input.sourceMessageId || input.messageId, text })
  }
  active() { return this.state.all('inbox').find(i => i.status === 'dispatching' || i.status === 'working') || null }
  async dispatch() {
    if (this.dispatching || this.active()) return
    const input = this.state.all('inbox').find(i => i.status === 'queued' && !(i.retryAfter > this.now()))
    if (!input) return
    this.dispatching = true
    try {
      this.sessionStatus = await this.client.status(this.sessionId)
      // The attached TUI may be running its own turn; wait for it to finish.
      this.externalBusy = this.sessionStatus.type !== 'idle'
      if (this.externalBusy) return
      input.status = 'dispatching'; input.attemptedAt = this.now(); input.startedAt ||= this.now(); delete input.retryAfter; this.put(input)
      this.event(input, 'queued', 'Request sent to opencode')
      try {
        const model = await Promise.resolve().then(() => this.client.config?.()).then(c => c?.model, () => undefined)
        await this.client.prompt(this.sessionId, promptFor(input, this.channelName), model)
        const fresh = this.state.get('inbox', input.messageId)
        if (fresh.status === 'dispatching') { fresh.status = 'working'; fresh.acceptedAt = this.now(); this.put(fresh) }
        this.event(fresh, 'working', 'opencode is working on your request')
        this.idleSince = null
      } catch (error) {
        const fresh = this.state.get('inbox', input.messageId)
        if (error.undelivered) { fresh.status = 'queued'; fresh.retryAfter = this.now() + 5000; this.put(fresh) }
        else { fresh.uncertain = true; fresh.error = clip(error.message, 300); this.put(fresh) }
      }
    } finally { this.dispatching = false }
  }
  async poll() {
    const input = this.active()
    if (!input || this.dispatching) {
      if (!input) { this.sessionStatus = await this.client.status(this.sessionId); this.externalBusy = this.sessionStatus.type !== 'idle' }
      return
    }
    const messages = await this.client.messages(this.sessionId, 100) || []
    const status = this.sessionStatus = await this.client.status(this.sessionId)
    const idle = status.type === 'idle'
    if (idle) this.idleSince ||= this.now(); else this.idleSince = null
    const settled = idle && this.now() - this.idleSince >= 1500
    const user = messages.find(m => m.info?.role === 'user' && textOf(m).startsWith(envelope(this.channelId, input.messageId)))
    if (!user) {
      // Accepted prompts are persisted before the session goes busy; a long,
      // idle absence means the request never landed. Report it, never resend.
      if (settled && this.now() - (input.attemptedAt || 0) > 30000) this.fail(input, 'uncertain', input.status === 'dispatching'
        ? 'opencode did not confirm this request and it is not in the session history. I have not resent it, to avoid duplicate work. Check `!status`, then send it again if needed.'
        : 'opencode accepted this request but it never appeared in the session history. I have not resent it. Check `!status`, then send it again if needed.')
      return
    }
    if (input.status === 'dispatching') { input.status = 'working'; this.put(input); this.event(input, 'working', 'opencode is working on your request') }
    input.userMessageId = user.info.id
    const replies = messages.filter(m => m.info?.role === 'assistant' && m.info.parentID === user.info.id)
    for (const message of replies) for (const part of message.parts || []) {
      if (part.type !== 'tool') continue
      if (/discord_reply$/.test(part.tool) && part.state?.status === 'completed' && !input.seenParts.includes(`reply:${part.id}`)) {
        input.explicitReply = true; input.replied.push(String(part.state.input?.text || '')); input.seenParts.push(`reply:${part.id}`)
      }
      if (!input.seenParts.includes(part.id)) {
        input.seenParts.push(part.id)
        const path = /^(edit|write|patch|multiedit)$/.test(part.tool) && (part.state?.input?.filePath || part.state?.input?.path)
        this.event(input, 'working', toolActivity(part.tool), `tool:${part.id}`, path ? { files: [path] } : {})
      }
    }
    input.seenParts = input.seenParts.slice(-500); this.put(input)
    if (status.type === 'retry') { this.event(input, 'working', clip(`Provider retry ${status.attempt}: ${status.message}`, 220), `retry:${status.attempt}`); return }
    if (!settled) return
    const last = replies.at(-1)
    if (last && !last.info.time?.completed && !last.info.error) return
    this.finish(input, last)
  }
  fail(input, tag, text) {
    input.status = 'failed'; input.finishedAt = this.now(); if (tag === 'uncertain') input.uncertain = true; this.put(input)
    this.event(input, 'failed', tag === 'uncertain' ? 'Delivery could not be confirmed; no automatic retry' : 'opencode did not complete the request')
    this.notice(input, tag, text)
  }
  finish(input, last) {
    if (terminalStates.has(input.status)) return
    const error = last?.info?.error
    if (error || !last) {
      if (error?.name === 'MessageAbortedError' || input.stopRequested) {
        input.status = 'interrupted'; input.finishedAt = this.now(); this.put(input)
        this.event(input, 'interrupted', 'opencode stopped'); this.notice(input, 'notice', 'opencode stopped this request.')
      } else this.fail(input, 'notice', error ? redact(`opencode could not complete this request: ${clip(error.data?.message || error.message || error.name || 'unknown error', 400)}`) : 'opencode finished without producing a response. Use `!status` to inspect the binding.')
      return
    }
    const text = finalText(last)
    input.status = 'complete'; input.finishedAt = this.now(); input.finish = last.info.finish; this.put(input)
    const duplicate = input.explicitReply && (ack(text) || input.replied.some(r => r.trim() === text))
    if (text && !duplicate) this.outbox(`opencode:${input.messageId}:reply`, { type: 'reply', operationId: `opencode:${input.messageId}:reply`, taskId: input.taskId, replyToMessageId: input.sourceMessageId || input.messageId, text })
    else if (!text && !input.explicitReply) this.notice(input, 'notice', 'opencode finished this request without a text reply.')
    this.event(input, 'complete', 'opencode finished')
  }
  async control(action) {
    const active = this.active()
    if (action === 'stop') {
      if (!active && !this.externalBusy) return { text: 'opencode is idle.' }
      if (active) { active.stopRequested = true; this.put(active) }
      await this.client.abort(this.sessionId)
      return { text: 'Stop requested from opencode; completion will confirm when it has stopped.' }
    }
    if (action === 'logs') {
      const rows = this.state.all('inbox').slice(-5)
      return { text: rows.map(i => `${i.messageId}: ${i.status}${i.uncertain ? ' (uncertain; not retried)' : ''}`).join('\n') || 'No Discord requests yet.' }
    }
    if (action === 'diff') return { text: 'opencode runs in its own session. Ask it to show the current diff in this channel.' }
    return { text: `opencode session is pinned to ${this.sessionId}. Use !status for connection and queue details.` }
  }
}
