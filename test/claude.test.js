import test from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeController, claudeReadiness, observeClaudeForeground, seedClaudeForeground, reconcileClaudeToolResults } from '../src/claude-controller.js'
import { DiscordService } from '../src/discord-service.js'
import { fixture,fakeDiscord,fakeSocket } from './helpers.js'
function setup(t){const{state,dir}=fixture(t);const c=new ClaudeController({state,channelId:'main',channelName:'test',projectDir:dir,home:dir,log:()=>{}});return{state,c}}

test('Claude shell presence permits a new request only after this session completed its foreground turn',()=>{
 const registry={sessionId:'current',startedAt:100,status:'shell'}
 const session={threadId:'current',tools:{},turns:{done:{startedAt:200,status:'complete'}}}
 const ready=claudeReadiness(registry,session,null)
 assert.equal(ready.newTaskReady,true);assert.equal(ready.backgroundShells,true)
 assert.match(ready.activity,/Ready.*background shells/)
 for(const current of [{...registry,status:'busy'},{...registry,status:'waiting'},
   {...registry,waitingFor:'permission prompt'},{...registry,waitingFor:'input needed'}]) {
  assert.equal(claudeReadiness(current,session,null).newTaskReady,false)
  assert.notEqual(claudeReadiness(current,session,null).activity,'Idle')
 }
 for(const active of [{status:'working'},{status:'working',awaitingInput:true}])
  assert.equal(claudeReadiness(registry,session,active).newTaskReady,false)
 for(const changed of [{...session,tools:{tool:{name:'Bash'}}},{...session,turns:{}},
   {...session,threadId:'previous'},{...session,turns:{old:{startedAt:50,status:'complete'}}},
   {...session,turns:{last:{startedAt:200,status:'working'}}}])
  assert.equal(claudeReadiness(registry,changed,null).newTaskReady,false)
 assert.equal(claudeReadiness({...registry,status:'idle'},{tools:{},turns:{}},null).newTaskReady,true)
})

const foregroundRecord = (type, at, message = {}, extra = {}) => ({type, sessionId:'current', timestamp:new Date(at).toISOString(), message, ...extra})
test('a real tool result after task interruption releases readiness without replaying task events',async t=>{
 const {c,state}=setup(t);c.session.threadId='current'
 c.receive({messageId:'1',taskId:'1',mode:'new',channelId:'main'})
 await c.transcript(input('1'),'start')
 await c.transcript(foregroundRecord('assistant',200,{content:[{type:'tool_use',id:'late',name:'Bash',input:{command:'PRIVATE'}}]}),'use')
 c.finish(c.active(),'interrupted','interrupt','Stopped')
 assert.ok(c.session.tools.late)
 const events=state.all('outbox').length
 await c.transcript(foregroundRecord('user',300,{content:[{type:'tool_result',tool_use_id:'late',content:'PRIVATE result'}]}),'late-result')
 assert.deepEqual(c.session.tools,{})
 assert.deepEqual(state.get('session','current').tools,{})
 assert.equal(state.all('outbox').length,events)
 await c.transcript(foregroundRecord('assistant',400,{stop_reason:'end_turn',content:[]}),'end')
 assert.equal(claudeReadiness({sessionId:'current',startedAt:100,status:'shell'},c.session,null).newTaskReady,true)
})

test('consumed-history seeding reconciles only actual same-session tool results',()=>{
 const session={threadId:'current',tools:{done:{name:'Bash'},open:{name:'Bash'},side:{name:'Bash'},foreign:{name:'Bash'}}}
 seedClaudeForeground(session,[foregroundRecord('user',200,{content:[{type:'tool_result',tool_use_id:'done',content:'PRIVATE result'}]}),
  foregroundRecord('user',300,{content:[{type:'tool_result',tool_use_id:'side'}]},{isSidechain:true}),
  foregroundRecord('user',400,{content:[{type:'tool_result',tool_use_id:'foreign'}]},{sessionId:'other'}),
  foregroundRecord('assistant',500,{stop_reason:'end_turn',content:[]})].map(JSON.stringify).join('\n'))
 assert.deepEqual(Object.keys(session.tools).sort(),['foreign','open','side'])
 assert.equal(session.toolResultsVersion,1)
 assert.ok(!JSON.stringify(session).includes('PRIVATE'))
 reconcileClaudeToolResults(session,foregroundRecord('assistant',600,{content:[{type:'tool_result',tool_use_id:'open'}]}))
 assert.ok(session.tools.open,'only actual user tool-result records release a handle')
})

test('shell presence admits requests after an explicit foreground end_turn even with no Discord turn',()=>{
 const registry={sessionId:'current',startedAt:100,status:'shell'}
 const session={threadId:'current',tools:{},turns:{}}
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,false)
 observeClaudeForeground(session,foregroundRecord('assistant',200,{content:[{type:'tool_use',id:'mon',name:'Monitor',input:{}}]}))
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,false,'unfinished foreground tool')
 observeClaudeForeground(session,foregroundRecord('user',300,{content:[{type:'tool_result',tool_use_id:'mon',content:'started'}]}))
 observeClaudeForeground(session,foregroundRecord('assistant',400,{stop_reason:'end_turn',content:[{type:'text',text:'done'}]}))
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,true)
 for(const changed of [{...registry,startedAt:500},{...registry,sessionId:'other'},{...registry,waitingFor:'permission'}])
  assert.equal(claudeReadiness(changed,session,null).newTaskReady,false)
 assert.equal(claudeReadiness(registry,session,{status:'working'}).newTaskReady,false)
 observeClaudeForeground(session,foregroundRecord('user',600,{content:'notification'}))
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,false,'working again')
})
test('delegated busy requires explicit foreground completion newer than this process and native status',()=>{
 const registry={sessionId:'current',startedAt:100,status:'busy',statusUpdatedAt:1000,updatedAt:1000}
 const session={threadId:'current',tools:{},turns:{}}
 observeClaudeForeground(session,foregroundRecord('user',1100,{content:'PRIVATE user request'}))
 observeClaudeForeground(session,foregroundRecord('assistant',1200,{content:[{type:'tool_use',id:'background-start',name:'Bash',input:{command:'PRIVATE command'}}]}))
 observeClaudeForeground(session,foregroundRecord('user',1300,{content:[{type:'tool_result',tool_use_id:'background-start',content:'PRIVATE background result'}]}))
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,false)
 observeClaudeForeground(session,foregroundRecord('assistant',1400,{stop_reason:'end_turn',content:[{type:'text',text:'PRIVATE answer'}]}))
 const ready=claudeReadiness(registry,session,null)
 assert.equal(ready.newTaskReady,true);assert.equal(ready.completedAfterBusy,true);assert.equal(ready.foregroundTools,0)
 assert.match(ready.activity,/foreground completed after native busy/)
 assert.equal(claudeReadiness({...registry,updatedAt:9000},session,null).newTaskReady,true,'descriptive metadata updates do not change the native status timestamp')
 assert.ok(!JSON.stringify(session.foreground).includes('PRIVATE'))
 for(const changed of [{...registry,statusUpdatedAt:1400},{...registry,statusUpdatedAt:1500},{...registry,startedAt:1400},
   {...registry,statusUpdatedAt:undefined},{...registry,sessionId:'different'},{...registry,status:'waiting'},
   {...registry,status:'unknown'},{...registry,waitingFor:'permission'}])
  assert.equal(claudeReadiness(changed,session,null).newTaskReady,false)
 assert.equal(claudeReadiness(registry,{...session,tools:{still:{name:'Bash'}}},null).newTaskReady,false)
 assert.equal(claudeReadiness(registry,session,{status:'working'}).newTaskReady,false)
 assert.equal(claudeReadiness(registry,session,{awaitingInput:true}).newTaskReady,false)
})

test('all non-channel foreground records revoke a busy override before the controller early return',async t=>{
 const {c,state}=setup(t);c.session.threadId='current'
 const registry={sessionId:'current',startedAt:100,status:'busy',statusUpdatedAt:1000,updatedAt:1000}
 for(const work of [foregroundRecord('user',1600,{content:'PRIVATE local input'}),
   foregroundRecord('assistant',1600,{content:[{type:'text',text:'PRIVATE work'}]}),
   foregroundRecord('assistant',1600,{content:[{type:'tool_use',id:'tool',name:'AskUserQuestion',input:{private:'payload'}}]})]){
  seedClaudeForeground(c.session,JSON.stringify(foregroundRecord('assistant',1500,{stop_reason:'end_turn',content:[]})))
  assert.equal(claudeReadiness(registry,c.session,null).newTaskReady,true)
  await c.transcript(work,'unbound-work')
  assert.equal(c.active(),null);assert.equal(claudeReadiness(registry,c.session,null).newTaskReady,false)
  assert.equal(state.get('session','current').foreground.phase,'working')
 }
 assert.equal(state.all('outbox').length,0,'observing a non-channel foreground must not emit router events')
 await c.transcript(foregroundRecord('system',1700,{}, {subtype:'turn_duration'}),'pending-duration')
 assert.equal(claudeReadiness(registry,c.session,null).newTaskReady,false,'duration cannot clear a pending question/tool')
 await c.transcript(foregroundRecord('user',1800,{content:[{type:'tool_result',tool_use_id:'tool',content:'PRIVATE response'}]}),'tool-result')
 assert.equal(claudeReadiness(registry,c.session,null).newTaskReady,false,'result alone is not completion')
 await c.transcript(foregroundRecord('system',1900,{}, {subtype:'turn_duration'}),'duration')
 assert.equal(claudeReadiness(registry,c.session,null).newTaskReady,true)
 assert.ok(!JSON.stringify(c.session.foreground).includes('PRIVATE'))
})

test('foreground seeding ignores sidechains and other sessions and never admits unproven completion',()=>{
 const session={threadId:'current',tools:{},turns:{}}
 const registry={sessionId:'current',startedAt:100,status:'busy',statusUpdatedAt:1000,updatedAt:1000}
 seedClaudeForeground(session,[foregroundRecord('user',1100,{content:'PRIVATE'}),
  foregroundRecord('assistant',1200,{stop_reason:'end_turn',content:[]}),
  foregroundRecord('user',1300,{content:'sidechain'}, {isSidechain:true}),
  foregroundRecord('user',1400,{content:'different'}, {sessionId:'other'})].map(JSON.stringify).join('\n'))
 assert.equal(claudeReadiness(registry,session,null).newTaskReady,true)
 session.threadId='restarted'
 const next={...registry,sessionId:'restarted',startedAt:2000,statusUpdatedAt:2100,updatedAt:2100}
 assert.equal(claudeReadiness(next,session,null).newTaskReady,false)
 observeClaudeForeground(session,foregroundRecord('assistant',2200,{stop_reason:'end_turn',content:[]},{sessionId:'restarted'}))
 assert.equal(claudeReadiness(next,session,null).newTaskReady,true)
 observeClaudeForeground(session,{type:'assistant',sessionId:'restarted',message:{stop_reason:'end_turn',content:[]}})
 assert.equal(claudeReadiness(next,session,null).newTaskReady,false,'missing timestamp must not invent newer evidence')
 seedClaudeForeground(session,'invalid JSON\n')
 assert.equal(claudeReadiness(next,session,null).newTaskReady,false)
})

test('completing a follow-up never discards its unincorporated original or other queued requests',async t=>{
 const {c,state}=setup(t)
 for(const row of [{messageId:'1',taskId:'1',mode:'new'},{messageId:'2',taskId:'1',mode:'steer'},
   {messageId:'3',taskId:'3',mode:'new'},{messageId:'4',taskId:'1',mode:'steer'}]) c.receive({...row,channelId:'main'})
 await c.transcript(input('2'),'steer-start')
 const turn=c.active();assert.deepEqual(turn.messageIds,['2']);assert.equal(state.get('inbox','1').status,'received')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[]}},'complete')
 assert.equal(state.get('inbox','1').status,'received')
 assert.equal(state.get('inbox','1').completionByTaskTurnId,undefined)
 assert.equal(state.get('inbox','1').turnId,undefined,'root was not incorporated')
 assert.deepEqual(turn.messageIds,['2']);assert.equal(state.get('inbox','2').status,'complete')
 assert.equal(state.get('inbox','3').status,'received');assert.equal(state.get('inbox','4').status,'received')
 await c.transcript(input('1'),'original-finally-incorporated')
 assert.equal(state.get('inbox','1').status,'working')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[]}},'original-complete')
 assert.equal(state.get('inbox','1').status,'complete')
 for(const status of ['failed','interrupted']){
  const id='root-'+status;c.receive({messageId:id,taskId:id,mode:'new',channelId:'main'})
  c.finish({id:'turn-'+status,taskId:id,status:'working',messageIds:[]},status,status,'')
  assert.equal(state.get('inbox',id).status,'received')
 }
 c.receive({messageId:'foreign',taskId:'foreign',mode:'new',channelId:'other'})
 c.finish({id:'foreign-turn',taskId:'foreign',status:'working',messageIds:[]},'complete','foreign','')
 assert.equal(state.get('inbox','foreign').status,'received')
})

const input = id => ({uuid:`turn-${id}`,timestamp:new Date().toISOString(),type:'attachment',attachment:{type:'queued_command',origin:{kind:'channel'},prompt:`<channel channelId="main" messageId="${id}">fix</channel>`}})
test('Claude queued channel context marks a message consumed and safely forwards text only',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'1',mode:'new'});await c.transcript(input('1'),'input')
 assert.equal(state.get('inbox','1').status,'working')
 await c.transcript({type:'assistant',message:{model:'claude',stop_reason:'end_turn',content:[{type:'thinking',thinking:'PRIVATE'},{type:'text',text:'Tests passed'}]}},'answer')
 const events=state.all('outbox');assert.ok(events.some(e=>e.text==='Tests passed'));assert.ok(events.some(e=>e.status==='complete'));assert.ok(!JSON.stringify(events).includes('PRIVATE'))
})
test('Claude follows the same task when a channel follow-up arrives mid-turn',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'one')
 c.receive({messageId:'2',taskId:'task',mode:'steer'});await c.transcript(input('2'),'two')
 assert.deepEqual(c.active().messageIds,['1','2']);assert.equal(state.get('inbox','2').status,'working')
})
test('Claude AskUserQuestion creates a waiting state and does not prematurely finish',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'1',mode:'new'});await c.transcript(input('1'),'input')
 await c.transcript({type:'assistant',message:{content:[{type:'tool_use',id:'q',name:'AskUserQuestion',input:{}}]}},'q')
 await c.transcript({type:'system',subtype:'turn_duration'},'stop')
 assert.ok(c.active());assert.ok(state.all('outbox').some(e=>e.status==='waiting'));assert.ok(!state.all('outbox').some(e=>e.status==='complete'))
})
test('Claude stop interrupts only the active task and records cancellation',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'1',mode:'new'});await c.transcript(input('1'),'input');let stopped=0;c.interrupt=async()=>stopped++
 await c.control('stop','stale');assert.equal(stopped,0)
 await c.control('stop','1');assert.equal(stopped,1);assert.ok(state.all('outbox').some(e=>e.status==='interrupted'))
})
test('Claude bridge owns durable delivery and forwards to the existing MCP notification connection',async t=>{
 const {state}=fixture(t),d=fakeDiscord(),s=new DiscordService({state,client:d.client,log:()=>{}}),mcp=fakeSocket(),bridge=fakeSocket()
 s.register(mcp,{channelId:'main'});s.register(bridge,{channelId:'main',role:'claude_bridge'})
 await s.receive(d.makeMessage({id:'1'}));assert.equal(mcp.messages.filter(m=>m.type==='message').length,0);assert.equal(bridge.messages.filter(m=>m.type==='message').length,1)
 await s.handle(bridge,{id:'deliver',type:'notify',channelId:'main',payload:{messageId:'1',content:'fix'}})
 assert.equal(mcp.messages.at(-1).content,'fix');assert.equal(state.get('binding','main').kind,'claude')
})

test('Claude resumes a completed task in a fresh turn while preserving its task id',async t=>{
 const {c,state}=setup(t)
 c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'first')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done'}]}},'finished')
 assert.equal(c.active(),null)
 c.receive({messageId:'2',taskId:'task',mode:'steer'});await c.transcript(input('2'),'follow-up')
 assert.equal(c.active().taskId,'task')
 assert.deepEqual(c.active().messageIds,['2'])
 assert.equal(state.get('inbox','1').status,'complete')
 assert.equal(state.get('inbox','2').status,'working')
})

async function explicitReply(c, key, text, failed = false) {
 await c.transcript({type:'assistant',message:{content:[{type:'tool_use',id:key,name:'mcp__custom-discord__discord_reply',input:{text}}]}},`${key}:use`)
 await c.transcript({type:'user',message:{content:[{type:'tool_result',tool_use_id:key,is_error:failed,content:'tool result'}]}},`${key}:result`)
}

test('Claude sends the explicit answer once, suppresses paraphrased end_turn prose, and still completes',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'input')
 await explicitReply(c,'reply','I have stepped off the task. The other agent owns it.')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'I stepped off this work and notified user; the other agent owns it from here.'}]}},'final')
 assert.equal(state.all('outbox').filter(e=>e.text).length,0)
 assert.equal(state.all('outbox').filter(e=>e.status==='complete').length,1)
 assert.equal(c.active(),null)
})

test('Claude failed explicit replies retain the automatic answer fallback',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'input')
 await explicitReply(c,'reply','Not delivered',true)
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Fallback answer'}]}},'final')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
 assert.equal(state.all('outbox').find(e=>e.text)?.text,'Fallback answer')
})

test('Claude new channel incorporation resets explicit delivery but duplicate incorporation does not',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'input-1')
 await explicitReply(c,'reply-1','Done')
 await c.transcript(input('1'),'replayed-input-1')
 await c.transcript({type:'assistant',message:{content:[{type:'text',text:'Paraphrased first answer'}]}},'suppressed')
 assert.equal(state.all('outbox').filter(e=>e.text).length,0)
 c.receive({messageId:'2',taskId:'task',mode:'steer'});await c.transcript(input('2'),'input-2')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done'}]}},'fallback')
 assert.equal(state.all('outbox').filter(e=>e.text).length,1)
})

test('Claude retains fallback for a follow-up incorporated while an earlier reply is in flight',async t=>{
 const {c,state}=setup(t);c.receive({messageId:'1',taskId:'task',mode:'new'});await c.transcript(input('1'),'input-1')
 await c.transcript({type:'assistant',message:{content:[{type:'tool_use',id:'old-reply',name:'mcp__custom-discord__discord_reply',input:{text:'Earlier answer'}}]}},'old-use')
 c.receive({messageId:'2',taskId:'task',mode:'steer'});await c.transcript(input('2'),'input-2')
 await c.transcript({type:'user',message:{content:[{type:'tool_result',tool_use_id:'old-reply',content:'Sent'}]}},'old-result')
 await c.transcript({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Follow-up answer'}]}},'new-final')
 assert.equal(state.all('outbox').find(e=>e.text)?.text,'Follow-up answer')
})
