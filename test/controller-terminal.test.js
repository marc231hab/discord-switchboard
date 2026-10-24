import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeController } from '../src/bridge-controller.js'
import { fixture, event } from './helpers.js'

async function running(t) {
  const { state, dir } = fixture(t)
  const calls = []
  const controller = new BridgeController({ state, codex: { request: async (...args) => { calls.push(args); throw Error('No RPC expected') } }, channelId: 'main', channelName: 'codex-test', projectDir: dir, home: dir, log: () => {} })
  controller.receive({ messageId: '1', taskId: 'task', mode: 'new' })
  await controller.record(event('task_started', { turn_id: 'turn' }), 'start')
  Object.assign(controller.active(), { taskId: 'task', messageIds: ['1'], lastReply: 'Earlier progress, not a result' })
  return { controller, state, calls }
}

test('actual capacity task_complete error fails once instead of sealing a false success', async t => {
  const { controller, state, calls } = await running(t)
  const payload = { turn_id: 'turn', last_agent_message: 'Earlier progress, not a result', error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } }
  const record = { timestamp: '2026-10-19T07:40:00.644Z', type: 'event_msg', payload: { type: 'task_complete', ...payload } }
  await controller.record(record, 'capacity')
  await controller.record(record, 'capacity-replay')
  controller.finish(controller.session.turns.turn, 'failed', 'native-failed', payload.error.message)
  assert.equal(controller.session.turns.turn.status, 'failed')
  assert.equal(controller.session.activeTurnId, null)
  assert.equal(state.get('inbox', '1').status, 'failed')
  const terminal = state.all('outbox')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].status, 'failed')
  assert.equal(terminal[0].summary, payload.error.message)
  assert.deepEqual(terminal[0].messageIds, ['1'])
  assert.equal(calls.length, 0)
})

test('terminal error summary is redacted and excludes unrelated structured payload fields', async t => {
  const { controller, state } = await running(t)
  await controller.record(event('task_complete', { turn_id: 'turn', error: { message: 'Provider refused token=private-token-value', private_diagnostics: 'DO_NOT_PUBLISH' } }), 'failure')
  const terminal = state.all('outbox')[0]
  assert.equal(terminal.summary, 'Provider refused token=[redacted]')
  assert.ok(!JSON.stringify(terminal).includes('DO_NOT_PUBLISH'))
  assert.ok(!JSON.stringify(terminal).includes('private-token-value'))
})

for (const [type, extra, status, summary] of [
  ['task_complete', {}, 'complete', 'Earlier progress, not a result'],
  ['task_complete', { error: null, last_agent_message: 'Actual result' }, 'complete', 'Actual result'],
  ['task_complete', { error: {} }, 'failed', 'Codex task failed'],
  ['task_complete', { error: 'Provider unavailable' }, 'failed', 'Provider unavailable'],
  ['task_failed', { message: 'Task failed at provider' }, 'failed', 'Task failed at provider'],
  ['task_failed', { error: { message: 'Actual failure' }, last_agent_message: 'Earlier prose' }, 'failed', 'Actual failure'],
  ['turn_aborted', { message: 'Cancelled' }, 'interrupted', 'Cancelled'],
  ['turn_aborted', { error: { message: 'Cancelled with error' } }, 'interrupted', 'Cancelled with error']
]) test(`${type} ${JSON.stringify(extra)} retains its explicit terminal meaning`, async t => {
  const { controller, state } = await running(t)
  await controller.record(event(type, { turn_id: 'turn', ...extra }), 'terminal')
  assert.equal(state.get('inbox', '1').status, status)
  assert.equal(state.all('outbox')[0].summary, summary)
})

test('capacity error wins over stopRequested while normal completion remains interrupted after Stop', async t => {
  for (const hasError of [false, true]) {
    const { controller, state } = await running(t)
    controller.active().stopRequested = true
    await controller.record(event('task_complete', { turn_id: 'turn', ...(hasError ? { error: { message: 'Capacity failure' } } : {}) }), 'terminal')
    assert.equal(state.get('inbox', '1').status, hasError ? 'failed' : 'interrupted')
  }
})

test('a late known-turn failure cannot finish another active turn or incorporated request', async t => {
  const { controller, state } = await running(t)
  await controller.record(event('task_started', { turn_id: 'other' }), 'other-start')
  Object.assign(controller.active(), { taskId: 'other-task', messageIds: ['2'] })
  controller.receive({ messageId: '2', taskId: 'other-task', mode: 'new' })
  await controller.record(event('task_complete', { turn_id: 'turn', error: { message: 'Capacity failure' } }), 'old-terminal')
  assert.equal(controller.active().id, 'other')
  assert.equal(controller.active().status, 'working')
  assert.equal(state.get('inbox', '2').status, 'received')
  assert.equal(state.all('outbox')[0].taskId, 'task')
})

test('terminal replay after controller restart stays idempotent and never replays input', async t => {
  const { controller, state, calls } = await running(t)
  await controller.record(event('task_complete', { turn_id: 'turn', error: { message: 'Capacity failure' } }), 'terminal')
  const resumed = new BridgeController({ state, codex: controller.codex, channelId: 'main', channelName: 'codex-test' })
  await resumed.record(event('task_complete', { turn_id: 'turn', error: { message: 'Capacity failure' } }), 'replay')
  await resumed.record(event('task_failed', { turn_id: 'turn', message: 'Later native failure' }), 'later-failure')
  assert.equal(state.all('outbox').length, 1)
  assert.equal(state.get('inbox', '1').status, 'failed')
  assert.equal(calls.length, 0)
})

test('genuine successful terminal guard is unchanged for contradictory late notifications', async t => {
  const { controller, state } = await running(t)
  await controller.record(event('task_complete', { turn_id: 'turn', last_agent_message: 'Actual result' }), 'success')
  await controller.record(event('task_failed', { turn_id: 'turn', message: 'Late contradiction' }), 'late')
  assert.equal(state.all('outbox').length, 1)
  assert.equal(state.get('inbox', '1').status, 'complete')
})
