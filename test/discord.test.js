import test from 'node:test'
import assert from 'node:assert/strict'
import { DiscordService } from '../src/discord-service.js'
import { fixture,fakeDiscord,fakeSocket } from './helpers.js'
function service(t){const {state}=fixture(t),d=fakeDiscord();const s=new DiscordService({state,client:d.client,allowedUsers:['user'],log:()=>{}});state.put('binding','main',{channelId:'main',channelName:'test',kind:'codex'});return {s,state,...d}}
for (const kind of ['codex','claude']) test(`${kind}: flat mode routes existing threads, new questions and events to the parent without new cards or duplicate completion`,async t=>{
 const {s,state,makeMessage,sent}=service(t)
 state.put('binding','main',{channelId:'main',channelName:'test',kind})
 await s.receive(makeMessage({id:'1'}));const thread=state.get('task','1').threadId
 s.taskThreads=false
 await s.applyEvent({eventId:'working-flat',taskId:'1',status:'working',messageIds:['1'],text:'Work is continuing'})
 assert.equal(sent.at(-1).channelId,'main')
 await s.receive(makeMessage({id:'2',channelId:thread,content:'Please continue'}))
 await s.reply({id:'flat-reply',channelId:'main',replyToMessageId:'2',text:'Parent response'})
 assert.equal(sent.at(-1).channelId,'main');assert.equal(sent.at(-1).options.reply,undefined)
 await s.questions.create({id:'flat-question',channelId:'main',replyToMessageId:'2',questions:[{question:'Choose?',options:['Yes','No']}]})
 assert.equal(state.all('question').at(-1).targetChannelId,'main')
 s.questions.expire('1')
 const count=sent.length
 await s.applyEvent({eventId:'complete-flat',taskId:'1',status:'complete',messageIds:['1','2']})
 assert.equal(sent.length,count)
 await s.receive(makeMessage({id:'3',content:'A new request'}));await s.flush()
 assert.equal(state.get('task','3').threadId,undefined);assert.equal(state.get('task','3').cardId,undefined)
 assert.ok(state.get('overview','shared').messageId)
 await s.reply({id:'explicit-parent',channelId:'main',replyToMessageId:'3',text:'Direct answer'})
 assert.equal(sent.at(-1).channelId,'main');assert.equal(sent.at(-1).options.reply.messageReference,'3')
})
test('offline messages persist, get receipt reactions, and replay until durable bridge receipt',async t=>{
 const {s,state,makeMessage}=service(t),m=makeMessage({id:'1'});await s.receive(m)
 assert.equal(state.get('message','1').status,'received');assert.ok(m.reactions.cache.has('👀'))
 const socket=fakeSocket();s.register(socket,{channelId:'main',role:'codex_bridge'})
 assert.equal(socket.messages.filter(m=>m.type==='message').length,1)
 await s.handle(socket,{type:'received',id:'ack',channelId:'main',messageId:'1'})
 s.replay('main');assert.equal(socket.messages.filter(m=>m.type==='message').length,1)
 await s.receive(m);assert.equal(state.all('message').length,1)
})
test('task threads receive replies and follow-ups; explicit new tasks get their own threads',async t=>{
 const {s,state,makeMessage,sent}=service(t);await s.receive(makeMessage({id:'1'}))
 await s.applyEvent({eventId:'work',taskId:'1',status:'working',messageIds:['1']})
 const thread=state.get('task','1').threadId;assert.equal(thread,'thread-1')
 await s.reply({id:'reply',operationId:'reply',channelId:'main',text:'result'})
 assert.equal(sent.at(-1).channelId,thread)
 await s.receive(makeMessage({id:'2',channelId:thread,content:'also test'}))
 assert.equal(state.get('message','2').taskId,'1');assert.equal(state.get('message','2').mode,'steer')
 await s.receive(makeMessage({id:'3',channelId:thread,content:'!new another task'}))
 assert.equal(state.get('message','3').taskId,'3');assert.notEqual(state.get('task','3').threadId,thread)
})
test('late queue events cannot downgrade working/complete reactions',async t=>{
 const {s,state,makeMessage}=service(t);const m=makeMessage({id:'1'});await s.receive(m)
 await s.applyEvent({eventId:'w',taskId:'1',status:'working',messageIds:['1']})
 await s.applyEvent({eventId:'q',taskId:'1',status:'queued',messageIds:['1']})
 assert.equal(state.get('task','1').status,'working');assert.equal(state.get('message','1').status,'working')
 await s.applyEvent({eventId:'c',taskId:'1',status:'complete',messageIds:['1']})
 await s.applyEvent({eventId:'q2',taskId:'1',status:'queued',messageIds:['1']})
 assert.ok(m.reactions.cache.has('✅'));assert.equal(state.get('task','1').status,'complete')
})
test('a retry after Discord failure does not duplicate task milestones or outcomes',async t=>{
 const {s,state,makeMessage,client,sent}=service(t);await s.receive(makeMessage({id:'1'}))
 const ch=await client.channels.fetch('main'),send=ch.send;let first=true
 ch.send=async opts=>{if(first){first=false;throw Error('network')};return send(opts)}
 const e={eventId:'done',taskId:'1',status:'complete',milestone:'Tests passed'}
 await assert.rejects(s.applyEvent(e),/network/);await s.applyEvent(e);await s.applyEvent(e)
 assert.equal(state.get('task','1').milestones.filter(m=>m==='Tests passed').length,1)
 assert.equal(sent.filter(m=>m.content?.includes('— complete.')).length,1)
})
test('bot messages and unauthorized users do not enter the inbox',async t=>{
 const {s,state,makeMessage}=service(t);await s.receive(makeMessage({id:'1',bot:true}));await s.receive(makeMessage({id:'2',user:'intruder'}));assert.equal(state.all('message').length,0)
})
test('legacy Claude registration still receives its channel messages',async t=>{
 const {s,makeMessage}=service(t),socket=fakeSocket();s.register(socket,{channelId:'claude'})
 await s.receive(makeMessage({id:'1',channelId:'claude'}));assert.equal(socket.messages.at(-1).type,'message')
})
test('one Codex delivery owner is allowed per binding',t=>{
 const {s}=service(t),one=fakeSocket(),two=fakeSocket();s.register(one,{channelId:'main',role:'codex_bridge'});s.register(two,{channelId:'main',role:'codex_bridge'});assert.equal(two.destroyed,true);assert.equal(one.destroyed,false)
})
test('replies are chunked and deduplicated using their stable operation id',async t=>{
 const {s,sent}=service(t),msg={channelId:'main',operationId:'one',text:'x'.repeat(4100)}
 await s.reply(msg);await s.reply(msg);assert.equal(sent.length,3);assert.ok(sent.every(m=>m.content.length<=1900))
})
test('status card is created once, pinned, and edited as health changes',async t=>{
 const {s,state,sent}=service(t);s.dirty.add('binding:main');await s.flush()
 const b=state.get('binding','main'),card=sent.find(m=>m.id===b.statusId);assert.ok(card.pinned)
 s.dirty.add('binding:main');await s.flush();assert.equal(sent.length,1);assert.match(card.content,/offline/)
})

test('router restart recovers messages sent during downtime without replaying existing tasks',async t=>{
 const {s,state,makeMessage,client}=service(t)
 state.put('binding','main',{channelId:'main',kind:'codex',enabledAt:1})
 const first=makeMessage({id:'1'});await s.receive(first)
 const second=makeMessage({id:'2'});second.createdTimestamp=Date.now()
 const ch=await client.channels.fetch('main'),fetch=ch.messages.fetch
 ch.messages.fetch=async args=>typeof args==='string'?fetch(args):new Map([['1',first],['2',second]])
 await s.recoverMessages()
 assert.equal(state.all('message').length,2);assert.equal(state.get('message','2').status,'received')
 await s.recoverMessages();assert.equal(state.all('message').length,2)
})

test('explicit task/message ids cannot send, edit, react, or update progress across bindings',async t=>{
 const {s,state,makeMessage}=service(t);await s.receive(makeMessage({id:'1'}))
 state.put('binding','other',{channelId:'other',kind:'codex'})
 await assert.rejects(s.reply({channelId:'other',taskId:'1',text:'cross-talk'}),/different binding/)
 for(const type of ['progress','react','edit'])await assert.rejects(s.handle(fakeSocket(),{id:type,type,channelId:'other',taskId:'1',messageId:'1',text:'cross-talk',emoji:'👀'}),/different binding/)
})

for (const kind of ['codex','claude']) for (const status of ['complete','failed','interrupted']) {
 test(`${kind}: a ${status} thread resumes in place and preserves earlier message outcomes`,async t=>{
  const {s,state,makeMessage,sent}=service(t)
  state.put('binding','main',{channelId:'main',channelName:'test',kind})
  await s.receive(makeMessage({id:'1'}))
  await s.applyEvent({eventId:'finished',taskId:'1',status,messageIds:['1']})
  const thread=state.get('task','1').threadId
  const follow=makeMessage({id:'2',channelId:thread,content:'a related follow-up'})
  await s.receive(follow);await s.receive(follow)
  assert.equal(state.all('task').length,1)
  assert.equal(state.all('message').length,2)
  assert.equal(state.get('message','2').taskId,'1')
  assert.equal(state.get('message','2').mode,'steer')
  assert.equal(state.get('task','1').status,'received')
  assert.equal(state.get('task','1').threadId,thread)
  const socket=fakeSocket();s.register(socket,{channelId:'main',role:`${kind}_bridge`})
  assert.equal(socket.messages.filter(m=>m.type==='message'&&m.messageId==='2').length,1)
  await s.reply({id:'response',channelId:'main',replyToMessageId:'2',text:'Same conversation'})
  assert.equal(sent.at(-1).channelId,thread)
  await s.applyEvent({eventId:'resume',taskId:'1',status:'working',startedAt:Date.now(),messageIds:['2']})
  assert.equal(state.get('binding','main').currentTask,'1')
  const next=status==='complete'?'failed':'complete'
  await s.applyEvent({eventId:'finished-again',taskId:'1',status:next,messageIds:['2']})
  assert.equal(state.get('message','1').status,status)
  assert.equal(state.get('message','2').status,next)
  assert.equal(state.get('task','1').threadId,thread)
 })
}
test('a follow-up in a completed thread waits behind another active task without changing its binding',async t=>{
 const {s,state,makeMessage}=service(t)
 await s.receive(makeMessage({id:'1'}))
 await s.applyEvent({eventId:'done',taskId:'1',status:'complete'})
 const thread=state.get('task','1').threadId
 await s.receive(makeMessage({id:'2',content:'!new other work'}))
 await s.applyEvent({eventId:'other-working',taskId:'2',status:'working',messageIds:['2']})
 await s.receive(makeMessage({id:'3',channelId:thread,content:'follow up on the old work'}))
 assert.equal(state.get('message','3').taskId,'1')
 assert.equal(state.get('binding','main').currentTask,'2')
 assert.equal(state.get('task','1').status,'received')
})
test('explicit new work in a completed thread and parent-channel requests still create separate tasks',async t=>{
 const {s,state,makeMessage}=service(t)
 await s.receive(makeMessage({id:'1'}))
 await s.applyEvent({eventId:'done',taskId:'1',status:'complete'})
 const thread=state.get('task','1').threadId
 await s.receive(makeMessage({id:'2',channelId:thread,content:'!new separate work'}))
 assert.equal(state.get('message','2').taskId,'2')
 assert.notEqual(state.get('task','2').threadId,thread)
 assert.equal(state.get('task','1').status,'complete')
 await s.applyEvent({eventId:'done2',taskId:'2',status:'complete'})
 await s.receive(makeMessage({id:'3',content:'another request in the main channel'}))
 assert.equal(state.get('message','3').taskId,'3')
 assert.notEqual(state.get('task','3').threadId,thread)
})
