import test from 'node:test'
import assert from 'node:assert/strict'
import { DiscordService } from '../src/discord-service.js'
import { validateQuestions, questionUI } from '../src/questions.js'
import { BridgeController } from '../src/bridge-controller.js'
import { ClaudeController } from '../src/claude-controller.js'
import { fixture, fakeDiscord, fakeSocket, event } from './helpers.js'

async function setup(t, kind = 'codex') {
  const { state } = fixture(t), discord = fakeDiscord()
  state.put('binding', 'main', { channelId: 'main', channelName: 'codex-infra', kind })
  const s = new DiscordService({ state, client: discord.client, allowedUsers: ['user'], log: () => {} })
  await s.receive(discord.makeMessage({ id: '1' }))
  await s.applyEvent({ eventId: 'work', taskId: '1', status: 'working', messageIds: ['1'] })
  const ask = (questions = [{ question: 'Which approach?', options: ['A', 'B'] }], operationId = 'ask') => s.questions.create({ channelId: 'main', taskId: '1', operationId, questions })
  return { state, s, ask, ...discord }
}
function click(q, action, suffix = '', extra = {}) {
  return { id: '900', customId: `ccq:${action}:${q.id}${suffix}`, channelId: q.targetChannelId, message: { id: q.messageId }, user: { id: 'user', username: 'user' }, isButton: () => true,
    reply: async function(value) { this.response = value }, deferReply: async function() { this.deferred = true }, editReply: async function(value) { this.response = value }, showModal: async function(value) { this.modal = value }, ...extra }
}

test('persisted question and answer survive restart and deliver to the same Codex or Claude task', async t => {
  for (const kind of ['codex', 'claude']) {
    const { s, state, ask, client } = await setup(t, kind)
    const result = await ask(), q = state.get('question', result.questionId)
    const restarted = new DiscordService({ state, client, allowedUsers: ['user'], log: () => {} })
    await restarted.interaction(click(q, 'choice', ':0:1'))
    assert.equal(state.get('question', q.id).status, 'answered')
    const answer = state.get('message', '900'); assert.equal(answer.taskId, '1'); assert.equal(answer.synthetic, true); assert.match(answer.payload.content, /Answer: B/)
    const socket = fakeSocket(); restarted.register(socket, { channelId: 'main', role: `${kind}_bridge` })
    const delivered = socket.messages.find(m => m.messageId === '900')
    assert.equal(delivered.taskId, '1'); assert.equal(delivered.mode, 'steer')
    await restarted.applyEvent({ eventId: 'resume', taskId: '1', status: 'working', messageIds: ['900'], startedAt: Date.now() })
    assert.equal(state.get('message', '1').status, 'working')
    const original = await (await s.channel('main')).messages.fetch('1')
    assert.ok(original.reactions.cache.has('🛠️')); assert.equal(original.reactions.cache.has('⏸️'), false)
    await restarted.applyEvent({ eventId: 'finish', taskId: '1', status: 'complete' })
    assert.equal(state.get('message', '900').status, 'complete')
    await s.questions.flush(q.id)
    const card = await (await s.channel(q.targetChannelId)).messages.fetch(q.messageId)
    assert.ok(card.options.components.every(row => row.components.every(component => component.data.disabled)))
  }
})

test('concurrent duplicate clicks submit one answer, and stale cards never deliver another', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  const a = click(q, 'choice', ':0:0'), b = click(q, 'choice', ':0:1', { id: '901' })
  await Promise.all([s.interaction(a), s.interaction(b)])
  assert.equal(state.all('message').filter(m => m.synthetic).length, 1)
  assert.match(b.response, /already closed/)
})

test('free-text modal and multi-select Other preserve the selected options', async t => {
  const { s, state, ask } = await setup(t)
  const { questionId } = await ask([{ id: 'scope', question: 'What should be included?', options: ['UI', 'Strategy', 'Architecture'], multiSelect: true }])
  const q = state.get('question', questionId), select = click(q, 'select', ':0', { values: ['0', '2', 'other'] })
  await s.interaction(select); assert.ok(select.modal); assert.equal(select.deferred, undefined)
  const modal = click(q, 'modal', ':0', { fields: { getTextInputValue: () => 'Operations, too' } })
  await s.interaction(modal)
  assert.deepEqual(state.get('question', q.id).answers.scope, ['UI', 'Architecture', 'Operations, too'])
})

test('multiple questions require all answers and persist partial drafts through restart', async t => {
  const { s, state, ask, client } = await setup(t)
  const { questionId } = await ask([{ id: 'one', question: 'First?', options: ['A', 'B'] }, { id: 'two', question: 'Second?' }])
  const q = state.get('question', questionId)
  await s.interaction(click(q, 'choice', ':0:1'))
  assert.equal(state.all('message').filter(m => m.synthetic).length, 0)
  const incomplete = click(q, 'submit'); await s.interaction(incomplete); assert.match(incomplete.response, /each question/)
  const restarted = new DiscordService({ state, client, allowedUsers: ['user'], log: () => {} })
  await restarted.interaction(click(q, 'modal', ':1', { fields: { getTextInputValue: () => 'Free text' } }))
  await restarted.interaction(click(q, 'submit'))
  assert.deepEqual(state.get('question', q.id).answers, { one: ['B'], two: ['Free text'] })
})

test('unauthorized and cross-channel interactions cannot save an answer', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  const stranger = click(q, 'choice', ':0:0', { user: { id: 'stranger' } }); await s.interaction(stranger)
  const other = click(q, 'choice', ':0:0', { channelId: 'other' }); await s.interaction(other)
  assert.equal(state.get('question', q.id).status, 'pending'); assert.equal(state.all('message').filter(m => m.synthetic).length, 0)
  await assert.rejects(s.questions.create({ channelId: 'other', taskId: '1', questions: [{ question: 'Wrong channel?' }] }), /different binding/)
  await assert.rejects(s.questions.cancel({ channelId: 'other', questionId }), /this binding/)
})

test('agent completion stays waiting while a question is pending; failures expire forms', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  await s.applyEvent({ eventId: 'complete', taskId: '1', status: 'complete', messageIds: ['1'] })
  assert.equal(state.get('task', '1').status, 'waiting'); assert.equal(state.get('message', '1').status, 'waiting')
  await s.applyEvent({ eventId: 'failed', taskId: '1', status: 'failed' })
  assert.equal(state.get('question', q.id).status, 'expired')
  const late = click(q, 'choice', ':0:0'); await s.interaction(late); assert.match(late.response, /closed/)
  assert.equal(state.all('message').filter(m => m.synthetic).length, 0)
})

test('dismissal notifies the agent without granting approval; agent cancellation closes an ended turn', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  await s.interaction(click(q, 'cancel'))
  assert.equal(state.get('question', q.id).status, 'dismissed'); assert.match(state.get('message', '900').payload.content, /No answer or approval/)
  await s.applyEvent({ eventId: 'consume-dismissal', taskId: '1', status: 'working', messageIds: ['900'] })
  const second = await ask([{ question: 'Another question?' }], 'another')
  await s.applyEvent({ eventId: 'complete', taskId: '1', status: 'complete' })
  await s.questions.cancel({ questionId: second.questionId, channelId: 'main' })
  assert.equal(state.get('task', '1').status, 'complete')
})

test('question sends retry without duplicating the form, and malformed questions are rejected', async t => {
  const { s, state, ask, client, sent } = await setup(t)
  const channel = await client.channels.fetch('thread-1'), send = channel.send; let once = true
  channel.send = async opts => { if (once) { once = false; throw Error('network') }; return send(opts) }
  await assert.rejects(ask(), /network/)
  const result = await ask(); await ask(); const retry = await ask(undefined, 'new-operation-after-uncertain-response')
  assert.equal(retry.questionId, result.questionId)
  assert.equal(state.all('question').length, 1); assert.equal(sent.filter(m => m.content?.includes('Your input is needed')).length, 1)
  assert.ok(result.messageId)
  for (const input of [[], [{ question: '' }], [{ question: 'x', options: ['same', 'same'] }], Array(4).fill({ question: 'x' }), [{ question: 'x', multiSelect: 'yes' }]]) assert.throws(() => validateQuestions(input))
  const ui = questionUI({ id: 'id', status: 'pending', questions: validateQuestions([{ question: 'x', options: Array.from({ length: 24 }, (_, i) => `Option ${i}`), multiSelect: true }]) })
  assert.equal(ui.components[0].components[0].toJSON().options.length, 25)
})

test('an answer racing with a pending form edit gets another UI update without requiring a restart', async t => {
  const { s, state, ask, client } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  const card = await (await client.channels.fetch(q.targetChannelId)).messages.fetch(q.messageId), edit = card.edit
  let release, ready; const editing = new Promise(resolve => { ready = resolve })
  card.edit = async opts => { ready(); await new Promise(resolve => { release = resolve }); card.edit = edit; return edit(opts) }
  const flushing = s.flush(); await editing
  await s.interaction(click(q, 'choice', ':0:0'))
  release(); await flushing
  assert.ok(s.dirty.has(`question:${questionId}`))
  await s.flush()
  assert.equal(state.get('question', questionId).uiStatus, 'answered')
  assert.ok(card.options.components.every(row => row.components.every(component => component.data.disabled)))
})

test('an answer accepted just before an agent turn ends stays queued until consumption', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  await s.interaction(click(q, 'choice', ':0:0'))
  await s.applyEvent({ eventId: 'early-complete', taskId: '1', status: 'complete', messageIds: ['1'] })
  assert.equal(state.get('task', '1').status, 'waiting'); assert.equal(state.get('message', '900').status, 'received')
  const bridge = fakeSocket(); s.register(bridge, { channelId: 'main', role: 'codex_bridge' })
  assert.ok(bridge.messages.some(m => m.messageId === '900'))
  await s.applyEvent({ eventId: 'consume-answer', taskId: '1', status: 'working', messageIds: ['900'] })
  await s.applyEvent({ eventId: 'real-complete', taskId: '1', status: 'complete' })
  assert.equal(state.get('task', '1').status, 'complete')
})

test('opening a text modal does not wait behind slow task lifecycle REST calls', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  let release; const blocked = s.serial('event:1', () => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  const interaction = click(q, 'write', ':0'); await s.interaction(interaction)
  assert.ok(interaction.modal); release(); await blocked
})

test('accepting a plain-text reply and cancelling its obsolete form cannot complete the new active turn', async t => {
  const { s, state, ask, makeMessage } = await setup(t); const { questionId } = await ask()
  await s.applyEvent({ eventId: 'question-turn-ended', taskId: '1', status: 'complete' })
  await s.receive(makeMessage({ id: '2', channelId: 'thread-1', content: 'Use approach B' }))
  await s.applyEvent({ eventId: 'text-consumed', taskId: '1', status: 'working', messageIds: ['2'], startedAt: Date.now() })
  await s.questions.cancel({ channelId: 'main', questionId })
  assert.equal(state.get('question', questionId).status, 'cancelled')
  assert.equal(state.get('task', '1').status, 'working'); assert.equal(state.get('message', '2').status, 'working')
  assert.equal(state.get('message', '1').status, 'working')
  await s.applyEvent({ eventId: 'new-turn-ended', taskId: '1', status: 'complete' })
  assert.equal(state.get('task', '1').status, 'complete')
})

test('question answer commit rolls back if persisting the delivery fails', async t => {
  const { s, state, ask } = await setup(t); const { questionId } = await ask(), q = state.get('question', questionId)
  const insert = state.insert.bind(state); state.insert = () => { throw Error('disk failure') }
  await assert.rejects(s.interaction(click(q, 'choice', ':0:0')), /disk failure/)
  state.insert = insert
  assert.equal(state.get('question', q.id).status, 'pending'); assert.equal(state.get('message', '900'), null)
  await s.interaction(click(q, 'choice', ':0:0')); assert.equal(state.get('question', q.id).status, 'answered')
})

test('actual Codex and Claude controllers consume form answers after a finished turn under the original task', async t => {
  for (const kind of ['codex', 'claude']) {
    const { s, state, ask } = await setup(t, kind), { state: bridgeState, dir } = fixture(t)
    const Controller = kind === 'claude' ? ClaudeController : BridgeController
    const controller = new Controller({ state: bridgeState, channelId: 'main', channelName: 'test', projectDir: dir, home: dir, log: () => {} })
    controller.receive({ messageId: '1', taskId: '1', mode: 'new' })
    const consume = async (id, turn) => kind === 'claude'
      ? controller.transcript({ uuid: turn, timestamp: new Date().toISOString(), type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'channel' }, prompt: `<channel channelId="main" messageId="${id}">answer</channel>` } }, `consume:${id}`)
      : (await controller.record(event('task_started', { turn_id: turn }), `start:${turn}`), controller.record(event('item_completed', { turn_id: turn, item: { type: 'UserMessage', content: [{ type: 'text', text: `[discord #test from user msg=${id}]` }] } }), `consume:${id}`))
    await consume('1', 'initial')
    const { questionId } = await ask(), q = state.get('question', questionId)
    controller.finish(controller.active(), 'complete', 'initial-finished', 'Waiting for answer')
    await s.applyEvent(bridgeState.get('outbox', 'initial-finished'))
    await s.interaction(click(q, 'choice', ':0:0'))
    const bridge = fakeSocket(); s.register(bridge, { channelId: 'main', role: `${kind}_bridge` })
    controller.receive(bridge.messages.find(m => m.messageId === '900'))
    await consume('900', 'answer-turn')
    assert.equal(controller.active().taskId, '1'); assert.equal(bridgeState.get('inbox', '900').status, 'working')
    for (const row of bridgeState.all('outbox')) await s.applyEvent(row)
    assert.equal(state.get('task', '1').status, 'working')
    controller.finish(controller.active(), 'complete', 'answer-finished', 'Answer applied')
    await s.applyEvent(bridgeState.get('outbox', 'answer-finished'))
    assert.equal(state.get('task', '1').status, 'complete')
  }
})
