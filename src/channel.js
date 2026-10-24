import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { RouterClient } from './router-client.js'

const channelId = process.env.DISCORD_CHANNEL_ID
if (!channelId) throw new Error('Missing DISCORD_CHANNEL_ID')
const channelName = process.env.CHANNEL_NAME || channelId
const inbound = process.env.DISCORD_INBOUND !== 'off'
const inbox = join(process.env.HOME || '/tmp', '.claude/channels/discord/inbox'); mkdirSync(inbox, { recursive: true, mode: 0o700 })
const router = new RouterClient(join(process.env.SOCKET_DIR || '/tmp/discord-agent-router', 'router.sock'), { channelId, channelName, role: inbound ? 'claude' : 'mcp_outbound' })
const tools = [
  { name: 'discord_reply', description: 'Send text and/or local artifact files to the current Discord task thread. Use replyToMessageId to associate a response with a specific request.', properties: { text: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Absolute paths of local files to attach.' }, replyToMessageId: { type: 'string' }, taskId: { type: 'string' } }, required: [] },
  { name: 'download_attachment', description: 'Download a Discord attachment URL to a local file.', properties: { url: { type: 'string' }, filename: { type: 'string' } }, required: ['url'] },
  { name: 'discord_progress', description: 'Update the live progress card. Set waiting when you need the user to answer a question; working when resuming.', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['working', 'waiting'] }, taskId: { type: 'string' } }, required: ['text'] },
  { name: 'discord_react', description: 'Add a reaction to a message in the bound channel or current task thread.', properties: { messageId: { type: 'string' }, emoji: { type: 'string' }, taskId: { type: 'string' } }, required: ['messageId', 'emoji'] },
  { name: 'discord_edit', description: 'Edit a message previously sent by this bot in the bound channel or task thread.', properties: { messageId: { type: 'string' }, text: { type: 'string' }, taskId: { type: 'string' } }, required: ['messageId', 'text'] },
  { name: 'discord_question', description: 'Ask the user 1–3 questions with Discord buttons, selections, or a text form. Returns immediately; the answer arrives as a user message for the same task. Use this instead of terminal-native question tools for Discord users. Do not treat dismissal as an answer or approval.', properties: {
    title: { type: 'string', maxLength: 100 }, taskId: { type: 'string' }, replyToMessageId: { type: 'string' },
    questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['question'], properties: { id: { type: 'string', pattern: '^[\\w-]{1,30}$' }, question: { type: 'string', minLength: 1, maxLength: 350 }, options: { type: 'array', maxItems: 24, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 80 } }, multiSelect: { type: 'boolean' } } } },
  }, required: ['questions'] },
  { name: 'discord_question_cancel', description: 'Close an obsolete Discord question when continuing without an answer. Only dismiss questions from this binding.', properties: { questionId: { type: 'string' } }, required: ['questionId'] },
  { name: 'discord_overview', description: 'Create or refresh the shared overview of all Codex and Claude bindings, including work, queued messages, and questions awaiting answers.', properties: {}, required: [] },
]
const server = new Server({ name: `discord-${channelName}`, version: '1.1.0' }, { capabilities: { tools: {}, ...(inbound ? { experimental: { 'claude/channel': {} } } : {}) }, instructions: `You are bound to Discord #${channelName}. Use discord_reply for all user-facing replies; it supports local artifact files and routes into task threads. After a successful discord_reply containing your final answer, end the turn without a separate terminal answer or recap. After a progress update, continue the authorized work. If delivery fails, recover before claiming it was sent. Progress, receipt reactions and completion are automatic. Use discord_progress to report a milestone. For user questions use discord_question instead of terminal-native AskUserQuestion or request_user_input. It returns immediately; the user's button/form answers arrive as a bound user message for the same task. Do not infer approval from dismissal or silence. Cancel obsolete questions with discord_question_cancel. Use discord_overview to show all Codex and Claude sessions. Messages arrive with their Discord message id. Download attachments using download_attachment. Do not use the official Discord plugin.` })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required, additionalProperties: false } })) }))
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params
  try {
    if (name === 'download_attachment') {
      const url = new URL(args.url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Attachment URL must use HTTP or HTTPS')
      const filename = basename(args.filename || decodeURIComponent(url.pathname.split('/').pop()) || 'attachment').replace(/[\x00-\x1f]/g, '_')
      const path = join(inbox, `${Date.now()}-${randomUUID().slice(0, 8)}-${filename}`)
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
        if (!response.ok) throw new Error(`Attachment download failed: HTTP ${response.status}`)
        let bytes = 0
        const limit = new Transform({ transform(chunk, encoding, next) { bytes += chunk.length; next(bytes > 100 * 1024 * 1024 ? new Error('Attachment exceeds 100 MiB') : null, chunk) } })
        await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
      } catch (error) { try { unlinkSync(path) } catch {}; throw error }
      return { content: [{ type: 'text', text: `Downloaded to ${path}` }] }
    }
    const types = { discord_reply: 'reply', discord_progress: 'progress', discord_react: 'react', discord_edit: 'edit', discord_question: 'question', discord_question_cancel: 'question_cancel', discord_overview: 'overview' }
    if (!types[name]) throw new Error(`Unknown tool: ${name}`)
    if (name === 'discord_reply' && !args.text && !args.files?.length) throw new Error('Provide text or at least one file')
    const result = await router.request({ ...args, type: types[name], channelId })
    if (name === 'discord_question_cancel') return { content: [{ type: 'text', text: `Closed Discord question ${result.questionId}` }] }
    return { content: [{ type: 'text', text: result.questionId ? `Discord question ${result.questionId}${result.messageId ? ` · message ${result.messageId}` : ''}. Answers arrive as user messages; continue independent work while waiting.` : result.messageId ? `Sent Discord message ${result.messageId}` : 'Discord updated' }] }
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] } }
})
router.on('message', msg => {
  if (msg.type !== 'message' || !inbound) return
  const meta = Object.fromEntries(Object.entries({ channelId: msg.channelId, channelName, guildId: msg.guildId || '', messageId: msg.messageId, authorId: msg.authorId, authorName: msg.authorName, attachmentCount: msg.attachmentCount || 0 }).map(([key, value]) => [key, String(value)]))
  server.notification({ method: 'notifications/claude/channel', params: { content: msg.content || '', meta } }).catch(e => console.error(e.message))
})
router.on('connectionError', e => console.error(`Discord router: ${e.message}`))
await server.connect(new StdioServerTransport())
router.start()
process.on('SIGTERM', () => { router.close(); process.exit(0) })
