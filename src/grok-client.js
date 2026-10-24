import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

export function grokTransport({ host = 'local', binary = 'grok', alwaysApprove = false, transport = 'ssh' } = {}) {
  const args = ['agent', ...(alwaysApprove ? ['--always-approve'] : []), '--leader', 'stdio']
  if (host === 'local') return { command: binary, args }
  if (!['ssh', 'tailscale'].includes(transport)) throw new Error('GROK_TRANSPORT must be ssh or tailscale')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const remote = 'exec ' + [binary, ...args].map(quote).join(' ')
  return { command: transport, args: [...(transport === 'tailscale' ? ['ssh'] : []), host, remote] }
}

// ACP over a private native SSH connection. Authentication stays on the host.
export class GrokClient extends EventEmitter {
  constructor({ command = 'tailscale', args, sessionId, cwd, spawnProcess = spawn }) {
    super(); Object.assign(this, { command, args, sessionId, cwd, spawnProcess })
    this.pending = new Map(); this.nextId = 1; this.closed = false
  }
  async connect() {
    if (this.proc) throw Error('Grok transport already connected')
    this.proc = this.spawnProcess(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const proc = this.proc
    proc.stdin.on('error', () => {})
    // Never expose arbitrary stderr, prompts, tool output or thinking in Discord.
    proc.stderr.resume()
    createInterface({ input: proc.stdout }).on('line', line => {
      if (this.closed) return
      let msg; try { msg = JSON.parse(line) } catch { return }
      if (Object.hasOwn(msg, 'id') && !msg.method) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id); clearTimeout(p.timer)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'Grok request failed'), { code: msg.error.code }))
        else p.resolve(msg.result)
      } else if (msg.method && Object.hasOwn(msg, 'id')) this.emit('request', msg)
      else if (msg.method) this.emit('notification', msg)
    })
    const ended = error => {
      if (this.proc !== proc) return
      this.proc = null
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
      this.pending.clear(); this.emit('disconnected', error)
    }
    proc.once('error', ended)
    proc.once('exit', () => ended(new Error('Grok native connection closed; dispatch may be uncertain')))
    this.initialized = await this.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'discord-grok-bridge', version: '1' }
    })
    if (!this.initialized.agentCapabilities?.loadSession) throw Error('Grok cannot load the pinned session')
    // Native load replays existing history. Buffer it before marking ready.
    this.loaded = await this.request('session/load', { sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] })
    const loadedId = this.loaded._meta?.sessionId || this.loaded.sessionId
    if (loadedId && loadedId !== this.sessionId) throw Error('Grok loaded a different session')
    return this.loaded
  }
  request(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin.writable) { reject(new Error('Grok native connection unavailable')); return }
      const id = this.nextId++
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Grok ${method} timed out; outcome may be uncertain`))
      }, timeout) : null
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  respond(id, result) { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') }
  reject(id, message = 'Client request is unsupported') {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }) + '\n')
  }
  cancel() { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }) + '\n') }
  prompt(text) { return this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 0) }
  close() { this.closed = true; this.proc?.stdin.end(); this.proc?.kill('SIGTERM') }
}
