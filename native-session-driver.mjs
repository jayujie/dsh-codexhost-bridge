import { UNLOAD_REASON } from './subagent-settlement.mjs'
import { hostRecord, isHostRecord } from './host-identity.mjs'
import { randomUUID, createHash } from 'node:crypto'
import { EXTERNAL_PRESETS, EXTERNAL_ENGINE_IDS, LEGACY_PRESET_IDS, engineLabel, hostProvider, presetForEngine } from './external-engines.mjs'
import { HostConnectionError, connectNativeHost } from './native-host-client.mjs'
import { NativeTurnProjector } from './native-turn-projector.mjs'
import { compactToolItemMeta } from './native-tool-projector.mjs'
import { encodeNativeHarnessRoute } from './harness-route.mjs'
import { CODEX_PERMISSION_MODES, codexPermissionMode, codexPermissionParameters } from './codex-permissions.mjs'
import { thinkingEfforts, selectedThinkingEffort } from './thinking-options.mjs'
import { OBSERVATION, OBSERVATION_TYPES, ZERO_USAGE, hasBillingCounters, observedUsage, observedCost, mergeObservedUsage, turnTimingUsage, turnUsage, acceptNativeTitle } from './native-observations.mjs'
import { completeExternalTitle, collectTitleMessages, extractUserMessageTexts, readNativeAntigravityTitle, syncNativeAgentTitle } from './native-title.mjs'
import { completeNativeClaudeTitle } from './native-claude-title.mjs'
import { readNativeCompactionSummary } from './native-compaction-summary.mjs'
import { DELEGATION_AGENTS, selectedDelegationTargets } from './delegation-mentions.mjs'
import { nativeDelegationInstruction, nativeTargetPreset } from './native-delegation.mjs'
import { COLLABORATION_SCHEMA } from './host-collaboration.mjs'
import { NativeInteractionBridge } from './native-interactions.mjs'
import { nativeImageInput, resolveWorkspaceImage } from './native-attachments.mjs'
import { NativeBackgroundJobs } from './native-background-jobs.mjs'
import { HOST_TURN_FAILURE, observedTurnFailure } from './native-turn-failure.mjs'
import { isBusyStartRejection, rejectedStartEvidence, inspectRejectedStart } from './rejected-start.mjs'
import { NativeReplySync, waitForNativeIdle } from './native-replies.mjs'
import { AutonomousTeamCollaboration } from './autonomous-team-collaboration.mjs'
import { NATIVE_COMMAND_NAMES, NATIVE_COMMAND_ENGINES, nativeCommandInput, nativeCommandDescriptor } from './native-commands.mjs'
import { NativeLiveStatusTracker, createAntigravityStartupLogWatcher, engineDisplayLabel, shouldAcceptAntigravityMilestone } from './native-live-status.mjs'
import { defaultPresetForLastAgent, isValidLastAgent, readLastAgentSync, writeLastAgent } from './last-agent.mjs'

export { EXTERNAL_PRESETS }
const RECORD = hostRecord('thread')

// DSH environment and DSH-loaded skills do not belong to external engines.
// Filter by provenance, never by text: user quotations survive.
// Collaboration keeps its own registered tool and on-demand discovery/permission checks.
const DSH_ENVIRONMENT_SOURCES = new Set([
  'runtime-context', 'agent-instructions', 'skill-catalog', 'skill-invocation', 'time-context', 'tool-registry',
])
const externalMessages = messages => messages.filter(message => !DSH_ENVIRONMENT_SOURCES.has(message.source?.kind))

export function nativeThreadState(session) {
  const event = session.snapshotEvents().findLast(event => isHostRecord(event.type, 'thread') && event.ignorable === true)
  if (event === undefined) return undefined
  const state = event.data
  if (state?.version !== 1 || !EXTERNAL_ENGINE_IDS.includes(state.harnessId)
    || !['creating', 'ready', 'submitted'].includes(state.phase)
    || (state.phase !== 'creating' && (typeof state.threadId !== 'string' || state.threadId === ''))) {
    throw new HostConnectionError('HOST_MAPPING_INVALID', 'The saved DSH Host session mapping is invalid; execution was stopped')
  }
  return state
}

/** An external Turn driver over the existing Agent pre-step extension. No LLM adapter. */
export class NativeSessionDriver {
  #ctx
  #helpers
  #connect
  #peer
  #connecting
  #active = new Map()
  #revisions = new WeakMap()
  #configWrites = new WeakMap()
  #stopped = false
  #observationOf
  #titlePolicy
  #metadataAbort = new AbortController()
  #nativeInteractionApprovals
  #usageRefreshing = new Map()
  #titleTasks = new Map()
  #lastTitleTrigger = new Map()
  #catalogReads = new Map()
  #preheats = new Set()
  #collaboration
  #background
  #replies
  #autonomousTeam
  #hostConfig
  #readCompactionSummary
  #syncNativeAgentTitle
  #liveStatus = new NativeLiveStatusTracker()
  #lastAgentPath
  #lastUsedAgent
  #lastAgentWrite = Promise.resolve()

  liveStatus(agent) {
    return this.#liveStatus.snapshot(agent?.id)
  }

  setCollaboration(manager) {
    this.#collaboration = manager
    this.#autonomousTeam = new AutonomousTeamCollaboration(this.#ctx, this.#helpers, {
      connect: () => this.#connection(), owner: agent => this.owner(agent),
      isRequested: agent => this.#active.has(agent.id), isStopped: () => this.#stopped,
      lifecycleSignal: this.#metadataAbort.signal, bound: result => manager.bound(result),
    })
  }
  callAutonomousCollaboration(request) { return this.#autonomousTeam?.call(request) }
  collaborationFor(threadId) {
    if (typeof threadId !== 'string') return undefined
    return [...this.#active.values()].find(entry => entry.threadId === threadId)?.lease
  }

  #catalogRead(peer, method, params, key) {
    const previous = this.#catalogReads.get(key)
    if (previous && previous.expires > Date.now()) return previous.promise
    const entry = { expires: Date.now() + 60000 }
    entry.promise = peer.request(method, params).then(result => {
      if (result.status === 'error' || result.status === 'unavailable') this.#catalogReads.delete(key)
      return result
    }, error => { this.#catalogReads.delete(key); throw error })
    this.#catalogReads.set(key, entry)
    return entry.promise
  }

  constructor(ctx, helpers, { connect = connectNativeHost, turnTimeoutMs = 600_000, cancelTimeoutMs = 10_000, observationOf = () => undefined, titlePolicy = { enabled: false }, nativeInteractionApprovals = false, hostConfig = {}, lastAgentPath, readCompactionSummary = readNativeCompactionSummary, syncNativeAgentTitle: syncNativeTitle = syncNativeAgentTitle } = {}) {
    this.#ctx = ctx
    this.#helpers = helpers
    this.#connect = connect
    this.turnTimeoutMs = turnTimeoutMs
    this.cancelTimeoutMs = cancelTimeoutMs
    this.#observationOf = observationOf
    this.#titlePolicy = titlePolicy
    this.#nativeInteractionApprovals = nativeInteractionApprovals
    this.#hostConfig = hostConfig
    this.#lastAgentPath = lastAgentPath
    this.#lastUsedAgent = lastAgentPath ? readLastAgentSync(lastAgentPath) : undefined
    this.#readCompactionSummary = readCompactionSummary
    this.#syncNativeAgentTitle = syncNativeTitle
    this.#background = new NativeBackgroundJobs(ctx)
    if (ctx.agents?.list) this.#replies = new NativeReplySync(ctx, helpers, {
      connect: () => this.#connection(), owner: agent => this.owner(agent),
      isRequested: (threadId, turnId) => [...this.#active.values()].some(entry => entry.threadId === threadId && (entry.submitting || entry.hostTurnId === turnId)),
    })
  }

  lastUsedAgent() { return this.#lastUsedAgent }

  #rememberLastAgent(agentId) {
    if (!isValidLastAgent(agentId)) return
    this.#lastUsedAgent = agentId
    if (!this.#lastAgentPath) return
    const targetPath = this.#lastAgentPath
    this.#lastAgentWrite = this.#lastAgentWrite
      .then(() => writeLastAgent(targetPath, agentId))
      .catch(error => this.#ctx.logger?.warn(`DSH Host last-agent persistence unavailable: ${error?.code ?? error?.message ?? String(error)}`))
  }

  async #applyLastUsedAgent(agent, source) {
    if (this.#stopped || source !== 'startup' || !agent?.session) return
    const header = agent.session.header
    if (header?.origin === 'subagent' || header?.parentSession !== undefined || header?.isSeeded === true) return
    const preset = defaultPresetForLastAgent(this.#lastUsedAgent)
    if (!preset) return
    const presets = this.#ctx.agentPresets
    if (!presets?.select) return
    const current = presets.presetForSession?.(agent.session)
    if (current && EXTERNAL_PRESETS[current] !== undefined) return
    if (current && presets.defaultId && current !== presets.defaultId) return
    const boundary = this.#ctx.agents?.turnBoundaryOf?.(agent.session)
    if (boundary && (boundary.lastTurn !== 0 || boundary.openTurnStartSeq !== null)) return
    if (agent.session.snapshotEvents?.().some(event => event.type === 'agent-preset/selected')) return
    try {
      if (current && EXTERNAL_PRESETS[current] === undefined) {
        this.#helpers.appendPluginRecord?.(agent.session, hostRecord('original-preset'), { preset: current })
      }
      await presets.select(agent, preset)
      await this.#ctx.sessionPersistence?.flush?.()
    } catch (error) {
      this.#ctx.logger?.warn(`DSH Host default agent selection skipped: ${error?.code ?? error?.message ?? String(error)}`)
    }
  }

  owner(agent) { return EXTERNAL_PRESETS[this.#ctx.agentPresets.presetForSession(agent.session)] }
  available() { return !this.#stopped }
  threadFor(agent) { return this.owner(agent) ? nativeThreadState(agent.session)?.threadId : undefined }
  // Same-process console capability; never registered as a public RPC method.
  consoleConnection() { return this.#connection() }

  submitCommand(agent, name, rawInput, signal) {
    signal.throwIfAborted()
    const harness = this.owner(agent)
    if (this.#stopped || !NATIVE_COMMAND_ENGINES.includes(harness) || !NATIVE_COMMAND_NAMES.includes(name)) throw new HostConnectionError('HOST_COMMAND_UNSUPPORTED', '当前引擎未适配此原生命令，未发送任务')
    const message = this.#helpers.createUserMessage({ content: [{ type: 'text', text: `/${name}${rawInput ? ' ' + rawInput.trimStart() : ''}` }], source: { kind: 'user' } })
    nativeCommandInput([message]) // Validate before admission, including direct Remote callers.
    agent.followup(message)
    return { kind: 'success', text: `已提交 ${engineLabel(harness)} 原生 /${name}；执行结果见会话，忙碌时按队列执行` }
  }

  async keepalive(sessionId, { expectedReply, maxCostUsd, signal }) {
    const agent = this.#ctx.agents.list().find(value => value.id === sessionId)
    if (!agent || this.owner(agent) !== 'claude-code' || agent.session.header.origin === 'subagent') throw new Error('仅支持已加载的主 Claude 会话')
    let admitted = false
    try { return await agent.runMaintenance(async () => {
      admitted = true
      const mapping = this.#recoveryState(agent)
      if (!mapping || mapping.phase !== 'ready' || this.#active.has(agent.id)) throw new Error('Claude 会话忙碌或结果尚未确认')
      // A detached DSH job does not make an idle conversation busy. Keepalive
      // forks without persisting or executing tools; runMaintenance serializes
      // any job-completion wake behind it. Native thread busy checks still apply.
      signal.throwIfAborted()
      const peer = await this.#connection(), operationId = randomUUID()
      signal.throwIfAborted()
      const cancel = () => { void peer.request('dsh/claude/keepalive/cancel', { threadId: mapping.threadId, operationId }, { timeoutMs: 10000 }).catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      try { return await peer.request('dsh/claude/keepalive', { threadId: mapping.threadId, operationId, expectedReply, maxCostUsd }, { timeoutMs: 90000 }) }
      finally { signal.removeEventListener('abort', cancel) }
    }) } catch (error) {
      // Only an exact local admission failure can be retried safely. Anything
      // after callback entry (including uncertain mapping/RPC outcomes) is not.
      if (!admitted && error?.message === `agent "${agent.id}" already has active work` && typeof agent.whenIdle === 'function') {
        throw Object.assign(new Error('会话正在运行或维护，保活等待空闲'), {
          code: 'HOST_KEEPALIVE_BUSY', requestDispatched: false,
          whenIdle: () => agent.whenIdle(),
        })
      }
      throw error
    }
  }

  // Account-scoped auxiliary request: no Agent, Thread or conversation context.
  async preheat({ signal }) {
    if (this.#preheats.size) throw new Error('Host Claude 预热正在执行')
    const combined = AbortSignal.any([signal, this.#metadataAbort.signal])
    const operation = (async () => {
      combined.throwIfAborted()
      const peer = await this.#connection(), operationId = randomUUID()
      combined.throwIfAborted()
      const cancel = () => { void peer.request('dsh/claude/preheat/cancel', { operationId }, { timeoutMs: 10000 }).catch(() => {}) }
      combined.addEventListener('abort', cancel, { once: true })
      try {
        const result = await peer.request('dsh/claude/preheat', { operationId }, { timeoutMs: 70000 })
        combined.throwIfAborted()
        return result
      } finally { combined.removeEventListener('abort', cancel) }
    })()
    this.#preheats.add(operation)
    try { return await operation } finally { this.#preheats.delete(operation) }
  }

  configuration(agent) {
    const harnessId = this.owner(agent)
    return agent.session.snapshotEvents().findLast(event => isHostRecord(event.type, 'configuration') && event.ignorable === true && event.data.harnessId === harnessId)?.data ?? {}
  }

  async selectAgent(agent, agentId) {
    return agent.runMaintenance(async () => {
      const boundary = this.#ctx.agents.turnBoundaryOf(agent.session)
      if (boundary.lastTurn !== 0 || boundary.openTurnStartSeq !== null) throw new HostConnectionError('HOST_AGENT_LOCKED', 'The Agent cannot be changed after the first Turn')
      let preset
      if (agentId === 'deepseek-harness') {
        preset = agent.session.snapshotEvents().findLast(event => isHostRecord(event.type, 'original-preset') && event.ignorable === true)?.data.preset ?? this.#ctx.agentPresets.defaultId
      } else {
        if (!EXTERNAL_ENGINE_IDS.includes(agentId)) throw new HostConnectionError('HOST_AGENT_INVALID', 'Unsupported Agent')
        preset = presetForEngine(agentId)
        const current = this.#ctx.agentPresets.presetForSession(agent.session)
        if (current && EXTERNAL_PRESETS[current] === undefined) this.#helpers.appendPluginRecord(agent.session, hostRecord('original-preset'), { preset: current })
      }
      await this.#ctx.agentPresets.select(agent, preset)
      await this.#ctx.sessionPersistence.flush()
      this.#rememberLastAgent(agentId)
      return preset
    })
  }

  async catalog(agent, targetEngine, childDefaults = false) {
    const agentId = targetEngine ?? this.owner(agent) ?? 'deepseek-harness'
    if (agentId === 'deepseek-harness') {
      // Native DSH must not start an external execution backend for price decoration.
      return { agentId, status: 'ready', models: [], permissionModes: [], selection: {} }
    }
    try {
      const peer = await this.#connection()
      // Model controls must not wait for transcript/price inspection.
      const saved = targetEngine ? {} : this.configuration(agent)
      const choice = saved.harnessId === agentId ? saved : {}
      const mapped = targetEngine ? undefined : nativeThreadState(agent.session)
      const existing = mapped?.harnessId === agentId ? mapped : undefined
      if (agentId === 'codex') {
        const result = await this.#catalogRead(peer, 'model/list', { limit: 100 }, 'codex')
        const models = result.data.map(model => ({ id: model.model, label: model.displayName ?? model.model,
          thinkingOptions: thinkingEfforts((model.supportedReasoningEfforts ?? []).map(effort => ({ id: effort.reasoningEffort, label: effort.reasoningEffort }))),
        }))
        if (models.length === 0) throw new HostConnectionError('HOST_MODELS_EMPTY', 'The native Codex model catalog is empty')
        const defaultModel = result.data.find(model => model.isDefault) ?? result.data[0]
        const modelId = choice.modelId ?? defaultModel?.model
        const selectedRawModel = result.data.find(model => model.model === modelId)
        const thinkingOptionId = selectedThinkingEffort(models.find(model => model.id === modelId)?.thinkingOptions ?? [], choice.thinkingOptionId, selectedRawModel?.defaultReasoningEffort)
        return { agentId, status: 'ready', models, permissionModes: CODEX_PERMISSION_MODES,
          selection: { modelId, ...(thinkingOptionId ? { thinkingOptionId } : {}), permissionModeId: codexPermissionMode(choice.permissionModeId ?? existing?.appliedConfiguration?.permissionModeId ?? ((childDefaults || agent.session.header.origin === 'subagent') ? 'workspace-write' : 'full-access')) } }
      }
      const catalogKey = agentId
      const result = await this.#catalogRead(peer, 'codexhost/harness/inspect', { harnessId: agentId, cwd: agent.session.header.cwd, refresh: false }, catalogKey)
      if (result.status !== 'ready') return { agentId, status: 'error', error: result.error?.message ?? 'Agent is unavailable' }
      const models = result.catalog.models.map(model => ({ id: model.ref.id, label: model.label, ...(model.resolvedModelLabel ? { resolvedLabel: model.resolvedModelLabel } : {}),
        thinkingOptions: thinkingEfforts((model.thinkingOptions ?? result.catalog.thinkingOptions ?? []).filter(option => model.supportedThinkingOptionIds === undefined || model.supportedThinkingOptionIds.includes(option.id)).map(option => ({ id: option.id, label: option.label }))),
      }))
      if (models.length === 0) throw new HostConnectionError('HOST_MODELS_EMPTY', 'The native Agent model catalog is empty')
      const savedModel = choice.modelId ?? existing?.appliedConfiguration?.modelId
      let modelId, migratedThinkingOptionId
      if (agentId === 'claude-code') {
        const legacyDefault = 'claude-model-v1.' + Buffer.from('default').toString('base64url')
        const preferred = (childDefaults || agent.session.header.origin === 'subagent') ? 'sonnet' : 'opus'
        const preferredId = 'claude-model-v1.' + Buffer.from(preferred).toString('base64url')
        // Retain an existing Thread's model, including legacy default, without a silent migration.
        modelId = savedModel && (savedModel !== legacyDefault || existing !== undefined) ? savedModel : preferredId
        if (!models.some(model => model.id === modelId)) throw new HostConnectionError('HOST_MODEL_UNAVAILABLE', modelId === preferredId ? `Claude ${preferred} is not in the native catalog; no alternative model was selected` : 'The saved Claude model is not in the native catalog; no alternative model was selected')
      } else {
        modelId = savedModel ?? result.catalog.defaultModel?.id ?? result.catalog.defaultModel?.ref?.id ?? models[0]?.id
        if (agentId === 'antigravity' && typeof modelId === 'string' && !models.some(model => model.id === modelId)) {
          const effortMatch = modelId.match(/^(?<base>.+)-(?<effort>low|medium|high|xhigh|max)$/u)
          const merged = effortMatch ? models.find(model => model.id === effortMatch.groups.base && model.thinkingOptions.some(option => option.id === effortMatch.groups.effort)) : undefined
          if (merged) {
            modelId = merged.id
            migratedThinkingOptionId = effortMatch.groups.effort
          }
        }
        if (!models.some(model => model.id === modelId)) throw new HostConnectionError('HOST_MODEL_UNAVAILABLE', `The saved ${engineLabel(agentId)} model is not in the native catalog; no alternative model was selected`)
      }
      const thinkingOptionId = selectedThinkingEffort(models.find(model => model.id === modelId)?.thinkingOptions ?? [], choice.thinkingOptionId ?? migratedThinkingOptionId, result.catalog.defaultThinkingOptionId)
      const defaultPermissionMode = result.permissionModes?.modes?.some(mode => mode.id === 'bypassPermissions') ? 'bypassPermissions' : (result.permissionModes?.defaultModeId ?? result.permissionModes?.modes?.[0]?.id ?? 'default')
      return { agentId, status: 'ready', models,
        permissionModes: (result.permissionModes?.modes ?? []).map(mode => ({ id: mode.id, label: mode.localizations?.['zh-CN']?.label ?? mode.label, ...(mode.dangerous ? { dangerous: true } : {}) })),
        selection: { modelId, ...(thinkingOptionId ? { thinkingOptionId } : {}),
          permissionModeId: choice.permissionModeId ?? existing?.appliedConfiguration?.permissionModeId ?? defaultPermissionMode },
      }
    } catch (error) { return { agentId, status: 'error', error: error.message, errorCode: error.code ?? 'HOST_CONNECTION_FAILED' } }
  }

  /** Read availability only. Selecting a target never creates or submits a task. */
  async delegationTargets(agent) {
    const peer = await this.#connection()
    // Reverse DSH targets use the same local subagent runtime, not a second Web instance.
    const candidates = DELEGATION_AGENTS.filter(target => target.id !== 'deepseek-harness' || this.#collaboration)
    const targets = await Promise.all(candidates.map(async target => {
      try {
        if (target.id === 'deepseek-harness') { nativeTargetPreset(this.#ctx, this, agent); return { ...target, status: 'ready' } }
        if (target.id === 'codex') {
          const result = await peer.request('model/list', { limit: 1 }, { timeoutMs: 15000 })
          return { ...target, status: result.data?.length ? 'ready' : 'unavailable' }
        }
        const result = await peer.request('codexhost/harness/inspect', { harnessId: target.id, cwd: agent.session.header.cwd, purpose: 'availability', refresh: false }, { timeoutMs: target.id === 'antigravity' ? 60000 : 15000 })
        return { ...target, status: result.status === 'ready' ? 'ready' : 'unavailable' }
      } catch (error) { return { ...target, status: 'unavailable' } } // Do not expose upstream diagnostics or silently select another Agent.
    }))
    return { targets }
  }

  #recoveryState(agent) {
    if (!this.available()) throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host session driver is unavailable')
    const state = nativeThreadState(agent.session)
    if (!this.owner(agent) || (state && state.harnessId !== this.owner(agent))) throw new HostConnectionError('HOST_OWNER_CONFLICT', 'Recovery requires this conversation’s external Agent')
    if (state && ((state.sessionId !== undefined && state.sessionId !== agent.id) || (agent.session.header.parentSession !== undefined && state.sessionId !== agent.id))) throw new HostConnectionError('HOST_FORK_PENDING', 'A DSH fork cannot reconcile its parent Host Thread')
    return state
  }

  /** Read-only outcome check. No resume, interrupt, model call or replay. */
  async recovery(agent) {
    const state = this.#recoveryState(agent)
    if (this.#active.has(agent.id)) return { status: 'running', reason: 'local-active' }
    if (!state || state.phase === 'ready') return { status: 'clear', reason: 'no-pending' }
    if (state.phase === 'creating' && state.notDispatched === true) return { status: 'clear', reason: 'not-sent' }
    if (state.phase !== 'submitted' || typeof state.hostTurnId !== 'string' || !state.hostTurnId) return { status: 'blocked', reason: 'identity-missing' }
    const expected = createHash('sha256').update(JSON.stringify(state)).digest('hex')
    const peer = await this.#connection()
    const inspect = async () => (await peer.request('thread/read', { threadId: state.threadId, includeTurns: false }, { timeoutMs: 15000 })).thread
    const before = await inspect()
    if (before?.id !== state.threadId) throw new HostConnectionError('HOST_RECOVERY_MISMATCH', 'Host returned a different Thread')
    if (before.status?.type === 'active') return { status: 'running', reason: 'remote-active' }
    if (before.status?.type !== 'idle') return { status: 'blocked', reason: 'status-unknown' }
    // Newest Turn only, for legacy and paginated Threads alike: a full legacy history
    // read (9.5 MB for a long Claude Session) is not needed to compare one Turn identity.
    const page = await peer.request('thread/turns/list', { threadId: state.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, { timeoutMs: 15000 })
    if (!Array.isArray(page.data) || page.data.length !== 1) return { status: 'blocked', reason: 'turn-missing' }
    const latest = page.data[0]
    if (!latest || latest.id !== state.hostTurnId) return { status: 'blocked', reason: 'turn-missing' }
    if (latest.status === 'inProgress') return { status: 'running', reason: 'remote-active' }
    if (!['completed', 'failed', 'interrupted'].includes(latest.status)) return { status: 'blocked', reason: 'status-unknown' }
    const after = await inspect()
    if (after?.id !== before.id || after.status?.type !== 'idle' || after.updatedAt !== before.updatedAt) return { status: 'blocked', reason: 'history-changed' }
    if (this.#active.has(agent.id) || JSON.stringify(this.#recoveryState(agent)) !== JSON.stringify(state)) throw new HostConnectionError('HOST_RECOVERY_STALE', 'Conversation changed while checking; check again')
    return { status: 'recoverable', reason: 'terminal-confirmed', expected, outcome: latest.status }
  }

  /** Commit only an explicitly acknowledged, freshly rechecked terminal outcome. */
  async reconcile(agent, confirmation) {
    if (confirmation?.acknowledgeStopped !== true || !/^[a-f0-9]{64}$/.test(confirmation.expected ?? '')) throw new HostConnectionError('HOST_RECOVERY_CONFIRMATION', 'Stop the source client and explicitly acknowledge recovery')
    return agent.runMaintenance(async () => {
      const result = await this.recovery(agent)
      if (result.status !== 'recoverable' || result.expected !== confirmation.expected) throw new HostConnectionError('HOST_RECOVERY_STALE', 'Outcome is not confirmed or the conversation changed; check again')
      const state = this.#recoveryState(agent)
      this.#helpers.appendPluginRecord(agent.session, hostRecord('reconciled'), { version: 1, threadId: state.threadId, hostTurnId: state.hostTurnId, outcome: result.outcome, checkedAt: Date.now(), historyReplayed: false })
      const { hostTurnId, localTurn, ...ready } = state
      await this.#save(agent.session, { ...ready, phase: 'ready', lastHostTurnId: hostTurnId })
      return { status: 'recovered', reason: 'unlocked', outcome: result.outcome }
    })
  }

  #serializeConfiguration(session, task) {
    const previous = this.#configWrites.get(session) ?? Promise.resolve()
    const current = previous.then(task)
    const cleanup = current.then(() => undefined, () => undefined).then(() => {
      if (this.#configWrites.get(session) === cleanup) this.#configWrites.delete(session)
    })
    this.#configWrites.set(session, cleanup)
    return current
  }

  async configure(agent, configuration) {
    // Match native DSH model/permission selection: allow updating durable
    // next-turn configuration while a turn is running without runMaintenance(),
    // serializing concurrent writes per session so partial updates never race.
    return this.#serializeConfiguration(agent.session, async () => {
      const catalog = await this.catalog(agent)
      if (this.#stopped) throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host session driver is unavailable')
      if (catalog.agentId === 'deepseek-harness' || catalog.status !== 'ready') throw new HostConnectionError('HOST_CONFIG_UNAVAILABLE', catalog.error ?? 'Select an external Agent before configuring it')
      if (catalog.agentId === 'claude-code' && Object.hasOwn(configuration, 'modelId') && configuration.modelId === 'claude-model-v1.' + Buffer.from('default').toString('base64url')) throw new HostConnectionError('HOST_MODEL_INVALID', 'The default alias is no longer selectable; choose Opus, Sonnet or another advertised model')
      const selected = { ...catalog.selection, ...configuration }
      const model = catalog.models.find(model => model.id === selected.modelId)
      if (model === undefined) throw new HostConnectionError('HOST_MODEL_INVALID', 'This model does not belong to the selected Agent')
      if (!Object.hasOwn(configuration, 'thinkingOptionId') && !model.thinkingOptions.some(option => option.id === selected.thinkingOptionId)) {
        if (model.thinkingOptions.length > 0) {
          const order = ['low', 'medium', 'high', 'xhigh', 'max']
          const prevRank = order.indexOf(selected.thinkingOptionId)
          const maxRank = order.indexOf(model.thinkingOptions.at(-1).id)
          selected.thinkingOptionId = prevRank > maxRank && maxRank >= 0 ? model.thinkingOptions.at(-1).id : model.thinkingOptions[0].id
        } else delete selected.thinkingOptionId
      }
      if (selected.thinkingOptionId && !model.thinkingOptions.some(option => option.id === selected.thinkingOptionId)) throw new HostConnectionError('HOST_THINKING_INVALID', 'This thinking option is unavailable for the selected model')
      if (!catalog.permissionModes.some(mode => mode.id === selected.permissionModeId)) throw new HostConnectionError('HOST_PERMISSION_INVALID', 'This permission mode does not belong to the selected Agent')
      this.#helpers.appendPluginRecord(agent.session, hostRecord('configuration'), { harnessId: catalog.agentId, ...selected })
      await this.#ctx.sessionPersistence?.flush?.()
      return { ...catalog, selection: selected }
    })
  }

  #stepBoundary({ agent, turn, step }) {
    return agent.session.snapshotEvents().findLast(event =>
      (event.type === 'step/start' || event.type === 'step/end') && event.data.turn === turn && event.data.step === step)
  }

  #assertStepAvailable(payload) {
    if (this.#stepBoundary(payload) !== undefined) throw new HostConnectionError('HOST_STEP_ALREADY_STARTED', 'This Host step has already started; refusing to repeat its request')
  }

  install() {
    this.#replies?.install()
    this.#ctx.on('agent/pre-step', async (payload, next) => {
      if (!this.owner(payload.agent)) return next()
      this.#assertStepAvailable(payload)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      // A retained legacy preset can execute this step inside next(). Its
      // recorded boundary is the receipt; never send a second Turn.
      if (this.#stepBoundary(payload)?.type === 'step/end') return { kind: 'enter', messages: [] }
      this.#assertStepAvailable(payload)
      const messages = externalMessages(decision.messages)
      if (messages.length === 0) return { ...decision, messages }
      await this.run({ ...payload, messages })
      return { kind: 'enter', messages: [] }
    }, { prepend: true })
    this.#ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.#stopped || this.owner(agent) === undefined) return
      // A zero-model Turn returns before the default loop's queue drain.
      // Re-admit the same identified pending item once to wake its next Turn.
      const target = agent.inbox.nextStep.length > 0 ? 'next-step' : 'next-turn'
      const pending = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
      if (pending.length === 0) return
      const [message] = agent.inbox.splice(target, 0, 1, [])
      if (message !== undefined) agent.followup(message)
    })
    // Mirror manual DSH user renames back into Host/Codex and native Claude/Antigravity storage.
    this.#ctx.on('session/event', (session, event) => {
      if (this.#stopped || event?.type !== 'session/title' || event.data?.source?.kind !== 'user') return
      const title = typeof event.data.title === 'string' ? event.data.title.trim() : ''
      if (!title) return
      try {
        const state = nativeThreadState(session)
        if (!state?.threadId || (state.sessionId !== undefined && state.sessionId !== session.id)) return
        if (this.#peer) {
          void this.#peer.request('thread/name/set', { threadId: state.threadId, name: title }, { timeoutMs: 10_000 })
            .catch(error => this.#ctx.logger?.warn(`Host title sync unavailable: ${error.code ?? error.name}`))
        }
        if (state.harnessId === 'claude-code' || state.harnessId === 'antigravity') {
          void this.#syncNativeAgentTitle({ harnessId: state.harnessId, threadId: state.threadId, title, config: this.#hostConfig, logger: this.#ctx.logger })
            .catch(error => this.#ctx.logger?.warn(`Native title sync unavailable: ${error.code ?? error.name}`))
        }
      } catch {}
    })
    // Trigger automatic title generation as soon as a human prompt enters the inbox
    // (including mid-turn follow-ups queued while the Agent is still running).
    this.#ctx.on('session/event', (session, event) => {
      if (this.#stopped || !this.#titlePolicy?.enabled || event?.type !== 'agent/inbox/spliced') return
      const inserted = event.data?.inserted
      if (!Array.isArray(inserted) || inserted.length === 0) return
      const agent = this.#ctx.agents?.get?.(session.id) ?? { id: session.id, session }
      const harnessId = this.owner(agent)
      if (!harnessId || (harnessId === 'claude-code' && this.#titlePolicy.nativeClaude?.enabled)) return
      const { texts, key } = extractUserMessageTexts(inserted)
      if (texts.length === 0) return
      const state = nativeThreadState(session)
      const baseSeq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : 0
      this.#scheduleExternalTitle(this.#peer ?? null, agent, state ? { ...state, harnessId } : { harnessId }, {
        extraMessages: texts.map(text => ({ seq: baseSeq, text })),
        triggerKey: key,
      })
    })
    this.#ctx.on('agent/created', async payload => {
      await this.#applyLastUsedAgent(payload?.agent, payload?.source)
    })
    this.#ctx.on('session/event', (session, event) => {
      if (this.#stopped || event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
      if (session?.header?.origin === 'subagent') return
      const agent = this.#ctx.agents?.get?.(session.id) ?? { id: session.id, session }
      this.#rememberLastAgent(this.owner(agent) ?? 'deepseek-harness')
    })
    this.#ctx.effect(() => () => this.dispose(), 'dsh-host: native session driver')
  }

  async dispose() {
    this.#stopped = true
    this.#metadataAbort.abort(new Error(UNLOAD_REASON))
    this.#background.dispose()
    for (const { agent } of this.#active.values()) agent.cancel({ kind: 'hook', reason: UNLOAD_REASON }, { keepInbox: true })
    await this.#replies?.close()
    await this.#lastAgentWrite.catch(() => undefined)
    const drained = Promise.allSettled([...this.#active.values()].map(value => value.done).concat([...this.#usageRefreshing.values()], [...this.#titleTasks.values()].map(value => value.promise), [...this.#preheats], this.#autonomousTeam?.drain() ?? []))
    let timer
    await Promise.race([drained, new Promise(resolve => { timer = setTimeout(resolve, this.cancelTimeoutMs) })])
    clearTimeout(timer)
    this.#peer?.close()
    await drained
  }

  async #connection() {
    if (this.#stopped) throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host session driver is unavailable')
    if (this.#peer !== undefined) return this.#peer
    this.#connecting ??= this.#connect().then(peer => {
      if (this.#stopped) { peer.close(); throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host session driver is unavailable') }
      this.#peer = peer
      // Background work outlives its Turn subscription; follow it per connection.
      this.#background.attach(peer)
      this.#replies?.attach(peer)
      const stopTitles = peer.subscribe(message => {
        if (!['thread/name/updated', 'codexhost/thread/usage/updated'].includes(message.method) || this.#stopped) return
        try {
          for (const agent of this.#ctx.agents.list?.() ?? []) {
            const mapping = this.owner(agent) ? nativeThreadState(agent.session) : undefined
            if (mapping?.threadId !== message.params?.threadId) continue
            if (message.method === 'codexhost/thread/usage/updated') {
              if (this.#active.has(agent.id) || this.#usageRefreshing.has(mapping.threadId)) continue
              const pending = this.#observe(peer, agent, mapping, undefined, false)
                .catch(error => this.#ctx.logger?.warn(`DSH Host usage persistence unavailable: ${error.code ?? error.name}`))
                .finally(() => this.#usageRefreshing.delete(mapping.threadId))
              this.#usageRefreshing.set(mapping.threadId, pending)
            } else if (this.#syncNativeTitle(agent, message.params.threadName)) {
              void this.#ctx.sessionPersistence.flush().catch(error => this.#ctx.logger?.warn(`DSH Host title persistence unavailable: ${error.code ?? error.name}`))
            }
          }
        } catch (error) { this.#ctx.logger?.warn(`DSH Host title update unavailable: ${error.code ?? error.name}`) }
      })
      void peer.closed.then(stopTitles)
      void peer.closed.then(() => { if (this.#peer === peer) { this.#peer = undefined; this.#catalogReads.clear() } })
      return peer
    }).finally(() => { this.#connecting = undefined })
    return this.#connecting
  }

  async #save(session, state) {
    this.#helpers.appendPluginRecord(session, RECORD, { version: 1, ...state, sessionId: session.id })
    // Mapping and write intent are durable before a network mutation begins.
    await this.#ctx.sessionPersistence.flush()
    const agent = this.#ctx.agents?.get?.(session.id)
    if (agent) this.#replies?.track(agent)
  }

  #isSidechatSession(agent) {
    if (agent.session.header.origin !== 'subagent') return false
    const current = this.#ctx.get?.('sessionTitle')?.get(agent.session)
    if (typeof current?.title === 'string' && current.title.startsWith('Side: ')) return true
    const events = agent.session.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type === 'subagent/descriptor' && event.data?.provider === 'sidechat') return true
    }
    return false
  }

  #syncNativeTitle(agent, value) {
    // Claude CLI's first-prompt fallback must not masquerade as a generated title.
    // Only the isolated title result is authoritative; imported/manual titles stay intact.
    if (this.owner(agent) === 'claude-code' && this.#titlePolicy.enabled) return false
    if (this.#isSidechatSession(agent)) return false
    const current = this.#ctx.get?.('sessionTitle')?.get(agent.session)
    if (this.#titlePolicy?.enabled && (this.#titleTasks.has(agent.id) || current?.source?.provider === 'dsh-host-dsh-title')) return false
    return acceptNativeTitle(agent.session, value, current)
  }

  #scheduleExternalTitle(peer, agent, state, { extraMessages = [], triggerKey = '' } = {}) {
    if (this.#stopped || !this.#titlePolicy?.enabled) return
    if (this.#isSidechatSession(agent)) return
    const current = this.#ctx.get?.('sessionTitle')?.get(agent.session)
    if (current?.source?.kind === 'user') return
    if (triggerKey) {
      const last = this.#lastTitleTrigger.get(agent.id)
      if (last && last.key === triggerKey && Date.now() - last.at < 60_000) return
    }
    const messages = collectTitleMessages(agent.session, { extraMessages })
    if (messages.length === 0) return
    if (triggerKey) this.#lastTitleTrigger.set(agent.id, { key: triggerKey, at: Date.now() })
    const previous = this.#titleTasks.get(agent.id)
    if (previous) previous.controller.abort(new Error('Superseded by newer turn'))
    const controller = new AbortController()
    const titleSignal = AbortSignal.any([controller.signal, this.#metadataAbort.signal])
    const task = { controller }
    const effectivePeer = peer ?? this.#peer ?? null
    const effectiveState = state ?? nativeThreadState(agent.session)
    const ownedThreadId = effectiveState?.sessionId === undefined || effectiveState.sessionId === agent.id ? effectiveState?.threadId : undefined
    const effectiveHarness = effectiveState?.harnessId ?? this.owner(agent)
    task.promise = completeExternalTitle(this.#ctx, agent, messages, titleSignal, this.#titlePolicy, {
      peer: effectivePeer, threadId: ownedThreadId, harnessId: effectiveHarness, hostConfig: this.#hostConfig,
      syncNativeTitle: this.#syncNativeAgentTitle, refresh: true,
    })
      .catch(error => {
        if (!titleSignal.aborted) this.#ctx.logger?.warn(`DSH Host title unavailable: ${error.code ?? error.name}`)
      })
      .finally(() => {
        if (this.#titleTasks.get(agent.id) === task) this.#titleTasks.delete(agent.id)
      })
    this.#titleTasks.set(agent.id, task)
  }

  #lastBillingUsage(session, threadId) {
    const projected = this.#observationOf(session)
    if (projected?.threadId === threadId && hasBillingCounters(projected.usage)) return projected.usage
    const events = session.snapshotEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.ignorable === true && OBSERVATION_TYPES.includes(event.type)
        && event.data?.threadId === threadId && hasBillingCounters(event.data?.usage)) {
        return event.data.usage
      }
    }
    return undefined
  }

  async #observe(peer, agent, state, model, readTitle = true, timing, terminalUsage) {
    // Metadata failures cannot fail or resubmit a completed task.
    let usage, cost
    try { const raw = (await peer.request('codexhost/thread/usage/inspect', { threadId: state.threadId, ...(state.harnessId === 'claude-code' && readTitle ? { refresh: 'exact' } : {}) }, { timeoutMs: 10_000 })).usage; usage = observedUsage(raw); cost = observedCost(raw) }
    catch (error) { this.#ctx.logger?.warn(`DSH Host usage unavailable: ${error.code ?? error.name}`) }
    // The terminal notification is already measured; failed optional inspection must not discard it.
    const terminal = observedUsage(terminalUsage)
    if (terminal) usage = { ...terminal, ...usage }
    if (readTitle) {
      try { this.#syncNativeTitle(agent, (await peer.request('thread/read', { threadId: state.threadId, includeTurns: false }, { timeoutMs: 10_000 })).thread?.name) }
      catch (error) { this.#ctx.logger?.warn(`DSH Host title unavailable: ${error.code ?? error.name}`) }
    }
    if (usage && !this.#stopped) {
      let observedModel = model ?? state.appliedConfiguration?.modelId ?? ''
      if (state.harnessId === 'claude-code' && (observedModel.startsWith('claude-model-v1.') || ['default', 'opus', 'sonnet', 'haiku'].includes(observedModel))) {
        try {
          const inspection = await peer.request('codexhost/thread/inspect', { threadId: state.threadId }, { timeoutMs: 10_000 })
          if (inspection.harnessId === state.harnessId && typeof inspection.resolvedModelLabel === 'string' && inspection.resolvedModelLabel.trim()) observedModel = inspection.resolvedModelLabel.trim()
        } catch (error) { this.#ctx.logger?.warn(`DSH Host resolved model unavailable: ${error.code ?? error.name}`) }
      }
      if (timing) Object.assign(usage, typeof timing === 'function' ? timing(usage) : timing)
      if (usage.outputTimingReliable === 0) delete usage.outputTokensPerSecond
      const observation = { threadId: state.threadId, harnessId: state.harnessId, model: observedModel, observedAt: Date.now(), usage, ...(cost ? { cost } : {}) }
      const previous = this.#observationOf(agent.session)
      const sameThread = previous?.threadId === state.threadId
      observation.usage = mergeObservedUsage(previous?.usage, usage, sameThread && previous?.model === observation.model, sameThread)
      if (JSON.stringify(previous?.usage) !== JSON.stringify(observation.usage) || JSON.stringify(previous?.cost) !== JSON.stringify(cost) || previous?.model !== observation.model) {
        this.#helpers.appendPluginRecord(agent.session, OBSERVATION, observation)
        await this.#ctx.sessionPersistence.flush()
      }
    }
    return usage
  }

  #isInheritedThreadState(agent, state) {
    return state !== undefined && ((state.sessionId !== undefined && state.sessionId !== agent.id)
      || (agent.session.header.parentSession !== undefined && state.sessionId !== agent.id))
  }

  #inheritedForkSource(agent, harnessId) {
    const events = agent.session.snapshotEvents?.() ?? []
    let parentThreadId, lastHostTurnId, appliedConfiguration
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event || event.ignorable !== true || !isHostRecord(event.type, 'thread')) continue
      const data = event.data
      if (!data || data.sessionId === agent.id || data.harnessId !== harnessId) continue
      if (parentThreadId === undefined && typeof data.threadId === 'string' && data.threadId !== '') {
        parentThreadId = data.threadId
      }
      if (parentThreadId !== undefined && data.threadId === parentThreadId) {
        if (appliedConfiguration === undefined && data.appliedConfiguration) appliedConfiguration = data.appliedConfiguration
        if (lastHostTurnId === undefined && typeof data.lastHostTurnId === 'string' && data.lastHostTurnId !== '') {
          lastHostTurnId = data.lastHostTurnId
        }
      }
    }
    return { parentThreadId, lastHostTurnId, appliedConfiguration }
  }

  #isForkCheckpointUnavailable(error) {
    const code = error?.code
    const message = String(error?.message ?? '')
    return code === -32080
      || /checkpoint is unavailable|checkpoint.*not found|no completed turns|no turns/i.test(message)
  }

  async #applyExternalSelection(peer, threadId, selection) {
    await peer.request('codexhost/thread/model/select', { threadId, model: { id: selection.modelId } })
    await peer.request('codexhost/thread/permission-mode/select', { threadId, permissionModeId: selection.permissionModeId })
    if (selection.thinkingOptionId) await peer.request('codexhost/thread/thinking/select', { threadId, thinkingOptionId: selection.thinkingOptionId })
  }

  async #thread(peer, agent, harnessId, turn, signal, selection) {
    let state = nativeThreadState(agent.session)
    const inheritedFork = this.#isInheritedThreadState(agent, state)
    if (state !== undefined && state.harnessId !== harnessId) throw new HostConnectionError('HOST_OWNER_CONFLICT', 'The saved session belongs to a different Agent')
    const startParams = () => {
      const permissions = harnessId === 'codex' ? codexPermissionParameters(selection.permissionModeId, agent.session.header.cwd) : undefined
      return { cwd: agent.session.header.cwd,
        ...(harnessId === 'codex'
          ? { model: selection.modelId, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox, ...(this.#collaboration ? { dynamicTools: [COLLABORATION_SCHEMA] } : {}) }
          : { model: encodeNativeHarnessRoute(harnessId, selection) }) }
    }
    if (inheritedFork) {
      const { parentThreadId, lastHostTurnId, appliedConfiguration } = this.#inheritedForkSource(agent, harnessId)
      const intent = {
        phase: 'creating', harnessId, operationId: randomUUID(),
        ...(parentThreadId ? { forkSourceThreadId: parentThreadId } : {}),
        ...(lastHostTurnId ? { forkSourceTurnId: lastHostTurnId } : {}),
      }
      let dispatched = false, result, forkedFromThreadId
      try {
        await this.#save(agent.session, intent)
        signal.throwIfAborted()
        const canFork = typeof parentThreadId === 'string' && parentThreadId !== ''
          && (harnessId === 'codex' || typeof lastHostTurnId === 'string' && lastHostTurnId !== '')
        if (canFork) {
          const permissions = harnessId === 'codex' ? codexPermissionParameters(selection.permissionModeId, agent.session.header.cwd) : undefined
          const forkParams = harnessId === 'codex'
            ? { threadId: parentThreadId, cwd: agent.session.header.cwd, model: selection.modelId, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox, excludeTurns: true }
            : { threadId: parentThreadId, cwd: agent.session.header.cwd, ...(lastHostTurnId ? { lastTurnId: lastHostTurnId } : {}), excludeTurns: true }
          dispatched = true
          try {
            result = await peer.request('thread/fork', forkParams)
            forkedFromThreadId = parentThreadId
          } catch (forkError) {
            if (!this.#isForkCheckpointUnavailable(forkError)) throw forkError
            this.#ctx.logger?.warn(`DSH Host native fork checkpoint unavailable for ${harnessId}; falling back to thread/start: ${forkError.message}`)
            result = await peer.request('thread/start', startParams())
          }
        } else {
          dispatched = true
          result = await peer.request('thread/start', startParams())
        }
      } catch (error) {
        if (!dispatched) await this.#save(agent.session, { ...intent, notDispatched: true })
        throw error
      }
      const threadId = result.thread?.id
      if (typeof threadId !== 'string' || threadId === '' || threadId === parentThreadId) {
        throw new HostConnectionError('HOST_INVALID_THREAD', 'DSH Host did not return a distinct forked Thread identity')
      }
      if (forkedFromThreadId && harnessId !== 'codex' && JSON.stringify(appliedConfiguration) !== JSON.stringify(selection)) {
        await this.#applyExternalSelection(peer, threadId, selection)
      }
      state = {
        phase: 'ready', harnessId, threadId, appliedConfiguration: selection,
        ...(forkedFromThreadId ? { forkedFromThreadId } : {}),
        ...(forkedFromThreadId && lastHostTurnId ? { forkedFromTurnId: lastHostTurnId } : {}),
        ...(this.#collaboration ? { collaborationVersion: 1 } : {}),
      }
      await this.#save(agent.session, state)
      return state
    }
    const rejection = rejectedStartEvidence(agent.session, state)
    if (rejection) {
      const terminal = await inspectRejectedStart(peer, state)
      if (terminal && JSON.stringify(nativeThreadState(agent.session)) === JSON.stringify(state)) {
        this.#helpers.appendPluginRecord(agent.session, hostRecord('reconciled'), {
          version: 1, threadId: state.threadId, outcome: 'rejected-before-start', checkedAt: Date.now(),
          historyReplayed: false, evidence: rejection, ...terminal,
        })
        const { localTurn, hostTurnId, ...ready } = state
        state = { ...ready, phase: 'ready' }
        await this.#save(agent.session, state)
      }
    }
    const retryUnsentCreation = state?.phase === 'creating' && state.notDispatched === true
    if ((state?.phase === 'creating' && !retryUnsentCreation) || state?.phase === 'submitted') throw new HostConnectionError('HOST_OUTCOME_UNKNOWN', 'The previous DSH Host operation has an unconfirmed outcome. Use the outcome check before sending again; it will not be repeated automatically.')
    if (state === undefined || retryUnsentCreation) {
      const seededChild = agent.session.header.isSeeded === true && agent.session.header.parentSession !== undefined
      if (turn !== 1 && !retryUnsentCreation && !seededChild) throw new HostConnectionError('HOST_MAPPING_MISSING', 'This conversation has already started but its DSH Host mapping is missing; refusing to create a replacement session')
      const intent = { phase: 'creating', harnessId, operationId: randomUUID() }
      let dispatched = false, result
      try {
        await this.#save(agent.session, intent)
        signal.throwIfAborted()
        const params = startParams()
        dispatched = true // From here, even an error can mean an unknown remote outcome.
        result = await peer.request('thread/start', params)
      } catch (error) {
        if (!dispatched) await this.#save(agent.session, { ...intent, notDispatched: true })
        throw error
      }
      const threadId = result.thread?.id
      if (typeof threadId !== 'string' || threadId === '') throw new HostConnectionError('HOST_INVALID_THREAD', 'DSH Host did not return a native Thread identity')
      state = { phase: 'ready', harnessId, threadId, appliedConfiguration: selection, ...(this.#collaboration ? { collaborationVersion: 1 } : {}) }
      await this.#save(agent.session, state)
    } else {
      await waitForNativeIdle(peer, state.threadId, signal, this.turnTimeoutMs)
      await peer.request('thread/resume', { threadId: state.threadId })
      if (harnessId !== 'codex' && JSON.stringify(state.appliedConfiguration) !== JSON.stringify(selection)) {
        await this.#applyExternalSelection(peer, state.threadId, selection)
        state = { ...state, appliedConfiguration: selection }
        await this.#save(agent.session, state)
      }
      if (harnessId === 'codex' && JSON.stringify(state.appliedConfiguration) !== JSON.stringify(selection)) {
        state = { ...state, appliedConfiguration: selection }
        await this.#save(agent.session, state)
      }
    }
    return state
  }

  async run(payload) {
    payload = { ...payload, messages: externalMessages(payload.messages) }
    if (this.#active.has(payload.agent.id)) throw new HostConnectionError('HOST_SESSION_BUSY', 'This DSH Host session already has an active Turn')
    this.#assertStepAvailable(payload)
    if (payload.messages.length === 0) throw new HostConnectionError('HOST_EMPTY_INPUT', 'DSH Host requires admitted input; automatic guidance alone must not start a request')
    const done = Promise.withResolvers(), entry = { agent: payload.agent, done: done.promise }
    this.#active.set(payload.agent.id, entry)
    this.#liveStatus.start(payload.agent.id, { harnessId: this.owner(payload.agent), phase: 'preparing', label: '正在准备会话…' })
    try {
      if (this.#collaboration) entry.lease = await this.#collaboration.open({ ...payload, onWaitingChange: waiting => entry.onCollaborationWait?.(waiting) })
      return await this.#run(payload)
    } finally {
      entry.agyLogWatcher?.stop?.()
      this.#liveStatus.clear(payload.agent.id)
      await entry.lease?.close()
      this.#active.delete(payload.agent.id); done.resolve()
      void this.#replies?.syncAgent(payload.agent).catch(error => this.#ctx.logger?.warn(`Native reply catch-up unavailable: ${error.code ?? error.name}`))
    }
  }

  /** Mirror engine-owned background work into DSH jobs. Never executes or resends it. */
  #handOffBackground(message, { peer, agent, harnessId, threadId, projector }) {
    const params = message.params ?? {}
    const handOff = (itemId, command, callId, seed) => {
      const registered = this.#background.registerCommand({ peer, agent, harnessId, threadId, itemId, command, callId, seed })
      const engineName = harnessId === 'codex' ? 'Codex' : harnessId === 'antigravity' ? 'Antigravity' : 'Claude'
      const text = registered.jobId
        ? `已转为 DSH 后台任务 ${registered.jobId}；命令仍由 ${engineName} 执行，输出、状态和停止入口见后台任务。`
        : `命令已在 ${engineName} 后台继续运行；未能登记为 DSH 后台任务（${registered.error}）。`
      projector.tools.detach(itemId, text, { jobId: registered.jobId ?? null })
    }
    if (message.method === 'codexhost/item/detached' && typeof params.itemId === 'string') {
      const open = projector.tools.openCall(params.itemId)
      // Claude re-reads its output file from the start, so no foreground seed.
      if (open) handOff(params.itemId, open.item?.command, open.callId)
      return
    }
    if ((message.method === 'item/started' || message.method === 'item/completed') && params.item?.type === 'collabAgentToolCall') {
      const itemId = params.item.id ?? params.item.itemId
      this.#background.observeAgents({ peer, agent, harnessId, threadId, item: params.item, callId: projector.tools.openCall(itemId)?.callId })
      return
    }
    if (message.method === 'turn/completed' && harnessId === 'codex') {
      for (const open of projector.tools.openBackgroundCommands()) handOff(open.itemId, open.item.command, open.callId, open.output)
    }
  }

  async #run({ agent, messages, turn, step, signal }) {
    signal.throwIfAborted()
    const harnessId = this.owner(agent)
    const nativeCommand = nativeCommandInput(messages)
    if (nativeCommand && !NATIVE_COMMAND_ENGINES.includes(harnessId)) throw new HostConnectionError('HOST_COMMAND_UNSUPPORTED', `当前引擎未适配 /${nativeCommand.name}；未发送普通提示词`)
    if (nativeCommand) messages = [nativeCommand.message]
    else messages = await prepareExternalReferences(this.#ctx, this.#helpers, agent, messages, signal)
    const entry = this.#active.get(agent.id), lease = entry.lease
    const targets = selectedDelegationTargets(messages)
    // General rules are discovered through the tool; only this input's explicit targets are appended.
    if (lease && targets.length) messages = [...messages, this.#helpers.createUserMessage({ content: [{ type: 'text', text: nativeDelegationInstruction(targets) }], source: { kind: 'dsh-host-collaboration', form: 'instructions' } })]
    const texts = [], images = []
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'text') { if (block.text !== '') texts.push(lease ? block.text.replace(/\[@([^\]\n]+)\]\(<?subagent:\/\/codexhost\.[a-z0-9-]+>?\)/gu, '@$1') : block.text); continue }
        if (block.type === 'image') { images.push(await resolveWorkspaceImage(this.#ctx.get('attachments'), agent.session.header.cwd, block, signal)); continue }
        throw new HostConnectionError('HOST_ATTACHMENT_PENDING', 'Only saved workspace images can be sent to Codex or Claude; this input was not sent')
      }
    }
    const input = images.length ? nativeImageInput(harnessId, images, texts) : texts.map(text => ({ type: 'text', text }))
    if (input.length === 0) throw new HostConnectionError('HOST_EMPTY_INPUT', 'DSH Host requires a message; the retry command is not connected yet')
    const { texts: earlyTitleTexts, key: earlyTitleKey, continueOnly: isContinueOnly } = !nativeCommand
      ? extractUserMessageTexts(messages)
      : { texts: [], key: '', continueOnly: false }
    if (earlyTitleTexts.length > 0 && !(harnessId === 'claude-code' && this.#titlePolicy.nativeClaude?.enabled)) {
      const earlySeq = Math.max(0, agent.session.snapshotEvents?.()?.at?.(-1)?.seq ?? 0)
      const existingState = nativeThreadState(agent.session)
      this.#scheduleExternalTitle(this.#peer ?? null, agent, existingState ? { ...existingState, harnessId } : { harnessId }, {
        extraMessages: earlyTitleTexts.map(text => ({ seq: earlySeq, text })),
        triggerKey: earlyTitleKey,
      })
    }
    const engineName = engineDisplayLabel(harnessId)
    this.#liveStatus.update(agent.id, { phase: 'connecting', label: '连接 DSH Host 运行时…' })
    const peer = await this.#connection()
    this.#liveStatus.update(agent.id, { phase: 'catalog', label: '读取模型与权限配置…' })
    const catalog = await this.catalog(agent)
    if (catalog.status !== 'ready') throw new HostConnectionError('HOST_CATALOG_UNAVAILABLE', catalog.error)
    const selectedModel = catalog.models.find(model => model.id === catalog.selection.modelId)
    if (!selectedModel) throw new HostConnectionError('HOST_MODEL_UNAVAILABLE', 'The saved model is no longer available; choose a model from the current Agent catalog')
    if (lease) lease.source = { kind: 'model', provider: hostProvider(harnessId), model: selectedModel.resolvedLabel ?? catalog.selection.modelId }
    const previousMapping = nativeThreadState(agent.session)
    const inheritedFork = this.#isInheritedThreadState(agent, previousMapping)
    const newThread = previousMapping === undefined || inheritedFork || (previousMapping.phase === 'creating' && previousMapping.notDispatched === true)
    if (agent.session.header.origin === 'subagent' && !catalog.permissionModes.some(mode => mode.id === catalog.selection.permissionModeId)) throw new HostConnectionError('HOST_PERMISSION_INVALID', 'The required child permission mode is unavailable; execution was stopped')
    this.#liveStatus.update(agent.id, { phase: 'thread', label: inheritedFork ? `正在分叉 ${engineName} 会话…` : newThread ? `正在创建 ${engineName} 会话…` : `正在恢复 ${engineName} 会话…` })
    const state = await this.#thread(peer, agent, harnessId, turn, signal, catalog.selection)
    entry.threadId = state.threadId
    let commandDescriptor
    if (nativeCommand) {
      const commands = await peer.request('codexhost/thread/commands/inspect', { threadId: state.threadId })
      commandDescriptor = nativeCommandDescriptor(commands, nativeCommand.name)
      if (nativeCommand.text && commandDescriptor.argumentMode !== 'text') throw new HostConnectionError('HOST_COMMAND_INPUT', '此原生命令不接受参数，未发送任务')
    }
    if (lease && harnessId === 'codex' && state.collaborationVersion !== 1 && (targets.length || lease.schemas.some(tool => tool.name.startsWith('team_task_')))) throw new HostConnectionError('HOST_COLLABORATION_UPGRADE', 'This Codex Thread predates unified collaboration tools. Start a new conversation for subagents/Teams; its history will not be replayed or replaced.')
    const fallbackUsageBefore = !newThread ? this.#lastBillingUsage(agent.session, state.threadId) : undefined
    this.#liveStatus.update(agent.id, { phase: 'observe', label: '同步会话上下文快照…' })
    const observedBefore = await this.#observe(peer, agent, state, catalog.selection.modelId)
    // A newly created Thread has no submitted requests, even when its initial
    // native snapshot contains context/price metadata but omits token counters.
    // A freshly forked Thread inherits cumulative counters from its parent, so
    // anchor usageBefore to observedBefore when billing counters are present.
    // On resumed turns, fall back to the last persisted same-thread billing counters if
    // the pre-turn inspect timed out or returned metadata without billing buckets.
    const usageBefore = (inheritedFork && state.forkedFromThreadId)
      ? (hasBillingCounters(observedBefore) ? observedBefore : ZERO_USAGE)
      : newThread ? ZERO_USAGE
      : hasBillingCounters(observedBefore) ? observedBefore
      : fallbackUsageBefore ?? observedBefore
    signal.throwIfAborted()
    // Recheck after asynchronous preparation, before committing any new step.
    this.#assertStepAvailable({ agent, turn, step })
    agent.session.append('step/start', { turn, step })
    let firstMessage
    let hasUserMessage = false
    for (const message of messages) {
      const event = agent.session.append('user/message', message, { surfaceOp: 'append' })
      if (message.source.kind === 'user') {
        hasUserMessage = true
        if (newThread && !firstMessage) firstMessage = { seq: event.seq, text: message.content.map(block => block.text).join('\n') }
      }
    }
    if (!nativeCommand && hasUserMessage && earlyTitleTexts.length > 0 && !(harnessId === 'claude-code' && this.#titlePolicy.nativeClaude?.enabled)) {
      this.#scheduleExternalTitle(peer, agent, state, { triggerKey: earlyTitleKey })
    }
    const dispatch = this.#helpers.agentEvents(this.#ctx, agent)
    const projector = new NativeTurnProjector({ agent, turn, step, helpers: this.#helpers, dispatch,
      provider: hostProvider(harnessId), model: selectedModel.resolvedLabel ?? catalog.selection.modelId,
      nextRevision: () => { const next = (this.#revisions.get(agent) ?? 0) + 1; this.#revisions.set(agent, next); return next },
    })
    const completed = Promise.withResolvers()
    const ended = Promise.withResolvers()
    void completed.promise.catch(() => undefined)
    let hostTurnId
    let startDispatched = false
    let remoteCompleted = false
    let remoteStatus
    let exactLiveUsage
    let threadLiveUsage
    let liveContextUsed
    let liveContextWindow
    const resolveLiveUsage = () => exactLiveUsage ?? threadLiveUsage
    let requestStartedAt, requestCompletedAt, requestAbortedAt
    let interrupt
    let cancelledTimer
    let turnTimer
    let turnTimerRemaining = this.turnTimeoutMs
    let turnTimerStartedAt
    let turnTimerPaused = false
    let interactionWaiting = false
    let collaborationWaiting = false
    const clearTurnTimer = () => { clearTimeout(turnTimer); turnTimer = undefined }
    const startTurnTimer = () => {
      if (remoteCompleted || turnTimerPaused || turnTimer !== undefined) return
      turnTimerStartedAt = performance.now()
      turnTimer = setTimeout(() => completed.reject(new HostConnectionError('HOST_TURN_TIMEOUT', 'The Host Turn did not finish in time')), Math.max(0, turnTimerRemaining))
    }
    const syncTurnTimer = () => {
      const nextPaused = interactionWaiting || collaborationWaiting
      if (nextPaused === turnTimerPaused) return
      turnTimerPaused = nextPaused
      if (turnTimerPaused) {
        if (turnTimer !== undefined && turnTimerStartedAt !== undefined) {
          turnTimerRemaining = Math.max(0, turnTimerRemaining - (performance.now() - turnTimerStartedAt))
        }
        clearTurnTimer()
        this.#liveStatus.update(agent.id, {
          phase: interactionWaiting ? 'waiting-approval' : 'waiting-subagent',
          label: interactionWaiting ? '等待你的确认…' : '等待子智能体返回…',
          paused: true,
        })
      } else {
        startTurnTimer()
        this.#liveStatus.update(agent.id, { phase: 'thinking', label: '已继续，等待模型响应…', paused: false })
      }
    }
    entry.onCollaborationWait = waiting => { collaborationWaiting = waiting; syncTurnTimer() }
    const buffered = []
    const interactions = new NativeInteractionBridge({ ctx: this.#ctx, agent, peer, helpers: this.#helpers,
      threadId: state.threadId, turnId: () => hostTurnId, turn, signal,
      permissionModeId: catalog.selection.permissionModeId, enableApprovalPrompts: this.#nativeInteractionApprovals,
      onError: error => completed.reject(error),
      onWaitingChange: waiting => { interactionWaiting = waiting; syncTurnTimer() },
    })
    const compactionBeforeTokens = Number.isFinite(usageBefore?.contextUsedTokens) && usageBefore.contextUsedTokens > 0 ? usageBefore.contextUsedTokens : undefined
    const compactionBeforeWindow = Number.isFinite(usageBefore?.contextWindowTokens) && usageBefore.contextWindowTokens > 0 ? usageBefore.contextWindowTokens : undefined
    const compactions = new Map()
    const compactionAliases = new Map()
    const pendingCompactionAfter = new Set()
    let compactionAfterReading = false
    let compactionPollTimer
    let compactionPollAttempts = 0
    let manualCompactionId
    const isPlausiblePostCompactionUsed = value => Number.isSafeInteger(value) && value > 0
      && (compactionBeforeTokens === undefined || value < compactionBeforeTokens * 0.8)
    const clearCompactionPoll = () => {
      if (compactionPollTimer !== undefined) {
        clearTimeout(compactionPollTimer)
        compactionPollTimer = undefined
      }
    }
    const scheduleCompactionAfterPoll = () => {
      if (this.#stopped || remoteCompleted || pendingCompactionAfter.size === 0 || compactionPollTimer !== undefined || compactionPollAttempts >= 3) return
      const delayMs = compactionPollAttempts === 0 ? 1500 : compactionPollAttempts === 1 ? 3000 : 5000
      compactionPollAttempts += 1
      compactionPollTimer = setTimeout(() => {
        compactionPollTimer = undefined
        refreshPendingCompactionAfter()
      }, delayMs)
    }
    const syncLiveContextObservation = (nextUsed, nextWindow) => {
      if (this.#stopped || !Number.isSafeInteger(nextUsed) || nextUsed <= 0) return
      const previous = this.#observationOf(agent.session)
      const prevUsage = previous?.usage ?? {}
      const windowTokens = Number.isSafeInteger(nextWindow) && nextWindow > 0
        ? nextWindow
        : Number.isSafeInteger(prevUsage.contextWindowTokens) && prevUsage.contextWindowTokens > 0
          ? prevUsage.contextWindowTokens
          : compactionBeforeWindow
      if (!windowTokens) return
      if (prevUsage.contextUsedTokens === nextUsed && prevUsage.contextWindowTokens === windowTokens) return
      this.#helpers.appendPluginRecord(agent.session, OBSERVATION, {
        threadId: state.threadId,
        harnessId,
        model: previous?.model || selectedModel.resolvedLabel || catalog.selection.modelId || '',
        observedAt: Date.now(),
        usage: { ...prevUsage, contextUsedTokens: nextUsed, contextWindowTokens: windowTokens },
        ...(previous?.cost ? { cost: previous.cost } : {}),
      })
    }
    const refreshPendingCompactionAfter = () => {
      if (this.#stopped || compactionAfterReading || pendingCompactionAfter.size === 0) return
      compactionAfterReading = true
      void this.#readCompactionSummary({ harnessId, threadId: state.threadId, config: this.#hostConfig })
        .then(nativeInfo => {
          if (this.#stopped || !nativeInfo) return
          const validAfter = isPlausiblePostCompactionUsed(nativeInfo.afterTokens) ? nativeInfo.afterTokens : undefined
          const liveUsed = isPlausiblePostCompactionUsed(nativeInfo.latestContextUsed) ? nativeInfo.latestContextUsed : validAfter
          if (liveUsed !== undefined) syncLiveContextObservation(liveUsed, liveContextWindow ?? compactionBeforeWindow)
          if (validAfter === undefined && !nativeInfo.summary) return
          for (const targetId of [...pendingCompactionAfter]) {
            const currentItem = compactions.get(targetId)
            if (!currentItem || currentItem.phase !== 'completed') { pendingCompactionAfter.delete(targetId); continue }
            if (validAfter !== undefined) pendingCompactionAfter.delete(targetId)
            recordCompaction(targetId, {
              phase: 'completed',
              ...(currentItem.beforeTokens === undefined && nativeInfo.beforeTokens !== undefined ? { beforeTokens: nativeInfo.beforeTokens } : {}),
              ...(currentItem.afterTokens === undefined && validAfter !== undefined ? { afterTokens: validAfter } : {}),
              ...(!currentItem.summary && nativeInfo.summary ? { summary: nativeInfo.summary } : {}),
            })
          }
          if (pendingCompactionAfter.size === 0) clearCompactionPoll()
        })
        .catch(() => undefined)
        .finally(() => {
          compactionAfterReading = false
          if (pendingCompactionAfter.size > 0) scheduleCompactionAfterPoll()
        })
    }
    const recordCompaction = (id, patch) => {
      if (!hostTurnId) return
      const previous = compactions.get(id)
      const next = {
        id,
        mode: patch.mode ?? previous?.mode ?? 'auto',
        phase: patch.phase ?? previous?.phase ?? 'started',
        beforeTokens: patch.beforeTokens ?? previous?.beforeTokens,
        afterTokens: patch.afterTokens ?? previous?.afterTokens,
        contextWindowTokens: patch.contextWindowTokens ?? previous?.contextWindowTokens,
        summary: patch.summary ?? previous?.summary,
        error: patch.error ?? previous?.error,
      }
      if (previous && JSON.stringify(previous) === JSON.stringify(next)) return
      compactions.set(id, next)
      this.#helpers.appendPluginRecord(agent.session, hostRecord('compaction'), {
        version: 1,
        harnessId,
        threadId: state.threadId,
        turnId: hostTurnId,
        localTurn: turn,
        compactionId: id,
        mode: next.mode,
        phase: next.phase,
        ...(next.beforeTokens === undefined ? {} : { beforeTokens: next.beforeTokens }),
        ...(next.afterTokens === undefined ? {} : { afterTokens: next.afterTokens }),
        ...(next.contextWindowTokens === undefined ? {} : { contextWindowTokens: next.contextWindowTokens }),
        ...(next.summary ? { summary: next.summary } : {}),
        ...(next.error ? { error: next.error } : {}),
      })
      if (next.phase === 'completed' && isPlausiblePostCompactionUsed(next.afterTokens)) {
        syncLiveContextObservation(next.afterTokens, next.contextWindowTokens)
      }
    }
    const accept = message => {
      const params = message.params ?? {}
      const eventTurnId = params.turnId ?? params.turn?.id
      if (params.threadId !== state.threadId || (hostTurnId !== undefined && eventTurnId !== undefined && eventTurnId !== hostTurnId)) return
      if (hostTurnId === undefined) { buffered.push(message); return }
      if (remoteCompleted) return
      try {
        if (message.id !== undefined) {
          if (message.method === 'item/tool/call' && lease) {
            const request = params.tool === COLLABORATION_SCHEMA.name && (params.namespace === undefined || params.namespace === null) ? params.arguments : undefined
            const task = request ? lease.call({ id: params.callId, name: request.name, arguments: request.arguments }) : Promise.reject(new Error('Unknown collaboration tool'))
            void task.catch(() => ({ isError: true, content: [{ type: 'text', text: 'DSH collaboration tool denied or failed. Do not automatically replay mutations.' }] }))
              .then(result => { if (!signal.aborted && !remoteCompleted) return peer.respond(message.id, { contentItems: result.content.map(block => ({ type: 'inputText', text: block.text })), success: !result.isError }) })
              .catch(error => completed.reject(error))
          } else interactions.accept(message)
          return
        }
        if (message.method === 'serverRequest/resolved') { interactions.resolve(params.requestId); return }
        this.#liveStatus.observeNotification(agent.id, message)
        projector.accept(message)
        this.#handOffBackground(message, { peer, agent, harnessId, threadId: state.threadId, projector })
        if (message.method === 'codexhost/thread/tokenUsage/updated') {
          const next = observedUsage(params.tokenUsage?.total)
          if (next) exactLiveUsage = next
        } else if (message.method === 'thread/tokenUsage/updated') {
          const next = observedUsage(params.tokenUsage?.total)
          // External context updates emit zero-total placeholders via projectCodexThreadUsage;
          // never let them overwrite real cumulative counters or trigger a zero-delta failure.
          if (next && next.totalTokens > 0) threadLiveUsage = next
          const lastUsed = params.tokenUsage?.last?.totalTokens
          const ctxWindow = params.tokenUsage?.modelContextWindow
          if (Number.isSafeInteger(lastUsed) && lastUsed > 0) liveContextUsed = lastUsed
          if (Number.isSafeInteger(ctxWindow) && ctxWindow > 0) liveContextWindow = ctxWindow
          if (pendingCompactionAfter.size > 0) {
            if (liveContextUsed !== undefined && (compactionBeforeTokens === undefined || liveContextUsed < compactionBeforeTokens * 0.85)) {
              for (const targetId of [...pendingCompactionAfter]) {
                const currentItem = compactions.get(targetId)
                if (!currentItem || currentItem.phase !== 'completed') { pendingCompactionAfter.delete(targetId); continue }
                pendingCompactionAfter.delete(targetId)
                recordCompaction(targetId, {
                  phase: 'completed',
                  afterTokens: liveContextUsed,
                  ...(liveContextWindow === undefined ? {} : { contextWindowTokens: liveContextWindow }),
                })
              }
              syncLiveContextObservation(liveContextUsed, liveContextWindow)
            } else {
              refreshPendingCompactionAfter()
            }
          }
        }
        if (message.method === 'thread/name/updated') this.#syncNativeTitle(agent, params.threadName)
        if (message.method === 'codexhost/thread/manual-compaction/started') {
          if (!manualCompactionId) {
            manualCompactionId = `manual:${hostTurnId}`
            recordCompaction(manualCompactionId, { mode: 'manual', phase: 'started', beforeTokens: compactionBeforeTokens, contextWindowTokens: compactionBeforeWindow })
          }
        }
        if ((message.method === 'item/started' || message.method === 'codexhost/item/started') && params.item?.type === 'contextCompaction') {
          const itemId = (typeof params.item.id === 'string' && params.item.id) ? params.item.id : (typeof params.item.itemId === 'string' && params.item.itemId) ? params.item.itemId : 'contextCompaction'
          const targetId = manualCompactionId && compactions.get(manualCompactionId)?.phase === 'started' ? manualCompactionId : itemId
          compactionAliases.set(itemId, targetId)
          recordCompaction(targetId, {
            mode: manualCompactionId === targetId || nativeCommand?.name === 'compact' ? 'manual' : 'auto',
            phase: 'started',
            beforeTokens: compactionBeforeTokens,
            contextWindowTokens: compactionBeforeWindow,
          })
        }
        if ((message.method === 'item/completed' || message.method === 'codexhost/item/completed') && params.item?.type === 'contextCompaction') {
          const itemId = (typeof params.item.id === 'string' && params.item.id) ? params.item.id : (typeof params.item.itemId === 'string' && params.item.itemId) ? params.item.itemId : 'contextCompaction'
          const targetId = compactionAliases.get(itemId) ?? (manualCompactionId && compactions.get(manualCompactionId)?.phase === 'started' ? manualCompactionId : itemId)
          compactionAliases.set(itemId, targetId)
          const failed = params.outcome?.status === 'failed' || params.outcome?.status === 'cancelled' || params.item.status === 'failed'
          const summary = typeof params.item.summary === 'string' ? params.item.summary : typeof params.item.text === 'string' ? params.item.text : undefined
          const errorText = params.outcome?.error?.message ?? params.item.error?.message
          const currentUsage = resolveLiveUsage()
          const candidateAfter = liveContextUsed ?? (Number.isFinite(currentUsage?.contextUsedTokens) && currentUsage.contextUsedTokens > 0 ? currentUsage.contextUsedTokens : undefined)
          const afterTokens = candidateAfter !== undefined && (compactionBeforeTokens === undefined || candidateAfter < compactionBeforeTokens * 0.85) ? candidateAfter : undefined
          const afterWindow = liveContextWindow ?? (Number.isFinite(currentUsage?.contextWindowTokens) && currentUsage.contextWindowTokens > 0 ? currentUsage.contextWindowTokens : compactionBeforeWindow)
          recordCompaction(targetId, {
            mode: manualCompactionId === targetId || nativeCommand?.name === 'compact' ? 'manual' : 'auto',
            phase: failed ? 'failed' : 'completed',
            beforeTokens: compactionBeforeTokens,
            ...(afterTokens === undefined ? {} : { afterTokens }),
            ...(afterWindow === undefined ? {} : { contextWindowTokens: afterWindow }),
            ...(summary ? { summary } : {}),
            ...(failed && errorText ? { error: errorText } : {}),
          })
          if (!failed && afterTokens === undefined) {
            pendingCompactionAfter.add(targetId)
            scheduleCompactionAfterPoll()
          }
          if (!failed && (!summary || afterTokens === undefined)) {
            void this.#readCompactionSummary({ harnessId, threadId: state.threadId, config: this.#hostConfig })
              .then(nativeInfo => {
                if (this.#stopped || !nativeInfo) return
                const currentItem = compactions.get(targetId)
                if (!currentItem || currentItem.phase !== 'completed') return
                const validAfter = isPlausiblePostCompactionUsed(nativeInfo.afterTokens) ? nativeInfo.afterTokens : undefined
                const liveUsed = isPlausiblePostCompactionUsed(nativeInfo.latestContextUsed) ? nativeInfo.latestContextUsed : validAfter
                if (validAfter !== undefined) {
                  pendingCompactionAfter.delete(targetId)
                  if (pendingCompactionAfter.size === 0) clearCompactionPoll()
                }
                if (liveUsed !== undefined) syncLiveContextObservation(liveUsed, afterWindow)
                recordCompaction(targetId, {
                  phase: 'completed',
                  ...(currentItem.beforeTokens === undefined && nativeInfo.beforeTokens !== undefined ? { beforeTokens: nativeInfo.beforeTokens } : {}),
                  ...(currentItem.afterTokens === undefined && validAfter !== undefined ? { afterTokens: validAfter } : {}),
                  ...(!currentItem.summary && nativeInfo.summary ? { summary: nativeInfo.summary } : {}),
                })
              })
              .catch(() => undefined)
          }
        }
        if (pendingCompactionAfter.size > 0 && ['item/started', 'item/completed', 'codexhost/item/started', 'codexhost/item/completed'].includes(message.method) && params.item?.type !== 'contextCompaction') {
          refreshPendingCompactionAfter()
        }
        if (message.method === 'item/completed' && !['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(params.item?.type)) {
          this.#helpers.appendPluginRecord(agent.session, hostRecord('item'), { threadId: state.threadId, turnId: hostTurnId, item: compactToolItemMeta(params.item) })
        }
        if (message.method === 'turn/completed') {
          if (remoteCompleted) return
          const currentUsage = resolveLiveUsage()
          for (const item of compactions.values()) {
            if (item.phase !== 'started') continue
            const failed = params.turn?.status !== 'completed'
            const afterTokens = liveContextUsed ?? (Number.isFinite(currentUsage?.contextUsedTokens) && currentUsage.contextUsedTokens > 0 ? currentUsage.contextUsedTokens : undefined)
            const afterWindow = liveContextWindow ?? (Number.isFinite(currentUsage?.contextWindowTokens) && currentUsage.contextWindowTokens > 0 ? currentUsage.contextWindowTokens : compactionBeforeWindow)
            recordCompaction(item.id, {
              phase: failed ? 'failed' : 'completed',
              ...(afterTokens === undefined ? {} : { afterTokens }),
              ...(afterWindow === undefined ? {} : { contextWindowTokens: afterWindow }),
              ...(failed ? { error: params.turn?.error?.message ?? (params.turn?.status === 'interrupted' ? '上下文压缩已中断' : '上下文压缩失败') } : {}),
            })
          }
          if (params.turn?.status === 'failed') this.#helpers.appendPluginRecord(agent.session, HOST_TURN_FAILURE, {
            version: 1, turn, step, harnessId, threadId: state.threadId, hostTurnId,
            failure: observedTurnFailure(params.turn.error),
          })
          interactions.cancel()
          remoteCompleted = true
          requestCompletedAt = performance.now()
          remoteStatus = params.turn?.status
          ended.resolve(params.turn)
          completed.resolve(params.turn)
        }
      } catch (error) { completed.reject(error) }
    }
    const unsubscribe = peer.subscribe(accept)
    const interruptRemote = () => {
      if (hostTurnId === undefined || remoteCompleted) return
      interrupt ??= peer.request('turn/interrupt', { threadId: state.threadId, turnId: hostTurnId }, { timeoutMs: this.cancelTimeoutMs })
      void interrupt.catch(error => completed.reject(error))
      cancelledTimer ??= setTimeout(() => completed.reject(new HostConnectionError('HOST_CANCEL_UNCONFIRMED', 'Host cancellation could not be confirmed; the session will not be resubmitted automatically')), this.cancelTimeoutMs)
    }
    startTurnTimer()
    signal.addEventListener('abort', interruptRemote)
    try {
      await this.#save(agent.session, { ...state, phase: 'submitted', localTurn: turn })
      signal.throwIfAborted()
      const permissions = harnessId === 'codex' ? codexPermissionParameters(catalog.selection.permissionModeId, agent.session.header.cwd) : undefined
      const params = { threadId: state.threadId, input,
        ...(harnessId === 'codex' ? { model: catalog.selection.modelId, approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandboxPolicy, ...(catalog.selection.thinkingOptionId ? { effort: catalog.selection.thinkingOptionId } : {}) } : {}) }
      // Metadata and durable admission can take time. Recheck immediately before the mutation.
      if (!newThread) await waitForNativeIdle(peer, state.threadId, signal, this.turnTimeoutMs)
      startDispatched = true
      entry.submitting = true
      requestStartedAt = performance.now()
      this.#liveStatus.update(agent.id, { phase: 'dispatching', label: `正在启动 ${engineName} 并派发指令…` })
      if (harnessId === 'antigravity') {
        entry.agyLogWatcher = createAntigravityStartupLogWatcher({
          onActivity: () => this.#liveStatus.touch(agent.id),
          onMilestone: milestone => {
            const cur = this.#liveStatus.snapshot(agent.id)
            if (!cur.active) return
            if (!shouldAcceptAntigravityMilestone(cur.phase, milestone.phase)) {
              this.#liveStatus.touch(agent.id)
              return
            }
            this.#liveStatus.update(agent.id, milestone)
          },
        })
        entry.agyLogWatcher.start()
      }
      const started = commandDescriptor
        ? await peer.request('codexhost/thread/command/execute', { threadId: state.threadId, commandId: commandDescriptor.id, ...(nativeCommand.text ? { arguments: { text: nativeCommand.text } } : {}) })
        : await peer.request('turn/start', params)
      hostTurnId = commandDescriptor ? started.turnId : started.turn?.id
      entry.hostTurnId = hostTurnId
      entry.submitting = false
      if (typeof hostTurnId !== 'string') throw new HostConnectionError('HOST_INVALID_TURN', 'DSH Host did not return a native Turn identity')
      const afterStart = this.#liveStatus.snapshot(agent.id)
      if (afterStart.active && afterStart.phase === 'dispatching') {
        this.#liveStatus.update(agent.id, { phase: 'starting', label: `${engineName} 已启动，等待首响应…` })
      }
      await this.#save(agent.session, { ...state, phase: 'submitted', localTurn: turn, hostTurnId })
      if (nativeCommand?.name === 'compact' && !manualCompactionId) {
        manualCompactionId = `manual:${hostTurnId}`
        recordCompaction(manualCompactionId, { mode: 'manual', phase: 'started', beforeTokens: compactionBeforeTokens, contextWindowTokens: compactionBeforeWindow })
      }
      for (const message of buffered.splice(0)) accept(message)
      if (signal.aborted) interruptRemote()
      const result = await Promise.race([completed.promise, peer.closed.then(error => { throw error })])
      await lease?.close()
      await this.#save(agent.session, { ...state, phase: 'ready', lastHostTurnId: hostTurnId })
      signal.throwIfAborted()
      if (result?.status === 'failed') throw new HostConnectionError('HOST_TURN_FAILED', result.error?.message ?? 'The native Host Turn failed')
      if (result?.status === 'interrupted') {
        agent.cancel({ kind: 'hook', reason: 'Native Host Turn interrupted' }, { keepInbox: true })
        signal.throwIfAborted()
      }
    } catch (error) {
      interactions.cancel()
      await lease?.close()
      if (!remoteCompleted) {
        requestAbortedAt ??= performance.now()
        interruptRemote()
        if (interrupt !== undefined) {
          await interrupt.catch(() => undefined)
          let confirmationTimer
          await Promise.race([ended.promise, new Promise(resolve => { confirmationTimer = setTimeout(resolve, this.cancelTimeoutMs) })])
          clearTimeout(confirmationTimer)
        }
      }
      // Only this explicit Host RPC denial proves that turn/start did not run.
      // Timeouts, disconnects, other RPC errors and failures after a Turn identity stay pending.
      const startRejected = hostTurnId === undefined && error instanceof HostConnectionError && isBusyStartRejection(error)
      if (remoteCompleted || !startDispatched || startRejected) await this.#save(agent.session, { ...state, phase: 'ready', ...(hostTurnId ? { lastHostTurnId: hostTurnId } : {}) })
      throw error
    } finally {
      entry.onCollaborationWait = undefined
      clearCompactionPoll()
      clearTurnTimer()
      clearTimeout(cancelledTimer)
      signal.removeEventListener('abort', interruptRemote)
      unsubscribe()
      await interactions.close()
      await lease?.close()
      const liveUsage = resolveLiveUsage()
      projector.usage(turnUsage(usageBefore, liveUsage))
      projector.settle({ interrupted: signal.aborted || remoteStatus === 'interrupted' })
      agent.session.append('step/end', { turn, step })
      const elapsedMs = requestStartedAt !== undefined
        ? (requestCompletedAt ?? requestAbortedAt ?? performance.now()) - requestStartedAt
        : NaN
      const timing = usage => turnTimingUsage(usageBefore, liveUsage ?? usage, elapsedMs, projector.hasMeasuredStream)
      const metadata = this.#observe(peer, agent, state, catalog.selection.modelId, false, timing, liveUsage)
        .then(async observedAfter => {
          const afterTokens = Number.isFinite(observedAfter?.contextUsedTokens) && observedAfter.contextUsedTokens > 0 ? observedAfter.contextUsedTokens : undefined
          const afterWindow = Number.isFinite(observedAfter?.contextWindowTokens) && observedAfter.contextWindowTokens > 0 ? observedAfter.contextWindowTokens : compactionBeforeWindow
          let compactionUpdated = false
          const hadCompletedCompaction = [...compactions.values()].some(item => item.phase === 'completed')
          const needsNativeSummary = hadCompletedCompaction
            || (!newThread && remoteStatus === 'completed' && compactions.size === 0 && hostTurnId
              && compactionBeforeTokens !== undefined && compactionBeforeTokens >= 80_000
              && afterTokens !== undefined && afterTokens <= compactionBeforeTokens * 0.55)
          const nativeInfo = needsNativeSummary
            ? await this.#readCompactionSummary({ harnessId, threadId: state.threadId, config: this.#hostConfig }).catch(() => null)
            : null
          const validNativeAfter = isPlausiblePostCompactionUsed(nativeInfo?.afterTokens) ? nativeInfo.afterTokens : undefined
          const validObservedAfter = isPlausiblePostCompactionUsed(afterTokens) ? afterTokens : undefined
          const transcriptLatestUsed = isPlausiblePostCompactionUsed(nativeInfo?.latestContextUsed)
            ? nativeInfo.latestContextUsed
            : validNativeAfter
          for (const item of compactions.values()) {
            if (item.phase !== 'completed') continue
            const nextAfter = item.afterTokens ?? validNativeAfter ?? validObservedAfter
            const nextBefore = item.beforeTokens ?? nativeInfo?.beforeTokens
            const nextSummary = item.summary || nativeInfo?.summary
            const changed = (nextAfter !== undefined && item.afterTokens !== nextAfter)
              || (nextBefore !== undefined && item.beforeTokens !== nextBefore)
              || (Boolean(nextSummary) && item.summary !== nextSummary)
            if (!changed) continue
            recordCompaction(item.id, {
              phase: 'completed',
              ...(nextBefore === undefined ? {} : { beforeTokens: nextBefore }),
              ...(nextAfter === undefined ? {} : { afterTokens: nextAfter }),
              ...(afterWindow === undefined ? {} : { contextWindowTokens: afterWindow }),
              ...(nextSummary ? { summary: nextSummary } : {}),
            })
            compactionUpdated = true
          }
          if (!compactionUpdated && !newThread && remoteStatus === 'completed' && compactions.size === 0 && hostTurnId
            && compactionBeforeTokens !== undefined && compactionBeforeTokens >= 80_000
            && afterTokens !== undefined && afterTokens <= compactionBeforeTokens * 0.55) {
            recordCompaction(`observed:${hostTurnId}`, {
              mode: 'auto',
              phase: 'completed',
              beforeTokens: compactionBeforeTokens,
              afterTokens: validNativeAfter ?? afterTokens,
              ...(afterWindow === undefined ? {} : { contextWindowTokens: afterWindow }),
              ...(nativeInfo?.summary ? { summary: nativeInfo.summary } : {}),
            })
            compactionUpdated = true
          }
          if (hadCompletedCompaction) {
            const recordedAfter = [...compactions.values()].reverse().find(item => item.phase === 'completed' && isPlausiblePostCompactionUsed(item.afterTokens))?.afterTokens
            const postCompactUsed = transcriptLatestUsed ?? recordedAfter
            const observedLooksStale = afterTokens === undefined
              || (compactionBeforeTokens !== undefined && afterTokens >= compactionBeforeTokens * 0.8)
              || (transcriptLatestUsed !== undefined && transcriptLatestUsed < afterTokens)
            if (postCompactUsed !== undefined && observedLooksStale) {
              syncLiveContextObservation(postCompactUsed, afterWindow)
              compactionUpdated = true
            }
          }
          if (compactionUpdated) await this.#ctx.sessionPersistence?.flush?.()
          if (nativeCommand || signal.aborted || this.#stopped || remoteStatus !== 'completed') return
          const titleSignal = AbortSignal.any([signal, this.#metadataAbort.signal])
          // Retry missing titles from the first human message, not only on the initial turn.
          const first = firstMessage ?? (() => {
            const event = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')
            if (!event) return undefined
            const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
            return text.trim() ? { seq: event.seq, text } : undefined
          })()
          if (harnessId === 'claude-code' && this.#titlePolicy.nativeClaude?.enabled) {
            await completeNativeClaudeTitle(this.#ctx, agent, peer, state, first, titleSignal, this.#titlePolicy.nativeClaude)
          } else if (!isContinueOnly && this.#titlePolicy?.enabled && !this.#titleTasks.has(agent.id)) {
            const currentTitle = this.#ctx.get?.('sessionTitle')?.get(agent.session)
            if (!currentTitle || currentTitle.source?.kind === 'fallback') {
              if (harnessId === 'antigravity') {
                const nativeTitle = await readNativeAntigravityTitle({ threadId: state.threadId })
                if (nativeTitle && !titleSignal.aborted && !this.#stopped && this.#syncNativeTitle(agent, nativeTitle)) {
                  await this.#ctx.sessionPersistence?.flush?.()
                  try { await peer.request('thread/name/set', { threadId: state.threadId, name: nativeTitle }, { timeoutMs: 10_000 }) }
                  catch (error) { this.#ctx.logger?.warn(`Antigravity native title saved in DSH; Host name sync unavailable: ${error.code ?? error.name}`) }
                  return
                }
              }
              const retryMessages = collectTitleMessages(agent.session)
              if (retryMessages.length > 0) await completeExternalTitle(this.#ctx, agent, retryMessages, titleSignal, this.#titlePolicy, {
                peer, threadId: state.threadId, harnessId: state.harnessId, hostConfig: this.#hostConfig,
                syncNativeTitle: this.#syncNativeAgentTitle, refresh: true,
              })
            }
          }
          // Catch up Host thread name and native Claude/Antigravity storage once the turn has materialized native files/DB rows.
          if (!titleSignal.aborted && !this.#stopped) {
            const finalTitle = this.#ctx.get?.('sessionTitle')?.get(agent.session)
            if (finalTitle?.title && finalTitle.source?.kind !== 'fallback') {
              try { await peer.request('thread/name/set', { threadId: state.threadId, name: finalTitle.title }, { timeoutMs: 10_000 }) }
              catch (error) { this.#ctx.logger?.warn(`Host title catch-up sync unavailable: ${error.code ?? error.name}`) }
              if (harnessId === 'claude-code' || harnessId === 'antigravity') {
                await this.#syncNativeAgentTitle({ harnessId, threadId: state.threadId, title: finalTitle.title, config: this.#hostConfig, logger: this.#ctx.logger })
              }
            }
          }
        })
        .catch(error => this.#ctx.logger?.warn(`DSH Host metadata unavailable: ${error.code ?? error.name}`))
        .finally(() => { if (this.#usageRefreshing.get(state.threadId) === metadata) this.#usageRefreshing.delete(state.threadId) })
      this.#usageRefreshing.set(state.threadId, metadata)
    }
  }
}

/** Resolve native DSH mentions before handing messages to an external engine. */
export async function prepareExternalReferences(ctx, helpers, agent, messages, signal) {
  const prepared = []
  for (const message of messages) {
    signal.throwIfAborted()
    if (message.source.kind !== 'user' || !message.content.some(block => block.type === 'text' && block.text.includes('dsh-session:'))) { prepared.push(message); continue }
    if (typeof helpers.parseSessionReferenceText !== 'function' || !ctx.get('sessionReferenceResolver')) throw new HostConnectionError('HOST_SESSION_REFERENCE_UNAVAILABLE', 'DSH session reference resolver is unavailable; the message was not sent')
    const references = []
    const content = message.content.map(block => {
      if (block.type !== 'text') return block
      const parsed = helpers.parseSessionReferenceText(block.text)
      references.push(...parsed.references)
      return { ...block, text: parsed.text }
    })
    if (!references.length) { prepared.push(message); continue }
    const route = agent.model.current()
    const resolved = await ctx.get('sessionReferenceResolver').prepare(agent, content, references, { provider: route.provider, model: route.model }, signal)
    if (!resolved.additionalContext) throw new HostConnectionError('HOST_SESSION_REFERENCE_UNAVAILABLE', 'DSH session reference snapshot is missing; the message was not sent')
    prepared.push({ ...message, content: resolved.content }, resolved.additionalContext)
  }
  return prepared
}

export async function installNativeSessionDriver(ctx, options) {
  const modules = await Promise.all(['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-reference'].map(name => ctx.loader.import(name)))
  const helpers = Object.assign({}, ...modules)
  const { Service } = await ctx.loader.import('@deepseek-ai/cordis')
  const driver = new NativeSessionDriver(ctx, helpers, options)
  class NativeDriverService extends Service {
    constructor(scope) { super(scope, 'dshHostNative') }
    available() { return driver.available() }
    owner(agent) { return driver.owner(agent) }
    catalog(agent, targetEngine, childDefaults) { return driver.catalog(agent, targetEngine, childDefaults) }
    configure(agent, configuration) { return driver.configure(agent, configuration) }
    keepalive(sessionId, options) { return driver.keepalive(sessionId, options) }
    preheat(options) { return driver.preheat(options) }
    run(payload) { return driver.run(payload) }
    submitCommand(agent, name, rawInput, signal) { return driver.submitCommand(agent, name, rawInput, signal) }
  }
  ctx.plugin(NativeDriverService)
  for (const [id, harness] of Object.entries(EXTERNAL_PRESETS)) {
    // Legacy ids stay mounted so Sessions created before 2026-11-27 reopen; they sort last and are not offered for new Sessions.
    const legacy = LEGACY_PRESET_IDS.includes(id)
    ctx.effect(async () => await ctx.agentPresets.register({ id, name: engineLabel(harness), ...(legacy ? { order: 1000, description: '仅用于打开 2026-11-27 前创建的会话；新会话请选择同名的 DSH Host 引擎。' } : {}), plugins: [{ name: new URL('./native-preset-driver.mjs', import.meta.url).href }, { name: '@deepseek-ai/dsh-tool-subagent-control' }, { name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', modelSelection: true } },
      // Desktop shell/job tools belong to presets, unlike the headless global composition.
      // Mount the same standard implementations into presets that expose dsh_background.
      ...(NATIVE_COMMAND_ENGINES.includes(harness) ? [{ name: new URL('./native-command-preset.mjs', import.meta.url).href }] : []),
      ...(harness === 'claude-code' || harness === 'antigravity' ? [{ name: '@deepseek-ai/dsh-tool-pwsh' }, { name: '@deepseek-ai/dsh-tool-jobs' }] : []),
    ] }))
  }
  driver.install()
  return driver
}
