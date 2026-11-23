import { replyMapping, readRecentTurns } from './native-replies.mjs'

export const AUTONOMOUS_COLLABORATION = 'plugin:codexhost/autonomous-collaboration'
const permitted = name => /^team_task_(create|list|get|update)$/.test(name)
const failure = (code, message) => ({ isError: true, error: { code, message }, content: [{ type: 'text', text: `${code}: ${message}` }] })
const instructions = 'Only shared task-board tools are available in this autonomous Turn. Read the latest task revision before updating it. Task updates do not wake agents. Delegation and messages require a new DSH-managed request. Never automatically replay a mutation with an unknown outcome.'

/** Short-lived Team-only authority; never retains an old DSH Step or starts a model request. */
export class AutonomousTeamCollaboration {
  constructor(ctx, helpers, { connect, owner, isRequested, isStopped, bound, lifecycleSignal }) {
    this.ctx = ctx; this.helpers = helpers
    Object.assign(this, { connect, owner, isRequested, isStopped, bound, lifecycleSignal })
    this.pending = new Set()
    this.busy = new Set()
  }

  call(request) {
    const operation = this.execute(request)
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  drain() { return Promise.allSettled([...this.pending]) }

  resolve(threadId) {
    if (typeof threadId !== 'string' || this.isStopped()) return undefined
    const matches = this.ctx.agents?.list().filter(agent => agent.session.snapshotEvents().findLast(event => event.type === 'plugin:codexhost/thread' && event.ignorable === true)?.data.threadId === threadId) ?? []
    const agent = matches.length === 1 ? matches[0] : undefined
    return agent && ['claude-code', 'antigravity'].includes(this.owner(agent)) && replyMapping(agent, this.owner(agent))?.threadId === threadId ? agent : undefined
  }

  async execute(request) {
    const agent = this.resolve(request?.threadId)
    if (!agent) return undefined
    if (!request || typeof request.id !== 'string' || !request.id || request.id.length > 1024 || typeof request.name !== 'string') return failure('COLLABORATION_INVALID_REQUEST', 'Invalid collaboration request.')
    if (request.name !== '__list__' && !permitted(request.name)) return failure('COLLABORATION_DSH_REQUEST_REQUIRED', 'This tool requires a new DSH-managed request; autonomous Turns may only use the shared task board.')
    if (agent.status !== 'idle' || this.isRequested(agent) || this.busy.has(agent)) return failure('COLLABORATION_AGENT_BUSY', 'DSH owns this agent now. No task operation was submitted; do not replay mutations blindly.')
    this.busy.add(agent)
    try {
      return await agent.runMaintenance(async maintenanceSignal => {
        const signal = AbortSignal.any([maintenanceSignal, this.lifecycleSignal])
        const assertOwner = () => {
          signal.throwIfAborted()
          if (this.isStopped() || this.isRequested(agent) || this.resolve(request.threadId) !== agent) throw new Error('Collaboration ownership changed')
        }
        const activeTurn = async peer => {
          assertOwner()
          const thread = await readRecentTurns(peer, request.threadId, { signal })
          assertOwner()
          const active = thread.turns.filter(turn => turn.status === 'inProgress')
          if (thread.status?.type !== 'active' || active.length !== 1 || typeof active[0].id !== 'string' || !active[0].id) return undefined
          return active[0].id
        }
        signal.throwIfAborted()
        const peer = await new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          Promise.resolve(this.connect()).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
        })
        const hostTurnId = await activeTurn(peer)
        if (!hostTurnId) return failure('COLLABORATION_NATIVE_TURN_INACTIVE', 'No single active native Turn owns this request. Send a new message through DSH to use collaboration tools.')
        const signature = JSON.stringify([request.name, request.arguments ?? {}])
        const receipts = agent.session.snapshotEvents().filter(event => event.type === AUTONOMOUS_COLLABORATION && event.ignorable === true && event.data.threadId === request.threadId && event.data.hostTurnId === hostTurnId && event.data.id === request.id)
        const toolSet = await this.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal })
        try {
          const schemas = this.ctx.tools.schemas(agent, toolSet).filter(tool => permitted(tool.name))
          if (!schemas.length) return failure('COLLABORATION_TEAM_UNAVAILABLE', 'The shared task board is not available to this agent.')
          if (request.name !== '__list__' && !this.ctx.tools.get(request.name, agent, toolSet)) return failure('COLLABORATION_TOOL_NOT_ADMITTED', 'This task-board tool is not admitted for this agent.')
          if (await activeTurn(peer) !== hostTurnId) return failure('COLLABORATION_NATIVE_TURN_CHANGED', 'The native Turn changed before dispatch. No tool was executed.')
          if (receipts.length) {
            if (receipts.some(event => event.data.signature !== signature)) return failure('COLLABORATION_REQUEST_CONFLICT', 'A collaboration request id was reused with different arguments.')
            const settled = receipts.findLast(event => event.data.phase === 'result')
            if (!settled) return failure('COLLABORATION_OUTCOME_UNKNOWN', 'An earlier request has no durable result. Read the current task state before considering a new mutation.')
            await this.ctx.sessionPersistence.flush(agent.session)
            assertOwner()
            return settled.data.result
          }
          const audit = async (phase, extra) => {
            this.helpers.appendPluginRecord(agent.session, AUTONOMOUS_COLLABORATION, { version: 1, threadId: request.threadId, hostTurnId, id: request.id, signature, name: request.name, phase, ...extra })
            await this.ctx.sessionPersistence.flush(agent.session)
          }
          await audit('request', { arguments: request.arguments ?? {} })
          assertOwner()
          let result
          try {
            if (request.name === '__list__') result = this.bound({ content: [{ type: 'text', text: JSON.stringify({ tools: schemas, agent: this.ctx.subagents.namesOf(agent), instructions }) }] })
            else {
              const call = { type: 'tool-call', id: this.helpers.ToolCallId(`autonomous:${hostTurnId}:${request.id}`), name: request.name, arguments: JSON.stringify(request.arguments ?? {}) }
              // The regular scoped executor still applies permissions; plugin receipts own audit outside a DSH Step.
              const batch = await this.ctx.tools.execute({ agent, calls: [call], signal, toolSet, maxParallelToolCalls: 1 })
              const value = batch.results[0]?.result
              if (!value) throw new Error('Tool result is missing')
              result = this.bound({ ...(value.isError ? { isError: true } : {}), content: value.content.filter(block => block.type === 'text').map(block => ({ type: 'text', text: block.text })) })
            }
          } catch (error) {
            // Once dispatch starts its outcome may be unknown; no automatic replay is authorized.
            result = failure('COLLABORATION_EXECUTION_UNCONFIRMED', 'The task operation did not return a confirmed result. Read current task state; do not automatically replay it.')
          }
          await audit('result', { result })
          return result
        } finally { toolSet.dispose() }
      })
    } catch (error) {
      return failure('COLLABORATION_EXECUTION_UNCONFIRMED', 'Collaboration was interrupted or could not be durably recorded. Read current task state before another mutation.')
    } finally { this.busy.delete(agent) }
  }
}
