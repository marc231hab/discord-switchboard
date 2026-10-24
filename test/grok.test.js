import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { GrokClient } from '../src/grok-client.js'
import { GrokController, envelope, acknowledgeInbox } from '../src/grok-controller.js'
import { DiscordService } from '../src/discord-service.js'
import { renderBinding } from '../src/presentation.js'
import { validateQuestions } from '../src/questions.js'
import { fixture, fakeSocket, fakeDiscord } from './helpers.js'

function setup(t, client = {}) {
  const { state } = fixture(t)
  const c = new GrokController({ state, client, channelId: 'main', channelName: 'grok', sessionId: 'session' })
  c.loaded()
  return { c, state, client }
}
const input = (id = '1') => ({ channelId: 'main', messageId: id, taskId: id, authorName: 'user', content: 'Hello' })
function update(c, type, extra = {}) { c.update({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: type, ...extra } } }) }
function consume(c, id = '1') { update(c, 'user_message_chunk', { content: { text: `${envelope('main', id)}\nHello` } }) }

test('Grok becomes an actual router delivery owner and appears in the overview', async t => {
  const { state } = fixture(t), d = fakeDiscord()
  const s = new DiscordService({ state, client: d.client, taskThreads: false, log: () => {} })
  const sock = fakeSocket(); s.register(sock, { role: 'grok_bridge', channelId: 'main', channelName: 'grok' })
  assert.equal(s.peer('main'), [...s.peers.get('main')][0]); assert.equal(s.binding('main').kind, 'grok')
  await s.receive(d.makeMessage({ id: '1' })); await s.receive(d.makeMessage({ id: '1' }))
  assert.equal(state.all('message').length, 1); assert.equal(sock.messages.at(-1).content, 'Please fix the build')
  assert.equal(s.overview.bindings()[0].kind, 'grok')
  assert.match(s.overview.render({ page: 0 }).content, /Grok/)
  assert.match(renderBinding(s.binding('main'), true, 1), /Grok binding/)
})
test('Grok cannot compete with another delivery owner or receive another binding', async t => {
  const { state } = fixture(t), d = fakeDiscord(), s = new DiscordService({ state, client: d.client, log: () => {} })
  const one = fakeSocket(), two = fakeSocket()
  s.register(one, { role: 'grok_bridge', channelId: 'main' }); s.register(two, { role: 'codex_bridge', channelId: 'main' })
  assert.equal(one.destroyed, false); assert.equal(two.destroyed, true)
  const { c } = setup(t)
  assert.throws(() => c.receive({ ...input(), channelId: 'other' }), /Wrong Grok channel/)
})
test('native final is posted once; thinking, tools and interim text are excluded', t => {
  const { c, state } = setup(t); c.receive(input()); consume(c)
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'First I will inspect it.' } })
  update(c, 'agent_thought_chunk', { content: { type: 'text', text: 'PRIVATE' } })
  update(c, 'tool_call', { toolCallId: 'tool', title: 'SECRET COMMAND', rawInput: { token: 'PRIVATE' } })
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Finished.' } })
  update(c, 'turn_completed', { stop_reason: 'end_turn' }); update(c, 'turn_completed', { stop_reason: 'end_turn' })
  const out = state.all('outbox')
  assert.equal(out.filter(r => r.type === 'reply').length, 1)
  assert.equal(out.find(r => r.type === 'reply').text, 'Finished.')
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|SECRET COMMAND|First I/)
})
test('durable input and native completion reconcile a lost acknowledgment without retry', async t => {
  let calls = 0
  const { c, state } = setup(t, { prompt: async () => { calls++; throw Error('lost reply') } })
  c.receive(input()); await c.dispatch(); assert.equal(calls, 1)
  const recovered = new GrokController({ state, client: { prompt: async () => { calls++ } }, channelId: 'main', sessionId: 'session' })
  consume(recovered); update(recovered, 'agent_message_chunk', { content: { type: 'text', text: 'Confirmed.' } })
  update(recovered, 'turn_completed', { stop_reason: 'end_turn' }); recovered.loaded(); await recovered.dispatch()
  assert.equal(calls, 1); assert.equal(state.get('inbox', '1').status, 'complete')
  assert.equal(state.all('outbox').filter(r => r.type === 'reply').length, 1)
})
test('an uncertain unobserved dispatch is explicit and never automatically retried', async t => {
  let calls = 0
  const { c, state } = setup(t, { prompt: async () => { calls++; throw Error('lost connection') } })
  c.receive(input()); await c.dispatch()
  c.loaded(); await c.dispatch()
  assert.equal(calls, 1); assert.equal(state.get('inbox', '1').uncertain, true)
  assert.match(state.all('outbox').find(r => r.type === 'reply').text, /have not resent/)
})
test('new messages wait while the shared TUI or a Discord turn is working', async t => {
  let calls = 0
  const { c } = setup(t, { prompt: async () => { calls++; return { stopReason: 'cancelled' } } })
  c.receive(input()); update(c, 'user_message_chunk', { content: { text: 'A request from the terminal' } })
  await c.dispatch(); assert.equal(calls, 0)
  update(c, 'turn_completed', { stop_reason: 'end_turn' }); await c.dispatch(); assert.equal(calls, 1)
})
test('native cancellation does not publish incomplete prose', t => {
  const { c, state } = setup(t); c.receive(input()); consume(c)
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Incomplete' } }); update(c, 'turn_completed', { stop_reason: 'cancelled' })
  assert.equal(state.get('inbox', '1').status, 'interrupted')
  assert.doesNotMatch(JSON.stringify(state.all('outbox')), /Incomplete/)
})
test('permissions require the exact current Discord answer and grant only once', async t => {
  const responses = [], { c, state } = setup(t, { respond: (...r) => responses.push(r), reject: () => {} })
  c.receive(input()); consume(c)
  const router = { request: async () => ({ questionId: 'question' }) }
  await c.permissionRequest({ id: 7, method: 'session/request_permission', params: { sessionId: 'session', toolCall: { title: 'Read file' }, options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' }, { kind: 'reject_once', optionId: 'no' }] } }, router)
  assert.equal(await c.permissionAnswer({ ...input('2'), taskId: 'other', content: '[Discord question answered: question]\nStructured answers: {"grok_permission":["Allow once"]}' }), false)
  assert.equal(await c.permissionAnswer({ ...input('2'), taskId: '1', content: '[Discord question answered: question]\nStructured answers: {"grok_permission":["Allow once"]}' }), true)
  assert.deepEqual(responses, [[7, { outcome: { outcome: 'selected', optionId: 'once' } }]])
  assert.equal(state.get('inbox', '2').status, 'complete')
})
test('question dismissal grants no approval', async t => {
  const responses = [], { c } = setup(t, { respond: (...r) => responses.push(r) })
  c.permission = { id: 2, questionId: 'q', taskId: '1', messageId: '1', allow: { optionId: 'yes' } }
  await c.permissionAnswer({ ...input('2'), taskId: '1', content: '[Discord question dismissed: q]' })
  assert.deepEqual(responses[0][1], { outcome: { outcome: 'cancelled' } })
})
test('native ACP uses the pinned session and routes out-of-order request results', async () => {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {}
  let buf = ''; const methods = []
  proc.stdin.on('data', data => {
    buf += data; let at
    while ((at = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1); methods.push(msg)
      const result = msg.method === 'initialize' ? { agentCapabilities: { loadSession: true } } : { _meta: { sessionId: 'pinned' } }
      proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
    }
  })
  const c = new GrokClient({ args: [], sessionId: 'pinned', cwd: '/project', spawnProcess: () => proc })
  await c.connect()
  assert.deepEqual(methods.map(r => r.method), ['initialize', 'session/load'])
  assert.equal(methods[1].params.sessionId, 'pinned'); assert.deepEqual(methods[1].params.mcpServers, [])
  assert.equal(methods.some(r => r.method === 'session/new'), false)
  c.close()
})

test('a delayed native prompt result cannot overlap the next dispatch', async t => {
  let resolve, calls = 0
  const { c, state } = setup(t, { prompt: () => { calls++; return new Promise(r => { resolve = r }) } })
  c.receive(input()); const running = c.dispatch(); consume(c)
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Done' } }); update(c, 'turn_completed', { stop_reason: 'end_turn' })
  c.receive(input('2')); await c.dispatch(); assert.equal(calls, 1)
  resolve({ stopReason: 'end_turn' }); await running
  assert.equal(state.get('inbox', '1').status, 'complete'); assert.equal(state.get('inbox', '2').status, 'queued')
})
test('foreign native updates cannot create a reply or confirm an input', t => {
  const { c, state } = setup(t); c.receive(input())
  c.update({ params: { sessionId: 'foreign', update: { sessionUpdate: 'user_message_chunk', content: { text: `${envelope('main', '1')}\nHello` } } } })
  consume(c, 'missing'); update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Foreign reply' } }); update(c, 'turn_completed', { stop_reason: 'end_turn' })
  assert.equal(state.get('inbox', '1').status, 'queued'); assert.equal(state.all('outbox').length, 0)
})

test('an old permission answer after reconnect is not a new prompt or approval', async t => {
  let calls = 0, approved = 0
  const { c, state } = setup(t, { prompt: async () => { calls++ }, respond: () => { approved++ } })
  state.put('permission', 'old', { taskId: '1', connectionId: 'old-connection' })
  const answer = { ...input('2'), taskId: '1', content: '[Discord question answered: old]\nStructured answers: {"grok_permission":["Allow once"]}' }
  c.receive(answer); await c.permissionAnswer(state.get('inbox', '2')); await c.dispatch()
  assert.equal(calls, 0); assert.equal(approved, 0); assert.equal(state.get('inbox', '2').status, 'complete')
})

test('the caller live ACP stream can complete without an echoed user message', async t => {
  let resolve
  const { c, state } = setup(t, { prompt: () => new Promise(r => { resolve = r }) })
  c.receive(input()); const running = c.dispatch()
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Native reply' } })
  update(c, 'turn_completed', { stop_reason: 'end_turn' }); resolve({ stopReason: 'end_turn' }); await running
  assert.equal(state.get('inbox', '1').status, 'complete')
  assert.equal(state.all('outbox').find(r => r.type === 'reply').text, 'Native reply')
})

test('the actual live leader queue envelope binds the owned prompt before streaming', t => {
  const { c, state } = setup(t); c.receive(input())
  c.update({ method: '_x.ai/queue/changed', params: { sessionId: 'session', runningPromptId: 'native', runningText: `${envelope('main', '1')}\nHello` } })
  assert.equal(state.get('inbox', '1').nativePromptId, 'native')
  c.update({ params: { sessionId: 'session', _meta: { promptId: 'foreign' }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Other response' } } } })
  update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Bound response' } }); update(c, 'turn_completed', { stop_reason: 'end_turn' })
  assert.equal(state.all('outbox').find(r => r.type === 'reply').text, 'Bound response')
})

test('a delayed durable router receipt cannot overwrite new native output', async t => {
  const { c, state } = setup(t); c.receive(input())
  const router = { request: async () => { consume(c); update(c, 'agent_message_chunk', { content: { type: 'text', text: 'Actual output' } }); update(c, 'turn_completed', { stop_reason: 'end_turn' }) } }
  await acknowledgeInbox(state, router, 'main')
  assert.equal(state.get('inbox', '1').routerAcknowledged, true)
  assert.equal(state.get('inbox', '1').status, 'complete'); assert.equal(state.get('inbox', '1').text, 'Actual output')
})

test('an actual-length native command permission fits the real Discord form', async t => {
  const { c } = setup(t, { respond: () => {}, reject: () => {} }); c.receive(input()); consume(c)
  const messages = []
  const command = 'find "$HOME/projects/example workspace" -iname "*sample*" -o -iname "*prompt*demo*" | head -100; echo "repositories"; find "$HOME/projects/example workspace" -name ".git" -type d | head -30'
  const title = `Execute ${command}`
  const router = { request: async msg => { messages.push(msg); if (msg.type === 'question') validateQuestions(msg.questions); return { questionId: 'question' } } }
  await c.permissionRequest({ id: 3, method: 'session/request_permission', params: { sessionId: 'session', toolCall: { title, rawInput: { command } }, options: [{ kind: 'allow_once', optionId: 'once' }] } }, router)
  assert.equal(messages[0].type, 'reply'); assert.match(messages[0].text, /\.git/)
  assert.equal(messages[1].type, 'question'); assert.ok(messages[1].questions[0].question.length <= 350)
  assert.equal(c.permission.questionId, 'question')
})
