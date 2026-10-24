import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { State } from '../src/state.js'
import { RolloutMonitor } from '../src/rollout-monitor.js'
import { redact, splitText, stableId, commandLabel } from '../src/presentation.js'
import { fixture } from './helpers.js'

test('durable inbox survives a reopen and refuses duplicate inserts', t => {
 const {dir,state}=fixture(t); assert.equal(state.insert('message','1',{body:'first'}),true)
 assert.equal(state.insert('message','1',{body:'duplicate'}),false)
 const other=new State(join(dir,'state.sqlite')); assert.deepEqual(other.get('message','1'),{body:'first'});other.close()
})
test('monitor waits for complete UTF-8 JSONL records and resumes at the byte offset', async t => {
 const {dir,state}=fixture(t),path=join(dir,'rollout.jsonl'), rows=[]
 const bytes=Buffer.from(JSON.stringify({payload:{content:'👀 café'}})+'\n')
 writeFileSync(path,bytes.subarray(0,bytes.length-3))
 const m=new RolloutMonitor(path,state,async r=>rows.push(r));await m.poll();assert.equal(rows.length,0)
 appendFileSync(path,bytes.subarray(bytes.length-3));await m.poll();assert.equal(rows[0].payload.content,'👀 café')
 await new RolloutMonitor(path,state,async()=>assert.fail('replayed consumed record')).poll()
})
test('monitor retries a record whose handler failed before cursor commit', async t => {
 const {dir,state}=fixture(t),path=join(dir,'r.jsonl');writeFileSync(path,'{"ok":true}\n')
 await assert.rejects(new RolloutMonitor(path,state,async()=>{throw Error('crash')}).poll(),/crash/)
 let count=0;await new RolloutMonitor(path,state,async()=>count++).poll();assert.equal(count,1)
})
test('presentation redacts credentials and never publishes shell script arguments',()=>{
 const text=redact('DISCORD_BOT_TOKEN=super-secret-value authorization: Bearer abc.def.ghi api_key="123456"')
 assert.ok(!text.includes('super-secret-value'));assert.ok(!text.includes('123456'))
 assert.ok(!text.includes('abc.def.ghi'))
 assert.ok(!redact('{"api_key": "opaque-secret"} Authorization: Bearer another-secret').includes('opaque-secret'))
 assert.ok(!redact('Authorization: Bearer another-secret').includes('another-secret'))
 assert.equal(commandLabel({command:"/bin/bash -lc 'export DISCORD_BOT_TOKEN=secret; npm test'"}),'Run export')
 assert.equal(commandLabel({command:['/bin/bash','-lc','npm test']}),'Run npm test')
 assert.equal(splitText('a'.repeat(4000)).length,3)
 assert.equal(stableId('id'),stableId('id'));assert.notEqual(stableId('id'),stableId('other'))
})
