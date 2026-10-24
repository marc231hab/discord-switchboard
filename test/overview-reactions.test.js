import test from 'node:test'
import assert from 'node:assert/strict'
import { DiscordService } from '../src/discord-service.js'
import { fixture, fakeDiscord, fakeSocket } from './helpers.js'

function setup(t) { const { state } = fixture(t), discord = fakeDiscord(); return { state, s: new DiscordService({ state, client: discord.client, allowedUsers: ['user'], log: () => {} }), ...discord } }

test('a tool called while Discord connects receives a retry error and resumes without duplicating the overview', async t => {
  const { s, state, client, sent } = setup(t); state.put('binding', 'main', { channelId: 'main', kind: 'codex' })
  client.isReady = () => false
  await assert.rejects(s.overview.ensure('main'), /Discord is connecting/)
  assert.equal(sent.length, 0)
  client.isReady = () => true
  await s.overview.ensure('main'); await s.overview.ensure('main')
  assert.equal(sent.length, 1)
})

test('reaction cleanup normalizes emoji variants, preserves human/custom reactions, and serializes updates', async t => {
  const { s, makeMessage } = setup(t), message = makeMessage({ id: '1' })
  await message.react('🛠'); await message.react('⏸'); await message.react('👍')
  message.reactions.cache.set('👀', { me: false, emoji: { name: '👀' }, users: { remove: () => assert.fail('removed human reaction') } })
  await Promise.all([s.reaction('main', '1', 'working'), s.reaction('main', '1', 'complete')])
  assert.equal(message.reactions.cache.has('🛠'), false); assert.equal(message.reactions.cache.has('⏸'), false)
  assert.ok(message.reactions.cache.has('✅')); assert.ok(message.reactions.cache.has('👍')); assert.ok(message.reactions.cache.has('👀'))
})

test('failed reaction cleanup is durable and retries with a forced fresh message fetch', async t => {
  const { s, state, client, makeMessage } = setup(t), message = makeMessage({ id: '1' }); await message.react('🛠️')
  const channel = await client.channels.fetch('main'), fetch = channel.messages.fetch; let first = true, forced = false
  channel.messages.fetch = async opts => { forced = opts.force === true && opts.cache === false; if (first) { first = false; throw Error('network') }; return fetch(opts) }
  await s.reaction('main', '1', 'complete')
  const pending = state.get('reaction', 'main:1'); assert.equal(pending.pending, true); pending.retryAt = 0; state.put('reaction', 'main:1', pending)
  const restarted = new DiscordService({ state, client, log: () => {} }); await restarted.reactions.flush()
  assert.ok(forced); assert.deepEqual([...message.reactions.cache.keys()], ['✅']); assert.equal(state.get('reaction', 'main:1').pending, false)
})

test('startup backfills tracked stale terminal reactions and skips synthetic answer ids', async t => {
  const { s, state, makeMessage } = setup(t), message = makeMessage({ id: '1' }); await message.react('🛠️')
  state.put('task', '1', { id: '1', status: 'complete' })
  state.put('message', '1', { id: '1', taskId: '1', status: 'working', payload: { originChannelId: 'main' } })
  state.put('message', '2', { id: '2', taskId: '1', status: 'complete', synthetic: true, payload: { originChannelId: 'main' } })
  s.reactions.seed(); await s.reactions.flush()
  assert.deepEqual([...message.reactions.cache.keys()], ['✅']); assert.equal(state.all('reaction').length, 1)
})

test('one shared paginated overview covers both engines, offline queues, and pending questions', async t => {
  const { s, state, sent } = setup(t)
  for (let i = 0; i < 18; i++) {
    const channelId = String(i), kind = i < 7 ? 'codex' : 'claude'
    state.put('binding', channelId, { channelId, kind, channelName: i === 0 ? 'codex-infra' : `session-${String(i).padStart(2, '0')}`, lastSeen: Date.now(), model: 'model' })
    if (i === 0) s.register(fakeSocket(), { channelId, channelName: 'codex-infra', role: 'codex_bridge' })
  }
  state.put('task', 'task', { id: 'task', channelId: '0', status: 'waiting', title: 'Awaiting an answer' })
  state.put('question', 'q', { id: 'q', channelId: '0', taskId: 'task', status: 'pending' })
  state.put('message', 'queue', { id: 'queue', channelId: '0', status: 'received', bridgeReceived: false })
  const card = await s.overview.ensure('17')
  assert.equal(card.channelId, '0'); assert.match(sent.at(-1).content, /18 sessions/); assert.match(sent.at(-1).content, /1 online/); assert.match(sent.at(-1).content, /1 question/); assert.match(sent.at(-1).content, /1 queued/)
  const seen = new Set()
  for (let page = 0; page < 3; page++) {
    const record = state.get('overview', 'shared'); record.page = page; state.put('overview', 'shared', record); await s.overview.flush()
    assert.ok(sent.at(-1).content.length <= 1900)
    for (const option of sent.at(-1).options.components[1].components[0].toJSON().options) seen.add(option.value)
  }
  assert.equal(seen.size, 18); assert.match(sent.at(-1).content, /Claude/)
  const restarted = new DiscordService({ state, client: s.client, log: () => {} }); await restarted.overview.ensure('17')
  assert.equal(sent.length, 1); assert.equal(state.get('overview', 'shared').messageId, card.messageId)
})

test('overview buttons and session details enforce channel ownership and the allowlist', async t => {
  const { s, state } = setup(t); state.put('binding', 'main', { channelId: 'main', kind: 'claude' })
  const card = await s.overview.ensure('main')
  const interaction = { customId: 'cco:session', channelId: 'main', message: { id: card.messageId }, user: { id: 'user' }, values: ['main'], deferReply: async () => {}, editReply: async function(v) { this.response = v }, reply: async function(v) { this.response = v } }
  await s.interaction(interaction); assert.match(interaction.response, /Claude binding/)
  interaction.user.id = 'stranger'; await s.interaction(interaction); assert.match(interaction.response.content, /restricted/)
  interaction.user.id = 'user'; interaction.channelId = 'elsewhere'; await s.interaction(interaction); assert.match(interaction.response.content, /moved or closed/)
})
