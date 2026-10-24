import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js'
import { clip, redact, stableId, terminalStates } from './presentation.js'

export function validateQuestions(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw Error('Provide 1–3 questions')
  const ids = new Set()
  return input.map((q, index) => {
    const id = q.id || `q${index + 1}`
    if (typeof id !== 'string' || !/^[\w-]{1,30}$/.test(id) || ids.has(id)) throw Error('Question ids must be unique, with 1–30 letters, numbers, underscores or hyphens')
    ids.add(id)
    if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 350) throw Error('Question prompts must contain 1–350 characters')
    const options = q.options || []
    if (!Array.isArray(options) || options.length > 24 || options.some(o => typeof o !== 'string' || !o.trim() || o.length > 80) || new Set(options).size !== options.length) throw Error('Options must be unique labels of 1–80 characters; at most 24')
    if (q.multiSelect != null && typeof q.multiSelect !== 'boolean') throw Error('multiSelect must be a boolean')
    return { id, question: redact(q.question), options: options.map(redact), multiSelect: !!q.multiSelect }
  })
}
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled)
export function questionUI(q) {
  const closed = q.status !== 'pending'
  const lines = [`**${clip(q.title || 'Your input is needed', 100)}** · ${closed ? q.status : 'waiting for your answer'}`]
  const rows = q.questions.map((item, i) => {
    lines.push(`${i + 1}. ${item.question}`)
    const prefix = `ccq:choice:${q.id}:${i}`
    if (item.options.length > 4 || item.multiSelect) {
      return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ccq:select:${q.id}:${i}`).setPlaceholder(clip(item.question, 100)).setMinValues(1).setMaxValues(item.multiSelect ? item.options.length + 1 : 1).setDisabled(closed).addOptions([...item.options.map((label, n) => ({ label, value: String(n) })), { label: 'Other… (write an answer)', value: 'other' }]))
    }
    return new ActionRowBuilder().addComponents(...item.options.map((label, n) => button(`${prefix}:${n}`, label, ButtonStyle.Primary, closed)), button(`ccq:write:${q.id}:${i}`, item.options.length ? 'Other…' : 'Write answer', ButtonStyle.Secondary, closed))
  })
  if (!closed) lines.push(q.questions.length > 1 ? 'Choose or write each answer, then press Send answers. Choices are saved privately for you.' : 'Choose an answer or write your own. Your answer is delivered to this task.')
  if (q.status === 'answered') lines.push(`Answered by ${clip(q.answeredByName || 'a configured user', 60)}.`)
  rows.push(new ActionRowBuilder().addComponents(...(q.questions.length > 1 ? [button(`ccq:submit:${q.id}`, 'Send answers', ButtonStyle.Success, closed)] : []), button(`ccq:cancel:${q.id}`, 'Dismiss question', ButtonStyle.Secondary, closed)))
  return { content: lines.join('\n').slice(0, 1900), components: rows, allowedMentions: { parse: [] } }
}

export class Questions {
  constructor(service) { this.s = service; this.state = service.state }
  pending(taskId) { return this.state.all('question').filter(q => q.taskId === taskId && q.status === 'pending') }
  hasQueuedAnswers(taskId) { return this.state.all('message').some(m => m.taskId === taskId && m.synthetic && ['received', 'queued'].includes(m.status)) }
  async create(msg) {
    const source = this.state.get('message', msg.replyToMessageId || '')
    const task = this.state.get('task', msg.taskId || source?.taskId || this.s.binding(msg.channelId)?.currentTask || '')
    if (!task || terminalStates.has(task.status)) throw Error('Questions need an active task; provide taskId or replyToMessageId')
    if (task.channelId !== msg.channelId || source && source.channelId !== msg.channelId) throw Error('Question belongs to a different binding')
    const questions = validateQuestions(msg.questions)
    const requestedId = stableId(`question:${msg.channelId}:${msg.operationId || msg.id}`)
    const title = clip(msg.title || 'Your input is needed', 100)
    return this.s.serial(`event:${task.id}`, async () => {
      let q = this.state.get('question', requestedId) || this.pending(task.id).find(q => q.title === title && JSON.stringify(q.questions) === JSON.stringify(questions))
      const id = q?.id || requestedId
      if (!q) {
        if (terminalStates.has(this.state.get('task', task.id).status)) throw Error('Task already ended')
        q = { id, taskId: task.id, channelId: task.channelId, targetChannelId: this.s.replyChannel(task, task.channelId), guildId: task.guildId, title, questions, status: 'pending', createdAt: Date.now(), drafts: {} }
        this.state.put('question', id, q)
      }
      this.s.dirty.add(`question:${id}`)
      await this.s.applyEvent({ eventId: `question:${id}`, taskId: task.id, status: 'waiting', activity: 'Waiting for your answer in Discord', messageIds: this.state.all('message').filter(m => m.taskId === task.id && !m.synthetic && !m.control && !terminalStates.has(m.status)).map(m => m.id) })
      await this.flush(id)
      return { questionId: id, messageId: this.state.get('question', id).messageId }
    })
  }
  async flush(id) {
    return this.s.serial(`question-ui:${id}`, async () => {
      const q = this.state.get('question', id)
      if (!q) return
      const opts = questionUI(q)
      if (!q.messageId) {
        const sent = await this.s.sendOnce(`question:${id}`, q.targetChannelId, opts)
        // An answer can arrive while Discord is sending the card.
        const current = this.state.get('question', id)
        current.messageId = sent.messageId; this.state.put('question', id, current)
      }
      const current = this.state.get('question', id)
      await (await (await this.s.channel(current.targetChannelId)).messages.fetch(current.messageId)).edit(questionUI(current))
      const latest = this.state.get('question', id)
      latest.uiStatus = current.status; this.state.put('question', id, latest)
    })
  }
  expire(taskId, status = 'expired') {
    for (const q of this.pending(taskId)) { q.status = status; q.drafts = {}; this.state.put('question', q.id, q); this.s.dirty.add(`question:${q.id}`) }
  }
  async cancel(msg) {
    const q = this.state.get('question', msg.questionId)
    if (!q || q.channelId !== msg.channelId) throw Error('Unknown question for this binding')
    return this.s.serial(`event:${q.taskId}`, async () => {
      const current = this.state.get('question', q.id)
      if (current.status === 'pending') { current.status = 'cancelled'; current.drafts = {}; this.state.put('question', q.id, current); this.s.dirty.add(`question:${q.id}`) }
      const task = this.state.get('task', q.taskId)
      if (task?.questionTurnEnded && !this.pending(q.taskId).length && !terminalStates.has(task.status)) await this.s.applyEvent({ eventId: `cancel:${q.id}`, taskId: q.taskId, status: 'complete', summary: 'Question dismissed by the agent.' })
      else if (task && !this.pending(q.taskId).length && !terminalStates.has(task.status)) await this.s.applyEvent({ eventId: `cancel-resume:${q.id}`, taskId: q.taskId, status: 'working', activity: 'Continuing the task' })
      return { questionId: q.id }
    })
  }
  async interaction(interaction) {
    const [, action, id, indexText, optionText] = interaction.customId.split(':')
    const q = this.state.get('question', id)
    if (!this.s.allowed(interaction.user.id)) return interaction.reply({ content: 'This binding is restricted to its configured users.', flags: 64 })
    if (!q || interaction.channelId !== q.targetChannelId || interaction.message && interaction.message.id !== q.messageId) return interaction.reply({ content: 'This question does not belong to this channel.', flags: 64 })
    const index = Number(indexText), item = q.questions[index]
    const needsModal = action === 'write' || action === 'select' && interaction.values.includes('other')
    if (needsModal) {
      // Opening a modal must be the initial acknowledgement. Never queue it behind REST work.
      const current = this.state.get('question', id)
      if (current.status !== 'pending' || terminalStates.has(this.state.get('task', q.taskId)?.status)) return interaction.reply({ content: 'This question has already closed.', flags: 64 })
      if (!item) throw Error('Unknown question field')
      if (action === 'select') {
        if (!item.multiSelect && interaction.values.length !== 1) throw Error('Invalid answer selection')
        const labels = interaction.values.filter(v => v !== 'other').map(v => item.options[Number(v)])
        if (labels.some(v => v === undefined)) throw Error('Unknown answer option')
        current.drafts[interaction.user.id] ||= {}; current.drafts[interaction.user.id][`${index}:selected`] = labels; this.state.put('question', id, current)
      }
      const modal = new ModalBuilder().setCustomId(`ccq:modal:${id}:${index}`).setTitle('Write your answer').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('answer').setLabel(clip(item.question, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)))
      return interaction.showModal(modal)
    }
    await interaction.deferReply({ flags: 64 })
    return this.s.serial(`event:${q.taskId}`, async () => {
      const current = this.state.get('question', id)
      if (current.status !== 'pending' || terminalStates.has(this.state.get('task', q.taskId)?.status)) return interaction.editReply('This question has already closed; no answer was sent.')
      const draft = current.drafts[interaction.user.id] ||= {}
      if (action === 'choice') {
        const label = item?.options[Number(optionText)]
        if (!label) throw Error('Unknown answer option')
        draft[index] = [label]
        delete draft[`${index}:selected`]
      } else if (action === 'select') {
        if (!item || !interaction.values.length || !item.multiSelect && interaction.values.length !== 1) throw Error('Invalid answer selection')
        const labels = interaction.values.map(v => item.options[Number(v)])
        if (labels.some(v => v === undefined)) throw Error('Unknown answer option')
        draft[index] = labels
        delete draft[`${index}:selected`]
      } else if (action === 'modal') {
        if (!item) throw Error('Unknown question field')
        const answer = interaction.fields.getTextInputValue('answer').trim()
        if (!answer || answer.length > 4000) throw Error('Answer must contain 1–4000 characters')
        draft[index] = [...(draft[`${index}:selected`] || []), answer]; delete draft[`${index}:selected`]
      } else if (!['submit', 'cancel'].includes(action)) throw Error('Unknown question action')
      if (action !== 'cancel' && q.questions.length > 1 && action !== 'submit') {
        this.state.put('question', id, current)
        return interaction.editReply(`Answer ${index + 1} saved. Complete the other questions and press Send answers.`)
      }
      if (action !== 'cancel' && current.questions.some((_, i) => !draft[i]?.length)) return interaction.editReply('Answer each question before sending. Your saved choices are still available.')
      const answers = action === 'cancel' ? null : Object.fromEntries(current.questions.map((field, i) => [field.id, draft[i]]))
      const content = answers ? `[Discord question answered: ${id}]\n${current.questions.map(field => `${field.question}\nAnswer: ${answers[field.id].join('; ')}`).join('\n\n')}\n\nStructured answers: ${JSON.stringify(answers)}` : `[Discord question dismissed: ${id}]\nThe user dismissed this question. No answer or approval was given. Continue only with work already authorized.`
      const payload = { type: 'message', channelId: q.channelId, originChannelId: q.targetChannelId, messageId: interaction.id, guildId: q.guildId || '', authorId: interaction.user.id, authorName: interaction.user.username, content, attachmentCount: 0, attachments: [] }
      // The answer and its delivery record commit together, before acknowledging Discord.
      this.state.transaction(() => {
        current.status = answers ? 'answered' : 'dismissed'; current.answers = answers; current.answeredBy = interaction.user.id; current.answeredByName = interaction.user.username; current.answeredAt = Date.now(); current.drafts = {}
        this.state.put('question', id, current)
        this.state.insert('message', interaction.id, { id: interaction.id, channelId: q.channelId, taskId: q.taskId, synthetic: true, status: 'received', bridgeReceived: false, mode: 'steer', payload })
      })
      this.s.dirty.add(`question:${id}`); this.s.dirty.add(q.taskId)
      const task = this.state.get('task', q.taskId)
      task.activity = 'Answer saved; waiting for the agent to consume it'; this.state.put('task', task.id, task)
      this.s.replay(q.channelId)
      return interaction.editReply(answers ? 'Answer saved and queued for this task.' : 'Question dismissed. The agent has been notified; no approval was given.')
    })
  }
}
