// Minimal client for the local `opencode serve` HTTP API (routes from its /doc
// OpenAPI document). The server is shared with an attached TUI, so every call
// targets one pinned session and the project directory explicitly.
export class OpencodeClient {
  constructor({ baseUrl, directory, password = '', username = 'opencode', fetchImpl = globalThis.fetch, timeout = 30000 }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/$/, ''), directory, fetchImpl, timeout })
    this.auth = password ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : null
  }
  url(path, query = {}) {
    const url = new URL(this.baseUrl + path)
    if (this.directory) url.searchParams.set('directory', this.directory)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    return url
  }
  async request(method, path, { body, query } = {}) {
    let response
    try {
      response = await this.fetchImpl(this.url(path, query), {
        method, signal: AbortSignal.timeout(this.timeout),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(this.auth ? { authorization: this.auth } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (error) {
      // Refused connections never reached the server, so the request is certainly undelivered.
      const code = error.cause?.code || error.code
      throw Object.assign(new Error(`opencode ${method} ${path} failed: ${code || error.message}`), { code, undelivered: code === 'ECONNREFUSED' })
    }
    if (response.status === 204) return null
    const text = await response.text()
    if (!response.ok) throw Object.assign(new Error(`opencode ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status })
    return text ? JSON.parse(text) : null
  }
  health() { return this.request('GET', '/global/health') }
  config() { return this.request('GET', '/config') }
  session(id) { return this.request('GET', `/session/${encodeURIComponent(id)}`) }
  // Busy or retrying sessions appear in this map; idle sessions are omitted.
  async status(id) { return (await this.request('GET', '/session/status'))?.[id] || { type: 'idle' } }
  messages(id, limit = 50, before) { return this.request('GET', `/session/${encodeURIComponent(id)}/message`, { query: { limit, before } }) }
  // Without an explicit model, opencode reuses the session's last model, so a
  // config switch would never reach an existing session.
  prompt(id, text, model) {
    const slash = model ? model.indexOf('/') : -1
    const body = { parts: [{ type: 'text', text }], ...(slash > 0 ? { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } } : {}) }
    return this.request('POST', `/session/${encodeURIComponent(id)}/prompt_async`, { body })
  }
  abort(id) { return this.request('POST', `/session/${encodeURIComponent(id)}/abort`) }
  permissions() { return this.request('GET', '/permission') }
  replyPermission(requestId, reply = 'once') { return this.request('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { body: { reply } }) }
}
