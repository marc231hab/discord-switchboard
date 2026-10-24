import { connect } from 'node:net'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

export class RouterClient extends EventEmitter {
  constructor(path, registration) { super(); this.path = path; this.registration = registration; this.pending = new Map(); this.socket = null; this.closed = false }
  start() {
    if (this.closed) return
    const socket = connect(this.path); this.socket = socket
    let buffer = ''
    socket.on('connect', () => { if (this.registration) this.send({ type: 'register', ...this.registration }); this.emit('connected') })
    socket.on('data', data => {
      buffer += data.toString()
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); return }
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        let msg; try { msg = JSON.parse(line) } catch { continue }
        const p = this.pending.get(msg.id)
        if (p && ['action_result', 'reply_result'].includes(msg.type)) {
          this.pending.delete(msg.id); clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg)
        } else this.emit('message', msg)
      }
    })
    socket.on('error', error => this.emit('connectionError', error))
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Discord router disconnected; outcome may be uncertain')) }
      this.pending.clear(); this.emit('disconnected')
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.start(), 3000)
    })
  }
  send(msg) { if (this.socket && !this.socket.destroyed && !this.socket.connecting) { this.socket.write(JSON.stringify(msg) + '\n'); return true }; return false }
  request(msg, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Discord action timed out')) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ ...msg, id, operationId: msg.operationId || id })) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Discord router is offline')) }
    })
  }
  close() { this.closed = true; clearTimeout(this.reconnectTimer); this.socket?.destroy() }
}
