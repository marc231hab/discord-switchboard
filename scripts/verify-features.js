// Run with the global environment sourced. --form-check posts then closes a clearly labelled test card.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { REST, Routes } from 'discord.js'
import { State } from '../src/state.js'
import { emoji, terminalStates } from '../src/presentation.js'

const state = new State(join(process.env.DISCORD_STATE_DIR || join(process.env.HOME, '.local/state/discord-agent-router'), 'router.sqlite'))
const binding = state.all('binding').find(b => b.channelId === process.env.DISCORD_CHANNEL_ID)
assert.ok(binding, 'Set DISCORD_CHANNEL_ID to a registered binding')
const env = { ...process.env, DISCORD_CHANNEL_ID: binding.channelId, CHANNEL_NAME: binding.channelName, DISCORD_INBOUND: 'off' }
delete env.DISCORD_BOT_TOKEN
const client = new Client({ name: 'discord-feature-verification', version: '1.0' })
const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-warnings', 'src/channel.js'], env, stderr: 'pipe' })
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function call(name, args = {}) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await client.callTool({ name, arguments: args })
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || ''
    if (result.isError && /router is offline|Discord is connecting/.test(text)) { await pause(500); continue }
    assert.ok(!result.isError, text); return text
  }
  throw Error('MCP router did not connect')
}
try {
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map(t => t.name)
  for (const name of ['discord_question', 'discord_question_cancel', 'discord_overview']) assert.ok(tools.includes(name))
  await call('discord_overview')
  const overview = state.get('overview', 'shared')
  const card = await rest.get(Routes.channelMessage(overview.channelId, overview.messageId))
  assert.match(card.content, /Shared agent overview/)
  assert.deepEqual(card.components[0].components.map(c => c.label), ['Refresh', 'Previous', 'Next'])
  assert.equal(card.components[1].components[0].type, 3)
  const counts = state.all('binding').reduce((a, b) => { a[b.kind] = (a[b.kind] || 0) + 1; return a }, {})
  console.log(JSON.stringify({ tools, bindings: counts, overview: `https://discord.com/channels/${card.guild_id || (await rest.get(Routes.channel(overview.channelId))).guild_id}/${overview.channelId}/${overview.messageId}` }))
  if (process.argv.includes('--form-check')) {
    const task = state.get('task', binding.currentTask)
    assert.ok(task, 'Form check needs an active task')
    let questionId
    try {
      const result = await call('discord_question', { taskId: task.id, title: 'Automated interface check — no answer needed', questions: [
        { id: 'choice', question: 'Choice buttons (automated check; no answer needed).', options: ['First choice', 'Second choice'] },
        { id: 'multiple', question: 'Multiple selection control (automated check).', options: ['UI', 'Strategy', 'System design'], multiSelect: true },
        { id: 'text', question: 'Free-text form control (automated check).' },
      ] })
      questionId = /Discord question ([\w-]+)/.exec(result)?.[1]
      assert.ok(questionId, result)
      const q = state.get('question', questionId)
      const form = await rest.get(Routes.channelMessage(q.targetChannelId, q.messageId))
      assert.equal(form.components.length, 4)
      assert.deepEqual(form.components.slice(0, 3).map(r => r.components[0].type), [2, 3, 2])
      assert.ok(form.components[0].components.some(c => c.label === 'Other…'))
      console.log(JSON.stringify({ questionId, formMessageId: form.id, questionRows: 3, choiceButtons: true, multipleSelect: true, freeTextControl: true }))
    } finally { if (questionId) await call('discord_question_cancel', { questionId }) }
    let disabled = false
    for (let n = 0; n < 15; n++) {
      const q = state.get('question', questionId)
      const form = await rest.get(Routes.channelMessage(q.targetChannelId, q.messageId))
      disabled = form.components.every(row => row.components.every(c => c.disabled))
      if (disabled) break
      await pause(1000)
    }
    assert.ok(disabled, 'Cancelled form controls must become disabled')
    console.log(JSON.stringify({ cancelledFormDisabled: disabled }))
  }
  // Startup repairs run in bounded batches; inspect after they have settled.
  for (let n = 0; n < 30 && state.all('reaction').some(r => r.pending); n++) await pause(1000)
  const tracked = state.all('message').filter(m => !m.control && !m.synthetic && m.payload?.originChannelId)
  let inspected = 0, stale = 0, incorrect = 0
  const lifecycle = new Set(['👀', '📥', '🛠', '⏸', '✅', '❌', '🛑'])
  for (const m of tracked.slice(-20)) {
    const message = await rest.get(Routes.channelMessage(m.payload.originChannelId, m.id))
    const own = (message.reactions || []).filter(r => r.me && lifecycle.has(r.emoji.name?.replace(/[\uFE0E\uFE0F]/g, '')))
    inspected++; if (own.length > 1) stale++
    const current = state.get('message', m.id), task = state.get('task', m.taskId), status = terminalStates.has(task?.status) ? task.status : current.status
    const expected = emoji[status]?.replace(/[\uFE0E\uFE0F]/g, '')
    if (expected && (own.length !== 1 || own[0].emoji.name.replace(/[\uFE0E\uFE0F]/g, '') !== expected)) incorrect++
  }
  assert.equal(stale, 0, 'Tracked requests must not have multiple bot lifecycle reactions')
  assert.equal(incorrect, 0, 'Tracked requests must show their current lifecycle reaction')
  console.log(JSON.stringify({ trackedRequests: tracked.length, inspectedReactions: inspected, staleLifecyclePairs: stale, incorrectLifecycleReactions: incorrect, pendingReactionRetries: state.all('reaction').filter(r => r.pending).length }))
} finally { await client.close(); state.close() }
