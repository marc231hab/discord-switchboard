import { createHash } from 'node:crypto'
import { basename } from 'node:path'

export const terminalStates = new Set(['complete', 'failed', 'interrupted'])
// Agent engines that own a channel's inbound delivery through the router.
export const bridgeKinds = ['codex', 'claude', 'grok', 'opencode']
export const bridgeRoles = bridgeKinds.map(kind => `${kind}_bridge`)
export function kindLabel(kind) { return { grok: 'Grok', claude: 'Claude', opencode: 'opencode' }[kind] || 'Codex' }
export const emoji = { received: '👀', queued: '📥', working: '🛠️', waiting: '⏸️', complete: '✅', failed: '❌', interrupted: '🛑' }
export function redact(text = '') {
  return String(text)
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [redacted]')
    .replace(/\b(Authorization\s*:\s*Bot)\s+[^\s"']+/gi, '$1 [redacted]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)[\w-]*["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,}|[\w-]{24,}\.[\w-]{6,}\.[\w-]{20,})\b/g, '[redacted]')
}
export function clip(text, length = 180) { return redact(text).replace(/\s+/g, ' ').slice(0, length) }
export function splitText(text, limit = 1900) {
  const result = []
  let rest = String(text)
  while (rest.length > limit) {
    let at = rest.lastIndexOf('\n', limit)
    if (at < limit / 2) at = limit
    result.push(rest.slice(0, at)); rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest) result.push(rest)
  return result
}
export function stableId(value) {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
export function commandLabel(item) {
  const actions = item.parsed_cmd || item.commandActions || []
  const labels = actions.map(a => {
    if (/read/i.test(a.type)) return `Read ${basename(a.path || a.name || 'file')}`
    if (/search/i.test(a.type)) return `Search ${clip(a.query || a.pattern || '', 70)}`
    if (/list/i.test(a.type)) return 'List files'
    return null
  }).filter(Boolean)
  if (labels.length) return [...new Set(labels)].join('; ')
  // Never publish shell scripts or command arguments containing credentials.
  const argv = Array.isArray(item.command) ? item.command : null
  const shellIndex = argv?.findIndex(a => /^-[a-z]*c$/.test(a))
  const command = argv ? (shellIndex >= 0 ? argv[shellIndex + 1] || '' : argv.join(' ')) : typeof item.command === 'string' ? item.command : ''
  const inner = command.replace(/^.*?\s-l?c\s+['"]?/, '')
  const bin = basename(inner.trim().split(/[\s;|]+/)[0] || 'command')
  const verb = inner.trim().split(/\s+/)[1]
  const safeVerb = /^(test|check|build|lint|status|diff|log|show|version|--version|--check)$/.test(verb || '') ? ` ${verb}` : ''
  return `Run ${clip(bin, 40)}${safeVerb}`
}
export function renderTask(task, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - (task.startedAt || task.createdAt)) / 1000))
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const lines = [`${emoji[task.status] || '📥'} **${clip(task.title, 100)}** · ${task.status} · ${elapsed}`,
    `Now: ${clip(task.activity || 'Waiting for Codex to consume the message', 220)}`]
  for (const line of (task.milestones || []).slice(-5)) lines.push(`• ${clip(line, 200)}`)
  if (task.files?.length) lines.push(`Files changed: ${task.files.length} (${task.files.slice(-3).map(p => clip(basename(p), 45)).join(', ')})`)
  if (task.lastEventAt) lines.push(`Last activity: <t:${Math.floor(task.lastEventAt / 1000)}:R>`)
  if (task.threadId) lines.push(`[Task thread](https://discord.com/channels/${task.guildId}/${task.threadId})`)
  return lines.join('\n').slice(0, 1900)
}
export function renderBinding(b, connected, pending) {
  return [`**${kindLabel(b.kind)} binding · ${clip(b.channelName || b.channelId)}**`,
    `Connection: ${connected ? 'online' : 'offline — messages are saved for recovery'}`,
    `Model: ${clip(b.model || 'unknown')} · reasoning: ${clip(b.effort || 'unknown')}`,
    `Project: \`${clip(b.projectDir || 'unknown', 220)}\``,
    `Session: \`${clip(b.tmuxSession || 'unknown')}\` · thread: \`${clip(b.codexThreadId || 'unbound')}\``,
    `Task: ${clip(b.activity || 'Idle', 240)} · pending messages: ${pending}`,
    `Health: ${clip(b.health || 'starting')} · updated <t:${Math.floor((b.lastSeen || Date.now()) / 1000)}:R>`,
    `Controls: \`!status\`, \`!stop\`, \`!diff\`, \`!logs\`, \`!new <task>\`${b.kind === 'codex' ? ', `!bind <session UUID>`.' : '.'}`
  ].join('\n').slice(0, 1900)
}
