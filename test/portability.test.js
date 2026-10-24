import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fixture } from './helpers.js'
import { grokTransport } from '../src/grok-client.js'

test('Grok works locally or over a configurable, shell-quoted SSH transport', () => {
  assert.deepEqual(grokTransport(), { command: 'grok', args: ['agent', '--leader', 'stdio'] })
  const remote = grokTransport({ host: 'user@example.invalid', binary: '/opt/agent tools/grok' })
  assert.equal(remote.command, 'ssh')
  assert.equal(remote.args[0], 'user@example.invalid')
  assert.match(remote.args[1], /^exec '\/opt\/agent tools\/grok'/)
  assert.deepEqual(grokTransport({ host: 'host', transport: 'tailscale' }).args.slice(0, 2), ['ssh', 'host'])
  assert.throws(() => grokTransport({ host: 'host', transport: 'unknown' }), /GROK_TRANSPORT/)
})

test('Codex config honors the configured socket and leaves the model to the native CLI', t => {
  const { dir } = fixture(t), bin = join(dir, 'bin'), project = join(dir, 'sample project'), home = join(dir, 'codex')
  mkdirSync(bin); mkdirSync(project)
  const global = join(dir, 'global.env'), channel = join(dir, 'channel.env'), socket = join(dir, 'custom-socket')
  writeFileSync(global, `SOCKET_DIR=${JSON.stringify(socket)}\nCODEX_MODEL=\nCODEX_EFFORT=\n`)
  writeFileSync(channel, `PROJECT_DIR=${JSON.stringify(project)}\nCODEX_HOME=${home}\nTMUX_SESSION=portable-test\nDISCORD_CHANNEL_ID=example-channel\n`)
  for (const [name, script] of Object.entries({ tmux: 'if [ "$1" = has-session ]; then exit 1; fi\nexit 0', 'systemd-run': 'exit 0', systemctl: 'exit 0' }))
    writeFileSync(join(bin, name), '#!/bin/sh\n'+script+'\n', { mode: 0o700 })
  execFileSync('bash', [resolve('scripts/start-codex-channel.sh'), global, channel], { env: { ...process.env, HOME: dir, PATH: bin+':'+process.env.PATH }, stdio: 'pipe' })
  const config = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.ok(config.includes(`SOCKET_DIR = ${JSON.stringify(socket)}`))
  assert.ok(config.includes(`[projects.${JSON.stringify(project)}]`))
  assert.doesNotMatch(config, /^model\s*=/m)
})

test('Codex approvals stay native by default, with an explicit unattended opt-in', t => {
  const { dir } = fixture(t), bin = join(dir, 'bin'), capture = join(dir, 'args.json')
  mkdirSync(bin)
  writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.ARGV_CAPTURE,JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 })
  const global = join(dir, 'global.env'), channel = join(dir, 'channel.env')
  writeFileSync(global, '# Fixture\n'); writeFileSync(channel, `PROJECT_DIR=${JSON.stringify(join(dir, 'sample project'))}\n`)
  const env = { ...process.env, PATH: bin+':'+process.env.PATH, ARGV_CAPTURE: capture, AGENT_UNATTENDED: 'off' }
  const run = () => execFileSync('bash', [resolve('scripts/run-codex.sh'), global, channel, 'example-session'], { env })
  run(); let args = JSON.parse(readFileSync(capture, 'utf8'))
  assert.equal(args[0], 'resume'); assert.ok(args.includes(join(dir, 'sample project')))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
  env.AGENT_UNATTENDED='on'; run(); args=JSON.parse(readFileSync(capture, 'utf8'))
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('all example environment files parse without containing real configuration', () => {
  for (const name of readdirSync('config').filter(p => p.endsWith('.example')))
    execFileSync('bash', ['-n', join('config', name)])
})

test('OpenCode setup can source its environment directly without a caller root variable', t => {
  const { dir } = fixture(t), global = join(dir, 'global.env'), channel = join(dir, 'channel.env'), password = join(dir, 'password')
  writeFileSync(global, 'EXAMPLE_GLOBAL_FLAG=ready\n')
  writeFileSync(password, 'fixture-password', { mode: 0o600 })
  writeFileSync(channel, `OPENCODE_PASSWORD_FILE=${JSON.stringify(password)}\nOPENCODE_CONFIG=\n`)
  const result = execFileSync('bash', ['-eu', '-c', 'unset ROOT_DIR; source "$1" "$2"; test "$EXAMPLE_GLOBAL_FLAG" = ready; test -n "$OPENCODE_SERVER_PASSWORD"; test -z "${OPENCODE_CONFIG+x}"; printf "%s" "$ROOT_DIR"', 'setup-test', resolve('scripts/opencode-env.sh'), channel], { env: { ...process.env, GLOBAL_ENV_FILE: global } })
  assert.equal(result.toString(), resolve('.'))
})
