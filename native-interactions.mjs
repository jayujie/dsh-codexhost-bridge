import { hostRecord, isHostRecord } from './host-identity.mjs'
import { HostConnectionError } from './native-host-client.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bad = message => new HostConnectionError('HOST_INTERACTION_UNSUPPORTED', message)
const idKey = id => {
  if ((typeof id === 'string' && id.length > 0 && id.length <= 1024) || Number.isSafeInteger(id)) return JSON.stringify([typeof id, id])
  throw bad('Native interaction has an invalid request identity')
}
const nonFull = new Set(['read-only', 'workspace-write', 'plan', 'acceptEdits', 'default', 'auto'])
const SUBAGENT_APPROVAL_ID = 'subagent-approval'
const SUBAGENT_APPROVE_LABEL = '仅允许本次'
const SUBAGENT_REJECT_LABEL = '拒绝'

function subagentApprovalQuestion(subagentLabel, method, params) {
  const scope = JSON.stringify(params, null, 2)
  const detail = '```json\n' + scope + '\n```'
  const titleZh = `子代理 ${subagentLabel} 请求执行操作（${method}）`
  const titleEn = `Subagent ${subagentLabel} requests approval (${method})`
  return {
    id: SUBAGENT_APPROVAL_ID,
    header: `子代理 ${subagentLabel}`,
    question: `${titleZh}，仅确认本次请求，不扩展整会话或永久授权。`,
    detail,
    multiSelect: false,
    options: [
      { label: SUBAGENT_APPROVE_LABEL, description: '仅允许本次操作，不修改子代理权限级别' },
      { label: SUBAGENT_REJECT_LABEL, description: '拒绝本次操作' },
    ],
    intent: {
      kind: 'approval',
      approve: SUBAGENT_APPROVE_LABEL,
      reject: SUBAGENT_REJECT_LABEL,
      subject: { name: `子代理 ${subagentLabel}` },
      display: {
        question: { en: `${titleEn} — allow this single operation?`, 'zh-CN': `${titleZh} — 是否仅允许本次操作？` },
        detail: { en: detail, 'zh-CN': detail },
        approve: { en: 'Allow once', 'zh-CN': SUBAGENT_APPROVE_LABEL },
      },
    },
  }
}

function subagentApprovalGranted(answer) {
  if (!record(answer) || !Array.isArray(answer.answers) || answer.answers.length !== 1) return false
  const item = answer.answers[0]
  if (!record(item) || item.id !== SUBAGENT_APPROVAL_ID) return false
  if (!Array.isArray(item.selected) || item.selected.length !== 1 || item.selected[0] !== SUBAGENT_APPROVE_LABEL) return false
  if (typeof item.custom === 'string' && item.custom.trim()) return false
  return true
}

/** Reviewed protocol subset. Unknown requests never acquire a permissive fallback. */
export function nativeInteraction(message) {
  idKey(message.id)
  const params = message.params
  if (!record(params) || Buffer.byteLength(JSON.stringify(params)) > 32768) throw bad('Native interaction scope is missing or exceeds the display budget; refusing to approve an incomplete scope')
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) throw bad('Native approval does not offer a reviewed one-time decision')
    return { kind: 'approval', params, allow: { decision: 'accept' }, deny: { decision: 'decline' } }
  }
  if (message.method === 'mcpServer/elicitation/request') {
    const schema = params.requestedSchema
    if (params.mode !== 'form' || params._meta?.codex_approval_kind !== 'mcp_tool_call' || !record(schema) || schema.type !== 'object' || !record(schema.properties) || Object.keys(schema.properties).length !== 0 || (schema.required?.length ?? 0) !== 0) throw bad('This native elicitation form is not a reviewed one-time approval')
    return { kind: 'approval', params, allow: { action: 'accept', content: {} }, deny: { action: 'decline' } }
  }
  if (message.method !== 'item/tool/requestUserInput') throw bad(`Native interaction method is not connected: ${message.method}`)
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 32) throw bad('Native question batch is invalid')
  const ids = new Set()
  const questions = params.questions.map(question => {
    if (!record(question) || typeof question.id !== 'string' || !question.id || ['__proto__', 'constructor', 'prototype'].includes(question.id) || ids.has(question.id) || typeof question.question !== 'string' || !question.question.trim()) throw bad('Native questions must have unique IDs and non-empty text')
    ids.add(question.id)
    if (question.isSecret === true) throw bad('Secret native questions require a dedicated protected input; refusing plaintext presentation')
    if (question.options !== undefined && question.options !== null && !Array.isArray(question.options)) throw bad('Native question options are invalid')
    const options = question.options ?? []
    if (options.length > 64 || options.some(option => !record(option) || typeof option.label !== 'string' || !option.label || (option.description !== undefined && typeof option.description !== 'string')) || new Set(options.map(option => option.label)).size !== options.length) throw bad('Native question choices are invalid or ambiguous')
    return { id: question.id, question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(options.length ? { options: options.map(option => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
      multiSelect: question.multiSelect === true,
    }
  })
  return { kind: 'question', params, questions }
}

/** Validate the human batch before translating it; skips never mean approval. */
export function nativeQuestionAnswer(descriptor, answer) {
  if (!record(answer) || !Array.isArray(answer.answers) || answer.answers.length !== descriptor.questions.length) throw bad('DSH answer must name every native question exactly once')
  const byId = new Map(answer.answers.map(item => [item?.id, item]))
  if (byId.size !== answer.answers.length || descriptor.questions.some(question => !byId.has(question.id))) throw bad('DSH answer contains duplicate or unknown question IDs')
  const entries = []
  for (const question of descriptor.questions) {
    const item = byId.get(question.id), original = descriptor.params.questions.find(candidate => candidate.id === question.id)
    if (!Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string') || new Set(item.selected).size !== item.selected.length || (item.custom !== undefined && typeof item.custom !== 'string')) throw bad('DSH question answer is malformed')
    const labels = new Set((question.options ?? []).map(option => option.label))
    if (item.selected.some(label => !labels.has(label))) throw bad('DSH answer selects an unoffered native option')
    const custom = item.custom?.trim() ? item.custom : undefined
    if (custom && question.options?.length && original.isOther === false) throw bad('This native question does not accept a custom answer')
    const values = [...item.selected, ...(custom === undefined ? [] : [custom])]
    if (!question.multiSelect && values.length > 1) throw bad('Native single-choice question received multiple answers')
    // A skipped required question cancels the batch, matching the Host cancellation form.
    if (values.length === 0 && original.isOptional !== true) return { answers: {} }
    if (values.some(value => Buffer.byteLength(value) > 16000)) throw bad('Native question answer exceeds the bounded reply size')
    entries.push([question.id, { answers: values }])
  }
  const result = { answers: Object.fromEntries(entries) }
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw bad('Native question answer exceeds the bounded batch size')
  return result
}

function untilAborted(promise, signal) {
  if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** One live turn only. Replies are one-shot and never replayed after uncertainty. */
export class NativeInteractionBridge {
  #ctx; #agent; #peer; #helpers; #threadId; #turnId; #localTurn; #allowPrompts; #permission; #entries = new Map(); #tasks = new Set(); #parent; #abort; #closed = false; #onError; #onWaitingChange; #waitingCount = 0
  constructor({ ctx, agent, peer, helpers, threadId, turnId, turn, signal, permissionModeId, enableApprovalPrompts = false, onError, onWaitingChange }) {
    this.#ctx = ctx; this.#agent = agent; this.#peer = peer; this.#helpers = helpers; this.#threadId = threadId; this.#turnId = turnId; this.#localTurn = turn
    this.#allowPrompts = enableApprovalPrompts; this.#permission = permissionModeId; this.#onError = onError ?? (() => {}); this.#onWaitingChange = onWaitingChange ?? (() => {}); this.#parent = signal
    this.#abort = () => this.cancel()
    signal.addEventListener('abort', this.#abort, { once: true })
    if (signal.aborted) this.cancel()
  }
  #enterWait() {
    this.#waitingCount += 1
    if (this.#waitingCount === 1) this.#onWaitingChange(true)
  }
  #leaveWait() {
    if (this.#waitingCount <= 0) return
    this.#waitingCount -= 1
    if (this.#waitingCount === 0) this.#onWaitingChange(false)
  }
  #interactionTarget() {
    if (this.#agent.session.header.origin !== 'subagent') {
      return { target: this.#agent, delegated: false, subagentLabel: undefined }
    }
    const subagents = this.#ctx.get('subagents')
    const root = subagents?.rootOf?.(this.#agent)
    if (!root || root === this.#agent || root.session?.header?.origin === 'subagent') return undefined
    const agents = this.#ctx.get('agents')
    if (agents?.get && agents.get(root.id) !== root) return undefined
    const selfName = subagents?.namesOf?.(this.#agent)?.self
    const subagentLabel = typeof selfName === 'string' && selfName.trim() ? selfName.trim() : this.#agent.id
    return { target: root, delegated: true, subagentLabel }
  }
  #log(entry, phase, extra = {}) {
    this.#helpers.appendPluginRecord(this.#agent.session, hostRecord('interaction'), { sessionId: this.#agent.session.id, threadId: this.#threadId, turnId: this.#turnId(), localTurn: this.#localTurn, requestId: entry.message.id, method: entry.message.method, phase, ...extra })
  }
  async #flush() { await this.#ctx.sessionPersistence.flush(this.#agent.session) }
  accept(message) {
    if (this.#closed || this.#parent.aborted) return
    const currentTurn = this.#turnId()
    if (message.params?.threadId !== this.#threadId || (message.params.turnId !== undefined && message.params.turnId !== currentTurn)) throw bad('Native interaction belongs to another thread or turn')
    const key = idKey(message.id), signature = JSON.stringify(message), previous = this.#entries.get(key)
    if (previous) { if (previous.signature !== signature) throw bad('Native request ID was reused with different content'); return }
    const descriptor = nativeInteraction(message)
    const entry = { message, descriptor, signature, controller: new AbortController(), state: 'pending' }
    this.#entries.set(key, entry)
    const task = this.#answer(entry).catch(error => { if (!entry.controller.signal.aborted && !this.#closed) this.#onError(error) })
    this.#tasks.add(task)
    void task.then(() => this.#tasks.delete(task), () => this.#tasks.delete(task))
  }
  resolve(requestId) {
    const entry = this.#entries.get(idKey(requestId))
    if (entry) { entry.state = 'resolved'; entry.controller.abort(new Error('Native interaction was resolved elsewhere')) }
  }
  cancel() {
    this.#closed = true
    for (const entry of this.#entries.values()) entry.controller.abort(new Error('Native turn no longer accepts interaction replies'))
  }
  async close() {
    this.cancel(); this.#parent.removeEventListener('abort', this.#abort)
    await Promise.allSettled([...this.#tasks])
  }
  async #answer(entry) {
    const { descriptor, controller } = entry, signal = controller.signal
    this.#log(entry, 'pending', { request: entry.message })
    await this.#flush()
    if (signal.aborted) return
    let result
    if (descriptor.kind === 'approval') {
      const approval = this.#ctx.get('approval')
      let outcome = 'unavailable'
      let delegatedTo
      if (this.#agent.session.header.origin !== 'subagent' && approval?.request) {
        // Explicitly authorized plugin policy: only this external, non-full Session.
        // Append without injecting a fake user message into the native engine.
        const events = this.#agent.session.snapshotEvents()
        const activated = events.some(event => isHostRecord(event.type, 'interaction') && event.data.phase === 'policy-enabled' && event.data.sessionId === this.#agent.session.id)
        if (this.#allowPrompts && nonFull.has(this.#permission) && !activated) {
          const current = events.findLast(event => event.type === 'approval/policy')
          this.#log(entry, 'policy-enabled')
          if (current?.data.policy !== 'ask') this.#agent.session.append('approval/policy', { policy: 'ask' })
          await this.#flush()
        }
        if (signal.aborted || this.#closed) return
        const scope = JSON.stringify(descriptor.params, null, 2)
        const reason = `外部 Agent 请求执行以下操作，仅确认本次请求，不选择整会话或永久授权：\n${scope}`
        const candidate = typeof descriptor.params.itemId === 'string' ? `dsh-host:${this.#localTurn}:${descriptor.params.itemId}` : undefined
        const callId = candidate && events.some(event => event.type === 'tool/call' && event.data.callId === candidate) ? candidate : undefined
        // ApprovalService itself races cancellation and commits approval/decided.
        // Await that audit completion before the enclosing DSH turn can finish.
        this.#enterWait()
        try {
          outcome = await approval.request({ agent: this.#agent, toolName: entry.message.method,
            reason, ...(callId === undefined ? {} : { callId }), signal,
          })
        } finally { this.#leaveWait() }
      } else if (this.#agent.session.header.origin === 'subagent' && this.#allowPrompts && nonFull.has(this.#permission)) {
        const routing = this.#interactionTarget()
        const questions = this.#ctx.get('userQuestions')
        const rootEvents = routing?.target?.session?.snapshotEvents?.() ?? []
        const rootPolicy = rootEvents.findLast(event => event.type === 'approval/policy')?.data?.policy
        const rootPreset = rootEvents.findLast(event => event.type === 'permission/preset')?.data?.preset
        const rootSandbox = rootEvents.findLast(event => event.type === 'sandbox/mode')?.data?.mode
        const rootBlocksPrompts = rootPolicy === 'never' && rootPreset !== 'danger-full-access' && rootSandbox !== 'danger-full-access'
        if (routing?.delegated && questions?.ask && !rootBlocksPrompts) {
          delegatedTo = routing.target.id
          const approvalQuestion = subagentApprovalQuestion(routing.subagentLabel, entry.message.method, descriptor.params)
          this.#enterWait()
          try {
            const answer = await untilAborted(Promise.resolve().then(() => questions.ask({ agent: routing.target, questions: [approvalQuestion], signal })), signal)
            outcome = subagentApprovalGranted(answer) ? 'allowed-once' : 'rejected'
          } catch (error) {
            if (signal.aborted) outcome = 'cancelled'
            else if (['NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE'].includes(error?.code)) outcome = 'unavailable'
            else throw error
          } finally { this.#leaveWait() }
        }
      }
      result = outcome === 'allowed-once' ? descriptor.allow : descriptor.deny
      this.#log(entry, 'decision', { outcome, result, ...(delegatedTo ? { delegatedTo } : {}) })
    } else {
      const questions = this.#ctx.get('userQuestions')
      const routing = this.#interactionTarget()
      const delegatedTo = routing?.delegated ? routing.target.id : undefined
      let timer
      const expiry = new AbortController(), askSignal = AbortSignal.any([signal, expiry.signal])
      const ms = descriptor.params.autoResolutionMs
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) timer = setTimeout(() => expiry.abort(new Error('Native question expired')), Math.min(ms, 2147483647))
      try {
        if (!questions?.ask || !routing) result = { answers: {} }
        else {
          const presented = routing.delegated
            ? descriptor.questions.map(question => ({
              ...question,
              header: question.header ? `子代理 ${routing.subagentLabel} · ${question.header}` : `子代理 ${routing.subagentLabel}`,
            }))
            : descriptor.questions
          this.#enterWait()
          let answer
          try {
            answer = await untilAborted(Promise.resolve().then(() => questions.ask({ agent: routing.target, questions: presented, signal: askSignal })), askSignal)
          } finally { this.#leaveWait() }
          result = nativeQuestionAnswer(descriptor, answer)
        }
      } catch (error) {
        if ((!signal.aborted && expiry.signal.aborted) || ['NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE'].includes(error?.code)) result = { answers: {} }
        else throw error
      } finally { clearTimeout(timer) }
      this.#log(entry, 'decision', { result, ...(delegatedTo ? { delegatedTo } : {}) })
    }
    await this.#flush()
    if (this.#closed || signal.aborted || entry.state !== 'pending' || this.#parent.aborted) return
    // Mark before the write: a failed/uncertain write must never be resubmitted.
    entry.state = 'writing'
    await this.#peer.respond(entry.message.id, result)
    entry.state = 'written'
    this.#log(entry, 'written')
    await this.#flush()
  }
}
