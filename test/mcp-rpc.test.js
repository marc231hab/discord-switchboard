import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as ipcServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CodexClient } from '../src/codex-client.js'
import { fixture } from './helpers.js'

test('MCP exposes artifact/progress/reaction/edit tools and downloads actual attachment bytes',async t=>{
 const {dir}=fixture(t),socketPath=join(dir,'router.sock'),requests=[]
 const server=ipcServer(socket=>{let buffer='';socket.on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);requests.push(msg);socket.write(JSON.stringify(msg.type==='register'?{type:'registered',channelId:'main'}:{type:msg.type==='reply'?'reply_result':'action_result',id:msg.id,messageId:'sent'})+'\n')}})})
 server.listen(socketPath);await once(server,'listening');t.after(()=>server.close())
 const transport=new StdioClientTransport({command:process.execPath,args:['src/channel.js'],env:{...process.env,HOME:dir,DISCORD_CHANNEL_ID:'main',DISCORD_INBOUND:'off',SOCKET_DIR:dir},stderr:'pipe'})
 const client=new Client({name:'test',version:'1.0'});await client.connect(transport);t.after(()=>client.close())
 assert.match(client.getInstructions(),/successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap/i)
 assert.match(client.getInstructions(),/After a progress update, continue the authorized work/i)
 assert.match(client.getInstructions(),/If delivery fails, recover before claiming it was sent/i)
 const names=(await client.listTools()).tools.map(t=>t.name);assert.deepEqual(names,['discord_reply','download_attachment','discord_progress','discord_react','discord_edit','discord_question','discord_question_cancel','discord_overview'])
 await new Promise(resolve=>setTimeout(resolve,50))
 const reply=await client.callTool({name:'discord_reply',arguments:{text:'Test',files:['/tmp/report.txt']}})
 assert.equal(reply.isError,undefined);assert.deepEqual(requests.find(r=>r.type==='reply').files,['/tmp/report.txt'])
 const question=await client.callTool({name:'discord_question',arguments:{questions:[{question:'Which approach?',options:['A','B']}],taskId:'1'}})
 assert.equal(question.isError,undefined);assert.equal(requests.find(r=>r.type==='question').taskId,'1')
 await client.callTool({name:'discord_question_cancel',arguments:{questionId:'question'}})
 assert.equal(requests.find(r=>r.type==='question_cancel').questionId,'question')
 await client.callTool({name:'discord_overview',arguments:{}})
 assert.equal(requests.find(r=>r.type==='overview').channelId,'main')
 const http=httpServer((req,res)=>{if(req.url==='/missing'){res.writeHead(404);res.end();return}res.end('attachment bytes')});http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>http.close())
 const base=`http://127.0.0.1:${http.address().port}`
 const download=await client.callTool({name:'download_attachment',arguments:{url:`${base}/file`,filename:'../../report.txt'}})
 assert.equal(download.isError,undefined);const path=download.content[0].text.replace('Downloaded to ','');assert.equal(readFileSync(path,'utf8'),'attachment bytes');assert.ok(path.startsWith(join(dir,'.claude/channels/discord/inbox')))
 assert.equal((await client.callTool({name:'download_attachment',arguments:{url:`${base}/missing`}})).isError,true)
})
test('Codex control initializes WebSocket transport and rejects pending requests on disconnect',async t=>{
 const {dir}=fixture(t),server=httpServer(),wss=new WebSocketServer({server}),methods=[]
 server.listen(join(dir,'codex.sock'));await once(server,'listening');t.after(()=>{wss.close();server.close()})
 wss.on('connection',socket=>socket.on('message',raw=>{const m=JSON.parse(raw);methods.push(m.method);if(m.method==='initialize')socket.send(JSON.stringify({id:m.id,result:{}}));if(m.method==='thread/read')socket.send(JSON.stringify({id:m.id,result:{thread:{id:'test'}}}));if(m.method==='turn/interrupt')socket.close()}))
 const c=new CodexClient(dir)
 // Use an actual Unix WebSocket connection, with the server's test socket path.
 const {default:WebSocket}=await import('ws');c.websocketFactory=()=>new WebSocket(`ws+unix://${join(dir,'codex.sock')}:/`)
 t.after(()=>c.close());assert.equal((await c.request('thread/read',{})).thread.id,'test');assert.deepEqual(methods.slice(0,3),['initialize','initialized','thread/read'])
 await assert.rejects(c.request('turn/interrupt',{}),/closed/)
 assert.equal(c.pending.size,0)
})
