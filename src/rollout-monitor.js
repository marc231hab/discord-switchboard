import { openSync, closeSync, readSync, statSync } from 'node:fs'

// Byte offsets and complete JSONL records are persisted, including split UTF-8.
export class RolloutMonitor {
  constructor(path, state, callback) { this.path = path; this.state = state; this.callback = callback }
  async poll() {
    const file = statSync(this.path)
    let cursor = this.state.get('cursor', this.path) || { offset: 0, inode: file.ino }
    if (cursor.inode !== file.ino || cursor.offset > file.size) cursor = { offset: 0, inode: file.ino }
    if (file.size === cursor.offset) return
    const fd = openSync(this.path, 'r')
    try {
      // A single record can exceed the chunk (large tool output); grow until it
      // holds at least one complete line, or the cursor never advances.
      let size = 8 * 1024 * 1024, chunk, count
      for (;;) {
        chunk = Buffer.alloc(Math.min(file.size - cursor.offset, size))
        count = readSync(fd, chunk, 0, chunk.length, cursor.offset)
        if (chunk.lastIndexOf(10, count - 1) >= 0 || cursor.offset + count >= file.size) break
        size *= 2
      }
      let start = 0
      for (let at = 0; at < count; at++) if (chunk[at] === 10) {
        const offset = cursor.offset + start
        const line = chunk.subarray(start, at).toString('utf8')
        let record
        try { record = JSON.parse(line) } catch { record = null }
        if (record) await this.callback(record, `${this.path}:${offset}`)
        start = at + 1
      }
      if (start) this.state.put('cursor', this.path, { offset: cursor.offset + start, inode: file.ino })
    } finally { closeSync(fd) }
  }
}
export function discordMessageId(content) {
  const text = typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
  return /^\[discord #[^\]\n]+ msg=(\d+)\]/m.exec(text)?.[1] || null
}
export function publicText(item) {
  if (typeof item.content === 'string') return item.content
  if (Array.isArray(item.content)) return item.content.filter(c => c.type === 'text' || c.type === 'output_text').map(c => c.text).join('\n')
  return item.text || ''
}
