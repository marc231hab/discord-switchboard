import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeController } from '../src/bridge-controller.js'
import { fixture,event } from './helpers.js'
import { State } from '../src/state.js'
import { join } from 'node:path'
function controller(t, handler) {
 const {state,dir}=fixture(t),calls=[]
 const c=new BridgeController({state,codex:{request:async(method,args)=>{calls.push({method,args});return handler(method,args)}},channelId:'main',channelName:'codex-test',projectDir:dir,home:dir,log:()=>{}})
 c.session.threadId='session';return {c,state,dir,calls}
}
test('an accepted queue add with a lost response is recovered without a duplicate add',async t=>{
 let queue=[],adds=0,starts=0
 const {c,state,dir}=controller(t,(method,args)=>{
  if(method==='thread/read')return {thread:{cwd:dir,status:{type:'idle'},canAcceptDirectInput:true,turns:[]}}
  if(method==='thread/queue/list')return {data:queue,nextCursor:null}
  if(method==='thread/queue/add'){adds++;queue=[{id:'q',clientUserMessageId:args.clientUserMessageId,input:args.input}];throw Error('connection closed after accept')}
  if(method==='thread/queue/start'){starts++;return {turn:{id:'turn'}}}
 })
 c.receive({messageId:'1',taskId:'1',mode:'new',authorName:'user',content:'fix'})
 await c.deliverPending();assert.equal(state.get('inbox','1').status,'uncertain')
 const row=state.get('inbox','1');row.retryAfter=0;state.put('inbox','1',row)
 await c.deliverPending();assert.equal(adds,1);assert.equal(starts,1)
})
test('follow-ups steer the exact active turn and become working only after consumption',async t=>{
 const {c,state,dir,calls}=controller(t,method=>method==='thread/read'?{thread:{cwd:dir,status:{type:'active'},canAcceptDirectInput:true}}:method==='thread/queue/list'?{data:[],nextCursor:null}:{turnId:'turn'})
 await c.record(event('task_started',{turn_id:'turn',root_turn_id:'turn'}),'s')
 c.session.turns.turn.taskId='task'
 c.receive({messageId:'2',taskId:'task',mode:'steer',authorName:'user',content:'also lint'})
 await c.deliverPending();assert.equal(state.get('inbox','2').status,'queued')
 assert.equal(calls.find(x=>x.method==='turn/steer').args.expectedTurnId,'turn')
 await c.record(event('item_completed',{turn_id:'turn',item:{type:'UserMessage',content:[{type:'text',text:'[discord #codex-test from user msg=2]\nalso lint'}]}}),'u')
 assert.equal(state.get('inbox','2').status,'working')
 assert.ok(state.all('outbox').some(e=>e.activity==='Follow-up incorporated into the active task'))
})
test('separate tasks wait while another turn is active',async t=>{
 const {c,dir,calls}=controller(t,method=>method==='thread/read'?{thread:{cwd:dir,status:{type:'active'},canAcceptDirectInput:true}}:{data:[],nextCursor:null})
 c.receive({messageId:'3',taskId:'3',mode:'new',content:'new task'})
 await c.deliverPending();assert.ok(!calls.some(x=>x.method==='turn/steer'||x.method==='thread/queue/add'))
})
test('Stop is independent of delivery and stale controls cannot stop another task',async t=>{
 const {c,calls}=controller(t,()=>({}))
 await c.record(event('task_started',{turn_id:'turn'}),'s');c.session.turns.turn.taskId='current';c.delivering=true
 assert.match((await c.control('stop','old')).text,/no longer running/)
 assert.equal(calls.length,0)
 await c.control('stop','current');assert.equal(calls[0].method,'turn/interrupt');assert.equal(calls[0].args.turnId,'turn')
})
test('reasoning and system content never enter the public event outbox',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.session.turns.turn.taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:{type:'Reasoning',raw_content:'PRIVATE',summary_text:'PRIVATE'}}),'r')
 await c.record({type:'response_item',payload:{type:'message',role:'developer',content:'SECRET'}},'d')
 assert.equal(state.all('outbox').length,0)
})
test('manual and automatic copies of the same public response are sent once per turn',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.session.turns.turn.taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:{type:'McpToolCall',tool:'discord_reply',status:'Completed',arguments:{text:'Done'}}}),'m')
 await c.record(event('item_completed',{turn_id:'turn',item:{type:'AgentMessage',content:'Done',phase:'final_answer'}}),'a')
 assert.equal(state.all('outbox').length,0)
 await c.record(event('task_started',{turn_id:'other'}),'s2');c.session.turns.other.taskId='other'
 await c.record(event('item_completed',{turn_id:'other',item:{type:'AgentMessage',content:'Done',phase:'final_answer'}}),'a2')
 assert.equal(state.all('outbox').length,1)
})
test('a completed turn cannot emit a second completion after event replay',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.session.turns.turn.taskId='task'
 await c.record(event('task_complete',{turn_id:'turn'}),'c1');await c.record(event('task_complete',{turn_id:'turn'}),'c2')
 assert.equal(state.all('outbox').filter(e=>e.status==='complete').length,1)
})

test('a follow-up to a finished Codex task starts an idle turn with the same task id',async t=>{
 const {c,state,dir,calls}=controller(t,method=>{
  if(method==='thread/read')return {thread:{cwd:dir,status:{type:'idle'},canAcceptDirectInput:true}}
  if(method==='thread/queue/list')return {data:[],nextCursor:null}
  if(method==='thread/queue/add')return {queuedSubmission:{id:'q'}}
  return {turn:{id:'resumed'}}
 })
 c.session.turns.old={id:'old',taskId:'1',status:'complete',messageIds:['1']}
 c.receive({messageId:'2',taskId:'1',mode:'steer',content:'follow up'})
 await c.deliverPending()
 assert.ok(calls.some(x=>x.method==='thread/queue/start'))
 assert.ok(!calls.some(x=>x.method==='turn/steer'))
 await c.record(event('task_started',{turn_id:'resumed'}),'start-resumed')
 await c.record(event('item_completed',{turn_id:'resumed',item:{type:'UserMessage',content:[{type:'text',text:'[discord #codex-test from user msg=2]\nfollow up'}]}}),'consume-resumed')
 assert.equal(c.active().taskId,'1')
 assert.deepEqual(c.active().messageIds,['2'])
 assert.equal(state.get('inbox','2').status,'working')
})
// Long self-driven turns must incorporate new requests instead of leaving them queued.
// 30+ min, so any Discord message now steers the active turn, even one for a different task.
test('a message for a different task steers the active Codex turn instead of waiting',async t=>{
 const {c,dir,calls}=controller(t,method=>method==='thread/read'?{thread:{cwd:dir,status:{type:'active'},canAcceptDirectInput:true}}:{data:[],nextCursor:null})
 await c.record(event('task_started',{turn_id:'other'}),'start-other')
 c.session.turns.other.taskId='other'
 c.receive({messageId:'2',taskId:'old',mode:'new',content:'a new request while busy'})
 await c.deliverPending()
 const steer=calls.find(x=>x.method==='turn/steer')
 assert.ok(steer)
 assert.equal(steer.params?.expectedTurnId ?? steer.args?.expectedTurnId ?? steer.expectedTurnId,'other')
 assert.ok(!calls.some(x=>x.method==='thread/queue/add'))
})

const manualReply = (text = 'The change is done', extra = {}) => ({type:'McpToolCall',tool:'discord_reply',status:'Completed',arguments:{text},...extra})
const assistantReply = (text, phase = 'final_answer') => ({type:'AgentMessage',content:text,phase})
const consumedMessage = id => ({type:'UserMessage',content:[{type:'text',text:`[discord #codex-test from user msg=${id}]\nrequest`}]})

for (const phase of ['commentary','final_answer']) test(`a successful explicit reply suppresses paraphrased automatic ${phase}`,async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply()}),'manual')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('I finished the requested change.',phase)}),'auto')
 assert.equal(state.all('outbox').filter(e=>e.text).length,0)
 await c.record(event('task_complete',{turn_id:'turn'}),'done')
 assert.equal(state.all('outbox').filter(e=>e.status==='complete').length,1)
 assert.equal(state.all('outbox').find(e=>e.status==='complete').summary,'The change is done')
})

test('automatic fallback remains available without an explicit reply, after failures, and after unfinished calls',async t=>{
 for(const reply of [null,manualReply('Not sent',{status:'Failed',result:{isError:true}}),manualReply('Not sent',{result:{isError:true}}),manualReply('Not sent',{status:'Incomplete'})]){
  const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
  if(reply)await c.record(event('item_completed',{turn_id:'turn',item:reply}),'manual')
  await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('Here is the answer')}),'auto')
  assert.equal(state.all('outbox').filter(e=>e.text).length,1)
 }
})

test('a failed reply after a successful progress reply permits automatic final fallback',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('I am working on it')}),'progress')
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Done',{status:'Failed',result:{isError:true}})}),'failed')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('The work is complete')}),'auto')
 assert.equal(state.all('outbox').find(e=>e.text)?.text,'The work is complete')
})

test('an explicit attachment-only reply also suppresses the automatic duplicate',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply(undefined,{arguments:{files:['/tmp/report.txt']}})}),'manual')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('I attached the report')}),'auto')
 assert.equal(state.all('outbox').filter(e=>e.text).length,0)
})

test('only incorporating a new follow-up resets explicit delivery and public text deduplication',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 c.receive({messageId:'1',taskId:'task',mode:'new'})
 await c.record(event('item_completed',{turn_id:'turn',item:consumedMessage('1')}),'consume-1')
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Done')}),'manual-1')
 c.receive({messageId:'2',taskId:'task',mode:'steer'})
 await c.record(event('item_started',{turn_id:'turn',item:consumedMessage('1')}),'replay-start-1')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('This is a paraphrase')}),'auto-before-consume')
 assert.equal(state.all('outbox').filter(e=>e.text).length,0)
 await c.record(event('item_started',{turn_id:'turn',item:consumedMessage('2')}),'consume-start-2')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('Done')}),'fallback-2')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Second answer')}),'manual-2')
 await c.record(event('item_completed',{turn_id:'turn',item:consumedMessage('2')}),'consume-complete-2')
 await c.record(event('item_completed',{turn_id:'turn',item:consumedMessage('1')}),'replay-complete-1')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('Another paraphrase')}),'auto-after-replay')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
})

test('explicit delivery survives a process restart between the tool result and assistant prose',async t=>{
 const {c,state,dir}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply()}),'manual')
 state.close()
 const reopened=new State(join(dir,'state.sqlite'))
 try{
  const resumed=new BridgeController({state:reopened,channelId:'main',channelName:'codex-test',projectDir:dir,home:dir,log:()=>{}})
  await resumed.record(event('item_completed',{turn_id:'turn',item:assistantReply('I finished the requested change.')}),'auto')
  assert.equal(reopened.all('outbox').filter(e=>e.text).length,0)
 }finally{reopened.close()}
})

test('late reply results from a prior request cannot suppress or re-enable a follow-up response',async t=>{
 const {c,state}=controller(t,()=>({}));await c.record(event('task_started',{turn_id:'turn'}),'s');c.active().taskId='task'
 await c.record(event('item_completed',{turn_id:'turn',item:consumedMessage('1')}),'consume-1')
 for(const id of ['old-success','old-failure'])await c.record(event('item_started',{turn_id:'turn',item:manualReply('Earlier answer',{id,status:'InProgress'})}),`start:${id}`)
 await c.record(event('item_completed',{turn_id:'turn',item:consumedMessage('2')}),'consume-2')
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Earlier answer',{id:'old-success'})}),'old-success')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('Follow-up answer')}),'new-fallback')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Explicit follow-up answer')}),'new-manual')
 await c.record(event('item_completed',{turn_id:'turn',item:manualReply('Failed old reply',{id:'old-failure',status:'Failed',result:{isError:true}})}),'old-failure')
 await c.record(event('item_completed',{turn_id:'turn',item:assistantReply('Paraphrased follow-up answer')}),'new-duplicate')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
})
