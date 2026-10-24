import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

const DISCORD_BOT_TOKEN = required('DISCORD_BOT_TOKEN')
const DISCORD_CHANNEL_ID = required('DISCORD_CHANNEL_ID')
const DISCORD_ALLOWED_USER_IDS = (process.env.DISCORD_ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const CLAUDE_CHANNEL_SOURCE = process.env.CLAUDE_CHANNEL_SOURCE || 'discord-custom'
const REQUIRE_MENTION = (process.env.REQUIRE_MENTION || 'false').toLowerCase() === 'true'
const CHANNEL_NAME = process.env.CHANNEL_NAME || DISCORD_CHANNEL_ID

let targetChannel = null
const replyToolName = 'discord_reply'
const downloadToolName = 'discord_download_attachment'

const LOG_DIR = join(process.env.HOME || '/tmp', '.claude', 'channel-logs')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = join(LOG_DIR, `${CHANNEL_NAME}.log`)

const INBOX_DIR = join(process.env.HOME || '/tmp', '.claude', 'channels', 'discord', 'inbox')
mkdirSync(INBOX_DIR, { recursive: true })

function log(msg) {
  const line = `[${CHANNEL_NAME}] ${new Date().toISOString()} ${msg}\n`
  console.error(line.trimEnd())
  try { appendFileSync(LOG_FILE, line) } catch {}
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err?.stack || err?.message || err}`)
})
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : JSON.stringify(reason)
  log(`UNHANDLED REJECTION: ${detail}`)
})
process.on('exit', (code) => {
  log(`PROCESS EXIT code=${code}`)
})
process.on('SIGTERM', () => { log('SIGTERM received'); process.exit(143) })
process.on('SIGINT', () => { log('SIGINT received'); process.exit(130) })

const mcp = new Server(
  { name: `discord-${CHANNEL_NAME}`, version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `CRITICAL: You are in a tmux session bound to Discord. EVERY reply to the user MUST use the ${replyToolName} tool. NEVER just print to the terminal. After a successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap. After a progress update, continue the authorized work. If delivery fails, recover before claiming it was sent. Messages from the Discord channel plugin arrive as <channel source="${CLAUDE_CHANNEL_SOURCE}" channelId="${DISCORD_CHANNEL_ID}" channelName="${CHANNEL_NAME}" authorId="..." authorName="...">...</channel>. Only messages from the configured Discord channel are forwarded. If the message includes attachments, they appear inside the tag as lines like [Attachment: name | type | size | url]. Use the ${downloadToolName} tool with the url to fetch an attachment to a local file for processing (images, PDFs, logs, etc.). Use the ${replyToolName} tool to reply back into the same Discord channel — it accepts optional local file paths via the files array to attach images or other files inline.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: replyToolName,
      description: 'Send a reply message back to the configured Discord channel. Optionally attach local files (images, PDFs, etc.) — they are uploaded inline to Discord\'s CDN.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send to Discord. Optional when files are provided.' },
          replyToMessageId: { type: 'string', description: 'Optional Discord message id to reply to.' },
          files: {
            type: 'array',
            description: 'Optional list of local absolute file paths to attach. Each file is uploaded to Discord inline. Total upload payload capped at ~25 MB by Discord for non-Nitro bots.',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: downloadToolName,
      description: 'Download a Discord attachment (by URL) to a local file under ~/.claude/channels/discord/inbox. Returns the local path so it can be read by Read/other tools.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The Discord attachment URL (taken from the [Attachment: ... | url] line in the incoming channel tag).' },
          filename: { type: 'string', description: 'Optional filename override. Defaults to the URL basename.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === downloadToolName) {
    const { url, filename } = request.params.arguments || {}
    if (!url || typeof url !== 'string') throw new Error('url is required')
    const base = (filename || url.split('/').pop().split('?')[0] || 'attachment').replace(/[^\w.\-]/g, '_')
    const dest = join(INBOX_DIR, `${Date.now()}-${base}`)
    try {
      await downloadToFile(url, dest)
      log(`downloaded attachment ${url} -> ${dest}`)
      return { content: [{ type: 'text', text: `Downloaded to ${dest}` }] }
    } catch (err) {
      log(`DOWNLOAD FAILED: ${err.message}`)
      throw new Error(`Download failed: ${err.message}`)
    }
  }

  if (request.params.name !== replyToolName) {
    throw new Error(`Unknown tool: ${request.params.name}`)
  }

  if (!targetChannel) {
    log('REPLY FAILED: targetChannel is null')
    throw new Error('Discord channel is not ready yet')
  }

  const wsStatus = client.ws?.status
  const wsReady = client.isReady()
  log(`reply attempt | ws.status=${wsStatus} isReady=${wsReady} targetChannel=${!!targetChannel}`)

  if (!wsReady) {
    log('REPLY FAILED: client not ready, attempting re-fetch channel')
    try {
      targetChannel = await client.channels.fetch(DISCORD_CHANNEL_ID, { force: true })
      log(`re-fetch succeeded: ${!!targetChannel}`)
    } catch (fetchErr) {
      log(`re-fetch FAILED: ${fetchErr.message}`)
      throw new Error(`Discord client not ready (ws.status=${wsStatus}) and re-fetch failed: ${fetchErr.message}`)
    }
  }

  const { text, replyToMessageId, files } = request.params.arguments || {}
  const hasFiles = Array.isArray(files) && files.length > 0
  if ((!text || typeof text !== 'string') && !hasFiles) {
    throw new Error('text or files is required')
  }
  if (hasFiles && !files.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new Error('files must be an array of non-empty string paths')
  }

  try {
    const payload = {}
    if (text && typeof text === 'string') payload.content = text
    if (hasFiles) payload.files = files
    if (replyToMessageId) payload.reply = { messageReference: replyToMessageId }

    const sent = await targetChannel.send(payload)

    const contentPreview = (text || '').slice(0, 50)
    log(`reply OK: messageId=${sent.id}${hasFiles ? ` +${files.length} file(s)` : ''} (${contentPreview}...)`)
    return {
      content: [
        {
          type: 'text',
          text: `Sent Discord message ${sent.id}`,
        },
      ],
    }
  } catch (sendErr) {
    log(`REPLY SEND FAILED: ${sendErr.message} | code=${sendErr.code} status=${sendErr.status}`)
    throw new Error(`Discord send failed: ${sendErr.message}`)
  }
})

await mcp.connect(new StdioServerTransport())

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

client.once('ready', async () => {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID)
  if (!channel || !channel.isTextBased()) {
    log(`FATAL: channel ${DISCORD_CHANNEL_ID} is not a text channel`)
    process.exit(1)
  }
  targetChannel = channel
  log(`ready for #${CHANNEL_NAME} (${DISCORD_CHANNEL_ID}) as ${client.user?.tag}`)
})

// Connection lifecycle logging
client.on('shardDisconnect', (event, shardId) => {
  log(`DISCONNECT: shard=${shardId} code=${event.code} reason=${event.reason || 'none'}`)
})

client.on('shardReconnecting', (shardId) => {
  log(`RECONNECTING: shard=${shardId}`)
})

client.on('shardResume', (shardId, replayedEvents) => {
  log(`RESUMED: shard=${shardId} replayed=${replayedEvents}`)
})

client.on('shardError', (error, shardId) => {
  log(`SHARD ERROR: shard=${shardId} error=${error.message}`)
})

client.on('warn', (msg) => {
  log(`WARN: ${msg}`)
})

client.on('error', (error) => {
  log(`CLIENT ERROR: ${error.message}`)
})

client.on('invalidated', () => {
  log('SESSION INVALIDATED — token may be reset or session killed')
})

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return
    if (message.channelId !== DISCORD_CHANNEL_ID) return
    if (DISCORD_ALLOWED_USER_IDS.length > 0 && !DISCORD_ALLOWED_USER_IDS.includes(message.author.id)) return
    if (REQUIRE_MENTION && !message.mentions.users.has(client.user.id)) return

    const attachments = [...message.attachments.values()]
    let content = message.content || ''
    if (attachments.length > 0) {
      const lines = attachments.map((att) => {
        const sizeKB = (att.size / 1024).toFixed(1)
        return `[Attachment: ${att.name} | ${att.contentType || 'unknown'} | ${sizeKB}KB | ${att.url}]`
      })
      content = content ? `${content}\n\n${lines.join('\n')}` : lines.join('\n')
    }

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          channelId: message.channelId,
          channelName: CHANNEL_NAME,
          guildId: message.guildId || '',
          messageId: message.id,
          authorId: message.author.id,
          authorName: message.author.username,
        },
      },
    })
    log(`forwarded msg from ${message.author.username}: ${(message.content || '').slice(0, 50)}${attachments.length > 0 ? ` +${attachments.length} attachment(s)` : ''}`)
  } catch (error) {
    log(`FORWARD FAILED: ${error.message}`)
  }
})

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadToFile(res.headers.location, dest).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const file = createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => { file.close(() => resolve(dest)) })
      file.on('error', reject)
    }).on('error', reject)
  })
}

await client.login(DISCORD_BOT_TOKEN)

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`)
})

process.on('SIGTERM', () => {
  log('SIGTERM received')
  process.exit(143)
})

process.on('exit', (code) => {
  log(`PROCESS EXIT code=${code}`)
})
