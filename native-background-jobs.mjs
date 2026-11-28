/**
 * Mirrors background work that Codex / Claude Code run natively into DSH's
 * `ctx.jobs`, so it appears in the native background task list with output,
 * status and stop. DSH never executes or resubmits the work: the engine keeps
 * ownership, this module only observes Host notifications and forwards a
 * human stop request to the engine's own stop mechanism.
 */
export const HOST_COMMAND_JOB = 'host-command'
export const HOST_AGENT_JOB = 'host-agent'

const OUTPUT_LIMIT_BYTES = 64 * 1024
const STOP_CONFIRM_MS = 15_000
const LIVE_AGENT = new Set(['pendingInit', 'running'])
const AGENT_STATUS = { pendingInit: '等待启动', running: '运行中', completed: '已完成', errored: '失败', interrupted: '已中断', shutdown: '已关闭', notFound: '已不存在' }
const ENGINE = { codex: 'Codex', 'claude-code': 'Claude', antigravity: 'Antigravity' }

const key = (kind, threadId, id) => `${kind}\u0000${threadId}\u0000${id}`
const oneLine = (text, limit) => {
  const line = String(text ?? '').split(/\r?\n/u).find(value => value.trim()) ?? ''
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line
}

/** Terminal job outcome of a finished native command Item. */
export function commandOutcome(item, outcome) {
  const status = outcome?.status ?? item?.status
  const exit = Number.isInteger(item?.exitCode) ? item.exitCode : undefined
  if (status === 'succeeded' || status === 'completed') {
    if (exit !== undefined && exit !== 0) return { status: 'failed', detail: `exit code: ${exit}` }
    return { status: 'completed', ...(exit === undefined ? {} : { detail: `exit code: ${exit}` }) }
  }
  if (status === 'cancelled' || status === 'interrupted' || status === 'declined') return { status: 'killed', detail: outcome?.reason ?? '引擎已停止该任务' }
  if (status === 'failed') return { status: 'failed', detail: outcome?.error?.message ?? item?.error?.message ?? (exit === undefined ? '引擎报告失败' : `exit code: ${exit}`) }
  return { status: 'failed', detail: `引擎返回未知结束状态：${String(status)}` }
}

/** Terminal job outcome for a native subagent state, or undefined while it is live. */
export function agentOutcome(state) {
  switch (state?.status) {
    case 'completed': return { status: 'completed', ...(state.message ? { result: state.message } : {}) }
    case 'errored': case 'notFound': return { status: 'failed', detail: state.message || AGENT_STATUS[state.status] }
    case 'interrupted': case 'shutdown': return { status: 'killed', detail: state.message || AGENT_STATUS[state.status] }
    default: return undefined
  }
}

export class NativeBackgroundJobs {
  #ctx
  #entries = new Map()
  #peers = new WeakSet()
  #disposed = false

  constructor(ctx) { this.#ctx = ctx }

  get #jobs() { return this.#ctx.get?.('jobs') }

  /** Follow one Host connection for the life of that connection. */
  attach(peer) {
    if (this.#peers.has(peer)) return
    this.#peers.add(peer)
    const off = peer.subscribe(message => this.#accept(peer, message))
    void peer.closed.then(() => {
      off()
      this.#abandon(entry => entry.peer === peer, 'DSH 与 Host 的连接已断开，无法继续确认此任务状态；引擎侧任务可能已随 Host 结束。')
    })
  }

  /** Plugin unload must not stop engine work; release DSH tracking honestly instead. */
  dispose() {
    this.#disposed = true
    this.#abandon(() => true, 'DSH Host 插件已卸载，DSH 不再跟踪此任务；引擎侧任务可能仍在运行。')
  }

  /**
   * Register a command the engine continues in the background.
   * @returns the DSH job id, or an error message when the registry refused it.
   */
  registerCommand({ peer, agent, harnessId, threadId, itemId, command, callId, seed }) {
    const id = key(HOST_COMMAND_JOB, threadId, itemId)
    if (this.#entries.has(id)) return { jobId: this.#entries.get(id).jobId }
    return this.#start({ id, kind: HOST_COMMAND_JOB, peer, agent, harnessId, threadId, itemId, callId, seed,
      label: oneLine(command, 200) || `${ENGINE[harnessId] ?? harnessId} 后台命令` })
  }

  /**
   * Subagent identities named by a collaboration Item. Claude delegations are one
   * Item per subagent whose id moves from the tool call to the materialized Host
   * Thread, so they are keyed by Item; Codex subagents are Threads reused by later
   * wait/send Items, so they are keyed by Thread.
   */
  static agentTargets(harnessId, threadId, item) {
    const receivers = (Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds : []).filter(value => typeof value === 'string' && value)
    const states = item?.agentsStates ?? {}
    const itemId = item?.id ?? item?.itemId
    if (harnessId === 'claude-code' || harnessId === 'antigravity') return receivers.length && typeof itemId === 'string' ? [{ id: key(HOST_AGENT_JOB, threadId, 'item:' + itemId), agentId: receivers[0], state: states[receivers[0]] }] : []
    return receivers.map(agentId => ({ id: key(HOST_AGENT_JOB, threadId, agentId), agentId, state: states[agentId] }))
  }

  /** Register native subagents named by a collaboration Item seen during a Turn. */
  observeAgents({ peer, agent, harnessId, threadId, item, callId }) {
    for (const { id, agentId, state } of NativeBackgroundJobs.agentTargets(harnessId, threadId, item)) {
      if (this.#entries.has(id) || !LIVE_AGENT.has(state?.status)) continue
      const prompt = oneLine(item.prompt, 120)
      const started = this.#start({ id, kind: HOST_AGENT_JOB, peer, agent, harnessId, threadId, agentId, callId,
        label: `${ENGINE[harnessId] ?? harnessId} 子代理：${prompt || agentId.slice(0, 12)}` })
      const entry = this.#entries.get(id)
      if (started.jobId && entry) this.#applyAgentState(entry, state)
    }
  }

  #start(spec) {
    const jobs = this.#jobs
    if (jobs === undefined || this.#disposed) return { error: 'DSH 后台任务服务不可用' }
    const entry = { ...spec, owner: spec.agent.id, jobId: undefined, handle: undefined, resolve: undefined, settled: false,
      cancelRequested: false, running: false, appended: false, lastMessage: undefined, timer: undefined }
    delete entry.agent; delete entry.seed
    try {
      entry.jobId = jobs.start({ kind: spec.kind, label: spec.label, owner: entry.owner, outputLimitBytes: OUTPUT_LIMIT_BYTES,
        ...(spec.callId ? { toolCall: { callId: spec.callId, rootCallId: spec.callId } } : {}),
        run: job => {
          entry.handle = job
          if (spec.seed) { job.append(spec.seed); entry.appended = true }
          job.updateProgress(spec.kind === HOST_AGENT_JOB ? '由引擎管理' : `${ENGINE[spec.harnessId] ?? spec.harnessId} 后台运行中`)
          const done = new Promise(resolve => { entry.resolve = resolve })
          return { cancel: reason => this.#cancel(entry, reason), done }
        } })
    } catch (error) {
      this.#ctx.logger?.warn?.(`DSH Host background job unavailable: ${error.message}`)
      return { error: error.message }
    }
    this.#entries.set(spec.id, entry)
    return { jobId: entry.jobId }
  }

  #accept(peer, message) {
    const params = message.params ?? {}
    const threadId = params.threadId
    if (typeof threadId !== 'string' || this.#entries.size === 0) return
    try {
      if (message.method === 'item/commandExecution/outputDelta') {
        const entry = this.#entries.get(key(HOST_COMMAND_JOB, threadId, params.itemId))
        if (entry?.peer === peer && !entry.settled && typeof params.delta === 'string' && params.delta) { entry.handle.append(params.delta); entry.appended = true }
        return
      }
      if (message.method === 'thread/status/changed') {
        // A materialized subagent Thread reports its own activity.
        for (const entry of this.#entries.values()) {
          if (entry.peer !== peer || entry.kind !== HOST_AGENT_JOB || entry.agentId !== threadId || entry.settled) continue
          if (params.status?.type === 'active') entry.running = true
          else if (params.status?.type === 'idle' && entry.running) this.#settle(entry, { status: 'completed', detail: '子代理线程已空闲；完整结果以引擎回复为准' })
        }
        return
      }
      if (!['item/started', 'item/completed', 'codexhost/item/completed'].includes(message.method)) return
      const item = params.item
      if (item?.type === 'collabAgentToolCall') {
        for (const harnessId of ['claude-code', 'codex', 'antigravity']) {
          for (const target of NativeBackgroundJobs.agentTargets(harnessId, threadId, item)) {
            const entry = this.#entries.get(target.id)
            if (entry?.peer !== peer || entry.harnessId !== harnessId || entry.settled) continue
            entry.agentId = target.agentId
            this.#applyAgentState(entry, target.state)
          }
        }
        return
      }
      if (message.method === 'item/started' || item?.type !== 'commandExecution') return
      const entry = this.#entries.get(key(HOST_COMMAND_JOB, threadId, item.itemId ?? item.id))
      if (entry?.peer !== peer || entry.settled) return
      const text = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : typeof item.output === 'string' ? item.output : undefined
      if (!entry.appended && text) entry.handle.append(text)
      this.#settle(entry, commandOutcome(item, params.outcome))
    } catch (error) { this.#ctx.logger?.warn?.(`DSH Host background job update failed: ${error.message}`) }
  }

  #applyAgentState(entry, state) {
    if (!state) return
    if (LIVE_AGENT.has(state.status)) entry.running = true
    entry.handle.updateProgress(AGENT_STATUS[state.status] ?? String(state.status))
    if (typeof state.message === 'string' && state.message && state.message !== entry.lastMessage) {
      entry.lastMessage = state.message
      if (state.status !== 'completed') entry.handle.append(state.message.endsWith('\n') ? state.message : state.message + '\n')
    }
    const outcome = agentOutcome(state)
    if (outcome) this.#settle(entry, outcome)
  }

  /** Synchronous and idempotent per the JobHooks contract; the engine confirms the stop. */
  #cancel(entry, reason) {
    if (entry.settled || entry.cancelRequested) return
    if (this.#disposed) { this.#settle(entry, { status: 'failed', detail: 'DSH Host 插件已卸载，未向引擎发送停止请求' }); return }
    let request
    if (entry.harnessId === 'codex') {
      if (entry.kind === HOST_AGENT_JOB) throw new Error('Codex 子代理由 Codex 自身管理，DSH 不能单独停止它；请在对话中让 Codex 关闭该子代理')
      const siblings = [...this.#entries.values()].filter(other => other !== entry && !other.settled && other.peer === entry.peer && other.threadId === entry.threadId && other.kind === HOST_COMMAND_JOB)
      if (siblings.length > 0) throw new Error('Codex 只能一次停止此会话的全部后台终端；为避免误停其他终端，DSH 未发送停止请求')
      request = () => entry.peer.request('thread/backgroundTerminals/clean', { threadId: entry.threadId }, { timeoutMs: STOP_CONFIRM_MS })
    } else {
      request = () => entry.peer.request('dsh/host/task/stop', { threadId: entry.threadId, ...(entry.kind === HOST_AGENT_JOB ? { agentId: entry.agentId } : { itemId: entry.itemId }) }, { timeoutMs: STOP_CONFIRM_MS })
    }
    entry.cancelRequested = true
    entry.handle.updateProgress('正在请求引擎停止')
    void Promise.resolve().then(request).then(() => {
      // Codex reports cleaned terminals through Item completion; settle it if that never arrives.
      entry.timer = setTimeout(() => this.#settle(entry, { status: 'killed', detail: `${reason ? reason + '；' : ''}已请求引擎停止，但未在 ${STOP_CONFIRM_MS / 1000} 秒内收到结束通知` }), STOP_CONFIRM_MS)
      entry.timer.unref?.()
    }, error => {
      if (entry.settled) return
      entry.handle.append(`\n[DSH] 停止请求失败：${error.message}\n`)
      this.#settle(entry, { status: 'failed', detail: `停止请求失败（${error.message}）；引擎侧任务可能仍在运行` })
    })
  }

  #settle(entry, outcome) {
    if (entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    this.#entries.delete(entry.id)
    // The engine already tells its own model; a live wait marks this settlement
    // collected so tool-jobs does not inject a duplicate notice into the Host Turn.
    try { void this.#jobs?.wait(entry.jobId, 60_000, entry.owner).catch(() => undefined) } catch {}
    entry.resolve?.(outcome)
  }

  #abandon(predicate, detail) {
    for (const entry of [...this.#entries.values()]) if (predicate(entry)) this.#settle(entry, { status: 'failed', detail })
  }

  /** Live entries, for tests and diagnostics. */
  get size() { return this.#entries.size }
}
