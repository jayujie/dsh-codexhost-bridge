import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { nativeModelSource } from './native-tool-projector.mjs'
import { validateNativeBackgroundCall } from './native-background-bridge.mjs'

export const COLLABORATION_TOOL = 'dsh_collaboration'
export const COLLABORATION_SCHEMA = Object.freeze({ name: COLLABORATION_TOOL, description: 'Use the current DSH subagent tree and shared task board. Call name="__list__" with arguments={} to discover admitted tool schemas, then call an admitted tool by name. Use DSH collaboration for shared DSH teammates; a separate Host delegation CLI creates an independent CodexHost child.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false } })
const names = new Set(['subagent', 'list_host_subagent_models', 'list_subagent_models', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent'])
const allowed = name => names.has(name) || /^team_task_(create|list|get|update)$/.test(name)
const failure = text => ({ isError: true, content: [{ type: 'text', text }] })
// Returned on discovery, not appended to every native input or added to tool schemas.
const COLLABORATION_INSTRUCTIONS = 'Use subagent for delegation. Set engine=codex, claude-code, or antigravity for external teammates, or omit engine for native DSH. Query list_host_subagent_models for external model and reasoning_effort ids; omit provider for external engines. Use list_agents and send_message to discover and follow up with named teammates. The standard tree, depth, scopes and current Team mode apply. Team mode does not require creating teammates or tasks. Use DSH collaboration for shared DSH teammates; a separate Host delegation CLI creates an independent CodexHost child. When team_task_* tools are admitted, task owners are names from list_agents. Read current revisions before claim/update, partition write scopes, and respect dependencies. Task updates do not wake teammates; use send_message explicitly. Wait for required results before a final answer. Discover tools again when current capabilities are unknown; discovery itself starts no work.'

/** One execution path for both native transports; all policy and logging remain in DSH tools. */
export class HostCollaboration {
  constructor(ctx, helpers, { maxOutputBytes = 32000 } = {}) {
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256) throw new Error('maxOutputBytes must be at least 256')
    this.ctx = ctx; this.helpers = helpers; this.maxOutputBytes = maxOutputBytes; this.leases = new Set(); this.closed = false
  }
  async open({ agent, turn, step, signal }) {
    if (this.closed) throw new Error('Collaboration bridge is closed')
    signal.throwIfAborted()
    const toolSet = await this.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal })
    const controller = new AbortController(), activeSignal = AbortSignal.any([signal, controller.signal]), requests = new Map()
    let closed = false, closing
    const admitted = () => this.ctx.tools.schemas(agent, toolSet).filter(tool => allowed(tool.name))
    const schemas = admitted()
    const lease = {
      schemas,
      source: { kind: 'model', provider: 'codexhost/collaboration', model: 'tool-dispatch' },
      call: request => {
        if (closed || activeSignal.aborted) return Promise.reject(new Error('Collaboration Turn is no longer active'))
        if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 1024 || typeof request.name !== 'string') return Promise.reject(new Error('Invalid collaboration request'))
        const background = request.channel === 'background'
        if (request.channel !== undefined && !background) return Promise.reject(new Error('Unknown SDK tool channel'))
        try { if (background) validateNativeBackgroundCall(request.name, request.arguments) } catch (error) { return Promise.reject(error) }
        let signature
        try { signature = JSON.stringify([request.channel ?? 'collaboration', request.name, request.arguments]); if (Buffer.byteLength(signature) > 32000) throw new Error('Collaboration request is too large') } catch (error) { return Promise.reject(error) }
        const previous = requests.get(request.id)
        if (previous) return previous.signature === signature ? previous.promise : Promise.reject(new Error('Collaboration request ID conflict'))
        const log = (phase, extra = {}) => this.helpers.appendPluginRecord(agent.session, 'plugin:codexhost/collaboration', { version: 1, turn, step, id: request.id, name: request.name, ...(background ? { channel: 'background' } : {}), phase, ...extra })
        const flush = () => this.ctx.sessionPersistence.flush(agent.session)
        const promise = Promise.resolve().then(async () => {
          let call
          try {
            activeSignal.throwIfAborted()
            log('request', { arguments: request.arguments ?? {} }); await flush()
            if (request.name !== '__list__' && ((!background && !allowed(request.name)) || !this.ctx.tools.get(request.name, agent, toolSet))) {
              const error = new Error('Tool is not admitted in this Agent/Turn')
              if (background) error.code = 'BACKGROUND_TOOL_UNAVAILABLE'
              throw error
            }
            let output
            if (request.name === '__list__') output = this.bound({ content: [{ type: 'text', text: JSON.stringify({ tools: admitted(), agent: this.ctx.subagents.namesOf(agent), instructions: COLLABORATION_INSTRUCTIONS }) }] })
            else {
              const source = nativeModelSource(lease.source?.provider, lease.source?.model)
              call = { type: 'tool-call', id: this.helpers.ToolCallId(`hostcollab:${turn}:${request.id}`), name: request.name, arguments: JSON.stringify(request.arguments ?? {}) }
              agent.session.append('assistant/message', { turn, step, message: this.helpers.createAssistantMessage({ content: [call], source }), stream: [] }, { surfaceOp: 'append' })
              const batch = await this.ctx.tools.execute({ agent, calls: [call], signal: activeSignal, toolSet, log: { turn, step }, maxParallelToolCalls: 1 })
              for (const context of batch.additionalContexts) agent.inject(context)
              const result = batch.results[0]?.result
              if (!result) throw new Error('Collaboration tool returned no result')
              output = this.bound({ ...(result.isError ? { isError: true } : {}), content: result.content.filter(block => block.type === 'text').map(block => ({ type: 'text', text: block.text })) })
            }
            log('result', { result: output }); await flush()
            return output
          } catch (error) {
            const result = failure(background && error?.code === 'BACKGROUND_TOOL_UNAVAILABLE'
              ? `BACKGROUND_TOOL_UNAVAILABLE: ${request.name} is not registered or admitted in this Claude preset. No command was started. Reload the fixed preset before submitting a new operation.`
              : 'DSH collaboration tool denied or failed. Do not automatically replay mutations.')
            if (call && !agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.callId === call.id)) {
              agent.session.append('tool/result', { turn, step, message: this.helpers.createToolResultMessage({ callId: call.id, ...result }) }, { surfaceOp: 'append' })
            }
            log('result', { result }); await flush()
            if (background && error?.code === 'BACKGROUND_TOOL_UNAVAILABLE') return result
            throw error
          }
        })
        requests.set(request.id, { signature, promise }); return promise
      },
      close: () => {
        if (closing) return closing
        closed = true; controller.abort(new Error('Collaboration Turn closed'))
        closing = Promise.allSettled([...requests.values()].map(entry => entry.promise)).then(() => { toolSet.dispose(); requests.clear(); this.leases.delete(lease) })
        return closing
      },
    }
    if (signal.aborted || this.closed) { await lease.close(); signal.throwIfAborted(); throw new Error('Collaboration bridge is closed') }
    this.leases.add(lease)
    return lease
  }
  bound(result) {
    if (Buffer.byteLength(JSON.stringify(result)) <= this.maxOutputBytes) return result
    const bounded = { ...(result.isError ? { isError: true } : {}), content: [{ type: 'text', text: '' }], truncated: true }
    const text = result.content.map(block => block.text).join('\n')
    let low = 0, high = text.length
    while (low < high) { const middle = Math.ceil((low + high) / 2); bounded.content[0].text = text.slice(0, middle); if (Buffer.byteLength(JSON.stringify(bounded)) <= this.maxOutputBytes) low = middle; else high = middle - 1 }
    if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
    bounded.content[0].text = text.slice(0, low)
    return bounded
  }
  async close() { this.closed = true; await Promise.allSettled([...this.leases].map(lease => lease.close())) }
}

/** Private SDK-only callback. Identity comes from the active driver, never from an arbitrary Session id. */
export async function installCollaborationBridge(ctx, driver, helpers, options = {}) {
  const manager = new HostCollaboration(ctx, helpers, options), token = randomBytes(32).toString('hex')
  const server = createServer(async (request, response) => {
    const answer = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
    const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token)
    if (request.method !== 'POST' || request.url !== '/collaboration' || request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { answer(403, {}); return }
    try {
      const chunks = []; let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32768) { answer(413, {}); return }; chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const lease = driver.collaborationFor(body.threadId)
      if (!lease) {
        // Background commands require the actual DSH execution lease; autonomous metadata access is not sufficient.
        if (body.channel !== undefined) { answer(403, {}); return }
        const result = await driver.callAutonomousCollaboration?.(body)
        if (result === undefined) answer(403, {})
        else answer(200, result)
        return
      }
      const result = await lease.call({ id: body.id, name: body.name, arguments: body.arguments, ...(body.channel === undefined ? {} : { channel: body.channel }) })
      answer(200, result)
    } catch { if (!response.writableEnded) answer(200, failure('DSH collaboration tool denied or failed. Do not automatically replay mutations.')) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  ctx.effect(() => async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.close() }, 'codexhost: collaboration bridge')
  return { manager, environment: { DSH_UNIFIED_WAKE: '1', DSH_COLLABORATION_URL: `http://127.0.0.1:${server.address().port}/collaboration`, DSH_COLLABORATION_TOKEN: token } }
}
