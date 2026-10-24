import { BridgeController } from './bridge-controller.js'
import { event } from './session-event.js'
import { clip, commandLabel, terminalStates } from './presentation.js'

// Observe foreground records even when they do not belong to a Discord task.
// Never retain user text, tool names/arguments/results or assistant content.
export function observeClaudeForeground(session, record) {
  if (record.isSidechain || !session.threadId || record.sessionId && record.sessionId !== session.threadId) return
  const isUser = record.type === 'user', isAssistant = record.type === 'assistant'
  const duration = record.type === 'system' && record.subtype === 'turn_duration'
  if (!isUser && !isAssistant && !duration) return
  if (session.foreground?.version !== 1 || session.foreground.sessionId !== session.threadId)
    session.foreground = { version: 1, sessionId: session.threadId, phase: 'unknown', tools: {}, lastAt: null, completedAt: null }
  const f = session.foreground
  const at = Date.parse(record.timestamp)
  f.lastAt = Number.isFinite(at) ? at : null
  f.completedAt = null
  f.phase = 'working'
  const blocks = Array.isArray(record.message?.content) ? record.message.content : []
  for (const block of blocks) {
    if (isAssistant && block.type === 'tool_use') f.tools[block.id || '?'] = true
    if (isUser && block.type === 'tool_result') delete f.tools[block.tool_use_id]
  }
  if ((duration || isAssistant && record.message?.stop_reason === 'end_turn') && !Object.keys(f.tools).length && Number.isFinite(at)) {
    f.phase = 'complete'; f.completedAt = at
  }
}

// A tool can finish after its Discord task was interrupted or completed. Its
// actual result must still retire the pending handle, without emitting events
// for an unrelated task or treating an unresolved tool as finished.
export function reconcileClaudeToolResults(session, record) {
  if (record.isSidechain || record.type !== 'user' || !session.threadId ||
      record.sessionId && record.sessionId !== session.threadId) return
  const blocks = Array.isArray(record.message?.content) ? record.message.content : []
  for (const block of blocks)
    if (block.type === 'tool_result') delete session.tools?.[block.tool_use_id]
}

// Read-only upgrade seeding reconciles metadata only, never transcript()/record()
// and therefore never replays a reply, inbox transition or router event.
export function seedClaudeForeground(session, consumedTranscript) {
  session.foreground = { version: 1, sessionId: session.threadId, phase: 'unknown', tools: {}, lastAt: null, completedAt: null }
  for (const line of consumedTranscript.split('\n')) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    observeClaudeForeground(session, record)
    reconcileClaudeToolResults(session, record)
  }
  session.toolResultsVersion = 1
}

// Native `busy` can include delegated background agents. Admit that state only
// after a newer, explicitly completed foreground with no unfinished tools.
export function claudeReadiness(registry, session, active) {
  const pendingTools = Object.keys(session.tools || {}).length
  const last = Object.values(session.turns || {}).at(-1)
  const completedHere = session.threadId === registry.sessionId && last?.status === 'complete' &&
    Number.isFinite(registry.startedAt) && Number.isFinite(last.startedAt) && last.startedAt >= registry.startedAt
  const backgroundShells = registry.status === 'shell'
  const f = session.foreground
  const foregroundTools = Object.keys(f?.tools || {}).length
  const completedAfterBusy = registry.status === 'busy' && f?.version === 1 &&
    session.threadId === registry.sessionId && f.sessionId === registry.sessionId && f.phase === 'complete' &&
    !foregroundTools && Number.isFinite(f.completedAt) && Number.isFinite(registry.statusUpdatedAt) &&
    Number.isFinite(registry.startedAt) && f.completedAt > registry.statusUpdatedAt && f.completedAt > registry.startedAt
  // A session driven by its own Monitor/background notifications never completes
  // a Discord turn, so shell presence alone would hold new requests forever.
  // An explicit end_turn in this session, newer than the native session start,
  // with no unfinished foreground tools, is enough to admit them.
  const shellForegroundComplete = backgroundShells && f?.version === 1 &&
    session.threadId === registry.sessionId && f.sessionId === registry.sessionId && f.phase === 'complete' &&
    !foregroundTools && Number.isFinite(f.completedAt) && Number.isFinite(registry.startedAt) && f.completedAt > registry.startedAt
  let reason = null
  if (registry.waitingFor || active?.awaitingInput) reason = 'Waiting for approval or user input'
  else if (active) reason = 'Working on the current task'
  else if (pendingTools) reason = 'Waiting for current tools to finish'
  else if (registry.status === 'idle') reason = null
  else if (backgroundShells && completedHere) reason = null
  else if (completedAfterBusy) reason = null
  else if (shellForegroundComplete) reason = null
  else if (backgroundShells) reason = 'Background shells running; waiting for foreground completion evidence'
  else reason = 'Waiting for the Claude foreground to become idle'
  return { newTaskReady: reason === null, registryStatus: registry.status,
    backgroundShells, pendingTools, foregroundCompletedInSession: completedHere,
    foregroundPhase: f?.phase || 'unknown', foregroundTools, completedAfterBusy,
    activity: reason || (completedAfterBusy ? 'Ready for requests; foreground completed after native busy status' : backgroundShells ? 'Ready for requests; background shells running' : 'Idle') }
}

export class ClaudeController extends BridgeController {
  constructor(options) { super(options); this.session.tools ||= {} }
  async transcript(record, key) {
    if (record.isSidechain) return
    observeClaudeForeground(this.session, record)
    const attachment = record.attachment || {}
    // Claude Code <2.1.29x records an incorporated channel message as a
    // queued_command attachment; newer versions write a plain user record whose
    // string content is the <channel …> tag. Missing the latter left every
    // delivery "queued" forever and re-notified it after 60s idle (duplicates).
    const channelPrompt = attachment.type === 'queued_command' && attachment.origin?.kind === 'channel'
      ? attachment.prompt || ''
      : record.type === 'user' && typeof record.message?.content === 'string' && record.message.content.trimStart().startsWith('<channel ')
        ? record.message.content : null
    if (channelPrompt !== null) {
      const prompt = channelPrompt
      if (!prompt.includes(`channelId="${this.channelId}"`)) return
      const id = /\bmessageId="(\d+)"/.exec(prompt)?.[1]
      if (!id) return
      const input = this.state.get('inbox', id)
      let t = this.active()
      if (!t || terminalStates.has(t.status) || input?.mode === 'new' && t.taskId !== input.taskId) {
        const turnId = record.uuid || key
        await super.record(event('task_started', { turn_id: turnId, started_at: Date.parse(record.timestamp) }), `${key}:start`)
        t = this.active()
      }
      t.awaitingInput = false
      await super.record(event('item_completed', { turn_id: t.id, item: { type: 'UserMessage', content: [{ type: 'text', text: `[discord #${this.channelName} from user msg=${id}]` }] } }), key)
      this.save(); return
    }
    const t = this.active()
    const message = record.message || {}
    if (message.model) this.session.model = message.model
    if (record.effort) this.session.effort = record.effort
    if (!t?.taskId) { reconcileClaudeToolResults(this.session, record); this.save(); return }
    if (record.type === 'assistant') {
      for (const [index, block] of (message.content || []).entries()) {
        const id = `${key}:${index}`
        if (block.type === 'thinking' || block.type === 'redacted_thinking') continue
        // Mid-turn text is terminal narration (third person about the requester), not a Discord reply:
        // relay only the end_turn text, as the fallback when the session never called discord_reply.
        if (block.type === 'text' && message.stop_reason === 'end_turn') await super.record(event('item_completed', { turn_id: t.id, item: { type: 'AgentMessage', content: block.text, phase: 'final_answer' } }), id)
        if (block.type === 'tool_use') {
          const args = block.input || {},name = block.name
          const tool = { name, path: args.file_path || args.path, label: name === 'Bash' ? commandLabel({ command: args.command }) : `Use ${clip(name, 60)}`, text: /discord_reply$/.test(name) ? args.text : undefined }
          this.session.tools[block.id] = tool
          if (/discord_reply$/.test(name)) await super.record(event('item_started', { turn_id: t.id, item: { type: 'McpToolCall', id: block.id, tool: 'discord_reply', status: 'InProgress' } }), id)
          if (name === 'AskUserQuestion' || /discord_progress$/.test(name) && args.status === 'waiting') { t.awaitingInput = true; this.emit({ eventId: id, taskId: t.taskId, status: 'waiting', activity: 'Waiting for your input' }) }
          else if (!/discord_(reply|progress|react|edit|question|question_cancel|overview)$/.test(name)) { this.addLog(t, tool.label); this.emit({ eventId: id, taskId: t.taskId, status: 'working', activity: tool.label }) }
        }
      }
      if (message.stop_reason === 'end_turn' && !t.awaitingInput) this.finish(t, t.stopRequested ? 'interrupted' : 'complete', `${key}:complete`, t.lastReply)
    }
    if (record.type === 'user') for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (block.type !== 'tool_result') continue
      const tool = this.session.tools[block.tool_use_id]
      if (!tool) continue
      const id = `${key}:${index}`,status = block.is_error ? 'Failed' : 'Completed'
      if (/discord_reply$/.test(tool.name)) await super.record(event('item_completed', { turn_id: t.id, item: { type: 'McpToolCall', id: block.tool_use_id, tool: 'discord_reply', status, arguments: { text: tool.text }, result: { isError: !!block.is_error } } }), id)
      else if (['Write','Edit','MultiEdit'].includes(tool.name) && tool.path && !block.is_error) await super.record(event('item_completed', { turn_id: t.id, item: { type: 'FileChange', changes: [{ path: tool.path }] } }), id)
      else if (!/discord_(question|question_cancel|overview)$/.test(tool.name)) { const line = `${tool.label} — ${block.is_error ? 'failed' : 'completed'}`; this.addLog(t,line);this.emit({ eventId: id, taskId: t.taskId, milestone: line, activity: tool.label }) }
      delete this.session.tools[block.tool_use_id]
    }
    if (record.type === 'system' && record.subtype === 'turn_duration' && !t.awaitingInput) this.finish(t, t.stopRequested ? 'interrupted' : 'complete', `${key}:complete`, t.lastReply)
    this.save()
  }
  async control(action, taskId, argument) {
    if (action === 'bind') throw new Error('Claude follows the session registered to its bound tmux pane')
    if (action === 'stop') {
      const t = this.active()
      if (t && (!taskId || t.taskId === taskId)) {
        await this.interrupt(t)
        t.stopRequested = true
        this.finish(t,'interrupted',`stop:${t.id}`,'Stopped from Discord')
        return { text: 'Stopped the Claude task.' }
      }
      const pending = this.state.all('inbox').filter(i => i.taskId === taskId && i.status === 'received')
      if (!pending.length) return { text: 'This task is no longer running.' }
      for (const input of pending) { input.status = 'interrupted';this.state.put('inbox',input.messageId,input) }
      this.emit({eventId:`cancel:${taskId}`,taskId,status:'interrupted',messageIds:pending.map(i=>i.messageId),activity:'Cancelled before delivery'})
      return {text:'Cancelled the queued task.'}
    }
    return super.control(action,taskId,argument)
  }
}
