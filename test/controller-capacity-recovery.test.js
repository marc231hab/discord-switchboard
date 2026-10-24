import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { BridgeController, capacityFailure, capacityBackoffMs, timestampMs } from '../src/bridge-controller.js'
import { State } from '../src/state.js'
import { fixture, event } from './helpers.js'

const capacity = { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }

async function setup(t, hooks = {}) {
  const { state: initial, dir } = fixture(t)
  let state = initial, clock = Date.parse('2026-10-20T07:17:29.857Z'), serial = 0, c
  const calls = [], queue = []
  const thread = { id: 'session', cwd: dir, model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', canAcceptDirectInput: true,
    status: { type: 'idle' }, turns: [{ id: 'failed', status: 'inProgress', items: [] }] }
  const codex = { request: async (method, args) => {
    calls.push({ method, args })
    await hooks.before?.(method, args, { queue, thread, c })
    if (method === 'thread/queue/list') return { data: structuredClone(queue), nextCursor: null }
    if (method === 'thread/read') return { thread: structuredClone(thread) }
    if (method === 'thread/queue/add') {
      if (hooks.rejectAdd) throw Error(hooks.rejectAdd)
      const q = { id: `q${++serial}`, clientUserMessageId: args.clientUserMessageId, input: args.input }
      queue.push(q)
      await hooks.afterAdd?.(q, { queue, thread, c })
      if (hooks.loseAdd) { hooks.loseAdd = false; throw Error('Codex control connection closed') }
      return { queuedSubmission: structuredClone(q) }
    }
    if (method === 'thread/queue/start') {
      const i = queue.findIndex(q => q.id === args.queuedSubmissionId)
      assert.notEqual(i, -1, 'Cannot consume the same queued submission twice')
      const q = queue.splice(i, 1)[0]
      const turn = { id: `recovery${serial}`, status: 'inProgress', items: [{ type: 'userMessage', content: q.input, clientUserMessageId: q.clientUserMessageId }] }
      thread.turns.push(turn); thread.status.type = 'active'
      await hooks.afterStart?.(turn, { queue, thread, c })
      if (hooks.loseStart) { hooks.loseStart = false; throw Error('Codex control connection closed') }
      return { turn: structuredClone(turn) }
    }
    if (method === 'thread/queue/delete') {
      const i = queue.findIndex(q => q.id === args.queuedSubmissionId)
      if (i >= 0) queue.splice(i, 1)
      return {}
    }
    if (method === 'turn/interrupt') return {}
    throw Error(`Unexpected RPC ${method}`)
  } }
  const make = () => new BridgeController({ state, codex, channelId: 'main', channelName: 'codex-test', projectDir: dir, home: dir, now: () => clock, log: () => {} })
  c = make(); c.session.threadId = 'session'; c.session.model = thread.model; c.session.effort = thread.reasoningEffort
  c.receive({ messageId: '1', taskId: 'task', mode: 'new', authorName: 'user', content: 'ORIGINAL_REQUEST_MUST_NOT_BE_REPLAYED' })
  await c.record(event('task_started', { turn_id: 'failed', started_at: clock }), 'start')
  await c.record(event('item_completed', { turn_id: 'failed', item: { type: 'UserMessage', content: '[discord #codex-test from user msg=1]\nORIGINAL_REQUEST_MUST_NOT_BE_REPLAYED' } }), 'human')
  const api = {
    get c() { return c }, get state() { return state }, dir, thread, queue, calls, hooks,
    advance(ms) { clock += ms }, get now() { return clock },
    recovery() { return state.all('capacity_recovery')[0] },
    async fail(error = capacity) {
      const current = c.active() || c.session.turns.failed
      const actual = thread.turns.find(x => x.id === current.id)
      actual.status = 'failed'; actual.error = error; thread.status.type = 'idle'
      await c.record({ timestamp: new Date(clock).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: current.id, error } }, `failure:${current.id}`)
    },
    restart() {
      state.close(); state = new State(join(dir, 'state.sqlite')); c = make()
      t.after(() => { try { state.close() } catch {} })
    },
    anotherController() { return make() }
  }
  return api
}

test('only explicit capacity errors qualify; a different structured class wins over matching prose', () => {
  assert.equal(capacityFailure(capacity), 'server_overloaded')
  assert.equal(capacityFailure({ codexErrorInfo: 'serverOverloaded', message: 'busy' }), 'server_overloaded')
  assert.equal(capacityFailure({ code: 'server_overloaded', message: 'busy' }), 'server_overloaded')
  assert.equal(capacityFailure(capacity.message), 'model_at_capacity_message')
  assert.equal(capacityFailure({ message: capacity.message }), 'model_at_capacity_message')
  for (const error of [null, {}, 'capacity', 'temporarily unavailable', 'Quota exceeded',
    { message: 'Selected model is at capacity.' },
    { message: capacity.message, codex_error_info: 'usage_limit_exceeded' },
    { message: capacity.message, codex_error_info: 'unauthorized' },
    { message: capacity.message, codex_error_info: 'context_window_exceeded' },
    { message: capacity.message, codex_error_info: 'safety_policy' }]) assert.equal(capacityFailure(error), null)
  for (const code of ['insufficient_quota','authentication_error','invalid_request']) {
    assert.equal(capacityFailure({code,message:capacity.message}),null)
    assert.equal(capacityFailure({...capacity,code}),null)
  }
})

test('actual Unix-second started_at and persisted seconds compare correctly against older inbox millisecond dates', async t => {
  const h = await setup(t)
  h.state.put('inbox', 'older', { messageId:'older',taskId:'old-task',status:'complete',receivedAt:1792445000000 })
  await h.c.record(event('task_started', { turn_id:'failed',started_at:1792445456 }), 'seconds-start')
  assert.equal(h.c.active().startedAt, 1792445456000)
  // Simulate the same raw numeric-seconds value left by the prior live bridge.
  h.c.active().startedAt = 1792445456; h.c.save(); h.restart()
  assert.equal(h.c.active().startedAt, 1792445456000)
  await h.fail()
  assert.equal(h.recovery().status, 'scheduled')
  assert.equal(timestampMs('2026-10-20T07:17:29.857Z'), h.now)
  assert.equal(timestampMs('1792445456'), 1792445456000)
})

test('the real structured failure persists a30s recovery without RPC and without forging an inbox message', async t => {
  const h = await setup(t); await h.fail()
  assert.equal(h.recovery().status, 'scheduled')
  assert.equal(h.recovery().dueAt-h.now, 30000)
  assert.equal(h.recovery().model, 'gpt-6.1-sol'); assert.equal(h.recovery().effort, 'xhigh')
  assert.equal(h.state.all('inbox').length, 1)
  assert.equal(h.c.session.turns.failed.status, 'failed')
  assert.equal(h.calls.length, 0)
  await h.c.deliverCapacityRecoveries(); assert.equal(h.calls.length, 0)
})

for (const error of ['Quota exceeded', { codex_error_info: 'unauthorized', message: 'Invalid token' },
  { codex_error_info: 'context_window_exceeded', message: 'Context invalid' }, { codex_error_info: 'safety_policy', message: 'Refused' }])
  test(`no automatic recovery for ${JSON.stringify(error)}`, async t => {
    const h = await setup(t); await h.fail(error); h.advance(300000); await h.c.deliverCapacityRecoveries()
    assert.equal(h.recovery(), undefined); assert.equal(h.calls.length, 0)
  })

test('success, interrupted, user Stop and goal-triggered failures do not recover', async t => {
  for (const mode of ['success', 'interrupt', 'stop', 'goal']) {
    const h = await setup(t)
    if (mode === 'success') h.c.finish(h.c.active(), 'complete', 'done', 'Done', capacity)
    else if (mode === 'interrupt') h.c.finish(h.c.active(), 'interrupted', 'abort', 'Stopped', capacity)
    else { if (mode === 'stop') h.c.active().stopRequested = true; else h.c.active().turnTrigger = 'goal'; await h.fail() }
    assert.equal(h.recovery(), undefined)
  }
})

test('due continuation uses the same thread/project route and explicitly inspects unfinished work, never original request replay', async t => {
  const h = await setup(t); await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  const add = h.calls.find(c => c.method === 'thread/queue/add')
  assert.equal(add.args.threadId, 'session')
  assert.deepEqual(Object.keys(add.args).sort(), ['clientUserMessageId','input','threadId'])
  const text = add.args.input[0].text
  assert.match(text, /^\[codex_capacity_recovery id=/)
  assert.match(text, /Bridge-generated.*not a new human request/)
  assert.match(text, /UNFINISHED/); assert.match(text, /current files, receipts and actual running\/completed jobs/)
  assert.match(text, /do not replay completed renders/); assert.match(text, /do not.*resume\/change goals/)
  assert.ok(!text.includes('ORIGINAL_REQUEST_MUST_NOT_BE_REPLAYED')); assert.ok(!text.includes('[discord #'))
  assert.equal(h.c.active().taskId, 'task'); assert.deepEqual(h.c.active().messageIds, ['1'])
  assert.equal(h.recovery().status, 'resumed'); assert.equal(h.state.all('inbox').length, 1)
})

test('selection fields omitted by thread/read remain provenance only, with no invented model API arguments', async t => {
  const h = await setup(t); await h.fail(); delete h.thread.model; delete h.thread.reasoningEffort
  h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().status, 'resumed')
  assert.equal(h.calls.filter(c => /model|config|goal/.test(c.method)).length, 0)
})

test('four capacity continuations use30/60/120/240 seconds and then exhaust across SQLite restarts', async t => {
  const h = await setup(t); await h.fail()
  for (let i=0;i<4;i++) {
    assert.equal(h.recovery().dueAt-h.now, capacityBackoffMs[i])
    h.restart(); h.advance(capacityBackoffMs[i]); await h.c.deliverCapacityRecoveries()
    assert.equal(h.calls.filter(c => c.method === 'thread/queue/add').length, i+1)
    await h.fail()
  }
  assert.equal(h.recovery().status, 'exhausted')
  h.advance(900000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 4)
})

test('terminal event/native notification replay cannot add another schedule or reset backoff', async t => {
  const h = await setup(t); await h.fail(); const before = h.recovery()
  h.advance(5000); h.restart()
  await h.c.record(event('task_complete', { turn_id: 'failed', error: capacity }), 'replay')
  h.c.finish(h.c.session.turns.failed, 'failed', 'notification', capacity.message, capacity)
  assert.deepEqual(h.recovery(), before)
})

test('lost queue/add response is reconciled after restart and the original internal ID starts once', async t => {
  const h = await setup(t, { loseAdd: true }); await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  const clientId = h.recovery().attempts[0].clientId
  assert.equal(h.queue.length, 1); h.restart(); h.advance(15000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/add').length, 1)
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 1)
  assert.equal(h.c.active().capacityAttemptClientId, clientId)
})

for (const terminal of [false, true]) test(`lost queue/start response reconciles actual ${terminal?'completed':'active'} turn without duplication`, async t => {
  const h = await setup(t, { loseStart: true }); await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  if (terminal) { h.thread.turns.at(-1).status = 'completed'; h.thread.status.type = 'idle' }
  h.restart(); h.advance(15000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/add').length, 1)
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 1)
  assert.equal(h.recovery().status, terminal ? 'complete' : 'resumed')
})

test('a provider terminal arriving before queue/start response is attributed and schedules only the next bounded attempt', async t => {
  const h = await setup(t, { afterStart: async (turn, { c, thread }) => {
    await c.record(event('task_started', { turn_id: turn.id }), 'early-start')
    turn.status = 'failed'; turn.error = capacity; thread.status.type = 'idle'
    c.finish(c.active(), 'failed', 'early-terminal', capacity.message, capacity)
  } })
  await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().status, 'scheduled'); assert.equal(h.recovery().attempts.length, 1)
  assert.equal(h.recovery().dueAt-h.now, 60000)
  assert.equal(h.c.session.turns.recovery1.taskId, 'task')
})

test('new user input cancels scheduled recovery, while duplicate delivery of the same user message does not', async t => {
  const h = await setup(t); await h.fail()
  h.c.receive({ messageId:'1',taskId:'task' }); assert.equal(h.recovery().status, 'scheduled')
  h.c.receive({ messageId:'2',taskId:'task',mode:'steer',content:'new steering' })
  h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().cancelReason, 'new_user_input'); assert.equal(h.calls.length, 0)
})

test('new input during queue/add removes the accepted queued recovery before any start', async t => {
  const h = await setup(t, { afterAdd: async (_, { c }) => c.receive({ messageId:'2',taskId:'task',mode:'steer',content:'new steering' }) })
  await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.queue.length, 0); assert.equal(h.recovery().status, 'cancelled')
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 0)
})

test('new steering incorporated into a resumed turn can start a fresh bounded incident after cancelling the old scope', async t => {
  const h = await setup(t); await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  const first = h.recovery().id
  h.c.receive({ messageId:'2',taskId:'task',mode:'steer',content:'continue but use the new measurements' })
  assert.equal(h.state.get('capacity_recovery', first).status, 'cancelled')
  await h.c.record(event('item_completed', {turn_id:h.c.active().id,item:{type:'UserMessage',content:'[discord #codex-test from user msg=2]\ncontinue with new measurements'}}),'new-steer')
  await h.fail()
  const pending = h.c.capacityPending()
  assert.notEqual(pending.id, first); assert.equal(pending.attempts.length, 0)
  assert.deepEqual(pending.messageIds, ['1','2']); assert.equal(pending.inputVersion, 2)
  assert.equal(pending.dueAt-h.now, 30000)
  assert.equal(h.state.get('capacity_recovery', first).status, 'cancelled')
})

test('late queue/start attribution preserves newly incorporated real steering', async t => {
  const h = await setup(t, { afterStart: async (turn, { c }) => {
    await c.record(event('task_started',{turn_id:turn.id}),'started-before-response')
    await c.record(event('item_completed',{turn_id:turn.id,item:{type:'UserMessage',content:turn.items[0].content}}),'marker-before-response')
    c.receive({messageId:'2',taskId:'task',mode:'steer',content:'new scope'})
    await c.record(event('item_completed',{turn_id:turn.id,item:{type:'UserMessage',content:'[discord #codex-test from user msg=2]\nnew scope'}}),'human-before-response')
  } })
  await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.deepEqual(h.c.active().messageIds,['1','2']); assert.equal(h.c.active().inputVersion,2)
  await h.fail(); assert.equal(h.c.capacityPending().inputVersion,2)
})

test('Stop cancels scheduled recovery without interrupting or starting unrelated work', async t => {
  const h = await setup(t); await h.fail()
  assert.match((await h.c.control('stop','task')).text, /Cancelled automatic capacity recovery/)
  h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().cancelReason, 'user_stop'); assert.equal(h.calls.length, 0)
})

for (const kind of ['active', 'completed', 'queued', 'project', 'model', 'effort']) test(`actual ${kind} advancement cancels stale recovery`, async t => {
  const h = await setup(t); await h.fail()
  if (kind === 'active' || kind === 'completed') {
    h.thread.turns.push({ id:'other',status:kind === 'active'?'inProgress':'completed',items:[] }); h.thread.status.type = kind === 'active'?'active':'idle'
  } else if (kind === 'queued') h.queue.push({ id:'human',input:[{type:'text',text:'new native input'}] })
  else if (kind === 'project') h.thread.cwd = '/other/project'
  else if (kind === 'model') h.thread.model = 'different-model'
  else h.thread.reasoningEffort = 'low'
  h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().status, 'cancelled')
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/add'||c.method === 'thread/queue/start').length, 0)
})

test('explicit new turn_context selection cancels pending recovery without changing config', async t => {
  const h = await setup(t); await h.fail()
  await h.c.record({type:'turn_context',payload:{model:'different-model',effort:'low'}},'selection')
  assert.equal(h.recovery().cancelReason, 'selection_changed')
})

test('bootstrap and old failed-turn replay after the13:55 user follow-up do not manufacture a historical retry', async t => {
  const h = await setup(t); h.c.bootstrapping = true; await h.fail(); assert.equal(h.recovery(), undefined)
  h.c.bootstrapping = false
  const old = h.c.session.turns.failed; old.status = 'working'
  h.advance(6*3600000+38*60000)
  h.c.receive({messageId:'2',taskId:'task',mode:'steer',content:'why stopped?'})
  await h.c.record(event('task_complete',{turn_id:'failed',error:capacity}),'old-replay')
  assert.equal(h.recovery(), undefined); assert.equal(h.calls.length, 0)
})

for (const text of ['Unauthorized', 'Quota exceeded', 'Invalid context', 'Safety policy refusal']) test(`definite delivery rejection ${text} is not retried`, async t => {
  const h = await setup(t, { rejectAdd:text }); await h.fail(); h.advance(30000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.recovery().cancelReason, 'delivery_rejected')
  h.advance(15000); await h.c.deliverCapacityRecoveries()
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/add').length, 1)
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 0)
})

test('a second controller sharing SQLite cannot dispatch a leased attempt concurrently', async t => {
  let release, blocked = true
  const gate = new Promise(resolve => { release = resolve })
  const h = await setup(t, { before: async method => { if (blocked && method === 'thread/queue/list') await gate } })
  await h.fail(); h.advance(30000)
  const first = h.c.deliverCapacityRecoveries()
  await new Promise(resolve => setImmediate(resolve))
  const other = h.anotherController(); await other.deliverCapacityRecoveries()
  blocked = false; release(); await first
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/add').length, 1)
  assert.equal(h.calls.filter(c => c.method === 'thread/queue/start').length, 1)
})
