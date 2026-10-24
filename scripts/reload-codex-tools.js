import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { State } from '../src/state.js'
import { CodexClient } from '../src/codex-client.js'
const exec=promisify(execFile),root=dirname(dirname(fileURLToPath(import.meta.url)))
const [envPath,mode]=process.argv.slice(2)
if(!envPath)throw new Error('Provide a Codex channel env file')
const script='set -e\nset -a\nsource "$1"\nnode -e \'process.stdout.write(JSON.stringify(Object.fromEntries(["CODEX_HOME","TMUX_SESSION","PROJECT_DIR"].map(k=>[k,process.env[k]]))))\''
const {stdout}=await exec('bash',['-c',script,'reload',envPath]),c=JSON.parse(stdout)
if(!c.CODEX_HOME || !c.TMUX_SESSION || !c.PROJECT_DIR)throw new Error('Incomplete Codex channel configuration')
const state=new State(join(c.CODEX_HOME,'discord-bridge.sqlite'))
const id=state.get('session','current')?.threadId;state.close()
if(!id)throw new Error('The bridge has not resolved its session yet')
const client=new CodexClient(c.CODEX_HOME)
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'"
try{
 let idle=false
 for(let n=0;n<(mode==='--wait'?14400:1);n++){
  const {thread}=await client.request('thread/read',{threadId:id,includeTurns:false})
  const {data}=await client.request('thread/queue/list',{threadId:id})
  if(thread.status.type==='idle' && !data.length){idle=true;break}
  if(mode!=='--wait')break
  await new Promise(r=>setTimeout(r,3000))
 }
 if(!idle){console.log('Deferred tool refresh for active session:',c.TMUX_SESSION);process.exitCode=2}
 else{
  const cmd=['bash',join(root,'scripts/run-codex.sh'),join(root,'config/global.env'),envPath,id].map(quote).join(' ')
  await exec('tmux',['respawn-pane','-k','-t',`${c.TMUX_SESSION}:codex`,cmd])
  console.log('Refreshed Discord tools:',c.TMUX_SESSION)
 }
}finally{client.close()}
