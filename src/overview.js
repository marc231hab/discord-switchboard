import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js'
import { clip, emoji, terminalStates, bridgeKinds, kindLabel } from './presentation.js'

export class Overview {
  constructor(service, channelId) { this.s = service; this.channelId = channelId }
  bindings() {
    const priority = b => { const s = this.snapshot(b); return s.task || s.waiting || s.queued ? 0 : 1 }
    return this.s.state.all('binding').filter(b => bridgeKinds.includes(b.kind)).sort((a, b) => priority(a) - priority(b) || (a.channelName || a.channelId).localeCompare(b.channelName || b.channelId))
  }
  snapshot(b) {
    const tasks = this.s.state.all('task').filter(t => t.channelId === b.channelId && !terminalStates.has(t.status))
    const waiting = this.s.state.all('question').filter(q => q.channelId === b.channelId && q.status === 'pending').length
    const task = tasks.find(t => t.id === b.currentTask) || tasks.find(t => t.status === 'working') || tasks.find(t => t.status === 'waiting') || tasks.at(-1)
    const queued = this.s.state.all('message').filter(m => m.channelId === b.channelId && !m.control && !m.bridgeReceived && !terminalStates.has(m.status)).length
    const online = !!this.s.peer(b.channelId) && Date.now() - b.lastSeen < 45000
    return { task, waiting, queued, online }
  }
  render(record) {
    const bindings = this.bindings(), pages = Math.max(1, Math.ceil(bindings.length / 6))
    record.page = Math.max(0, Math.min(record.page || 0, pages - 1))
    const selected = bindings.slice(record.page * 6, record.page * 6 + 6)
    let working = 0, waiting = 0, online = 0
    for (const b of bindings) { const s = this.snapshot(b); if (s.online) online++; if (s.waiting || s.task?.status === 'waiting') waiting++; else if (s.task?.status === 'working') working++ }
    const lines = [`**Shared agent overview** · ${bindings.length} sessions`, `${online} online · ${working} working · ${waiting} waiting for input · page ${record.page + 1}/${pages}`]
    for (const b of selected) {
      const s = this.snapshot(b), task = s.task
      const state = s.waiting ? 'waiting' : task?.status || 'idle'
      const link = this.s.taskThreads && task?.threadId ? ` · [task](https://discord.com/channels/${task.guildId}/${task.threadId})` : ''
      lines.push(`${s.online ? '🟢' : '⚫'} <#${b.channelId}> · ${kindLabel(b.kind)} · ${emoji[state] || '💤'} ${state}${s.queued ? ` · ${s.queued} queued` : ''}${s.waiting ? ` · ${s.waiting} question(s)` : ''}${link}\n${clip(task?.title || b.health || 'Idle', 65)}${task?.activity ? ` · ${clip(task.activity, 110)}` : ''}`)
    }
    const rows = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('cco:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('cco:prev').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(record.page === 0), new ButtonBuilder().setCustomId('cco:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(record.page >= pages - 1))]
    if (selected.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('cco:session').setPlaceholder('Inspect a session').addOptions(selected.map(b => ({ label: clip(b.channelName || b.channelId, 100), description: clip(`${b.kind} · ${this.snapshot(b).online ? 'online' : 'offline'} · ${b.model || 'unknown model'}`, 100), value: b.channelId })))))
    return { content: lines.join('\n').slice(0, 1900), components: rows, allowedMentions: { parse: [] } }
  }
  async ensure(requestChannelId) {
    if (!this.s.state.get('overview', 'shared')) {
      const channelId = this.channelId || this.bindings().find(b => b.channelName === 'codex-infra')?.channelId || requestChannelId
      if (!channelId) return
      this.s.state.put('overview', 'shared', { channelId, page: 0 })
    }
    await this.flush()
    return this.s.state.get('overview', 'shared')
  }
  async flush() {
    return this.s.serial('overview-ui', async () => {
      const record = this.s.state.get('overview', 'shared')
      if (!record) return
      const opts = this.render(record), fingerprint = JSON.stringify(opts)
      if (!record.messageId) {
        const result = await this.s.sendOnce('overview:shared', record.channelId, opts)
        record.messageId = result.messageId
      } else if (record.fingerprint !== fingerprint) await (await (await this.s.channel(record.channelId)).messages.fetch(record.messageId)).edit(opts)
      record.fingerprint = fingerprint; this.s.state.put('overview', 'shared', record)
    })
  }
  async interaction(interaction) {
    if (!this.s.allowed(interaction.user.id)) return interaction.reply({ content: 'This binding is restricted to its configured users.', flags: 64 })
    const record = this.s.state.get('overview', 'shared')
    if (!record || interaction.channelId !== record.channelId || interaction.message?.id !== record.messageId) return interaction.reply({ content: 'This overview has moved or closed.', flags: 64 })
    await interaction.deferReply({ flags: 64 })
    const action = interaction.customId.split(':')[1]
    if (action === 'session') {
      const binding = this.s.binding(interaction.values[0])
      if (!binding) return interaction.editReply('This session is no longer bound.')
      return interaction.editReply((await this.s.control(binding.channelId, 'status')).text)
    }
    if (!['refresh', 'prev', 'next'].includes(action)) return interaction.editReply('Unknown overview action.')
    await this.s.serial('overview-ui', async () => { const current = this.s.state.get('overview', 'shared'); current.page += action === 'next' ? 1 : action === 'prev' ? -1 : 0; this.s.state.put('overview', 'shared', current) })
    await this.flush()
    return interaction.editReply('Overview updated.')
  }
}
