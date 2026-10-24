#!/usr/bin/env node
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { createServer } from 'node:net'
import { mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { State } from './state.js'
import { DiscordService } from './discord-service.js'
import { bridgeKinds } from './presentation.js'

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('Missing DISCORD_BOT_TOKEN')
const socketDir = process.env.SOCKET_DIR || '/tmp/discord-agent-router'
mkdirSync(socketDir, { recursive: true, mode: 0o700 }); chmodSync(socketDir, 0o700)
const path = join(socketDir, 'router.sock')
const state = new State(join(process.env.DISCORD_STATE_DIR || join(process.env.HOME, '.local/state/discord-agent-router'), 'router.sqlite'))
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel, Partials.Message] })
const log = value => console.error(`[router] ${new Date().toISOString()} ${value}`)
const service = new DiscordService({ client, state, log, allowedUsers: (process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean), taskThreads: process.env.DISCORD_TASK_THREADS !== 'off', overviewChannelId: process.env.DISCORD_OVERVIEW_CHANNEL_ID })

if (existsSync(path)) unlinkSync(path)
const server = createServer(socket => {
  let buffer = '', peer
  const connectionId = randomUUID()
  socket.on('data', data => {
    buffer += data.toString()
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); return }
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let msg; try { msg = JSON.parse(line) } catch { log('Invalid IPC JSON'); continue }
      if (msg.type === 'register') { peer = service.register(socket, msg); continue }
      if (!msg.operationId) msg.operationId = `${connectionId}:${msg.id}`
      service.handle(socket, msg, peer).catch(e => {
        log(`${msg.type}: ${e.message}`)
        if (!socket.destroyed) socket.write(JSON.stringify({ type: msg.type === 'reply' ? 'reply_result' : 'action_result', id: msg.id, error: e.message }) + '\n')
      })
    }
  })
  socket.on('error', e => log(`IPC: ${e.message}`))
})
server.listen(path, () => { chmodSync(path, 0o600); log(`IPC listening at ${path}`) })
client.once('clientReady', () => {
  log(`Discord connected as ${client.user.tag}`)
  for (const b of state.all('binding')) if (bridgeKinds.includes(b.kind)) service.dirty.add(`binding:${b.channelId}`)
  for (const t of state.all('task')) if (!['complete', 'failed', 'interrupted'].includes(t.status)) service.dirty.add(t.id)
  for (const q of state.all('question')) if (q.status === 'pending' || q.uiStatus !== q.status) service.dirty.add(`question:${q.id}`)
  service.reactions.seed()
  service.recoverMessages().catch(e => log(e.message))
})
client.on('messageCreate', message => service.receive(message).catch(e => log(`Inbound: ${e.message}`)))
client.on('interactionCreate', interaction => service.interaction(interaction).catch(async e => {
  log(`Interaction: ${e.message}`)
  const content = `Discord action failed: ${e.message}`
  if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {})
  else await interaction.reply({ content, flags: 64 }).catch(() => {})
}))
const timer = setInterval(() => {
  if (!client.isReady()) return
  for (const b of state.all('binding')) if (bridgeKinds.includes(b.kind) && Date.now() - b.lastSeen > 45000) service.dirty.add(`binding:${b.channelId}`)
  for (const id of service.peers.keys()) service.replay(id)
  service.flush().catch(e => log(e.message))
}, 5000)
// Periodic history recovery also catches individual messageCreate events missed by the gateway.
const recoverTimer = setInterval(() => {
  if (client.isReady()) service.recoverMessages({ periodic: true }).catch(e => log(`periodic recovery: ${e.message}`))
}, 120000)
function shutdown() { clearInterval(timer); clearInterval(recoverTimer); server.close(); client.destroy(); state.close(); process.exit(0) }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
await client.login(process.env.DISCORD_BOT_TOKEN)
