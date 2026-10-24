import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { State } from '../src/state.js'
import { EventEmitter } from 'node:events'
export function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-test-'))
  const state = new State(join(dir, 'state.sqlite'))
  t.after(() => { try { state.close() } catch {}; rmSync(dir, { recursive: true, force: true }) })
  return { dir, state }
}
export function fakeDiscord() {
  let next = 10000
  const sent = [], channels = new Map()
  function channel(id) {
    if (channels.has(id)) return channels.get(id)
    const messages = new Map()
    const ch = { id, messages: { fetch: async key => { const m = messages.get(typeof key === 'object' ? key.message : key); if (!m) throw new Error('Unknown message'); return m } }, send: async opts => {
      const msg = makeMessage({ id: String(next++), channelId: id, content: opts.content, bot: true }); msg.options = opts; sent.push(msg); return msg
    }, isThread: () => id.startsWith('thread') }
    ch.cache = messages; channels.set(id, ch); return ch
  }
  function makeMessage({ id, channelId = 'main', content = 'Please fix the build', bot = false, user = 'user' }) {
    const ch = channel(channelId)
    const cache = new Map()
    const m = { id, channelId, channel: ch, content, guildId: 'guild', author: { id: bot ? 'bot' : user, username: user, bot }, attachments: new Map(), reactions: { cache },
      react: async e => { cache.set(e, { me: true, emoji: { name: e }, users: { remove: async () => cache.delete(e) } }); return m },
      reply: opts => ch.send(opts), edit: async opts => { m.content = opts.content; m.options = { ...m.options, ...opts }; return m }, pin: async () => { m.pinned = true },
      startThread: async () => { m.thread = channel(`thread-${id}`); return m.thread }
    }
    ch.cache.set(id, m); return m
  }
  return { client: { channels: { fetch: async id => channel(id) }, user: { id: 'bot' } }, makeMessage, sent, channels }
}
export function fakeSocket() { const s = new EventEmitter(); s.destroyed = false; s.messages = []; s.write = raw => s.messages.push(JSON.parse(raw)); s.destroy = () => { s.destroyed = true; s.emit('close') }; return s }
export const event = (type, payload) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, ...payload } })
