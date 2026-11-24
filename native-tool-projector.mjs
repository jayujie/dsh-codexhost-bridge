/** Refuse an invalid durable source before any assistant event or stream is published. */
export function nativeModelSource(provider, model) {
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) throw new Error('Host assistant messages require a non-empty provider and model source')
  return { kind: 'model', provider, model }
}

/** Keep lightweight identity/status metadata without duplicating multi-KB outputs or diffs already stored in tool/result text. */
export function compactToolItemMeta(item) {
  if (!item || typeof item !== 'object') return item
  const compact = {}
  for (const key of ['id', 'itemId', 'type', 'toolName', 'tool', 'namespace', 'command', 'cwd', 'status', 'exitCode', 'durationMs', 'success', 'processId', 'dshBackground']) {
    if (item[key] !== undefined) compact[key] = item[key]
  }
  if (Array.isArray(item.changes)) {
    compact.changes = item.changes.map(change => (change && typeof change === 'object' ? { path: change.path, ...(change.kind ? { kind: change.kind } : {}) } : change))
  }
  if (item.error && typeof item.error === 'object' && typeof item.error.message === 'string') {
    compact.error = { message: item.error.message }
  }
  return compact
}

/** Display observations only: these records never execute DSH tools. */
export class NativeToolProjector {
  #session; #helpers; #position; #calls = new Map(); #harness; #raw = false; #source
  constructor(session, helpers, position, harness, source) { this.#source = nativeModelSource(source?.provider, source?.model); this.#session = session; this.#helpers = helpers; this.#position = position; this.#harness = harness }

  accept(message) {
    if (message.method === 'item/commandExecution/outputDelta') {
      const call = this.#calls.get(message.params?.itemId)
      if (call && !call.ended && typeof message.params.delta === 'string') {
        const combined = (call.output ?? '') + message.params.delta
        call.output = combined.slice(0, 262144)
        call.truncated ||= combined.length > 262144
      }
      return
    }
    const raw = message.method === 'codexhost/item/started' || message.method === 'codexhost/item/completed'
    if (raw) this.#raw = true
    if (!raw && this.#raw && this.#harness !== 'codex') return
    if (!raw && !['item/started', 'item/completed'].includes(message.method)) return
    const { item, outcome } = message.params ?? {}
    if (!item || ['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(item.type)) return
    const id = item.itemId ?? item.id
    if (typeof id !== 'string') return
    let call = this.#calls.get(id)
    if (call?.ended) return
    const completed = message.method.endsWith('/completed')
    const name = item.toolName ?? item.tool ?? (item.type === 'commandExecution' ? (this.#harness === 'codex' ? 'exec_command' : 'Bash') : item.type)
    const args = item.arguments ?? (item.type === 'commandExecution' ? { command: item.command, ...(item.cwd ? { workdir: item.cwd } : {}) }
      : item.type === 'fileChange' ? { description: item.changes?.map(change => change.path).join(', '), changes: item.changes } : item)
    if (!call) {
      call = { id: `codexhost:${this.#position.turn}:${id}`, ended: false, item }
      this.#calls.set(id, call)
      const argumentsRaw = typeof args === 'string' ? args : JSON.stringify(args)
      // Released DSH V4 requires the assistant's advertised call before execution.
      // This records an external observation; DSH does not execute it again.
      this.#session.append('assistant/message', { ...this.#position,
        message: this.#helpers.createAssistantMessage({ content: [{ type: 'tool-call', id: call.id, name, arguments: argumentsRaw }], source: this.#source }), stream: [],
      }, { surfaceOp: 'append' })
      this.#session.append('tool/call', { ...this.#position, callId: call.id, name, arguments: argumentsRaw })
    }
    if (!completed) return
    const output = item.aggregatedOutput ?? item.output ?? item.contentItems ?? item.result ?? (call.output ? call.output + (call.truncated ? '\n[Output truncated by DSH display limit]' : '') : undefined) ?? (item.changes ? item.changes.map(change => `${change.path}\n${change.diff ?? change.unifiedDiff ?? ''}`).join('\n') : undefined)
    const content = typeof output === 'string' ? output : output?.content ?? output
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text' || part.type === 'inputText').map(part => part.text).join('\n') : content ? JSON.stringify(content) : ''
    const failed = outcome?.status === 'failed' || outcome?.status === 'cancelled' || ['failed', 'declined', 'cancelled', 'interrupted'].includes(item.status) || item.success === false || (Number.isInteger(item.exitCode) && item.exitCode !== 0)
    const details = outcome?.error?.message ?? outcome?.reason ?? item.error?.message
    this.#result(call, text || details || JSON.stringify({ status: outcome?.status ?? item.status, ...(item.exitCode == null ? {} : { exitCode: item.exitCode }) }), failed, item)
  }

  #result(call, text, isError, item) {
    call.ended = true
    this.#session.append('tool/result', { ...this.#position,
      message: this.#helpers.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text }], isError }),
      meta: { codexHost: { harness: this.#harness, item: compactToolItemMeta(item) } },
    }, { surfaceOp: 'append' })
  }

  /** The recorded DSH call for a native Item, while its observation is open. */
  openCall(itemId) {
    const call = this.#calls.get(itemId)
    return call && !call.ended ? { callId: call.id, item: call.item, output: call.output ?? '' } : undefined
  }

  /** Codex commands still running with a live process when the Turn ends. */
  openBackgroundCommands() {
    return [...this.#calls.entries()].filter(([, call]) => !call.ended && call.item?.type === 'commandExecution' && typeof call.item.processId === 'string' && call.item.processId)
      .map(([itemId, call]) => ({ itemId, callId: call.id, item: call.item, output: call.output ?? '' }))
  }

  /** Close the foreground observation of work that continues in the background. Not an error. */
  detach(itemId, text, background) {
    const call = this.#calls.get(itemId)
    if (!call || call.ended) return false
    this.#result(call, text, false, { ...call.item, dshBackground: background })
    return true
  }

  settle() {
    for (const call of this.#calls.values()) if (!call.ended) this.#result(call, 'External tool ended without a confirmed result.', true, call.item)
  }
}
