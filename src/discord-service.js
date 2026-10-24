import { randomUUID, createHash } from 'node:crypto'
import { statSync, realpathSync } from 'node:fs'
import { isAbsolute, basename } from 'node:path'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import { clip, redact, renderTask, renderBinding, emoji, terminalStates, splitText, bridgeKinds, bridgeRoles } from './presentation.js'
import { Questions } from './questions.js'
import { Overview } from './overview.js'
import { Reactions } from './reactions.js'

export class DiscordService {
  constructor({ client, state, log = console.error, allowedUsers = [], taskThreads = true, overviewChannelId }) {
    this.client = client; this.state = state; this.log = log; this.allowedUsers = allowedUsers; this.taskThreads = taskThreads
    this.peers = new Map(); this.controls = new Map(); this.dirty = new Set(); this.chains = new Map(); this.flushing = false
    this.questions = new Questions(this); this.overview = new Overview(this, overviewChannelId); this.reactions = new Reactions(this)
  }
  allowed(id) { return !this.allowedUsers.length || this.allowedUsers.includes(id) }
  binding(id) { return this.state.get('binding', id) }
  peer(id) { return [...(this.peers.get(id) || [])].find(p => bridgeRoles.includes(p.role)) }
  send(peer, value) { if (!peer.socket.destroyed) peer.socket.write(JSON.stringify(value) + '\n') }
  register(socket, msg) {
    const role = msg.role || 'claude'
    const peer = { socket, role, channelId: msg.channelId }
    if (!this.peers.has(msg.channelId)) this.peers.set(msg.channelId, new Set())
    this.peers.get(msg.channelId).add(peer)
    socket.once('close', () => {
      this.peers.get(msg.channelId)?.delete(peer)
      if (bridgeRoles.includes(role)) this.dirty.add(`binding:${msg.channelId}`)
    })
    if (bridgeRoles.includes(role)) {
      // Reject two delivery owners: duplicate agents must not consume a message.
      const owners = [...this.peers.get(msg.channelId)].filter(p => bridgeRoles.includes(p.role))
      if (owners.length > 1) { this.peers.get(msg.channelId).delete(peer); socket.destroy(); return }
      const old = this.binding(msg.channelId)
      this.state.put('binding', msg.channelId, { ...old, channelId: msg.channelId, channelName: msg.channelName, kind: role.replace('_bridge', ''), engine: role.replace('_bridge', ''), enabledAt: old?.enabledAt || Date.now(), lastSeen: Date.now() })
    }
    this.send(peer, { type: 'registered', channelId: msg.channelId })
    this.replay(msg.channelId)
    return peer
  }
  replay(channelId) {
    const peer = this.peer(channelId)
    if (!peer) return
    for (const row of this.state.all('message')) {
      if (row.channelId === channelId && !row.bridgeReceived && !terminalStates.has(row.status)) this.send(peer, { ...row.payload, type: 'message', taskId: row.taskId, mode: row.mode })
    }
  }
  serial(key, work) {
    const previous = this.chains.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.chains.set(key, next)
    next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key) }).catch(() => {})
    return next
  }
  async channel(id) {
    if (this.client.isReady && !this.client.isReady()) throw Error('Discord is connecting; retry in a moment')
    const channel = await this.client.channels.fetch(id)
    if (!channel) throw Error('Discord channel is unavailable')
    return channel
  }
  taskForThread(id) { return this.state.all('task').find(t => t.threadId === id) }
  replyChannel(task, channelId) { return this.taskThreads && task?.threadId || channelId }
  async receive(message) {
    if (message.author?.bot || !this.allowed(message.author.id)) return
    const threadTask = this.taskForThread(message.channelId)
    const channelId = threadTask?.channelId || message.channelId
    const b = this.binding(channelId)
    const peers = this.peers.get(channelId)
    if (!b && !peers?.size) return
    if (!bridgeKinds.includes(b?.kind)) {
      for (const p of peers || []) if (p.role === 'claude') this.send(p, this.payload(message, channelId))
      return
    }
    return this.serial(channelId, async () => {
      if (this.state.get('message', message.id)) return
      const command = /^!(status|stop|diff|logs|bind|overview)\b\s*(.*)$/is.exec(message.content || '')
      if (command) {
        this.state.insert('message', message.id, { id: message.id, channelId, status: 'complete', control: true, bridgeReceived: true })
        this.checkpoint(message.channelId, message.id)
        const result = await this.control(channelId, command[1].toLowerCase(), threadTask?.id || this.binding(channelId)?.currentTask, command[2].trim())
        await message.reply({ content: result.text, files: result.files, allowedMentions: { parse: [], repliedUser: false } })
        return
      }
      const isNew = /^!new\s+/i.test(message.content || '')
      const current = threadTask || this.state.get('task', this.binding(channelId)?.currentTask || '') || this.state.all('task').reverse().find(t => t.channelId === channelId && !terminalStates.has(t.status))
      // A task thread remains its conversation after completion. Parent-channel
      // requests still create new tasks when idle; !new always separates work.
      let task = !isNew && current && (threadTask || !terminalStates.has(current.status)) ? current : null
      const payload = this.payload(message, channelId)
      if (isNew) payload.content = payload.content.replace(/^!new\s+/i, '')
      this.state.transaction(() => {
        if (task && terminalStates.has(task.status)) {
          task.status = 'received'; task.activity = 'Follow-up received; waiting for delivery'
          task.startedAt = Date.now(); task.lastPublicText = ''; task.questionTurnEnded = false
          this.state.put('task', task.id, task)
        }
        if (!task) task = this.newTask(message, channelId)
        const mode = task.id === message.id ? 'new' : 'steer'
        this.state.insert('message', message.id, { id: message.id, channelId, taskId: task.id, status: 'received', bridgeReceived: false, mode, payload })
      })
      this.checkpoint(message.channelId, message.id)
      await this.reaction(message.channelId, message.id, 'received')
      this.dirty.add(task.id)
      // Creating the thread can be retried independently of delivering the prompt.
      await this.ensureTaskUI(task.id).catch(e => this.log(`task UI: ${e.message}`))
      this.replay(channelId)
    })
  }
  payload(message, channelId) {
    const attachments = [...message.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType, size: a.size }))
    const lines = attachments.map(a => `[Attachment: ${a.name} | ${a.contentType || 'unknown'} | ${(a.size / 1024).toFixed(1)}KB | ${a.url}]`)
    return { type: 'message', channelId, originChannelId: message.channelId, messageId: message.id, guildId: message.guildId || '', authorId: message.author.id, authorName: message.author.username, content: [message.content || '', ...lines].filter(Boolean).join('\n\n'), attachmentCount: attachments.length, attachments }
  }
  checkpoint(channelId, messageId) {
    const old = this.state.get('history_cursor', channelId)
    if (!old || BigInt(messageId) > BigInt(old.id)) this.state.put('history_cursor', channelId, { id: messageId })
  }
  async recoverMessages({ periodic = false } = {}) {
    // Gateway resumes cover short disconnects; history covers process restarts. The periodic sweep (every 2 min,
    // the sweep also catches individual gateway gaps; receive() deduplicates by message ID.
    // Periodic runs only scan open tasks' threads to stay well inside Discord rate limits.
    if (this.recovering) return
    this.recovering = true
    try {
    for (const b of this.state.all('binding')) {
      if (!bridgeKinds.includes(b.kind)) continue
      const ids = [b.channelId, ...this.state.all('task').filter(t => t.channelId === b.channelId && t.threadId && (!periodic || !['complete', 'failed', 'interrupted'].includes(t.status))).map(t => t.threadId)]
      for (const channelId of new Set(ids)) {
        try {
          const channel = await this.channel(channelId)
          let cursor = this.state.get('history_cursor', channelId)?.id
          for (let page = 0; page < 10; page++) {
            const messages = await channel.messages.fetch({ limit: 100, ...(cursor ? { after: cursor } : {}) })
            const rows = [...messages.values()].sort((a,b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)
            for (const m of rows) {
              if ((m.createdTimestamp || Date.now()) >= (b.enabledAt || Date.now())) await this.receive(m)
              this.checkpoint(channelId, m.id)
            }
            if (!rows.length || !cursor || rows.length < 100) break
            cursor = rows.at(-1).id
          }
        } catch (e) { this.log(`history recovery ${channelId}: ${e.message}`) }
      }
    }
    } finally { this.recovering = false }
  }
  newTask(message, channelId) {
    const t = { id: message.id, channelId, originChannelId: message.channelId, guildId: message.guildId || '', title: clip((message.content || 'Attachment task').replace(/^!new\s+/i, ''), 100), status: 'received', createdAt: Date.now(), milestones: [], files: [] }
    this.state.put('task', t.id, t)
    return t
  }
  async adopt(msg) {
    if (this.state.get('task', msg.taskId)) return
    const ch = await this.channel(msg.channelId)
    const message = await ch.messages.fetch(msg.taskId)
    if (message.author.bot || !this.allowed(message.author.id)) return
    this.newTask(message, msg.channelId)
    const payload = this.payload(message, msg.channelId)
    this.state.insert('message', msg.taskId, { id: msg.taskId, channelId: msg.channelId, taskId: msg.taskId, payload, status: 'working', bridgeReceived: true })
    await this.applyEvent({ ...msg, status: 'working', messageIds: [msg.taskId], activity: 'Continuing the current task', eventId: `adopt:${msg.taskId}` })
    await this.ensureTaskUI(msg.taskId)
  }
  buttons(taskId, disabled = false) {
    const row = new ActionRowBuilder()
    for (const [action, label, style] of [['status', 'Status', ButtonStyle.Secondary], ['stop', 'Stop', ButtonStyle.Danger], ['diff', 'Show diff', ButtonStyle.Secondary], ['logs', 'Show logs', ButtonStyle.Secondary]]) {
      row.addComponents(new ButtonBuilder().setCustomId(`cc:${action}:${taskId}`).setLabel(label).setStyle(style).setDisabled(action === 'stop' && disabled))
    }
    return [row]
  }
  async sendOnce(key, channelId, opts) {
    const old = this.state.get('sent', key)
    if (old) return old
    const channel = await this.channel(channelId)
    const nonce = BigInt('0x' + createHash('sha256').update(key).digest('hex').slice(0, 16)).toString()
    const sent = await channel.send({ ...opts, nonce, enforceNonce: true, allowedMentions: { parse: [], repliedUser: false } })
    return this.state.put('sent', key, { messageId: sent.id, channelId: sent.channelId || channelId })
  }
  async ensureTaskUI(id) {
    return this.serial(`ui:${id}`, async () => {
      let t = this.state.get('task', id)
      if (!t) return
      if (!this.taskThreads) { await this.overview.ensure(t.channelId); return }
      const parent = await this.channel(t.channelId)
      if (!t.cardId) {
        const result = await this.sendOnce(`card:${id}`, t.channelId, { content: renderTask(t), components: this.buttons(id), reply: { messageReference: id, failIfNotExists: false } })
        t = this.state.get('task', id); t.cardId = result.messageId; this.state.put('task', id, t)
      }
      if (this.taskThreads && !t.threadId && !t.threadAttempted) {
        try {
          const root = await parent.messages.fetch(t.originChannelId === t.channelId ? id : t.cardId)
          const thread = root.thread || await root.startThread({ name: clip(t.title, 90), autoArchiveDuration: 1440 })
          t = this.state.get('task', id); t.threadId = thread.id
          await thread.send({ content: 'Progress and results for this task appear here. Follow-ups in this thread steer this task; use `!new <task>` to queue separate work.', allowedMentions: { parse: [] } })
        } catch (e) { t = this.state.get('task', id); t.threadError = clip(e.message); this.log(`thread fallback: ${e.message}`) }
        t.threadAttempted = true; this.state.put('task', id, t)
      }
      this.dirty.add(id)
    })
  }
  async reaction(channelId, messageId, status) {
    await this.reactions.set(channelId, messageId, status)
  }
  async applyEvent(msg) {
    const receipt = this.state.get('event', msg.eventId)
    if (receipt?.done) return
    let t = this.state.get('task', msg.taskId)
    if (!t) throw new Error('Unknown task for event')
    const pendingAnswers = this.questions.hasQueuedAnswers(t.id)
    if (msg.status === 'complete' && (this.questions.pending(t.id).length || pendingAnswers)) {
      t.questionTurnEnded = true; this.state.put('task', t.id, t)
      msg = { ...msg, status: 'waiting', activity: pendingAnswers ? 'Answer saved; waiting for the agent to consume it' : 'Waiting for your answer in Discord' }
    }
    if (['failed', 'interrupted'].includes(msg.status)) this.questions.expire(t.id)
    if (!receipt) {
      const ranks = { received: 0, queued: 1, working: 2, waiting: 2, complete: 3, failed: 3, interrupted: 3 }
      if (msg.status && (ranks[msg.status] >= ranks[t.status] || msg.status === 'working' && msg.startedAt > (t.startedAt || 0))) t.status = msg.status
      if (msg.activity && (!msg.status || msg.status === t.status)) t.activity = clip(msg.activity, 240)
      if (msg.milestone) t.milestones = [...(t.milestones || []), clip(msg.milestone, 200)].slice(-30)
      if (msg.files) t.files = [...new Set([...(t.files || []), ...msg.files.map(p => redact(p))])]
      if (msg.startedAt) t.startedAt = msg.startedAt
      if (msg.status === 'working') t.questionTurnEnded = false
      if (msg.codexTurnId) t.codexTurnId = msg.codexTurnId
      t.lastEventAt = Date.now()
      this.state.put('task', t.id, t)
      this.state.put('event', msg.eventId, { applied: true })
    }
    const b = this.binding(t.channelId) || { channelId: t.channelId }
    if (t.status === 'working' || t.status === 'waiting') b.currentTask = t.id
    if (terminalStates.has(t.status) && b.currentTask === t.id) b.currentTask = null
    b.activity = b.currentTask ? t.activity : 'Idle'
    this.state.put('binding', t.channelId, b)
    for (const id of msg.messageIds || []) {
      const m = this.state.get('message', id)
      if (m) {
        const ranks = { received: 0, queued: 1, working: 2, waiting: 2, complete: 3, failed: 3, interrupted: 3 }
        if (msg.status && ranks[msg.status] >= ranks[m.status]) m.status = msg.status
        m.bridgeReceived = true; this.state.put('message', id, m)
        await this.reaction(m.payload?.originChannelId || t.channelId, id, m.status)
      }
    }
    // Resuming after an answer must clear waiting on the original real request too.
    if (t.status === 'working' && msg.status === 'working' && !this.questions.pending(t.id).length && !this.questions.hasQueuedAnswers(t.id)) {
      for (const m of this.state.all('message').filter(m => m.taskId === t.id && !m.control && !m.synthetic && m.bridgeReceived && m.status === 'waiting')) {
        m.status = 'working'; this.state.put('message', m.id, m)
        await this.reaction(m.payload.originChannelId, m.id, m.status)
      }
    }
    if (msg.text) {
      const key = `public:${msg.eventId}`
      await this.postText(key, this.replyChannel(t, t.channelId), redact(msg.text))
      t = this.state.get('task', t.id); t.lastPublicText = clip(msg.text, 500); this.state.put('task', t.id, t)
    }
    if (terminalStates.has(t.status) && terminalStates.has(msg.status)) {
      const messages = this.state.all('message').filter(m => m.taskId === t.id && !m.control && !terminalStates.has(m.status))
      for (const m of messages) { m.status = t.status; this.state.put('message', m.id, m); await this.reaction(m.payload.originChannelId, m.id, m.status) }
      const link = this.taskThreads && t.threadId ? ` [Open task](https://discord.com/channels/${t.guildId}/${t.threadId})` : ''
      // Flat conversations already contain the answer. Reactions and the shared
      // overview carry completion; keep explicit failure/stop notices visible.
      if (this.taskThreads || t.status !== 'complete') await this.sendOnce(`outcome:${msg.eventId}`, t.channelId, { content: `${emoji[t.status]} **${clip(t.title, 100)}** — ${t.status}.${link}\n${clip(msg.summary || t.lastPublicText || t.activity || '', 650)}` })
    }
    this.state.put('event', msg.eventId, { done: true, at: Date.now() })
    this.dirty.add(t.id); this.dirty.add(`binding:${t.channelId}`)
  }
  async postText(key, channelId, text, files = []) {
    const parts = splitText(text)
    if (!parts.length && files.length) parts.push('')
    let result
    for (let i = 0; i < parts.length; i++) result = await this.sendOnce(`${key}:${i}`, channelId, { content: parts[i] || undefined, files: i === parts.length - 1 ? files : undefined })
    return result
  }
  async reply(msg) {
    const b = this.binding(msg.channelId)
    const source = msg.replyToMessageId && this.state.get('message', msg.replyToMessageId)
    const task = this.state.get('task', msg.taskId || source?.taskId || b?.currentTask || '')
    if (source && source.channelId !== msg.channelId || task && task.channelId !== msg.channelId) throw new Error('Task belongs to a different binding')
    const channelId = this.replyChannel(task, msg.channelId)
    const files = (msg.files || []).map(path => {
      if (!isAbsolute(path)) throw new Error('Artifact paths must be absolute')
      const actual = realpathSync(path)
      if (!statSync(actual).isFile()) throw new Error('Artifact is not a file')
      return { attachment: actual, name: basename(actual) }
    })
    const options = { content: redact(msg.text || '') || undefined, files }
    if (msg.replyToMessageId && channelId === (source?.payload?.originChannelId || msg.channelId)) options.reply = { messageReference: msg.replyToMessageId, failIfNotExists: false }
    const result = msg.text?.length > 1900 ? await this.postText(`reply:${msg.operationId || msg.id}`, channelId, redact(msg.text), files) : await this.sendOnce(`reply:${msg.operationId || msg.id}`, channelId, options)
    if (task) { task.lastPublicText = clip(msg.text, 500); this.state.put('task', task.id, task) }
    return result
  }
  async control(channelId, action, taskId, argument = '') {
    const b = this.binding(channelId)
    if (action === 'overview') {
      const card = await this.overview.ensure(channelId)
      return { text: `Shared overview: <#${card.channelId}> · message ${card.messageId}` }
    }
    if (action === 'status') return { text: renderBinding(b, !!this.peer(channelId), this.state.all('message').filter(m => m.channelId === channelId && !terminalStates.has(m.status)).length) }
    const peer = this.peer(channelId)
    if (!peer) return { text: 'The bridge is offline. Saved messages will resume when it reconnects.' }
    const id = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.controls.delete(id); resolve({ text: 'The control request timed out. Use Status to check the session before retrying.' }) }, 20000)
      this.controls.set(id, { resolve, timer })
      this.send(peer, { type: 'control', id, action, taskId, argument })
    })
  }
  async interaction(interaction) {
    if (interaction.customId?.startsWith('ccq:')) return this.questions.interaction(interaction)
    if (interaction.customId?.startsWith('cco:')) return this.overview.interaction(interaction)
    if (!interaction.isButton() || !interaction.customId.startsWith('cc:')) return
    if (!this.allowed(interaction.user.id)) return interaction.reply({ content: 'This binding is restricted to its configured users.', flags: 64 })
    await interaction.deferReply({ flags: 64 })
    const [, action, id] = interaction.customId.split(':')
    const task = this.state.get('task', id)
    const channelId = task?.channelId || id
    if (!this.binding(channelId) || ![channelId, task?.threadId].includes(interaction.channelId)) return interaction.editReply('This control no longer belongs to this channel.')
    const result = await this.control(channelId, action, task?.id || this.binding(channelId)?.currentTask)
    return interaction.editReply({ content: result.text, files: result.files })
  }
  async handle(socket, msg, peer) {
    if (msg.type === 'register') return this.register(socket, msg)
    if (peer && msg.channelId && peer.channelId !== msg.channelId) throw new Error('Channel binding mismatch')
    if (msg.type === 'control_result') {
      const pending = this.controls.get(msg.id)
      if (pending) { clearTimeout(pending.timer); this.controls.delete(msg.id); pending.resolve({ text: redact(msg.text), files: (msg.files || []).map(f => ({ attachment: f, name: basename(f) })) }) }
      return
    }
    let result = {}
    if (msg.type === 'reply') result = await this.reply(msg)
    else if (msg.type === 'question') result = await this.questions.create(msg)
    else if (msg.type === 'question_cancel') result = await this.questions.cancel(msg)
    else if (msg.type === 'overview') result = await this.overview.ensure(msg.channelId)
    else if (msg.type === 'control_request') result = await this.control(msg.channelId, msg.action, msg.taskId, msg.argument)
    else if (msg.type === 'binding') {
      this.state.put('binding', msg.channelId, { ...this.binding(msg.channelId), ...msg.binding, channelId: msg.channelId, kind: msg.binding.kind || this.binding(msg.channelId)?.kind || 'codex', lastSeen: Date.now() }); this.dirty.add(`binding:${msg.channelId}`)
    } else if (msg.type === 'notify') {
      const targets = [...(this.peers.get(msg.channelId) || [])].filter(p => p.role === 'claude')
      if (!targets.length) throw new Error('Claude channel MCP is offline')
      for (const target of targets) this.send(target, { ...msg.payload, type: 'message', channelId: msg.channelId })
    } else if (msg.type === 'received') {
      const m = this.state.get('message', msg.messageId)
      if (m) { m.bridgeReceived = true; this.state.put('message', m.id, m) }
    } else if (msg.type === 'adopt') await this.adopt(msg)
    else if (msg.type === 'event') await this.serial(`event:${msg.taskId}`, () => this.applyEvent(msg))
    else if (msg.type === 'react') {
      const t = this.state.get('task', msg.taskId || this.binding(msg.channelId)?.currentTask || '')
      const source = this.state.get('message', msg.messageId)
      if (t && t.channelId !== msg.channelId || source && source.channelId !== msg.channelId) throw new Error('Message belongs to a different binding')
      const channelId = source?.payload?.originChannelId || t?.threadId || msg.channelId
      if (msg.emoji) await (await (await this.channel(channelId)).messages.fetch(msg.messageId)).react(msg.emoji)
      else await this.reaction(channelId, msg.messageId, msg.status)
    }
    else if (msg.type === 'edit') {
      const sent = this.state.all('sent').find(s => s.messageId === msg.messageId)
      const t = this.state.get('task', msg.taskId || this.binding(msg.channelId)?.currentTask || '')
      if (t && t.channelId !== msg.channelId) throw new Error('Task belongs to a different binding')
      if (sent && sent.channelId !== msg.channelId && !this.state.all('task').some(task => task.channelId === msg.channelId && task.threadId === sent.channelId)) throw new Error('Message belongs to a different binding')
      const channel = await this.channel(sent?.channelId || t?.threadId || msg.channelId)
      const message = await channel.messages.fetch(msg.messageId)
      if (message.author.id !== this.client.user.id) throw new Error('Can only edit bot messages')
      await message.edit({ content: redact(msg.text), allowedMentions: { parse: [] } })
    } else if (msg.type === 'progress') {
      const t = this.state.get('task', msg.taskId || this.binding(msg.channelId)?.currentTask || '')
      if (!t) throw new Error('No active task')
      if (t.channelId !== msg.channelId) throw new Error('Task belongs to a different binding')
      await this.applyEvent({ ...msg, taskId: t.id, eventId: msg.operationId || msg.id, activity: msg.text, status: msg.status || 'working' })
    } else throw new Error(`Unknown router action: ${msg.type}`)
    socket.write(JSON.stringify({ type: msg.type === 'reply' ? 'reply_result' : 'action_result', id: msg.id, ...result }) + '\n')
  }
  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const id of [...this.dirty]) {
        try {
          if (id.startsWith('question:')) {
            await this.questions.flush(id.slice(9))
          } else if (id.startsWith('binding:')) {
            const channelId = id.slice(8), b = this.binding(channelId)
            if (!b) { this.dirty.delete(id); continue }
            const connected = !!this.peer(channelId) && Date.now() - b.lastSeen < 45000
            const pending = this.state.all('message').filter(m => m.channelId === channelId && !terminalStates.has(m.status)).length
            const content = renderBinding(b, connected, pending)
            if (!b.statusId) {
              const result = await this.sendOnce(`binding:${channelId}`, channelId, { content, components: this.buttons(channelId) })
              b.statusId = result.messageId; this.state.put('binding', channelId, b)
            }
            const card=await (await this.channel(channelId)).messages.fetch(b.statusId)
            await card.edit({ content, components: this.buttons(channelId), allowedMentions: { parse: [] } })
            if (!b.pinSucceeded && (!b.lastPinAttempt || Date.now()-b.lastPinAttempt>300000)) {
              b.lastPinAttempt=Date.now()
              try { await card.pin(); b.pinSucceeded=true; b.pinError=null } catch (e) { b.pinError=clip(e.message); this.log(`pin: ${e.message}`) }
              this.state.put('binding',channelId,b)
            }
          } else {
            let t = this.state.get('task', id)
            if (!t) { this.dirty.delete(id); continue }
            if (!this.taskThreads) { await this.overview.ensure(t.channelId); this.dirty.delete(id); continue }
            if (!t.cardId) await this.ensureTaskUI(id)
            t = this.state.get('task', id)
            if (t.cardId) await (await (await this.channel(t.channelId)).messages.fetch(t.cardId)).edit({ content: renderTask(t), components: this.buttons(id, terminalStates.has(t.status)), allowedMentions: { parse: [] } })
          }
          if (id.startsWith('question:')) {
            const question = this.state.get('question', id.slice(9))
            if (question && question.uiStatus !== question.status) continue
          }
          this.dirty.delete(id)
        } catch (e) { this.log(`UI update ${id}: ${e.message}`) }
      }
      await this.reactions.flush()
      await this.overview.flush().catch(e => this.log(`overview: ${e.message}`))
    } finally { this.flushing = false }
  }
}
