/** Isolated original UI: it cannot access the DSH DOM, credentials, or loopback directly. */
export function consoleDocument({ script, style }, channel) {
  const bootstrap = `(${consoleFrameBridge.toString()})(${JSON.stringify(channel)});`
  const safeScript = value => value.replace(/<\/script/gi, '<\\/script')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>DSH Host console</title><style>${style.replace(/<\/style/gi, '<\\/style')}</style></head><body><script>${safeScript(bootstrap)}</script><script>${safeScript(script)}</script></body></html>`
}

function consoleFrameBridge(channel) {
  let sequence = 0
  const pending = new Map()
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.kind !== 'console-response') return
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    clearTimeout(entry.timer)
    entry.cleanup()
    if (event.data.error) entry.reject(new Error(event.data.error))
    else entry.resolve(new Response(event.data.response.body, { status: event.data.response.status, headers: event.data.response.headers }))
  })
  window.fetch = (input, options = {}) => {
    const pathname = typeof input === 'string' ? input : input.url
    if (!/^\/api\/[a-z0-9/-]+$/.test(pathname)) return Promise.reject(new Error('Unsupported console path'))
    const signal = options.signal
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const abort = () => { const entry = pending.get(id); if (!entry) return; pending.delete(id); clearTimeout(entry.timer); entry.cleanup(); reject(signal.reason) }
      const timer = setTimeout(() => { pending.delete(id); signal?.removeEventListener('abort', abort); reject(new Error('Console request timed out; a submitted operation will not be repeated')) }, 180_000)
      const cleanup = () => signal?.removeEventListener('abort', abort)
      pending.set(id, { resolve, reject, timer, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      parent.postMessage({ channel, kind: 'console-request', id, request: { method: options.method ?? 'GET', path: pathname, ...(options.body === undefined ? {} : { body: options.body }) } }, '*')
    })
  }
  document.addEventListener('click', event => {
    const anchor = event.composedPath().find(node => node.matches?.('a[href="/api/diagnostics/export"]'))
    if (!anchor) return
    event.preventDefault()
    void fetch('/api/diagnostics/export').then(async response => {
      if (!response.ok) throw new Error('Diagnostic export failed')
      const url = URL.createObjectURL(await response.blob())
      const download = document.createElement('a')
      download.href = url
      download.download = 'dsh-host-diagnostics.json'
      download.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }).catch(error => window.alert(error.message))
  })
}
