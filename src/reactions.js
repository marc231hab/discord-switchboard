import { emoji, terminalStates } from './presentation.js'

const normalized = name => (name || '').replace(/[\uFE0E\uFE0F]/g, '')
const lifecycle = new Set(Object.values(emoji).map(normalized))
export class Reactions {
  constructor(service) { this.s = service }
  seed() {
    for (const m of this.s.state.all('message')) {
      if (m.control || m.synthetic || !m.payload?.originChannelId || !emoji[m.status]) continue
      const task = this.s.state.get('task', m.taskId)
      const status = task && terminalStates.has(task.status) ? task.status : m.status
      this.s.state.put('reaction', `${m.payload.originChannelId}:${m.id}`, { channelId: m.payload.originChannelId, messageId: m.id, status, pending: true, attempts: 0 })
    }
  }
  async set(channelId, messageId, status) {
    if (!emoji[status] || this.s.state.get('message', messageId)?.synthetic) return
    const id = `${channelId}:${messageId}`
    // Persist the latest desired state before REST. The serial worker reads it again.
    this.s.state.put('reaction', id, { channelId, messageId, status, pending: true, attempts: 0 })
    await this.apply(id)
  }
  async apply(id) {
    return this.s.serial(`reaction:${id}`, async () => {
      const row = this.s.state.get('reaction', id)
      if (!row?.pending) return
      try {
        const message = await (await this.s.channel(row.channelId)).messages.fetch({ message: row.messageId, force: true, cache: false })
        for (const reaction of message.reactions.cache.values()) {
          if (reaction.me && !reaction.emoji.id && lifecycle.has(normalized(reaction.emoji.name)) && normalized(reaction.emoji.name) !== normalized(emoji[row.status])) await reaction.users.remove(this.s.client.user.id)
        }
        if (![...message.reactions.cache.values()].some(r => r.me && !r.emoji.id && normalized(r.emoji.name) === normalized(emoji[row.status]))) await message.react(emoji[row.status])
        const current = this.s.state.get('reaction', id)
        if (current.status === row.status) { current.pending = false; current.attempts = 0; this.s.state.put('reaction', id, current) }
      } catch (error) {
        const current = this.s.state.get('reaction', id)
        if (current.status !== row.status) return
        current.attempts = (current.attempts || 0) + 1
        current.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(current.attempts - 1, 6))
        // Deleted messages/channels cannot be repaired. Permission and network failures can.
        if ([10003, 10008].includes(error.code)) current.pending = false
        this.s.state.put('reaction', id, current)
        this.s.log(`reaction ${row.messageId}: ${error.message}`)
      }
    })
  }
  async flush() {
    for (const row of this.s.state.all('reaction').filter(r => r.pending && (!r.retryAt || r.retryAt <= Date.now())).slice(0, 8)) await this.apply(`${row.channelId}:${row.messageId}`)
  }
}
