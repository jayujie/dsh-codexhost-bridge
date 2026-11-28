import { hostRecord, isHostRecord } from './host-identity.mjs'
import { createHash } from 'node:crypto'
import { EXTERNAL_ENGINE_IDS, EXTERNAL_PRESET_IDS, presetForEngine } from './external-engines.mjs'
import { selectedDelegationTargets } from './delegation-mentions.mjs'
import { HOST_TURN_FAILURE, observedTurnFailure } from './native-turn-failure.mjs'

const TASK_RECORD = hostRecord('native-task')
export const NATIVE_DELEGATION_TOOL = 'dsh_host_task'
export const HOST_SUBAGENT_TOOL = 'subagent_host'
const nativeTargets = [...EXTERNAL_ENGINE_IDS, 'deepseek-harness']
const boundedText = (value, bytes = 12000) => {
  let text = '', size = 0
  for (const ch of String(value ?? '')) { const next = Buffer.byteLength(ch); if (size + next > bytes) return { text, truncated: true }; text += ch; size += next }
  return { text, truncated: false }
}
export function encodeNativeTaskResult(result) {
  const value = { ...result }
  let text = JSON.stringify(value)
  while (Buffer.byteLength(JSON.stringify({ result: text })) > 32000 && typeof value.reply === 'string' && value.reply.length > 0) {
    value.reply = boundedText(value.reply, Math.floor(Buffer.byteLength(value.reply) / 2)).text
    value.reply_truncated = true; text = JSON.stringify(value)
  }
  if (Buffer.byteLength(JSON.stringify({ result: text })) > 32000) throw new Error('External task result exceeds the output limit')
  return text
}
export function nativeTaskRecords(session) {
  const rows = new Map()
  for (const event of session.snapshotEvents()) if (isHostRecord(event.type, 'native-task') && event.ignorable === true && event.data?.version === 1 && event.data.parentSessionId === session.id) rows.set(event.data.taskId, event.data)
  return rows
}
function currentUserTargets(session) {
  const events = session.snapshotEvents(), start = events.findLastIndex(event => event.type === 'turn/start')
  if (start < 0 || events.slice(start).some(event => event.type === 'turn/end')) return []
  return selectedDelegationTargets(events.slice(start).filter(event => event.type === 'user/message').map(event => event.data))
}
export function nativeDelegationInstruction(targets) {
  return `[DSH Host delegation]\n用户明确选择了独立委派目标：${targets.join(', ')}。当前主 Agent 不变。\n` +
    `使用 subagent，为每个目标设置对应 engine 并提供自包含 prompt。外部 model 和 reasoning_effort 先用 list_host_subagent_models 查询；外部引擎不填 provider。` +
    `返回的 name 用于 list_agents、send_message 和已启用的团队任务板；等待实际完成通知再汇报结果。` +
    `Codex 子代理默认工作区内修改权限（workspace-write），Claude 与 Antigravity 子代理默认完全权限（无需审批）。不要使用独立的 dsh-host delegate CLI 或另一套 Host 委派，也不要复制运行时 token。`
}

/** Resolve a native target from the tree root, never another external execution preset. */
export function nativeTargetPreset(ctx, driver, parent) {
  const root = ctx.subagents.rootOf(parent)
  const current = ctx.agentPresets.presetForSession(root.session)
  const original = root.session.snapshotEvents().findLast(event => isHostRecord(event.type, 'original-preset') && event.ignorable === true)?.data.preset
  const preset = driver.owner(root) ? original ?? ctx.agentPresets.defaultId : current ?? ctx.agentPresets.defaultId
  if (!preset || EXTERNAL_PRESET_IDS.includes(preset)) throw new Error('A native DSH preset is required for this target')
  return preset
}

/** Compatibility task receipts over the standard subagent runtime; never owns Agent handles. */
export class NativeDelegation {
  constructor(ctx, driver, helpers) { this.ctx = ctx; this.driver = driver; this.helpers = helpers; this.children = new Map(); this.starting = new Map(); this.initialConfigurations = new Map(); this.lifetime = new AbortController(); this.closed = false }
  assertParent(parent) {
    if (this.closed || !this.driver.available()) throw new Error('DSH Host delegation is unavailable')
    if (!parent) throw new Error('This tool requires a live DSH-managed Agent')
  }
  async save(parent, row) { this.helpers.appendPluginRecord(parent.session, TASK_RECORD, row); await this.ctx.sessionPersistence.flush() }
  async start(parent, args, signal, { requireSelection = true } = {}) {
    this.assertParent(parent); signal = AbortSignal.any([signal, this.lifetime.signal]); signal.throwIfAborted()
    if (!nativeTargets.includes(args.engine) || (requireSelection && !currentUserTargets(parent.session).includes(args.engine))) throw new Error('Start requires that engine to be explicitly selected with # / @ in the current user turn')
    if (typeof args.task !== 'string' || !args.task.trim() || Buffer.byteLength(args.task) > 32000) throw new Error('Task must be self-contained and between 1 and 32000 UTF-8 bytes')
    if (args.name !== undefined && (typeof args.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(args.name) || args.name === 'lead')) throw new Error('Invalid subagent name')
    if (args.engine === 'deepseek-harness' && (args.model !== undefined || args.reasoning_effort !== undefined)) throw new Error('Use native subagent provider/model selection for DSH tasks')
    for (const field of ['model', 'reasoning_effort']) if (args[field] !== undefined && (typeof args[field] !== 'string' || !args[field].trim())) throw new Error('Invalid ' + field)
    const boundary = this.ctx.agents.turnBoundaryOf(parent.session)
    if (boundary.openTurnStartSeq === null) throw new Error('A native delegation requires an open user turn')
    const slot = args.name ? `${args.engine}\0${args.name}` : args.engine
    const taskId = 'hosttask-' + createHash('sha256').update(`${parent.id}\0${boundary.openTurnStartSeq}\0${slot}`).digest('hex').slice(0, 32)
    const digestInput = [args.task, args.description ?? '', args.cwd ?? '']
    if (args.model !== undefined || args.reasoning_effort !== undefined) digestInput.push(args.model ?? null, args.reasoning_effort ?? null)
    const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex'), pending = this.starting.get(taskId), existing = nativeTaskRecords(parent.session).get(taskId)
    if (pending) {
      if (pending.digest !== digest) throw new Error('This target already has a different task in the current turn')
      return pending.promise
    }
    if (existing) {
      if (existing.taskDigest !== digest) throw new Error('This target already has a task in the current turn; do not replace or repeat it')
      return this.read(parent, taskId, signal)
    }
    const promise = this.createTask(parent, args, signal, taskId, digest).finally(() => this.starting.delete(taskId))
    this.starting.set(taskId, { digest, parentId: parent.id, promise })
    return promise
  }
  nativePreset(parent) { return nativeTargetPreset(this.ctx, this.driver, parent) }
  async createTask(parent, args, signal, taskId, digest) {
    const row = { version: 1, parentSessionId: parent.id, taskId, childSessionId: 'session-' + taskId, engine: args.engine, taskDigest: digest, phase: 'creating', managedSubagent: true }
    let preset
    try {
      if (args.model !== undefined || args.reasoning_effort !== undefined) {
        const catalog = await this.driver.catalog(parent, args.engine, true)
        signal.throwIfAborted()
        if (catalog.status !== 'ready') throw new Error(catalog.error ?? 'External model catalog unavailable')
        const modelId = args.model ?? catalog.selection.modelId
        const model = catalog.models.find(item => item.id === modelId)
        if (!model) throw new Error('Model is not advertised by the selected engine')
        if (args.reasoning_effort !== undefined && !model.thinkingOptions.some(item => item.id === args.reasoning_effort)) throw new Error('Reasoning effort is not advertised for the selected model')
        const defaultPermissionMode = args.engine === 'codex' ? 'workspace-write' : args.engine === 'claude-code' ? 'bypassPermissions' : 'dangerously-skip-permissions'
        const advertisedPermissionMode = catalog.selection?.permissionModeId
        const permissionModeId = advertisedPermissionMode && (!Array.isArray(catalog.permissionModes) || catalog.permissionModes.some(mode => mode.id === advertisedPermissionMode)) ? advertisedPermissionMode : defaultPermissionMode
        this.initialConfigurations.set(row.childSessionId, { harnessId: args.engine, modelId, permissionModeId, ...(args.reasoning_effort !== undefined ? { thinkingOptionId: args.reasoning_effort } : {}) })
      }
      await this.save(parent, row)
      signal.throwIfAborted()
      preset = args.engine === 'deepseek-harness' ? this.nativePreset(parent) : presetForEngine(args.engine)
      // Persist an uncertain intent before the manager can accept the first inbox message.
      await this.save(parent, { ...row, phase: 'submitted' })
      signal.throwIfAborted()
    } catch (error) {
      this.initialConfigurations.delete(row.childSessionId)
      await this.save(parent, { ...row, phase: 'not-started' })
      throw error
    }
    // From this point an unconfirmed start is never replayed; the standard catalog is authoritative.
    let activation
    try { activation = await this.ctx.subagents.startActivation({
      provider: 'spawn', parent, childId: row.childSessionId, agentPreset: preset,
      label: args.description?.trim() || `${args.engine}: ${args.task.slice(0, 100)}`,
      ...(args.name ? { name: args.name } : {}), ...(args.cwd ? { cwd: args.cwd } : {}),
      prompt: [{ type: 'text', text: args.task }], signal,
      maxDepth: this.ctx.subagents.resolveMaxDepth(), delivery: 'parent',
    }) } finally { this.initialConfigurations.delete(row.childSessionId) }
    const accepted = { ...row, phase: 'submitted', name: activation.name }
    await this.save(parent, accepted)
    const tracked = { parentId: parent.id, activation, done: activation.result }
    this.children.set(taskId, tracked)
    void tracked.done.catch(error => this.ctx.logger?.warn(`Host subagent result unavailable: ${error.code ?? error.name}`)).finally(() => { if (this.children.get(taskId) === tracked) this.children.delete(taskId) })
    const child = this.ctx.agents.get(activation.childId)
    if (child?.session.header.cwd) {
      const workspace = await this.ctx.workspaceRegistry.create(child.session.header.cwd)
      await workspace.attachSession(activation.childId)
    }
    return this.read(parent, taskId, signal)
  }
  async events(row, signal) {
    signal.throwIfAborted()
    const live = this.ctx.agents.get(row.childSessionId)
    if (live) return { events: live.session.snapshotEvents(), running: live.status === 'running', partial: false }
    const stat = await this.ctx.sessionPersistence.stat(row.childSessionId, { signal })
    if (!stat) return { events: [], running: false, partial: true }
    const handle = await this.ctx.sessionPersistence.open(row.childSessionId, 'read', { signal })
    try {
      const counted = Number.isSafeInteger(stat.eventCount), offset = counted ? Math.max(0, stat.eventCount - 512) : 0
      const { events } = await handle.read(offset, 512, { signal })
      if (!counted && events.length === 512 && (await handle.read(512, 1, { signal })).events.length) return { events: [], running: false, partial: true }
      return { events, running: false, partial: offset > 0 }
    } finally { await handle.close() }
  }
  async read(parent, taskId, signal) {
    this.assertParent(parent)
    const row = nativeTaskRecords(parent.session).get(taskId)
    if (!row) throw new Error('Task does not belong to this DSH Session')
    const base = { task_id: taskId, session_id: row.childSessionId, engine: row.engine, ...(row.name ? { name: row.name } : {}) }
    if (row.phase === 'not-started') return { ...base, status: 'not-started', reply: '' }
    const snapshot = await this.events(row, signal)
    const start = snapshot.events.findLast(event => event.type === 'turn/start')
    const current = start ? snapshot.events.filter(event => event.seq >= start.seq) : snapshot.events
    const end = current.findLast(event => event.type === 'turn/end')
    const currentTurn = start?.data.turn ?? end?.data.turn
    const texts = current.findLast(event => event.type === 'assistant/message' && (currentTurn === undefined || event.data.turn === undefined || event.data.turn === currentTurn))?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    const reply = boundedText(texts)
    const ended = end && (!start || end.seq > start.seq)
    const status = snapshot.running ? 'running' : !ended ? 'unknown' : end.data.reason.kind === 'completed' ? 'completed' : end.data.reason.kind === 'aborted' ? 'cancelled' : 'failed'
    const nativeFailure = current.findLast(event => isHostRecord(event.type, 'turn-failure') && event.ignorable === true && event.data.version === 1 && event.data.harnessId === row.engine && (currentTurn === undefined || event.data.turn === currentTurn))?.data.failure
    const failure = status === 'failed' ? observedTurnFailure(nativeFailure ?? end?.data.reason.error) : undefined
    return { ...base, status, reply: reply.text, reply_truncated: reply.truncated, history_partial: snapshot.partial, ...(failure ? { failure } : {}) }
  }
  async run(parent, args, signal) {
    this.assertParent(parent); signal.throwIfAborted()
    if (args.action === 'start') return this.start(parent, args, signal)
    if (args.action === 'list') return { tasks: [...nativeTaskRecords(parent.session).values()].slice(-20).map(row => ({ task_id: row.taskId, session_id: row.childSessionId, engine: row.engine, ...(row.name ? { name: row.name } : {}) })) }
    const row = nativeTaskRecords(parent.session).get(args.task_id)
    if (!row) throw new Error('Task does not belong to this DSH Session')
    const child = this.ctx.agents.get(row.childSessionId)
    let cancelled = false
    if (args.action === 'cancel') {
      if (row.managedSubagent && child?.status === 'running') {
        this.ctx.subagents.interrupt(row.childSessionId, { kind: 'ancestor', agent: parent })
        cancelled = true
      }
    } else if (!['read', 'wait'].includes(args.action)) throw new Error('Unsupported native delegation action')
    if ((args.action === 'wait' || args.action === 'cancel') && child?.status === 'running') {
      let timer, abort
      try { await Promise.race([child.whenIdle(), new Promise((resolve, reject) => { timer = setTimeout(resolve, 20000); abort = () => reject(signal.reason ?? new Error('Stopped waiting')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })]) }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    }
    return { ...(await this.read(parent, args.task_id, signal)), ...(args.action === 'cancel' ? { cancel_requested: cancelled } : {}) }
  }
  async dispose() {
    this.closed = true; this.lifetime.abort(new Error('DSH Host delegation unloaded'))
    await Promise.allSettled([...this.starting.values()].map(entry => entry.promise))
    // Standard subagents owns children, completion delivery and root teardown.
    this.children.clear()
  }
}

export async function installNativeDelegation(ctx, driver) {
  const [tools, llm, agents, sessions] = await Promise.all(['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session'].map(name => ctx.loader.import(name)))
  if (!ctx.get('subagents')) throw new Error('Unified Host delegation requires the standard DSH subagent runtime')
  const helpers = { ...llm, ...agents, ...sessions }, manager = new NativeDelegation(ctx, driver, helpers)
  ctx.on('agent/created', async ({ agent }) => {
    const configuration = manager.initialConfigurations.get(agent.id)
    if (configuration) {
      helpers.appendPluginRecord(agent.session, hostRecord('configuration'), configuration)
      await ctx.sessionPersistence.flush(agent.session)
    }
  })
  await installUnifiedSubagentEntry(ctx, manager, driver, tools)

  ctx.on('agent/pre-step', async (payload, next) => {
    if (driver.owner(payload.agent)) return next()
    const targets = selectedDelegationTargets(payload.messages)
    const decision = await next()
    if (!targets.length || decision.kind === 'reject') return decision
    if (!ctx.tools.get('subagent', payload.agent)?.parameters.properties.engine) throw new Error('当前预设未允许统一 subagent 引擎入口')
    return { ...decision, messages: [...decision.messages, helpers.createUserMessage({ content: [{ type: 'text', text: nativeDelegationInstruction(targets) }], source: { kind: 'dsh-host-native-delegation', form: 'instructions' } })] }
  })
  ctx.effect(() => () => manager.dispose())
  return manager
}

/** Scoped facade: omitted/native engine executes the original admitted DSH tool. */
export async function installUnifiedSubagentEntry(ctx, manager, driver, tools) {
  const installed = new Map()
  const install = agent => {
    if (installed.has(agent)) return
    const original = ctx.tools.get('subagent', agent)
    if (!original) return
    const extension = tools.defineTool({ name: 'external-entry-schema', parameters: {
      engine: { type: 'string', enum: ['deepseek-harness', ...EXTERNAL_ENGINE_IDS], description: 'Child execution engine; omitted uses native DSH.' },
      model: { type: 'string', description: 'External model id from list_host_subagent_models; native DSH model requires provider.' },
      reasoning_effort: { type: 'string', description: 'Supported effort id for the selected engine and model; omitted uses its default.' },
    }, output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: async () => ({}) })
    const definition = {
      ...original,
      description: original.description + ' Use engine=codex, claude-code, or antigravity for external teammates in this same tree. Query list_host_subagent_models first for their model and reasoning_effort ids. Omit engine for native DSH delegation.',
      parameters: { ...original.parameters, properties: { ...original.parameters.properties, ...extension.parameters.properties } },
      async execute(args, exec) {
        if (args.engine === undefined || args.engine === 'deepseek-harness') {
          const { engine, ...native } = args
          return original.execute(native, exec)
        }
        if (!EXTERNAL_ENGINE_IDS.includes(args.engine)) throw new Error('Unknown child engine')
        if (args.provider !== undefined) throw new Error('provider selects a DSH LLM route; omit provider for an external engine')
        const result = await manager.start(exec.agent, { ...args, task: args.prompt }, exec.signal, { requireSelection: false })
        return { kind: 'activation', name: result.name }
      },
    }
    installed.set(agent, () => {})
    try {
      const dispose = agent.ctx.tools.register(definition)
      installed.set(agent, dispose)
    } catch (error) { installed.delete(agent); throw error }
  }
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  ctx.on('tools/change', () => { for (const agent of ctx.agents.list()) install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
  ctx.effect(() => () => { for (const dispose of installed.values()) dispose(); installed.clear() })
  ctx.effect(() => ctx.tools.register(tools.defineTool({
    name: 'list_host_subagent_models',
    description: 'Read native Codex, Claude Code or Antigravity child model ids and their supported reasoning effort ids. Starts no inference task.',
    parameters: { engine: { type: 'string', required: true, enum: [...EXTERNAL_ENGINE_IDS] } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(args, exec) {
      if (!exec.agent || !EXTERNAL_ENGINE_IDS.includes(args.engine)) throw new Error('Live parent and external engine required')
      const catalog = await driver.catalog(exec.agent, args.engine, true)
      if (catalog.status !== 'ready') throw new Error(catalog.error ?? 'External catalog unavailable')
      return { result: JSON.stringify({ engine: args.engine, models: catalog.models, defaults: { model: catalog.selection.modelId, reasoning_effort: catalog.selection.thinkingOptionId } }) }
    },
  })))
}
