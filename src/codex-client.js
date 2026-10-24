import WebSocket from 'ws'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

// The daemon control socket speaks WebSocket over Unix, not JSONL stdio.
export class CodexClient extends EventEmitter {
  constructor(home, { websocketFactory = url => new WebSocket(url), timeout = 15000 } = {}) {
    super(); this.home = home; this.websocketFactory = websocketFactory; this.timeout = timeout
    this.pending = new Map(); this.socket = null; this.ready = null
  }
  async connect() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const socket = this.websocketFactory(`ws+unix://${join(this.home, 'app-server-control', 'app-server-control.sock')}:/`)
      this.socket = socket
      socket.on('message', data => {
        let msg; try { msg = JSON.parse(data.toString()) } catch { return }
        const pending = this.pending.get(String(msg.id))
        if (pending && ('result' in msg || 'error' in msg)) {
          this.pending.delete(String(msg.id)); clearTimeout(pending.timer)
          if (msg.error) pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          else pending.resolve(msg.result)
        } else if (msg.method && !('id' in msg)) this.emit('notification', msg)
        // Never answer approval/elicitation requests on behalf of a user.
      })
      socket.on('close', () => this.lost(socket))
      socket.on('error', () => this.lost(socket))
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Codex socket connect timed out')), this.timeout)
        socket.once('open', () => { clearTimeout(timer); resolve() })
        socket.once('error', error => { clearTimeout(timer); reject(error) })
      })
      await this.raw('initialize', { clientInfo: { name: 'discord_bridge', title: 'Discord bridge', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      socket.send(JSON.stringify({ method: 'initialized', params: {} }))
    })().catch(error => { this.close(); throw error })
    return this.ready
  }
  lost(socket) {
    if (this.socket !== socket) return
    this.socket = null; this.ready = null
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex control connection closed')) }
    this.pending.clear(); this.emit('disconnected')
  }
  raw(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return reject(new Error('Codex control unavailable'))
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out; delivery outcome is uncertain`)) }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async request(method, params) { await this.connect(); return this.raw(method, params) }
  close() { const socket = this.socket; if (socket) { this.lost(socket); socket.terminate() } }
}
