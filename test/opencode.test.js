import test from 'node:test'
import assert from 'node:assert/strict'
import { OpencodeClient } from '../src/opencode-client.js'
import { OpencodeController, envelope, promptFor, finalText } from '../src/opencode-controller.js'
import { DiscordService } from '../src/discord-service.js'
import { renderBinding } from '../src/presentation.js'
import { fixture, fakeSocket, fakeDiscord } from './helpers.js'

// A fake opencode server session: prompts become user messages, and tests
// script the assistant messages and the session status.
function fakeServer() {
  const s = { messages: [], status: { type: 'idle' }, prompts: [], aborts: 0, n: 0 }
  s.client = {
    status: async () => s.status,
    messages: async () => s.messages,
    prompt: async (id, text) => {
      if (s.failPrompt) throw s.failPrompt
      s.prompts.push(text); s.messages.push({ info: { id: `msg_u${++s.n}`, role: 'user' }, parts: [{ type: 'text', text }] }); s.status = { type: 'busy' }
    },
    abort: async () => { s.aborts++ }
  }
  s.assistant = (parts, info = {}) => {
    const parent = s.messages.filter(m => m.info.role === 'user').at(-1).info.id
    s.messages.push({ info: { id: `msg_a${++s.n}`, role: 'assistant', parentID: parent, time: { created: 1, completed: 2 }, finish: 'stop', ...info }, parts })
  }
  return s
}
function setup(t) {
  const { state } = fixture(t), server = fakeServer()
  let clock = 1_000_000
  const c = new OpencodeController({ state, client: server.client, channelId: 'main', channelName: 'opencode-test', sessionId: 'ses_pinned', now: () => clock })
  return { c, state, server, advance: ms => { clock += ms } }
}
const input = (id = '1') => ({ channelId: 'main', messageId: id, taskId: id, authorName: 'user', content: 'Hello' })
async function settle(c, advance) { await c.poll(); advance(2000); await c.poll() }

test('opencode becomes a router delivery owner and renders as opencode', async t => {
  const { state } = fixture(t), d = fakeDiscord()
  const s = new DiscordService({ state, client: d.client, taskThreads: false, log: () => {} })
  const sock = fakeSocket(); s.register(sock, { role: 'opencode_bridge', channelId: 'main', channelName: 'opencode-test' })
  assert.equal(s.peer('main'), [...s.peers.get('main')][0]); assert.equal(s.binding('main').kind, 'opencode')
  await s.receive(d.makeMessage({ id: '1' }))
  assert.equal(sock.messages.at(-1).content, 'Please fix the build')
  assert.match(s.overview.render({ page: 0 }).content, /opencode/)
  assert.match(renderBinding(s.binding('main'), true, 0), /opencode binding/)
  const other = fakeSocket(); s.register(other, { role: 'codex_bridge', channelId: 'main' })
  assert.equal(other.destroyed, true)
})
test('a Discord request is prompted once and only the final text after tools is posted', async t => {
  const { c, state, server, advance } = setup(t)
  assert.equal(c.receive(input()), true); assert.equal(c.receive(input()), false)
  await c.dispatch(); await c.dispatch()
  assert.equal(server.prompts.length, 1)
  assert.ok(server.prompts[0].startsWith(envelope('main', '1')))
  assert.match(server.prompts[0], /posted to this Discord channel automatically/)
  server.assistant([{ type: 'text', text: 'Let me look.' }, { id: 'prt_t1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'echo SECRET_TOKEN=abc' } } }], { finish: 'tool-calls' })
  server.assistant([{ type: 'text', text: 'Done: the build passes.' }])
  await c.poll() // still busy
  assert.equal(state.get('inbox', '1').status, 'working')
  server.status = { type: 'idle' }
  await settle(c, advance)
  const out = state.all('outbox')
  assert.deepEqual(out.filter(r => r.type === 'reply').map(r => r.text), ['Done: the build passes.'])
  assert.equal(out.find(r => r.type === 'reply').replyToMessageId, '1')
  assert.ok(out.some(r => r.type === 'event' && r.activity === 'Running a command'))
  assert.doesNotMatch(JSON.stringify(out), /SECRET_TOKEN|Let me look/)
  assert.equal(state.get('inbox', '1').status, 'complete')
  await settle(c, advance)
  assert.equal(state.all('outbox').filter(r => r.type === 'reply').length, 1)
})
test('a final answer already sent with discord_reply is not posted twice', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input()); await c.dispatch()
  server.assistant([{ id: 'prt_r', type: 'tool', tool: 'custom_discord_discord_reply', state: { status: 'completed', input: { text: 'Here you go' } } }], { finish: 'tool-calls' })
  server.assistant([{ type: 'text', text: 'Delivered' }]); server.status = { type: 'idle' }
  await settle(c, advance)
  assert.equal(state.all('outbox').filter(r => r.type === 'reply').length, 0)
  assert.equal(state.get('inbox', '1').status, 'complete')
})
test('new requests wait while the attached TUI is running a turn', async t => {
  const { c, server } = setup(t)
  server.status = { type: 'busy' }; c.receive(input()); await c.dispatch()
  assert.equal(server.prompts.length, 0); assert.equal(c.externalBusy, true)
  server.status = { type: 'idle' }; await c.dispatch(); assert.equal(server.prompts.length, 1)
})
test('requests are serialized: the second waits for the first to finish', async t => {
  const { c, server, advance } = setup(t)
  c.receive(input('1')); c.receive(input('2'))
  await c.dispatch(); server.status = { type: 'idle' }; await c.dispatch()
  assert.equal(server.prompts.length, 1)
  server.assistant([{ type: 'text', text: 'one' }]); await settle(c, advance)
  await c.dispatch(); assert.equal(server.prompts.length, 2); assert.ok(server.prompts[1].startsWith(envelope('main', '2')))
})
test('an uncertain dispatch is reconciled from history and never resent', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input()); server.failPrompt = Object.assign(new Error('socket hang up'), { undelivered: false })
  await c.dispatch(); server.failPrompt = null
  assert.equal(state.get('inbox', '1').status, 'dispatching')
  // The server did persist it: history reconciliation adopts the turn.
  server.messages.push({ info: { id: 'msg_x', role: 'user' }, parts: [{ type: 'text', text: promptFor(input(), 'opencode-test') }] })
  server.status = { type: 'busy' }; await c.poll(); await c.dispatch()
  assert.equal(state.get('inbox', '1').status, 'working'); assert.equal(server.prompts.length, 0)
  server.assistant([{ type: 'text', text: 'Recovered.' }]); server.status = { type: 'idle' }; await settle(c, advance)
  assert.equal(state.all('outbox').find(r => r.type === 'reply').text, 'Recovered.')
})
test('an unconfirmed request missing from history fails explicitly without retry', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input()); server.failPrompt = new Error('timeout'); await c.dispatch(); server.failPrompt = null
  await settle(c, advance); advance(31000); await c.poll(); await c.dispatch()
  assert.equal(state.get('inbox', '1').status, 'failed'); assert.equal(state.get('inbox', '1').uncertain, true)
  assert.equal(server.prompts.length, 0)
  assert.match(state.all('outbox').find(r => r.type === 'reply').text, /have not resent/)
})
test('a refused connection is certainly undelivered and is retried', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input()); server.failPrompt = Object.assign(new Error('refused'), { undelivered: true })
  await c.dispatch(); assert.equal(state.get('inbox', '1').status, 'queued')
  server.failPrompt = null; await c.dispatch(); assert.equal(server.prompts.length, 0)
  advance(6000); await c.dispatch(); assert.equal(server.prompts.length, 1)
})
test('provider errors and aborts are reported without partial prose', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input('1')); await c.dispatch()
  server.assistant([{ type: 'text', text: 'Partial' }], { error: { name: 'APIError', data: { message: 'rate limited' } } }); server.status = { type: 'idle' }
  await settle(c, advance)
  assert.equal(state.get('inbox', '1').status, 'failed')
  assert.match(state.all('outbox').find(r => r.type === 'reply').text, /rate limited/)
  c.receive(input('2')); await c.dispatch(); assert.match((await c.control('stop')).text, /Stop requested/); assert.equal(server.aborts, 1)
  server.assistant([{ type: 'text', text: 'Half' }], { error: { name: 'MessageAbortedError' } }); server.status = { type: 'idle' }
  await settle(c, advance)
  assert.equal(state.get('inbox', '2').status, 'interrupted')
  assert.doesNotMatch(JSON.stringify(state.all('outbox')), /Partial|Half/)
})
test('injected cc- nudges never post stop or failure notices', async t => {
  const { c, state, server, advance } = setup(t)
  c.receive(input('cc-test-fix-1')); await c.dispatch()
  server.assistant([{ type: 'text', text: 'Half' }], { error: { name: 'MessageAbortedError' } }); server.status = { type: 'idle' }
  await settle(c, advance)
  assert.equal(state.get('inbox', 'cc-test-fix-1').status, 'interrupted')
  c.receive(input('cc-test-continue-2')); await c.dispatch()
  server.assistant([{ type: 'text', text: 'x' }], { error: { name: 'APIError', data: { message: 'Not Found' } } }); server.status = { type: 'idle' }
  await settle(c, advance)
  assert.equal(state.get('inbox', 'cc-test-continue-2').status, 'failed')
  assert.equal(state.all('outbox').filter(r => r.type === 'reply').length, 0)
})
test('finalText keeps only text after the last tool call', () => {
  assert.equal(finalText({ parts: [{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c', synthetic: true }] }), 'b')
})
test('the HTTP client targets the pinned directory, authenticates, and flags refused connections', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url: String(url), opts }); return { status: url.pathname.endsWith('prompt_async') ? 204 : 200, ok: true, text: async () => JSON.stringify({ ses_1: { type: 'busy' } }) } }
  const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:1/', directory: '/workspace/project', password: 'pw', fetchImpl })
  assert.deepEqual(await client.status('ses_1'), { type: 'busy' }); assert.deepEqual(await client.status('ses_2'), { type: 'idle' })
  assert.equal(await client.prompt('ses_1', 'hi'), null)
  assert.equal(calls[2].url, 'http://127.0.0.1:1/session/ses_1/prompt_async?directory=%2Fworkspace%2Fproject')
  assert.deepEqual(JSON.parse(calls[2].opts.body), { parts: [{ type: 'text', text: 'hi' }] })
  assert.equal(calls[2].opts.headers.authorization, `Basic ${Buffer.from('opencode:pw').toString('base64')}`)
  await client.prompt('ses_1', 'hi', 'runpod/huihui-ai/Model-27B')
  assert.deepEqual(JSON.parse(calls[3].opts.body).model, { providerID: 'runpod', modelID: 'huihui-ai/Model-27B' })
  const refused = new OpencodeClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) } })
  await assert.rejects(refused.health(), e => e.undelivered === true)
})
