import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fixture } from './helpers.js'

function protocol(text) {
 assert.match(text,/successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap/i)
 assert.match(text,/After a progress update, continue the authorized work/i)
 assert.match(text,/If delivery fails, recover before claiming it was sent/i)
}

function launchFixture(t) {
 const {dir}=fixture(t),bin=join(dir,'bin'),project=join(dir,'project'),global=join(dir,'global.env'),channel=join(dir,'channel.env'),codexHome=join(dir,'codex')
 mkdirSync(bin);mkdirSync(project);writeFileSync(global,'# Test environment only\n')
 writeFileSync(channel,`PROJECT_DIR=${project}\nCODEX_HOME=${codexHome}\nTMUX_SESSION=protocol-test\nDISCORD_CHANNEL_ID=main\n`)
 const executable=(name,body)=>writeFileSync(join(bin,name),'#!/bin/sh\n'+body+'\n',{mode:0o700})
 return {dir,global,channel,codexHome,executable,env:{...process.env,HOME:dir,PATH:bin+':'+process.env.PATH}}
}

test('the Codex launcher injects final-only turn completion into its generated configuration',t=>{
 const f=launchFixture(t)
 f.executable('tmux','if [ "$1" = has-session ]; then exit 1; fi\nexit 0')
 f.executable('systemd-run','exit 0');f.executable('systemctl','exit 0')
 execFileSync('bash',[resolve('scripts/start-codex-channel.sh'),f.global,f.channel],{env:f.env,stdio:'pipe'})
 const config=readFileSync(join(f.codexHome,'config.toml'),'utf8')
 protocol(config);assert.match(config,/developer_instructions = """/)
 assert.match(config,/custom_discord discord_reply/)
})

test('the Claude launcher appends the final-only protocol without replacing the default system prompt',t=>{
 const f=launchFixture(t),capture=join(f.dir,'claude-args')
 f.executable('claude','if [ "$1" = mcp ]; then exit 0; fi\nprintf "%s\\0" "$@" > "$PROTOCOL_CAPTURE"')
 execFileSync('bash',[resolve('scripts/run-claude.sh'),f.global,f.channel],{env:{...f.env,PROTOCOL_CAPTURE:capture},stdio:'pipe'})
 const args=readFileSync(capture,'utf8').split('\0'),at=args.indexOf('--append-system-prompt')
 assert.notEqual(at,-1);protocol(args[at+1])
 assert.ok(!args.includes('--system-prompt'))
 assert.ok(args.includes('--dangerously-load-development-channels'))
})
