import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdirSync,writeFileSync,appendFileSync,statSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fixture} from './helpers.js'
import {State} from '../src/state.js'

test('an empty Claude session receives its first notification and reports its first completion',async t=>{
 const {dir}=fixture(t),project=join(dir,'project'),socketDir=join(dir,'socket'),bin=join(dir,'bin')
 for(const p of [project,socketDir,bin,join(dir,'.claude/sessions')])mkdirSync(p,{recursive:true})
 writeFileSync(join(bin,'tmux'),'#!/bin/sh\nprintf "%s\\n" "%test"\n',{mode:0o700})
 writeFileSync(join(dir,'.claude/sessions','session.json'),JSON.stringify({pid:process.pid,sessionId:'session',cwd:project,tmux:'cc-test:@1.%test',kind:'interactive',status:'idle'}))
 const rows=[];let socket
 const server=createServer(s=>{socket=s;let buffer='';s.on('data',d=>{buffer+=d;let at;while((at=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);rows.push(m);s.write(JSON.stringify(m.type==='register'?{type:'registered',channelId:'main'}:{type:'action_result',id:m.id})+'\n')}})})
 server.listen(join(socketDir,'router.sock'));await once(server,'listening');t.after(()=>server.close())
 const child=spawn(process.execPath,['--no-warnings','src/claude-bridge.js'],{cwd:resolve('.'),env:{...process.env,HOME:dir,PATH:bin+':'+process.env.PATH,DISCORD_CHANNEL_ID:'main',TMUX_SESSION:'cc-test',PROJECT_DIR:project,SOCKET_DIR:socketDir},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',d=>errors+=d);t.after(()=>child.kill())
 async function until(check){for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,100))}assert.fail('Bridge condition timed out: '+errors)}
 await until(()=>rows.some(m=>m.type==='binding'))
 socket.write(JSON.stringify({type:'message',messageId:'1',taskId:'1',mode:'new',content:'fix',channelId:'main',authorName:'user'})+'\n')
 await until(()=>rows.some(m=>m.type==='notify'))
 const transcriptDir=join(dir,'.claude/projects',project.replace(/[^a-zA-Z0-9]/g,'-'));mkdirSync(transcriptDir,{recursive:true})
 const records=[{type:'attachment',uuid:'turn',timestamp:new Date().toISOString(),attachment:{type:'queued_command',origin:{kind:'channel'},prompt:'<channel channelId="main" messageId="1">fix</channel>'}},{type:'assistant',message:{model:'claude',stop_reason:'end_turn',content:[{type:'thinking',thinking:'PRIVATE'},{type:'text',text:'Fixed the build'}]}}]
 writeFileSync(join(transcriptDir,'session.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n')
 await until(()=>rows.some(m=>m.type==='event'&&m.status==='complete'))
 assert.ok(rows.some(m=>m.type==='event'&&m.status==='working'&&m.messageIds?.includes('1')))
 assert.ok(rows.some(m=>m.type==='event'&&m.text==='Fixed the build'));assert.ok(!JSON.stringify(rows).includes('PRIVATE'))
})

test('completed foreground with two background shells delivers queued work and reports readiness honestly',async t=>{
 const {dir}=fixture(t),project=join(dir,'project'),socketDir=join(dir,'socket'),bin=join(dir,'bin')
 for(const p of [project,socketDir,bin,join(dir,'.claude/sessions')])mkdirSync(p,{recursive:true})
 writeFileSync(join(bin,'tmux'),'#!/bin/sh\nprintf "%s\\n" "%test"\n',{mode:0o700})
 writeFileSync(join(dir,'.claude/sessions','session.json'),JSON.stringify({pid:process.pid,sessionId:'session',cwd:project,
  tmux:'cc-test:@1.%test',kind:'interactive',status:'shell',startedAt:100}))
 const transcriptDir=join(dir,'.claude/projects',project.replace(/[^a-zA-Z0-9]/g,'-'));mkdirSync(transcriptDir,{recursive:true})
 const records=[{type:'attachment',uuid:'finished-turn',timestamp:new Date().toISOString(),attachment:{type:'queued_command',origin:{kind:'channel'},prompt:'<channel channelId="main" messageId="1">earlier request</channel>'}},
  {type:'assistant',message:{content:[{type:'tool_use',id:'monitor-a',name:'Bash',input:{run_in_background:true,command:'background monitor A'}},
   {type:'tool_use',id:'monitor-b',name:'Bash',input:{run_in_background:true,command:'background monitor B'}}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'monitor-a',content:'Command running in background with ID: task-a'},
   {type:'tool_result',tool_use_id:'monitor-b',content:'Command running in background with ID: task-b'}]}},
  {type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Foreground finished; monitors remain running'}]}}]
 writeFileSync(join(transcriptDir,'session.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n')
 const rows=[];let socket
 const server=createServer(s=>{socket=s;let buffer='';s.on('data',d=>{buffer+=d;let at;while((at=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);rows.push(m);s.write(JSON.stringify(m.type==='register'?{type:'registered',channelId:'main'}:{type:'action_result',id:m.id})+'\n')}})})
 server.listen(join(socketDir,'router.sock'));await once(server,'listening');t.after(()=>server.close())
 const child=spawn(process.execPath,['--no-warnings','src/claude-bridge.js'],{cwd:resolve('.'),env:{...process.env,HOME:dir,PATH:bin+':'+process.env.PATH,DISCORD_CHANNEL_ID:'main',TMUX_SESSION:'cc-test',PROJECT_DIR:project,SOCKET_DIR:socketDir},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',d=>errors+=d);t.after(()=>child.kill())
 async function until(check){for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,100))}assert.fail('Bridge condition timed out: '+errors)}
 await until(()=>rows.some(m=>m.type==='binding'))
 const binding=rows.find(m=>m.type==='binding').binding
 assert.equal(binding.newTaskReady,true);assert.equal(binding.registryStatus,'shell');assert.equal(binding.backgroundShells,true)
 assert.equal(binding.foregroundCompletedInSession,true);assert.equal(binding.pendingTools,0)
 assert.match(binding.activity,/Ready.*background shells/)
 const registryFile=join(dir,'.claude/sessions','session.json')
 const registry={pid:process.pid,sessionId:'session',cwd:project,tmux:'cc-test:@1.%test',kind:'interactive',startedAt:100}
 writeFileSync(registryFile,JSON.stringify({...registry,status:'busy'}))
 await new Promise(r=>setTimeout(r,1200))
 socket.write(JSON.stringify({type:'message',messageId:'2',taskId:'2',mode:'new',content:'next request',channelId:'main'})+'\n')
 await until(()=>rows.some(m=>m.type==='received'&&m.messageId==='2'))
 await new Promise(r=>setTimeout(r,1200))
 assert.equal(rows.filter(m=>m.type==='notify'&&m.messageId==='2').length,0,'foreground work must keep the request queued')
 writeFileSync(registryFile,JSON.stringify({...registry,status:'waiting',waitingFor:'permission prompt'}))
 await new Promise(r=>setTimeout(r,1200))
 assert.equal(rows.filter(m=>m.type==='notify'&&m.messageId==='2').length,0,'approval must keep the request queued')
 writeFileSync(registryFile,JSON.stringify({...registry,status:'shell'}))
 await until(()=>rows.some(m=>m.type==='notify'&&m.messageId==='2'))
 assert.equal(rows.filter(m=>m.type==='notify'&&m.messageId==='2').length,1)
})

const foreground = (type,at,message={},extra={}) => ({type,timestamp:new Date(at).toISOString(),sessionId:'session',message,...extra})
async function busyBridge(t,history,{upgrade=false,tools={},foregroundState}={}) {
 const {dir}=fixture(t),project=join(dir,'project'),socketDir=join(dir,'socket'),bin=join(dir,'bin')
 for(const p of [project,socketDir,bin,join(dir,'.claude/sessions')])mkdirSync(p,{recursive:true})
 writeFileSync(join(bin,'tmux'),'#!/bin/sh\nprintf "%s\\n" "%test"\n',{mode:0o700})
 const registryFile=join(dir,'.claude/sessions','session.json')
 const registry={pid:process.pid,sessionId:'session',cwd:project,tmux:'cc-test:@1.%test',kind:'interactive',status:'busy',startedAt:100,statusUpdatedAt:1000,updatedAt:1000}
 writeFileSync(registryFile,JSON.stringify(registry))
 const transcriptDir=join(dir,'.claude/projects',project.replace(/[^a-zA-Z0-9]/g,'-'));mkdirSync(transcriptDir,{recursive:true})
 const path=join(transcriptDir,'session.jsonl')
 writeFileSync(path,history.map(r=>JSON.stringify(r)).join('\n')+'\n')
 const state=new State(join(dir,'.claude/channels/discord/state/main.sqlite'));t.after(()=>state.close())
 if(upgrade){
  state.put('session','current',{threadId:'session',activeTurnId:null,tools,foreground:foregroundState,turns:{old:{id:'old',taskId:'old',status:'complete',startedAt:1100}},freshTranscript:false})
  state.put('cursor',path,{offset:statSync(path).size,inode:statSync(path).ino})
 }
 const rows=[];let socket
 const server=createServer(s=>{socket=s;let buffer='';s.on('data',d=>{buffer+=d;let at;while((at=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);rows.push(m);s.write(JSON.stringify(m.type==='register'?{type:'registered',channelId:'main'}:{type:'action_result',id:m.id})+'\n')}})})
 server.listen(join(socketDir,'router.sock'));await once(server,'listening');t.after(()=>server.close())
 const child=spawn(process.execPath,['--no-warnings','src/claude-bridge.js'],{cwd:resolve('.'),env:{...process.env,HOME:dir,PATH:bin+':'+process.env.PATH,DISCORD_CHANNEL_ID:'main',TMUX_SESSION:'cc-test',PROJECT_DIR:project,SOCKET_DIR:socketDir},stdio:['ignore','ignore','pipe']})
 let errors='';child.stderr.on('data',d=>errors+=d);t.after(()=>child.kill())
 async function until(check){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,100))}assert.fail('Bridge condition timed out: '+errors)}
 await until(()=>rows.some(m=>m.type==='binding'))
 return {rows,state,registry,registryFile,path,transcriptDir,until,
  append:records=>appendFileSync(path,records.map(r=>JSON.stringify(r)).join('\n')+'\n'),
  send:(id,mode='new',taskId=id)=>socket.write(JSON.stringify({type:'message',messageId:id,taskId,mode,content:'fixture request',channelId:'main'})+'\n')}
}

test('an existing foreground observer upgrades completed tool bookkeeping and delivers held requests once',async t=>{
 const b=await busyBridge(t,[foreground('user',1300,{content:[{type:'tool_result',tool_use_id:'closed',content:'PRIVATE historic output'}]}),
  foreground('assistant',1400,{stop_reason:'end_turn',content:[{type:'text',text:'PRIVATE old answer'}]})],
  {upgrade:true,tools:{closed:{name:'Bash',label:'PRIVATE historic command'}},
   foregroundState:{version:1,sessionId:'session',phase:'complete',tools:{},lastAt:1400,completedAt:1400}})
 const first=b.rows.find(m=>m.type==='binding').binding
 assert.equal(first.newTaskReady,true);assert.equal(first.pendingTools,0)
 assert.equal(b.state.get('session','current').toolResultsVersion,1)
 assert.deepEqual(b.state.get('session','current').tools,{})
 b.send('9');await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='9'))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='9').length,1)
 assert.equal(b.rows.filter(m=>m.type==='event'&&!m.eventId?.startsWith('queued:')).length,0)
 assert.ok(!JSON.stringify(b.rows).includes('PRIVATE'),'history migration must not relay old content')
})

test('delegated busy with completed non-channel foreground delivers once, and new work or approval revokes it',async t=>{
 const b=await busyBridge(t,[foreground('user',1100,{content:'PRIVATE local request'}),
  foreground('assistant',1200,{content:[{type:'tool_use',id:'launch-agent',name:'Agent',input:{run_in_background:true,prompt:'PRIVATE delegate'}}]}),
  foreground('user',1300,{content:[{type:'tool_result',tool_use_id:'launch-agent',content:'PRIVATE background agent handle'}]}),
  foreground('assistant',1400,{stop_reason:'end_turn',content:[{type:'text',text:'PRIVATE foreground finished'}]})])
 const first=b.rows.find(m=>m.type==='binding').binding
 assert.equal(first.registryStatus,'busy');assert.equal(first.newTaskReady,true);assert.equal(first.completedAfterBusy,true)
 assert.equal(first.foregroundPhase,'complete');assert.equal(first.foregroundTools,0)
 b.send('2');await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='2'))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='2').length,1)
 b.append([foreground('user',1500,{content:'PRIVATE background-triggered main request'}),
  foreground('assistant',1600,{content:[{type:'tool_use',id:'question',name:'AskUserQuestion',input:{question:'PRIVATE'}}]})])
 await b.until(()=>b.state.get('session','current')?.foreground.tools.question)
 b.send('3');await b.until(()=>b.rows.some(m=>m.type==='received'&&m.messageId==='3'))
 await b.until(()=>b.rows.some(m=>m.type==='binding'&&m.binding.foregroundPhase==='working'))
 const blocked=b.rows.filter(m=>m.type==='binding').at(-1).binding
 assert.equal(blocked.newTaskReady,false);assert.equal(blocked.foregroundTools,1)
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='3').length,0)
 writeFileSync(b.registryFile,JSON.stringify({...b.registry,status:'waiting',waitingFor:'permission'}))
 b.append([foreground('user',1700,{content:[{type:'tool_result',tool_use_id:'question',content:'PRIVATE reply'}]}),
  foreground('system',1800,{}, {subtype:'turn_duration'})])
 await b.until(()=>b.state.get('session','current')?.foreground.completedAt===1800)
 await new Promise(r=>setTimeout(r,1200))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='3').length,0,'native approval remains authoritative')
 writeFileSync(b.registryFile,JSON.stringify({...b.registry,statusUpdatedAt:1800,updatedAt:9000}))
 await new Promise(r=>setTimeout(r,1200))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='3').length,0,'completion must follow the latest native status')
 b.append([foreground('assistant',1900,{stop_reason:'end_turn',content:[]})])
 await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='3'))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='3').length,1)
 assert.ok(!JSON.stringify(b.state.get('session','current').foreground).includes('PRIVATE'))
 assert.equal(b.rows.filter(m=>m.type==='event'&&!m.eventId?.startsWith('queued:')).length,0,'foreground-only observation emits no task events beyond real delivery acknowledgements')
})

test('an upgrade seeds only consumed foreground metadata without replay, and old-session completion cannot unlock a restart',async t=>{
 const b=await busyBridge(t,[foreground('user',1100,{content:'<channel channelId="main" messageId="1">PRIVATE past request</channel>'}),
  foreground('assistant',1200,{content:[{type:'tool_use',id:'sent',name:'mcp__custom_discord__discord_reply',input:{text:'PRIVATE old reply'}}]}),
  foreground('user',1300,{content:[{type:'tool_result',tool_use_id:'sent',content:'PRIVATE sent'}]}),
  foreground('assistant',1400,{stop_reason:'end_turn',content:[{type:'text',text:'PRIVATE final'}]})],{upgrade:true})
 assert.equal(b.rows.find(m=>m.type==='binding').binding.newTaskReady,true)
 assert.equal(b.rows.filter(m=>m.type==='event').length,0)
 assert.equal(b.state.all('inbox').length,0);assert.equal(b.state.all('public_hash').length,0)
 assert.deepEqual(Object.keys(b.state.get('session','current').turns),['old'])
 assert.equal(b.state.get('cursor',b.path).offset,statSync(b.path).size)
 b.send('4');await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='4'))
 writeFileSync(b.registryFile,JSON.stringify({...b.registry,sessionId:'restart',startedAt:2000,statusUpdatedAt:2100,updatedAt:2100}))
 await b.until(()=>b.state.get('session','current').threadId==='restart')
 b.send('5');await b.until(()=>b.rows.some(m=>m.type==='received'&&m.messageId==='5'))
 await new Promise(r=>setTimeout(r,1200))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='5').length,0)
 writeFileSync(join(b.transcriptDir,'restart.jsonl'),[foreground('user',2200,{content:'PRIVATE restarted foreground'},{sessionId:'restart'}),
  foreground('assistant',2300,{stop_reason:'end_turn',content:[]},{sessionId:'restart'})].map(r=>JSON.stringify(r)).join('\n')+'\n')
 await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='5'))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='5').length,1)
 assert.equal(b.rows.filter(m=>m.type==='event'&&!m.eventId?.startsWith('queued:')).length,0)
})

test('a follow-up delivers its held original before Update while unrelated requests stay queued',async t=>{
 const b=await busyBridge(t,[])
 b.send('6');await b.until(()=>b.state.get('inbox','6')?.status==='received')
 b.send('8');await b.until(()=>b.state.get('inbox','8')?.status==='received')
 b.send('7','steer','6');await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='7'))
 assert.deepEqual(b.rows.filter(m=>m.type==='notify').map(m=>m.messageId),['6','7'])
 b.append([foreground('user',1100,{content:'<channel channelId="main" messageId="6">original request</channel>'},{uuid:'original-turn'}),
  foreground('user',1150,{content:'<channel channelId="main" messageId="7">fixture steer</channel>'},{uuid:'steered-turn'}),
  foreground('assistant',1200,{stop_reason:'end_turn',content:[]})])
 await b.until(()=>b.state.get('inbox','6')?.status==='complete')
 await b.until(()=>b.rows.some(m=>m.type==='notify'&&m.messageId==='8'))
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='6').length,1)
 assert.equal(b.rows.filter(m=>m.type==='notify'&&m.messageId==='7').length,1)
 assert.equal(b.state.get('inbox','6').turnId,'original-turn')
 assert.equal(b.state.get('inbox','6').completionByTaskTurnId,undefined)
})
