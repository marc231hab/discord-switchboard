import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stableId, clip, redact, commandLabel, terminalStates } from './presentation.js'
import { discordMessageId, publicText } from './rollout-monitor.js'
const exec = promisify(execFile)
const digest = text => createHash('sha256').update(text.trim()).digest('hex')
export const capacityBackoffMs = [30000, 60000, 120000, 240000]
const recoveryPending = new Set(['scheduled', 'dispatching', 'queued'])
const recoveryClosed = new Set(['complete', 'cancelled', 'exhausted'])
export function timestampMs(value) {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null
  }
  const number = Number(value)
  if (value == null || !Number.isFinite(number) || number < 0) return null
  // Native task_started.started_at uses Unix seconds; inbox.receivedAt and
  // JS wall clocks use milliseconds. Also handle already persisted old turns.
  return number < 100000000000 ? number * 1000 : number
}
const recoveryMarker = content => {
  const text = typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
  return /^\[codex_capacity_recovery id=([0-9a-f-]{36})\]/m.exec(text)?.[1] || null
}
export function capacityFailure(error) {
  const info = error && typeof error === 'object' ? error.codex_error_info ?? error.codexErrorInfo : null
  const code = error && typeof error === 'object' ? error.code : null
  if (code != null && !['server_overloaded', 'serverOverloaded'].includes(code)) return null
  // Structured error information is authoritative, including a non-capacity
  // classification whose prose happens to mention capacity.
  if (info != null) return ['server_overloaded', 'serverOverloaded'].includes(info) ? 'server_overloaded' : null
  if (code != null) return 'server_overloaded'
  const text = typeof error === 'string' ? error : error?.message
  return typeof text === 'string' && text.trim() === 'Selected model is at capacity. Please try a different model.' ? 'model_at_capacity_message' : null
}

export class BridgeController {
  constructor({ state, codex, channelId, channelName, projectDir, home, log = console.error, now = Date.now }) {
    Object.assign(this, { state, codex, channelId, channelName, projectDir, home, log, now })
    this.session = state.get('session', 'current') || { turns: {}, activeTurnId: null }
    for (const t of Object.values(this.session.turns)) if (timestampMs(t.startedAt) != null) t.startedAt = timestampMs(t.startedAt)
    this.bootstrapping = false; this.delivering = false; this.recovering = false; this.recoveryOwner = randomUUID()
  }
  save() { this.state.put('session', 'current', this.session) }
  emit(event) {
    if (this.bootstrapping) return
    this.state.insert('outbox', event.eventId, { type: 'event', channelId: this.channelId, ...event })
  }
  receive(msg) {
    return this.state.transaction(() => {
      if (this.state.get('inbox', msg.messageId)) return false
      this.session.inputVersion = (this.session.inputVersion || 0) + 1
      this.session.lastUserMessageId = msg.messageId
      this.state.insert('inbox', msg.messageId, { ...msg, status: 'received', clientId: stableId(`discord:${this.channelId}:${msg.messageId}`), receivedAt: this.now(), inputVersion: this.session.inputVersion })
      this.cancelCapacityRecoveries('new_user_input')
      this.save(); return true
    })
  }
  active() { return this.session.turns[this.session.activeTurnId] || null }
  taskTurn(taskId) { return Object.values(this.session.turns).reverse().find(t => t.taskId === taskId) }
  async record(record, eventId) {
    const p = record.payload || {}
    if (record.type === 'turn_context') {
      for (const r of this.state.all('capacity_recovery')) if (recoveryPending.has(r.status) &&
        (p.model && r.model && p.model !== r.model || p.effort && r.effort && p.effort !== r.effort)) {
        r.status = 'cancelled'; r.cancelReason = 'selection_changed'; r.lease = null; this.state.put('capacity_recovery', r.id, r)
      }
      this.session.model = p.model || this.session.model; this.session.effort = p.effort || this.session.effort
      const t = this.session.turns[p.turn_id] || this.active()
      if (t) { t.model = p.model || t.model; t.effort = p.effort || t.effort }
      this.save(); return
    }
    if (record.type === 'response_item' && p.type === 'custom_tool_call') {
      const t = this.active()
      if (t?.taskId) this.emit({ eventId, taskId: t.taskId, activity: 'Running tools', status: 'working' })
      return
    }
    if (record.type !== 'event_msg') return
    if (p.type === 'task_started') {
      const prior = this.session.turns[p.turn_id] || this.session.turns[p.root_turn_id]
      // Goal continuations start fresh root turns; keep them on the running task
      // so Discord follow-ups can steer them.
      const goal = p.turn_attribution?.turn_trigger === 'goal' ? this.active() || Object.values(this.session.turns).at(-1) : null
      const t = { ...prior, id: p.turn_id, rootId: p.root_turn_id || p.turn_id, taskId: prior?.taskId || goal?.taskId, messageIds: prior?.messageIds || [], startedAt: timestampMs(p.started_at ?? record.timestamp) ?? this.now(), status: 'working', logs: prior?.logs || [], files: prior?.files || [], repos: prior?.repos || [], model: prior?.model || this.session.model, effort: prior?.effort || this.session.effort, inputVersion: prior?.inputVersion ?? this.session.inputVersion ?? 0, turnTrigger: p.turn_attribution?.turn_trigger }
      this.session.turns[t.id] = t; this.session.activeTurnId = t.id; this.save(); return
    }
    const t = this.session.turns[p.turn_id] || this.active()
    if (!t) return
    if (p.type === 'item_completed' || p.type === 'item_started') {
      const item = p.item || {}
      if (item.type === 'UserMessage') {
        const marker = recoveryMarker(item.content)
        if (marker) {
          const row = this.state.all('capacity_recovery').find(r => r.attempts.some(a => a.clientId === marker))
          if (row) this.registerRecoveryTurn(row, t, marker)
          this.save(); return
        }
        const id = discordMessageId(item.content)
        if (id) {
          const input = this.state.get('inbox', id)
          t.taskId = t.taskId || input?.taskId || id
          // A received/queued message isn't a new response scope until the
          // model incorporates it. Start/completed replays of the same message
          // must not re-enable automatic copies of an already delivered reply.
          if (!t.messageIds.includes(id)) { t.responseMessageId = id; delete t.explicitReply }
          t.messageIds = [...new Set([...t.messageIds, id])]
          t.inputVersion = input?.inputVersion ?? t.inputVersion ?? 0
          if (input) { input.status = 'working'; input.turnId = t.id; this.state.put('inbox', id, input) }
          else if (!this.bootstrapping) this.state.insert('outbox', `adopt:${id}`, { type: 'adopt', channelId: this.channelId, taskId: t.taskId, codexTurnId: t.id, eventId: `adopt:${id}` })
          this.emit({ eventId, taskId: t.taskId, codexTurnId: t.id, status: 'working', startedAt: t.startedAt, messageIds: [id], activity: input?.mode === 'steer' ? 'Follow-up incorporated into the active task' : 'Working on your request', milestone: input?.mode === 'steer' ? 'Follow-up incorporated' : undefined })
        }
      } else if (item.type === 'McpToolCall' && /discord_reply$/.test(item.tool || '')) {
        const text = item.arguments?.text
        const scope = t.responseMessageId || t.id
        // A reply started before a new follow-up may finish afterward. Its
        // result belongs to the request it started answering, including replay.
        if (p.type === 'item_started' && item.id) { t.replyScopes ||= {}; t.replyScopes[item.id] ||= scope }
        const replyScope = t.replyScopes?.[item.id] || scope
        if (p.type === 'item_completed' && replyScope === scope) {
          if (/^completed?$/i.test(item.status || '') && !item.result?.isError) {
            // Once the agent uses explicit Discord delivery, it owns prose for
            // this incorporated request. A terminal paraphrase is not a second
            // answer. Persist the marker with the turn, including file replies.
            t.explicitReply = true
            if (text) { this.state.put('public_hash', digest(`${t.id}:${t.responseMessageId || t.id}:${text}`), { at: Date.now() }); t.lastReply = clip(text, 600) }
          } else delete t.explicitReply // A failed delivery keeps prose fallback available.
        }
      } else if (t.taskId && item.type === 'AgentMessage') {
        const text = publicText(item)
        const final = item.phase === 'final_answer' || item.phase === 'final'
        const duplicate = text && this.state.get('public_hash', digest(`${t.id}:${t.responseMessageId || t.id}:${text}`))
        if (text.trim() && !duplicate && !t.explicitReply) {
          this.emit({ eventId, taskId: t.taskId, text, activity: final ? 'Writing the result' : clip(text, 220), status: item.questions?.length ? 'waiting' : 'working' })
          this.state.put('public_hash', digest(`${t.id}:${t.responseMessageId || t.id}:${text}`), { at: Date.now() })
          t.lastReply = clip(text, 600)
        }
      } else if (t.taskId && item.type === 'CommandExecution') {
        const label = commandLabel(item)
        const exit = item.exit_code ?? item.exitCode
        const milestone = p.type === 'item_started' ? undefined : `${label} — ${exit === 0 ? 'completed' : exit == null ? (item.status || 'finished') : `exit ${exit}`}`
        this.addLog(t, milestone || label)
        if (item.cwd) {
          let path = item.cwd
          while (path !== dirname(path) && !existsSync(join(path, '.git'))) path = dirname(path)
          if (existsSync(join(path, '.git'))) t.repos = [...new Set([...t.repos, path])]
        }
        this.emit({ eventId, taskId: t.taskId, milestone, activity: label, status: 'working' })
      } else if (t.taskId && item.type === 'FileChange') {
        const changes = item.changes || []
        const paths = Array.isArray(changes) ? changes.map(c => c.path) : Object.keys(changes)
        t.files = [...new Set([...t.files, ...paths])]
        const diffs = Array.isArray(changes) ? changes.map(c => c.diff || '').join('\n') : Object.values(changes).map(c => c.diff || c.unified_diff || '').join('\n')
        if (diffs) this.state.put('diff', eventId, { taskId: t.taskId, text: redact(diffs).slice(0, 1000000) })
        const line = `Updated ${paths.length} file(s): ${paths.map(p => clip(p, 80)).join(', ')}`
        this.addLog(t, line); this.emit({ eventId, taskId: t.taskId, files: paths, milestone: line, activity: 'Editing files', status: 'working' })
      } else if (t.taskId && /RequestUserInput|Elicitation/.test(item.type || '')) {
        this.emit({ eventId, taskId: t.taskId, status: 'waiting', activity: 'Waiting for your input' })
      }
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted' || p.type === 'task_failed') {
      // task_complete is a terminal envelope, including provider failures. Its
      // error must win over prior assistant prose before the replay guard seals
      // the turn. Never publish arbitrary fields from the error payload.
      const failed = p.type === 'task_failed' || p.error != null
      const status = p.type === 'turn_aborted' ? 'interrupted' : failed ? 'failed' : t.stopRequested ? 'interrupted' : 'complete'
      const error = typeof p.error === 'string' ? p.error : typeof p.error?.message === 'string' ? p.error.message : null
      const summary = failed ? error || (typeof p.message === 'string' ? p.message : '') || 'Codex task failed' : p.last_agent_message || p.message || t.lastReply
      this.finish(t, status, eventId, summary, p.error ?? (p.type === 'task_failed' ? p.message : null))
    } else if (p.type === 'error' && t.taskId) {
      this.emit({ eventId, taskId: t.taskId, activity: clip(p.message || p.error?.message || 'Codex error', 220), milestone: 'Codex reported an error; checking recovery' })
    }
    this.save()
  }
  addLog(t, text) { t.logs = [...(t.logs || []), `${new Date().toISOString()} ${redact(text)}`].slice(-300) }
  finish(t, status, eventId, summary, error = null) {
    if (terminalStates.has(t.status)) return
    this.state.transaction(() => {
      t.status = status; t.summary = clip(summary || '', 650); t.capacityErrorClass = status === 'failed' ? capacityFailure(error) : null
      const recovery = this.capacityTerminal(t)
      if (t.taskId) this.emit({ eventId, taskId: t.taskId, status, messageIds: t.messageIds, summary: t.summary,
        activity: recovery?.status === 'scheduled' ? `Model capacity unavailable; same-model recovery ${recovery.attempts.length + 1}/4 scheduled` : status === 'complete' ? 'Finished' : status === 'interrupted' ? 'Stopped' : 'Run failed',
        ...(recovery?.status === 'scheduled' ? { milestone: `Same-model retry in ${Math.ceil((recovery.dueAt - this.now()) / 1000)} seconds; check saved results and continue unfinished work` } : recovery?.status === 'exhausted' ? { milestone: 'Bounded capacity recovery exhausted; no further automatic continuation' } : {}) })
      for (const id of t.messageIds || []) {
        const input = this.state.get('inbox', id)
        if (input) { input.status = status; this.state.put('inbox', id, input) }
      }
      if (this.session.activeTurnId === t.id) this.session.activeTurnId = null
      this.save()
    })
  }
  capacityPending() { return this.state.all('capacity_recovery').find(r => recoveryPending.has(r.status)) || null }
  cancelCapacityRecoveries(reason, taskId = null) {
    let count = 0
    for (const r of this.state.all('capacity_recovery')) if (!recoveryClosed.has(r.status) && (!taskId || r.taskId === taskId)) {
      r.status = 'cancelled'; r.cancelReason = reason; r.cancelledAt = this.now(); r.lease = null
      this.state.put('capacity_recovery', r.id, r); count++
    }
    return count
  }
  capacityTerminal(t) {
    let r = t.capacityRecoveryId ? this.state.get('capacity_recovery', t.capacityRecoveryId) : null
    if (r && recoveryClosed.has(r.status)) {
      const incorporatedNewInput = t.messageIds?.some(id => (this.state.get('inbox', id)?.inputVersion || 0) > r.inputVersion)
      if (r.status === 'cancelled' && r.cancelReason === 'new_user_input' && t.capacityErrorClass &&
          !t.stopRequested && t.inputVersion > r.inputVersion && incorporatedNewInput) r = null
      else return r
    }
    if (r) {
      const a = r.attempts.find(a => a.turnId === t.id)
      if (a) { a.status = t.status; a.finishedAt = this.now() }
      r.lease = null
      if (t.status !== 'failed' || !t.capacityErrorClass) {
        r.status = t.status === 'complete' ? 'complete' : 'cancelled'; r.cancelReason = 'non_capacity_terminal'
        this.state.put('capacity_recovery', r.id, r); return r
      }
    }
    if (!t.capacityErrorClass || t.stopRequested || this.bootstrapping || t.turnTrigger === 'goal' || !t.taskId || !t.messageIds?.length || !this.session.threadId || !this.projectDir) return r
    const startedAt = timestampMs(t.startedAt)
    if (startedAt == null) return r
    t.startedAt = startedAt
    const newer = this.state.all('inbox').some(i => !t.messageIds.includes(i.messageId) && timestampMs(i.receivedAt) >= startedAt)
    if (newer || (t.inputVersion ?? 0) !== (this.session.inputVersion || 0)) {
      if (r) { r.status = 'cancelled'; r.cancelReason = 'new_user_input'; this.state.put('capacity_recovery', r.id, r) }
      return r
    }
    r ||= { id: stableId(`capacity:${this.channelId}:${this.session.threadId}:${t.id}`), threadId: this.session.threadId, projectDir: this.projectDir,
      failedRootTurnId: t.id, taskId: t.taskId, messageIds: [...t.messageIds], responseMessageId: t.responseMessageId || t.messageIds.at(-1),
      inputVersion: this.session.inputVersion || 0, model: t.model || this.session.model || null, effort: t.effort || this.session.effort || null,
      createdAt: this.now(), expiresAt: this.now() + 15 * 60 * 1000, attempts: [] }
    r.failedTurnId = t.id; r.errorClass = t.capacityErrorClass
    t.capacityRecoveryId = r.id
    if (r.attempts.length >= capacityBackoffMs.length || this.now() >= r.expiresAt) r.status = 'exhausted'
    else { r.status = 'scheduled'; r.dueAt = this.now() + capacityBackoffMs[r.attempts.length] }
    this.state.put('capacity_recovery', r.id, r); return r
  }
  recoveryText(r, a) {
    return `[codex_capacity_recovery id=${a.clientId}]\nBridge-generated recovery metadata, not a new human request. Same bound project/thread; capacity attempt ${a.number}/4 after failed turn ${r.failedTurnId}.\nResume only UNFINISHED work already authorized in this thread, including incorporated user steering through the original Discord message IDs ${r.messageIds.join(', ')}. First inspect current files, receipts and actual running/completed jobs. Preserve completed changes and do not replay completed renders, commands or other side effects. Continue the existing task scope; do not invent new work, re-send the original request, resume/change goals, or modify model/effort. If the work is already complete or needs user input, report that instead of restarting it.`
  }
  registerRecoveryTurn(row, turn, clientId) {
    const r = this.state.get('capacity_recovery', row.id); const a = r?.attempts.find(a => a.clientId === clientId)
    if (!a) return
    const existing = this.session.turns[turn.id] || turn
    const wasUnattributedTerminal = terminalStates.has(existing.status) && !existing.taskId
    const terminal = existing.status
    Object.assign(existing, { id: turn.id, rootId: turn.id, taskId: existing.taskId || r.taskId,
      messageIds: [...new Set([...r.messageIds, ...(existing.messageIds || [])])], responseMessageId: existing.responseMessageId || r.responseMessageId,
      inputVersion: Math.max(existing.inputVersion || 0, r.inputVersion), model: existing.model || r.model, effort: existing.effort || r.effort,
      capacityRecoveryId: existing.capacityRecoveryId || r.id, capacityAttemptClientId: existing.capacityAttemptClientId || a.clientId })
    existing.startedAt = timestampMs(existing.startedAt) ?? this.now(); existing.status ||= 'working'; existing.logs ||= []; existing.files ||= []; existing.repos ||= []
    this.session.turns[turn.id] = existing
    a.turnId = turn.id; a.status = existing.status
    if (!recoveryClosed.has(r.status) && r.status !== 'scheduled') { r.status = 'resumed'; r.lease = null }
    this.state.put('capacity_recovery', r.id, r); this.save()
    if (wasUnattributedTerminal) {
      existing.status = 'working'
      this.finish(existing, terminal, `capacity-attributed:${turn.id}`, existing.summary || existing.lastReply,
        existing.capacityErrorClass === 'server_overloaded' ? { codex_error_info: 'server_overloaded' } : existing.capacityErrorClass === 'model_at_capacity_message' ? 'Selected model is at capacity. Please try a different model.' : null)
    } else if (!terminalStates.has(existing.status)) {
      this.session.activeTurnId = existing.id; this.save()
      this.emit({ eventId: `capacity-resumed:${turn.id}`, taskId: r.taskId, codexTurnId: turn.id, status: 'working', startedAt: existing.startedAt,
        activity: 'Resuming unfinished work after temporary model capacity; checking existing files and jobs' })
    }
    return existing
  }
  async reconcileCapacity(r, attempt) {
    let cursor = null, queued = null, otherQueued = false
    do {
      const page = await this.codex.request('thread/queue/list', { threadId: r.threadId, cursor, limit: 100 })
      for (const q of page.data) {
        if (attempt && (q.clientUserMessageId === attempt.clientId || recoveryMarker(q.input) === attempt.clientId)) queued ||= q
        else otherQueued = true
      }
      cursor = page.nextCursor
    } while (cursor)
    const { thread } = await this.codex.request('thread/read', { threadId: r.threadId, includeTurns: true })
    if (thread.cwd !== r.projectDir || thread.id && thread.id !== r.threadId) throw new Error('Capacity recovery binding differs from its original project/thread')
    const consumed = attempt && thread.turns?.find(t => (t.items || []).some(i =>
      ['userMessage', 'UserMessage'].includes(i.type) &&
      (i.clientId === attempt.clientId || i.clientUserMessageId === attempt.clientId || recoveryMarker(i.content) === attempt.clientId)))
    return { thread, queued, consumed, otherQueued }
  }
  async deliverCapacityRecoveries() {
    if (this.recovering || this.delivering || !this.session.threadId || this.bootstrapping) return
    this.recovering = true
    try {
      for (const candidate of this.state.all('capacity_recovery')) {
        const cleanup = recoveryClosed.has(candidate.status) && candidate.attempts.some(a => a.attemptedAt && !a.cleanupDone && !terminalStates.has(a.status))
        if (!recoveryPending.has(candidate.status) && !cleanup) continue
        const now = this.now()
        if ((candidate.checkAfter || 0) > now || candidate.status === 'scheduled' && candidate.dueAt > now) continue
        let r = this.state.transaction(() => {
          const row = this.state.get('capacity_recovery', candidate.id)
          if (row.lease && row.lease.until > now && row.lease.owner !== this.recoveryOwner) return null
          row.lease = { owner: this.recoveryOwner, until: now + 60000 }
          this.state.put('capacity_recovery', row.id, row); return row
        })
        if (!r) continue
        try {
          let a = r.status === 'scheduled' ? null : r.attempts.at(-1)
          const known = await this.reconcileCapacity(r, a)
          r = this.state.get('capacity_recovery', r.id)
          if (recoveryClosed.has(r.status)) {
            if (known.queued) await this.codex.request('thread/queue/delete', { threadId: r.threadId, queuedSubmissionId: known.queued.id })
            if (known.consumed && r.cancelReason === 'user_stop' && known.consumed.status === 'inProgress')
              await this.codex.request('turn/interrupt', { threadId: r.threadId, turnId: known.consumed.id })
            a = r.attempts.at(-1); if (a) a.cleanupDone = true
            this.state.put('capacity_recovery', r.id, r); continue
          }
          if (known.consumed) {
            const actual = known.consumed
            const status = actual.status === 'inProgress' ? 'working' : actual.status === 'failed' ? 'failed' : actual.status === 'interrupted' ? 'interrupted' : 'complete'
            const t = this.registerRecoveryTurn(r, { id: actual.id, status: 'working', startedAt: this.now() }, a.clientId)
            if (status !== 'working') this.finish(t, status, `capacity-reconciled:${actual.id}`, actual.error?.message || t.lastReply, actual.error)
            continue
          }
          const newerInput = r.inputVersion !== (this.session.inputVersion || 0) || this.state.all('inbox').some(i =>
            !r.messageIds.includes(i.messageId) && i.receivedAt >= r.createdAt)
          const latest = known.thread.turns?.at(-1)
          const failed = known.thread.turns?.find(t => t.id === r.failedTurnId)
          const selectionChanged = known.thread.model && r.model && known.thread.model !== r.model ||
            known.thread.reasoningEffort && r.effort && known.thread.reasoningEffort !== r.effort
          if (r.threadId !== this.session.threadId || r.projectDir !== this.projectDir || newerInput || selectionChanged || known.otherQueued ||
              !failed || failed.status !== 'failed' || latest?.id !== r.failedTurnId) {
            r.status = 'cancelled'; r.cancelReason = newerInput ? 'new_user_input' : selectionChanged ? 'selection_changed' : known.otherQueued ? 'other_input_queued' : 'thread_advanced_or_binding_changed'
            this.state.put('capacity_recovery', r.id, r)
            if (known.queued) await this.codex.request('thread/queue/delete', { threadId: r.threadId, queuedSubmissionId: known.queued.id })
            continue
          }
          if (this.now() >= r.expiresAt) {
            r.status = 'exhausted'; this.state.put('capacity_recovery', r.id, r)
            if (known.queued) await this.codex.request('thread/queue/delete', { threadId: r.threadId, queuedSubmissionId: known.queued.id })
            continue
          }
          if (known.thread.status.type !== 'idle' || !known.thread.canAcceptDirectInput) {
            r.checkAfter = this.now() + 15000; this.state.put('capacity_recovery', r.id, r); continue
          }
          if (!a) {
            const number = r.attempts.length + 1
            if (number > capacityBackoffMs.length) { r.status = 'exhausted'; this.state.put('capacity_recovery', r.id, r); continue }
            a = { number, clientId: stableId(`capacity-input:${r.id}:${number}`), status: 'dispatching', createdAt: this.now() }
            r.attempts.push(a); r.status = 'dispatching'
            this.state.put('capacity_recovery', r.id, r)
          }
          if (!known.queued) {
            a.attemptedAt = this.now(); this.state.put('capacity_recovery', r.id, r)
            const result = await this.codex.request('thread/queue/add', { threadId: r.threadId,
              clientUserMessageId: a.clientId, input: [{ type: 'text', text: this.recoveryText(r, a), text_elements: [] }] })
            a.queuedId = result.queuedSubmission.id
          } else a.queuedId = known.queued.id
          // New input/Stop can arrive during either RPC. Check persisted state
          // again BEFORE starting; cancelled work never becomes a new prompt.
          const fresh = this.state.get('capacity_recovery', r.id)
          if (recoveryClosed.has(fresh.status) || fresh.inputVersion !== (this.session.inputVersion || 0) || fresh.lease?.owner !== this.recoveryOwner) {
            await this.codex.request('thread/queue/delete', { threadId: r.threadId, queuedSubmissionId: a.queuedId })
            continue
          }
          fresh.attempts.at(-1).queuedId = a.queuedId; fresh.attempts.at(-1).status = 'queued'; fresh.status = 'queued'
          this.state.put('capacity_recovery', fresh.id, fresh)
          const started = await this.codex.request('thread/queue/start', { threadId: r.threadId, queuedSubmissionId: a.queuedId })
          const turnId = started.turn?.id || started.turnId
          if (turnId) this.registerRecoveryTurn(fresh, { id: turnId, status: 'working', startedAt: this.now() }, a.clientId)
        } catch (e) {
          const current = this.state.get('capacity_recovery', r.id)
          if (current?.lease?.owner === this.recoveryOwner) {
            const uncertain = /^Codex (?:control (?:connection closed|unavailable)|socket connect timed out|.+ timed out; delivery outcome is uncertain)$/.test(e.message)
            // Definite auth/quota/invalid-request/safety errors are not capacity
            // errors. Only an uncertain transport outcome may be reconciled.
            if (!uncertain && !recoveryClosed.has(current.status)) { current.status = 'cancelled'; current.cancelReason = 'delivery_rejected' }
            if (this.now() >= current.expiresAt && !recoveryClosed.has(current.status)) current.status = 'exhausted'
            current.checkAfter = this.now() + 15000; current.lastDeliveryError = clip(e.message, 160)
            this.state.put('capacity_recovery', current.id, current)
          }
          const stopped = recoveryClosed.has(this.state.get('capacity_recovery', r.id)?.status)
          this.log(`Capacity recovery ${stopped ? 'stopped; no further automatic continuation' : 'delivery uncertain; reconciling before any retry'}: ${clip(e.message, 180)}`)
        } finally {
          const current = this.state.get('capacity_recovery', r.id)
          if (current?.lease?.owner === this.recoveryOwner) { current.lease = null; this.state.put('capacity_recovery', current.id, current) }
        }
      }
    } finally { this.recovering = false }
  }
  async snapshot() {
    const { thread } = await this.codex.request('thread/read', { threadId: this.session.threadId, includeTurns: false })
    if (thread.cwd !== this.projectDir) throw new Error('Bound Codex thread belongs to a different project')
    this.session.model = thread.model || this.session.model; this.session.effort = thread.reasoningEffort || this.session.effort
    this.save(); return thread
  }
  async reconcile(input) {
    // After an uncertain send or restart, inspect both queue and consumed history.
    let cursor = null
    do {
      const page = await this.codex.request('thread/queue/list', { threadId: this.session.threadId, cursor, limit: 100 })
      const queued = page.data.find(q => q.clientUserMessageId === input.clientId || q.input.some(c => c.type === 'text' && discordMessageId(c.text) === input.messageId))
      if (queued) return { queued }
      cursor = page.nextCursor
    } while (cursor)
    if (!input.attemptedAt) return {}
    const { thread } = await this.codex.request('thread/read', { threadId: this.session.threadId, includeTurns: true })
    for (const turn of thread.turns) for (const item of turn.items || []) if (item.type === 'userMessage' && (item.clientId === input.clientId || discordMessageId(item.content) === input.messageId)) return { consumed: turn }
    return {}
  }
  async deliverPending() {
    if (this.delivering || !this.session.threadId) return
    this.delivering = true
    try {
      for (let input of this.state.all('inbox').filter(i => ['received', 'uncertain', 'queued'].includes(i.status))) {
        if (input.retryAfter && Date.now() < input.retryAfter) continue
        const thread = await this.snapshot()
        if (thread.status.type === 'notLoaded' || !thread.canAcceptDirectInput) throw new Error('The bound Codex session is not ready for direct input')
        const known = await this.reconcile(input)
        if (known.consumed) {
          const turn = known.consumed
          const status = turn.status === 'inProgress' ? 'working' : turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'complete'
          input.status = status; this.state.put('inbox', input.messageId, input)
          this.emit({ eventId: `recovered:${input.messageId}:${status}`, taskId: input.taskId, status, messageIds: [input.messageId], activity: `Recovered delivery: ${status}` })
          continue
        }
        if (known.queued) {
          input.status = 'queued'; input.queuedId = known.queued.id; this.state.put('inbox', input.messageId, input)
          if (thread.status.type === 'idle') await this.codex.request('thread/queue/start', { threadId: this.session.threadId, queuedSubmissionId: input.queuedId })
          continue
        }
        const active = this.active()
        // Incorporate new Discord input into active work before starting an unrelated task:
        // agents run long self-driven turns, so waiting for the turn to finish left his new requests unanswered
        // for 30+ minutes. Only with no known active turn do we wait.
        if (thread.status.type === 'active' && !active) continue
        const text = `[discord #${this.channelName} from ${input.authorName} msg=${input.messageId}]\n${input.content || '(no text)'}`
        const args = { threadId: this.session.threadId, input: [{ type: 'text', text, text_elements: [] }] }
        input.attemptedAt = Date.now(); input.status = 'uncertain'; this.state.put('inbox', input.messageId, input)
        try {
          if (thread.status.type === 'active') {
            await this.codex.request('turn/steer', { ...args, clientUserMessageId: input.clientId, expectedTurnId: active.id })
          } else {
            const { queuedSubmission } = await this.codex.request('thread/queue/add', { ...args, clientUserMessageId: input.clientId })
            input.queuedId = queuedSubmission.id
            this.state.put('inbox', input.messageId, input)
            await this.codex.request('thread/queue/start', { threadId: this.session.threadId, queuedSubmissionId: input.queuedId })
          }
          // The monitor might already have seen consumption while the RPC was in flight.
          const saved = this.state.get('inbox', input.messageId)
          if (saved.status === 'uncertain') { input.status = 'queued'; this.state.put('inbox', input.messageId, input)
            this.emit({ eventId: `queued:${input.messageId}`, taskId: input.taskId, status: 'queued', messageIds: [input.messageId], activity: input.mode === 'steer' ? 'Follow-up delivered; waiting for incorporation' : 'Delivered to Codex' }) }
        } catch (e) {
          input = this.state.get('inbox', input.messageId)
          if (['working', ...terminalStates].includes(input.status)) continue
          input.status = 'uncertain'; input.retryAfter = Date.now() + 15000; input.error = clip(e.message); this.state.put('inbox', input.messageId, input)
          this.emit({ eventId: `uncertain:${input.messageId}:${input.attemptedAt}`, taskId: input.taskId, activity: 'Checking an uncertain delivery before retrying', milestone: clip(e.message, 160) })
        }
      }
    } finally { this.delivering = false }
  }
  async control(action, taskId, argument = '') {
    if (action === 'bind') {
      if (this.active() || this.state.all('inbox').some(i => !terminalStates.has(i.status))) throw new Error('Finish or stop pending work before changing the binding')
      if (!/^[0-9a-f-]{36}$/i.test(argument)) throw new Error('Use !bind followed by a Codex session UUID')
      const { thread } = await this.codex.request('thread/read', { threadId: argument, includeTurns: false })
      if (thread.cwd !== this.projectDir || !thread.canAcceptDirectInput) throw new Error('Choose a loaded Codex session for this project')
      this.session.threadId = thread.id; this.session.rolloutPath = thread.path; this.save()
      this.cancelCapacityRecoveries('binding_changed')
      return { text: `Bound to Codex session ${thread.id}.` }
    }
    if (action === 'stop') {
      const cancelledRecoveries = this.cancelCapacityRecoveries('user_stop', taskId)
      const active = this.active()
      if (active && (!taskId || active.taskId === taskId)) {
        await this.codex.request('turn/interrupt', { threadId: this.session.threadId, turnId: active.id })
        active.stopRequested = true; this.save()
        this.emit({ eventId: `stop:${active.id}`, taskId: active.taskId, activity: 'Stop requested; waiting for cancellation' })
        return { text: 'Stop requested for the running task.' }
      }
      const inputs = this.state.all('inbox').filter(i => i.taskId === taskId && ['received', 'queued', 'uncertain'].includes(i.status))
      if (!inputs.length) return { text: cancelledRecoveries ? 'Cancelled automatic capacity recovery for this task.' : 'This task is no longer running.' }
      for (const input of inputs) {
        const known = await this.reconcile(input)
        if (known.consumed?.status === 'inProgress') throw new Error('Task just started; try Stop again once Status updates')
        if (known.queued) await this.codex.request('thread/queue/delete', { threadId: this.session.threadId, queuedSubmissionId: known.queued.id })
        input.status = 'interrupted'; this.state.put('inbox', input.messageId, input)
      }
      this.emit({ eventId: `cancel:${taskId}`, taskId, status: 'interrupted', messageIds: inputs.map(i => i.messageId), activity: 'Cancelled before starting' })
      return { text: 'Cancelled the queued task.' }
    }
    const t = taskId ? this.taskTurn(taskId) : this.active()
    if (!t) return { text: 'No recorded work is available for that task yet.' }
    const dir = join(this.home, 'discord-artifacts'); mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (action === 'logs') {
      const path = join(dir, `${t.taskId}-activity.log`)
      writeFileSync(path, (t.logs || []).join('\n') + '\n', { mode: 0o600 })
      return { text: 'Public activity log for this task.', files: [path] }
    }
    if (action === 'diff') {
      const parts = this.state.all('diff').filter(d => d.taskId === t.taskId).map(d => d.text)
      for (const repo of t.repos || []) {
        try {
          const { stdout } = await exec('git', ['diff', '--no-ext-diff', 'HEAD', '--'], { cwd: repo, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })
          if (stdout) parts.push(`Working tree diff in ${repo} (includes current uncommitted changes):\n${redact(stdout)}`)
        } catch (e) { parts.push(`Could not read diff: ${clip(e.message)}`) }
      }
      if (!parts.length) return { text: 'No patch has been recorded for this task yet.' }
      const path = join(dir, `${t.taskId}.diff`); writeFileSync(path, parts.join('\n').slice(0, 2 * 1024 * 1024), { mode: 0o600 })
      return { text: 'Recorded patches and current working tree diff.', files: [path] }
    }
    throw new Error(`Unknown control: ${action}`)
  }
}
