#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { State } from './state.js'
import { RouterClient } from './router-client.js'
import { RolloutMonitor } from './rollout-monitor.js'
import { ClaudeController, claudeReadiness, seedClaudeForeground } from './claude-controller.js'
import { clip, terminalStates } from './presentation.js'
const exec = promisify(execFile)
const { DISCORD_CHANNEL_ID: channelId, TMUX_SESSION: tmuxSession, PROJECT_DIR: projectDir } = process.env
if (!channelId || !tmuxSession || !projectDir) throw new Error('Missing Claude bridge binding environment')
const channelName = process.env.CHANNEL_NAME || tmuxSession, home = process.env.HOME
const state = new State(join(home,'.claude/channels/discord/state',`${channelId}.sqlite`))
const logs = join(home,'.claude/channel-logs');mkdirSync(logs,{recursive:true})
const log = value => { const line=`[${channelName}] ${new Date().toISOString()} ${clip(value,300)}`;console.error(line);appendFileSync(join(logs,`${channelName}-bridge.log`),line+'\n') }
const router = new RouterClient(join(process.env.SOCKET_DIR || '/tmp/discord-agent-router','router.sock'),{role:'claude_bridge',engine:'claude',channelId,channelName})
const controller = new ClaudeController({state,channelId,channelName,projectDir,home:join(home,'.claude/channels/discord/state',channelId),log})
let registry,monitor,busy=false,flushing=false,heartbeatAt=0
async function resolveSession() {
 const {stdout:pane} = await exec('tmux',['display-message','-p','-t',`${tmuxSession}:claude`,'#{pane_id}'])
 const entries = readdirSync(join(home,'.claude/sessions')).filter(f=>f.endsWith('.json')).map(f=>{try{return JSON.parse(readFileSync(join(home,'.claude/sessions',f),'utf8'))}catch{return null}}).filter(Boolean)
 const entry=entries.find(e=>e.tmux?.split('.').at(-1)===pane.trim().replace(/^%/,'%') && e.kind==='interactive')
 if(!entry || entry.cwd !== projectDir) throw new Error('No Claude session registered to the bound pane')
 try {process.kill(entry.pid,0)}catch{throw new Error('Bound Claude session is not running')}
 return entry
}
controller.interrupt=async task=>{
 const current=await resolveSession()
 if(current.sessionId!==registry.sessionId)throw new Error('Session changed; refresh Status before stopping')
 if(current.status!=='idle')await exec('tmux',['send-keys','-t',`${tmuxSession}:claude`,'Escape'])
}
async function flush(){
 if(flushing || !router.socket || router.socket.connecting)return
 flushing=true
 try{for(const e of state.all('outbox')){await router.request(e);state.delete('outbox',e.eventId)}}catch(e){log(e.message)}finally{flushing=false}
}
router.on('message',msg=>{
 if(msg.type==='message'){controller.receive(msg);router.request({type:'received',channelId,messageId:msg.messageId}).catch(e=>log(e.message))}
 if(msg.type==='control')controller.control(msg.action,msg.taskId,msg.argument).then(result=>router.send({type:'control_result',id:msg.id,...result})).catch(e=>router.send({type:'control_result',id:msg.id,text:`Control failed: ${clip(e.message)}`}))
})
router.on('connectionError',e=>log(e.message));router.on('disconnected',()=>log('Router disconnected; preserving pending delivery'))
async function tick(){
 if(busy)return;busy=true
 try{
  const current=await resolveSession()
  const transcriptPath=join(home,'.claude/projects',projectDir.replace(/[^a-zA-Z0-9]/g,'-'),`${current.sessionId}.jsonl`)
  if(!registry || registry.sessionId!==current.sessionId || !monitor && existsSync(transcriptPath)){
   if(controller.active())controller.finish(controller.active(),'interrupted',`session-ended:${controller.active().id}`,'Claude session was restarted')
   registry=current;controller.session.threadId=current.sessionId;controller.save()
   const path=transcriptPath
   const first=!state.get('cursor',path)
   if(existsSync(path) && (controller.session.foreground?.version!==1 || controller.session.foreground.sessionId!==current.sessionId || controller.session.toolResultsVersion!==1)){
    const file=readFileSync(path),cursor=state.get('cursor',path)
    const consumed=cursor?.inode===statSync(path).ino && Number.isSafeInteger(cursor.offset) && cursor.offset>=0 && cursor.offset<=file.length ? cursor.offset : 0
    seedClaudeForeground(controller.session,file.subarray(0,consumed).toString('utf8'));controller.save()
   }
   monitor=existsSync(path)?new RolloutMonitor(path,state,(record,key)=>controller.transcript(record,key)):null
   if(!monitor){controller.session.freshTranscript=true;controller.save()}
   if(first && monitor && !controller.session.freshTranscript){controller.bootstrapping=true;do{const before=state.get('cursor',path)?.offset;await monitor.poll();if(state.get('cursor',path)?.offset===before)break}while(true);controller.bootstrapping=false
    const t=controller.active();if(t?.taskId && current.status!=='idle'){state.insert('outbox',`adopt:${t.taskId}`,{type:'adopt',channelId,taskId:t.taskId,eventId:`adopt:${t.taskId}`})}else if(t && current.status==='idle'){t.status='complete';controller.session.activeTurnId=null;controller.save()}}
   if(monitor){controller.session.freshTranscript=false;controller.save()}
  }
  registry=current;if(monitor)await monitor.poll();await flush()
  const inbox=state.all('inbox')
  for(const input of inbox.filter(i=>i.status==='received' || i.status==='uncertain')){
   if(input.retryAfter>Date.now())continue
   const readiness=claudeReadiness(current,controller.session,controller.active())
   // A follow-up can reach the native channel while unrelated foreground work
   // is busy. Deliver its held original first, so "Update?" never replaces the
   // actual request. Unrelated new tasks and uncertain retries still wait.
   const continuingTask=controller.active()?.taskId===input.taskId || inbox.some(i=>
    i.taskId===input.taskId && i.mode==='steer' && ['received','uncertain','queued','working'].includes(i.status))
   if(input.mode==='new' && !readiness.newTaskReady && !continuingTask)continue
   // The transcript is checked before replaying an interrupted MCP delivery.
   if(input.status==='uncertain' && !readiness.newTaskReady)continue
   input.status='uncertain';input.deliveredSession=current.sessionId;state.put('inbox',input.messageId,input)
   try{await router.request({type:'notify',channelId,messageId:input.messageId,taskId:input.taskId,payload:input})
    const saved=state.get('inbox',input.messageId)
    if(saved.status==='uncertain'){input.status='queued';input.queuedAt=Date.now();state.put('inbox',input.messageId,input);controller.emit({eventId:`queued:${input.messageId}`,taskId:input.taskId,status:'queued',messageIds:[input.messageId],activity:'Delivered to Claude; waiting for incorporation'})}
   }catch(e){input.retryAfter=Date.now()+15000;state.put('inbox',input.messageId,input);log(e.message)}
  }
  // A previously delivered notification may have been lost with a crashed session.
  for(const input of state.all('inbox').filter(i=>i.status==='queued' && (i.deliveredSession!==current.sessionId || current.status==='idle' && Date.now()-(i.queuedAt||Date.now())>60000))){input.status='received';state.put('inbox',input.messageId,input)}
  if(Date.now()-heartbeatAt>15000){
   const readiness=claudeReadiness(current,controller.session,controller.active())
   const pendingNewRequests=state.all('inbox').filter(i=>i.mode==='new'&&['received','uncertain'].includes(i.status)).length
   const activity=readiness.activity+(!readiness.newTaskReady&&pendingNewRequests?`; ${pendingNewRequests} new request(s) queued`:'')
   await router.request({type:'binding',channelId,binding:{kind:'claude',engine:'claude',channelName,projectDir,tmuxSession,codexThreadId:current.sessionId,model:controller.session.model,effort:controller.session.effort,health:'healthy',currentTask:controller.active()?.taskId||null,...readiness,pendingNewRequests,activity}});heartbeatAt=Date.now()
  }
 }catch(e){controller.bootstrapping=false;log(e.message);if(Date.now()-heartbeatAt>15000){await router.request({type:'binding',channelId,binding:{kind:'claude',engine:'claude',channelName,projectDir,tmuxSession,health:clip(e.message),activity:'Waiting for the Claude session'}}).catch(()=>{});heartbeatAt=Date.now()}}
 finally{busy=false}
}
router.start();const timer=setInterval(tick,1000);tick()
function shutdown(){clearInterval(timer);router.close();state.close();process.exit(0)}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
