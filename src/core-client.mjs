const READ_TIMEOUT_MS = 10_000
const SEND_TIMEOUT_MS = 110_000

export function createCoreClient({ url = 'http://127.0.0.1:7317', fetch = globalThis.fetch } = {}) {
  url = url.replace(/\/$/, '')

  async function request(path, body, keepRefusal = false) {
    const response = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(body ? SEND_TIMEOUT_MS : READ_TIMEOUT_MS),
      ...(body ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Board-Client': 'milestone' },
        body: JSON.stringify(body)
      } : {})
    })
    const result = await response.json()
    if (!response.ok && !(keepRefusal && result.sent === false)) {
      throw Object.assign(new Error(result.error ?? `HTTP ${response.status}`), { status: response.status })
    }
    return result
  }

  function listen(changed) {
    const controller = new AbortController()
    let timer
    let delay = 1000

    async function connect() {
      try {
        const response = await fetch(`${url}/events`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const decoder = new TextDecoder()
        let pending = ''
        let event = ''
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true })
          let end
          while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end).replace(/\r$/, '')
            pending = pending.slice(end + 1)
            if (line.startsWith('event:')) event = line.slice(6).trim()
            if (line === '') {
              if (event === 'changed' && !controller.signal.aborted) {
                delay = 1000
                changed()
              }
              event = ''
            }
          }
        }
      } catch {
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(connect, delay)
          timer.unref?.()
          delay = Math.min(delay * 2, 30_000)
        }
      }
    }

    void connect()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }

  return {
    url,
    workspaces: () => request('/api/v1/workspaces'),
    turn: () => request('/api/v1/turn'),
    sendNext: (body) => request('/api/v1/workspaces/next', body, true),
    answerAsk: ({ id, ...body }) => request(`/api/v1/asks/${encodeURIComponent(id)}/answer`, body),
    listen
  }
}
