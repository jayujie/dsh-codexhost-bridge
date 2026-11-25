import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { nativeRemoteContribution } from './remote-contract.mjs'
import { AGENT_ICONS } from './icons.mjs'
import { installConsoleClient, CONSOLE_PANEL_ID, dshConsoleCss } from './console-client.mjs'
import { Menu, RiskConfirmation, IconDatabaseOutlineRegular, IconChevronDownOutlineRegular, PermissionIconReadOnlyRegular, PermissionIconWorkspaceWriteRegular, PermissionIconFullAccessRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostPermissionOptions, hostPermissionPresentation } from './permission-presentation.mjs'
import { getSliderPrimitive } from './slider-runtime.mjs'
import { getNativeModelSelect, nativeModelCss } from './native-model-runtime.mjs'
import { dshPresetView } from './preset-view.mjs'
import { externalProjection, hostCostLabel, hostModelPresentation, hostApiCostObservation } from './native-ui-projections.mjs'
import { ContextMeter, nativeContextCss } from './native-context.mjs'
import { hostFormat } from './native-host-format.mjs'
import { DelegationPicker, installDelegationSource, delegationCss } from './delegation-client.mjs'
import { DELEGATION_SOURCE, delegationReference } from './delegation-mentions.mjs'
import { installNativeRepliesClient } from './native-replies-client.mjs'
import { installNativeCompactionClient } from './native-compaction-client.mjs'
import { installNativeTurnUsageClient, nativeTurnUsageCss } from './native-turn-usage-client.mjs'

const NS = 'codexhost'
const AGENTS = [{ id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }, { id: 'antigravity', label: 'Antigravity' }, { id: 'deepseek-harness', label: 'DSH' }]
const en = { agent: 'Agent', model: 'Model', thinking: 'Thinking', permission: 'Permissions', loading: 'Loading…', retry: 'Retry', error: 'Connection failed', confirmDanger: 'Allow this Agent to bypass permission checks?', locked: 'The Agent is fixed after the first message', off: 'Off', auto: 'Auto', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const zh = { agent: 'Agent', model: '模型', thinking: '思考', permission: '权限', loading: '加载中…', retry: '重试', error: '连接失败', confirmDanger: '允许此 Agent 跳过权限检查？', locked: '首条消息发送后不能更换 Agent', off: '关闭', auto: '自动', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' }
Object.assign(en, { console: 'DSH Host console', refresh: 'Reload', openConsole: 'Open console', notRunning: 'Host is not running' })
Object.assign(zh, { console: 'DSH Host 控制台', refresh: '重新加载', openConsole: '打开控制台', notRunning: 'Host 未启动' })
Object.assign(en, { 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'full-access': 'Full access', confirmTitle: 'Enable {mode}?', confirmDescription: 'This mode can run commands and change files without individual permission checks. Use it only for a task you trust.', acknowledge: 'I understand the risks', cancel: 'Cancel', enable: 'Enable', close: 'Close', thinkingDefault: 'Model default' })
Object.assign(zh, { 'read-only': '只读', 'workspace-write': '工作区内修改', 'full-access': '完全访问', confirmTitle: '启用{mode}？', confirmDescription: '此模式可以执行命令、修改文件，并跳过逐项权限确认。请仅对你信任的任务启用。', acknowledge: '我了解并接受此风险', cancel: '取消', enable: '启用', close: '关闭', thinkingDefault: '模型默认' })
Object.assign(en, { permissionReadOnly: 'Read only', permissionWorkspaceWrite: 'Workspace write', permissionFullAccess: 'Full access', permissionPlan: 'Plan mode', permissionEdit: 'Edit mode', permissionNativeDefault: 'Default (native)', permissionNativeAuto: 'Auto (native)' })
Object.assign(zh, { permissionReadOnly: '仅可查看', permissionWorkspaceWrite: '工作区内修改', permissionFullAccess: '完全权限', permissionPlan: '规划模式', permissionEdit: '编辑模式', permissionNativeDefault: '默认（原生）', permissionNativeAuto: '自动模式（原生）' })
Object.assign(en, { totalUsage: 'Session usage', uncached: 'Uncached input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output', cacheHit: 'Cache hit', context: 'Context', nativeContext: 'Native context', capacity: 'Context capacity', usedContext: 'Context used', observed: 'Last native observation', unknown: 'Unavailable' })
Object.assign(zh, { totalUsage: '会话用量', uncached: '未缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出', cacheHit: '缓存命中', context: '上下文', nativeContext: '原生上下文', capacity: '上下文容量', usedContext: '上下文已用', observed: '上次原生观测', unknown: '未提供' })

Object.assign(zh, { recoveryTitle: '核对原生任务的真实结果；不会重发任务', quotaResume: '额度续跑', quotaChipCountdown: '续跑 {time}', quotaChip_waiting: '等待空闲后续跑', quotaChip_sending: '正在续跑…', quotaChip_done: '已续跑', quotaChip_off: '续跑已关', quotaChip_stopped: '续跑已停止', quotaChip_stale: '续跑已过期', quotaChip_unknown: '额度暂停', quotaChip_error: '续跑失败',
  quotaSchedule: '五小时额度预计北京时间 {reset} 重置，{due} 自动发送“继续”。', quotaNoReset: '网关没有给出重置时间，不会自动续跑。', quotaAuto: '额度重置 2 分钟后自动继续',
  quotaNote: '只在会话空闲时发送一条“继续”，不重放旧请求或工具。需要保持 DSH 页面打开；若网关仍未恢复，会按新的重置时间再排，最多连续 3 次。超过 6 小时未发出则不再自动发送。',
  quotaNow: '立即继续', quotaSkip: '本次不续跑', quotaExhausted: '已连续 {n} 次因额度失败，停止自动续跑。', quotaSendFailed: '发送失败：', quotaSessionGone: '会话已关闭，无法续跑。',
  quotaResumePrompt: '继续完成之前的任务。（上一轮因五小时额度保护暂停，额度已重置，这是自动续跑。）' })
Object.assign(en, { recoveryTitle: 'Check the native outcome; nothing is resent', quotaResume: 'Quota resume', quotaChipCountdown: 'Resume {time}', quotaChip_waiting: 'Resume when idle', quotaChip_sending: 'Resuming…', quotaChip_done: 'Resumed', quotaChip_off: 'Resume off', quotaChip_stopped: 'Resume stopped', quotaChip_stale: 'Resume expired', quotaChip_unknown: 'Quota paused', quotaChip_error: 'Resume failed',
  quotaSchedule: 'The five-hour quota should reset at {reset} (Beijing); “continue” is sent at {due}.', quotaNoReset: 'The gateway gave no reset time; no automatic resume.', quotaAuto: 'Continue automatically 2 minutes after reset',
  quotaNote: 'Sends one “continue” only while the session is idle; old requests and tools are not replayed. Keep DSH open. If the gateway is still limited, it reschedules up to 3 times in a row. Not sent automatically more than 6 hours late.',
  quotaNow: 'Continue now', quotaSkip: 'Skip this time', quotaExhausted: 'Failed on quota {n} times in a row; automatic resume stopped.', quotaSendFailed: 'Send failed: ', quotaSessionGone: 'Session closed; cannot resume.',
  quotaResumePrompt: 'Continue the previous task. (The last turn stopped on the five-hour quota guard; the quota has reset and this is an automatic resume.)' })

Object.assign(en, { apiValue: 'API value', publicPrice: 'API pricing, including cache reads and writes', nativeCost: 'Native reported API cost', unpriced: 'Not priced', priceUnavailable: 'API value unavailable' })
Object.assign(zh, { apiValue: 'API 价值', publicPrice: '按 API 价格计算，包含缓存读取与写入', nativeCost: '原生返回的 API 费用', unpriced: '未计价', priceUnavailable: 'API 价值暂不可用' })

Object.assign(zh, { hostTurnAverage: '本轮平均吞吐（含等待和工具耗时）', hostAveragePrefix: '平均 ', hostLocale:'zh-CN', hostCredits:'已记录消耗', priceRefreshing:'统计正在刷新，当前为 Host 已保存的记录', hostUsage:'用量', hostSession:'会话', hostTurn:'本轮', hostCost:'费用估算', hostAverageCache:'平均缓存命中', hostRecentCache:'最近缓存命中（CH）', hostTps:'输出速度（TPS）', hostApiTps:'API 平均速度', hostTtft:'首 token（TTFT）', hostInputOutput:'输入 / 输出', hostCacheReadWrite:'缓存读取 / 写入', hostTotal:'总数' })
Object.assign(en, { hostTurnAverage: 'Turn average throughput (including wait and tools)', hostAveragePrefix: 'Avg ', hostLocale:'en', hostCredits:'Recorded credits', priceRefreshing:'Refreshing statistics; showing the saved Host record', hostUsage:'Usage', hostSession:'Session', hostTurn:'Latest turn', hostCost:'Cost estimate', hostAverageCache:'Session cache hit', hostRecentCache:'Latest cache hit (CH)', hostTps:'Output speed (TPS)', hostApiTps:'API average speed', hostTtft:'Time to first token (TTFT)', hostInputOutput:'Input / output', hostCacheReadWrite:'Cache read / write', hostTotal:'Total' })

Object.assign(zh, { recoveryOutcome: '原生结果', recovery_completed: '已完成', recovery_failed: '失败', recovery_interrupted: '已中断', recovery: '核对任务', recoveryCheck: '重新核对', recoveryConfirm: '解锁后续发送', recoveryChecking: '正在核对原生任务…', recoveryAcknowledge: '我已停止原客户端，仅解锁后续发送', recoveryNote: '不重发任务，不补齐断线期间丢失的回复。请先在原客户端核对结果。', 'recovery_no-pending': '没有待确认的操作，无需解锁。', 'recovery_not-sent': '上次操作确定尚未发出，可以重新发送。', 'recovery_local-active': '本地任务仍在执行，暂不能核对恢复。', 'recovery_remote-active': '原生任务仍在执行，请等待结束或在原客户端停止。', 'recovery_identity-missing': '缺少确定的 Thread / Turn 身份，不能安全解锁；请在原客户端核对，勿重复发送。', 'recovery_status-unknown': '上游未提供可确认的终态，仍保持保护。', 'recovery_turn-missing': '最新任务与本地记录不匹配，或历史不完整；不能安全解锁。', 'recovery_history-changed': '核对期间原生会话发生变化，请停止原客户端后重查。', 'recovery_terminal-confirmed': '已确认原生任务结束。确认后可解锁后续发送，但不会重发旧任务。', 'recovery_unlocked': '已解锁后续发送，旧任务没有重发。' })
Object.assign(en, { recoveryOutcome: 'Native outcome', recovery_completed: 'Completed', recovery_failed: 'Failed', recovery_interrupted: 'Interrupted', recovery: 'Check outcome', recoveryCheck: 'Check again', recoveryConfirm: 'Unlock future messages', recoveryChecking: 'Checking native outcome…', recoveryAcknowledge: 'I stopped the source client; unlock future messages only', recoveryNote: 'Does not replay tasks or restore replies lost during disconnection. Check the original client first.', 'recovery_no-pending': 'No pending operation needs recovery.', 'recovery_not-sent': 'The previous operation was not dispatched. It is safe to send again.', 'recovery_local-active': 'A local task is still running.', 'recovery_remote-active': 'The native task is still running. Wait or stop it in the source client.', 'recovery_identity-missing': 'Thread / Turn identity is missing. Recovery cannot be confirmed; do not resend blindly.', 'recovery_status-unknown': 'No confirmed terminal outcome is available. Protection remains enabled.', 'recovery_turn-missing': 'The latest native task does not match or history is incomplete. Recovery is blocked.', 'recovery_history-changed': 'Native history changed during the check. Stop the source client and check again.', 'recovery_terminal-confirmed': 'The native task has ended. You may unlock future messages without replaying this task.', 'recovery_unlocked': 'Future messages are unlocked. The previous task was not replayed.' })

Object.assign(zh, { delegateTargetHint: '独立任务，不切换当前会话', delegateTitle: '委派给 Agent', delegateIndependent: '发送后由当前 Agent 创建原生可续接子智能体，可选择 Codex / Claude / Antigravity / DSH，不切换当前会话', delegateUnavailable: '暂不可用', delegateNoMatch: '没有匹配的 Agent', delegateDraftChanged: '草稿已变化，请重新输入 # 选择目标', delegateSessionUnavailable: '当前会话不可用，请重新打开会话', delegateRemoveSelfBeforeSwitch: '请先移除指向 DSH 的委派标签', delegateNativeIndependent: '创建原生可续接子智能体，进入子代理树与已开启的共享任务板；Codex 默认工作区内修改，Claude / Antigravity 默认完全权限' })
Object.assign(en, { delegateTargetHint: 'Independent task; keep this conversation', delegateTitle: 'Delegate to Agent', delegateIndependent: 'Sending asks the current Agent to create a continuable Codex / Claude / Antigravity / DSH subagent, without switching this conversation.', delegateUnavailable: 'Unavailable', delegateNoMatch: 'No matching Agent', delegateDraftChanged: 'Draft changed. Type # again to choose a target.', delegateSessionUnavailable: 'This Session is unavailable. Reopen it first.', delegateRemoveSelfBeforeSwitch: 'Remove references targeting DSH before switching to DSH.', delegateNativeIndependent: 'Create a continuable native subagent in the shared tree and enabled task board. Codex starts in workspace-write; Claude / Antigravity use full access.' })

Object.assign(zh, { childModelPending: '模型尚未记录', childModelDefault: '默认（具体型号未记录）', childModelSelection: '{model}（已选模型）', legacyClaudeDefault: '旧会话默认（未切换）' })
Object.assign(en, { childModelPending: 'Model not recorded yet', childModelDefault: 'Default (resolved model not recorded)', childModelSelection: '{model} (selected model)', legacyClaudeDefault: 'Legacy default (unchanged)' })

export const inject = ['slots', 'locale', 'sessions', 'remote', 'layout', 'remoteAccess']

export async function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  const t = ctx.locale.bind(NS)
  installConsoleClient(ctx, t)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css + nativeContextCss + dshConsoleCss + delegationCss + nativeModelCss + nativeTurnUsageCss
    document.head.append(style)
    return () => style.remove()
  })
  ctx.effect(async () => await ctx.remote.$mount(nativeRemoteContribution))
  ctx.inject(['remote.codexHost', 'remote.agentPresets', 'remote.settings', 'conversation', 'uiWorkspace', 'configForms'], scope => {
    const directories = new Map()
    const directoryFor = sessionId => {
      const binding = scope.sessions.binding(sessionId)
      if (!binding) throw new Error('CodexHost controls require a native Session binding')
      let directory = directories.get(binding)
      if (!directory) {
        directory = new CatalogDirectory(scope.remote.codexHost, sessionId, t)
        directories.set(binding, directory)
        binding.ctx.effect(() => () => { directory.dispose(); directories.delete(binding) })
      }
      return directory
    }
    const canDelegate = id => scope.sessions.binding(id)?.session !== undefined && scope.sessions.subagentAddress(id) === undefined
    scope.inject(['inputTriggers'], triggerScope => installDelegationSource(triggerScope, { canDelegate, directoryFor, t }))
    scope.slots.inject('conversation.input.model', () => {
      const native = scope.slots.entriesOfSlot('conversation.input.model')[0]
      if (!native) throw new Error('CodexHost requires the native model seat')
      return scope.slots.register({
        name: 'conversation.input.model', priority: (native.options.priority ?? 0) - 100, locale: native.locale,
        inject: sessionId => ({ ...native.inject?.(sessionId), modelSlots: Object.fromEntries(
          ['conversation.input.model.label', 'conversation.input.model.options'].map(name => [name,
            scope.slots.entriesOfSlot(name).map(entry => ({ Component: entry.component, injected: entry.inject?.(sessionId) ?? {}, t: scope.locale.bind(entry.locale ?? native.locale) })),
          ])),
        }),
      }, NativeModelSeat)
    })
    // The right list is additive. CSS ordering places this seat after the
    // native model, preserving the separate microphone/activity seat.
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right', id: 'codexhost-agent-controls', order: 1000, locale: NS,
      inject: sessionId => ({ sessionId, hostDirectory: directoryFor(sessionId), openConsole: () => scope.layout.selectPanel(CONSOLE_PANEL_ID),
        nativeModel: (() => { const entry = scope.slots.entriesOfSlot('conversation.input.model')[0]; if (!entry) throw new Error('CodexHost requires the native model seat'); return { Component: entry.component, t: scope.locale.bind(entry.locale ?? 'model') } })(),
        nativeTeam: (() => { const entry = scope.slots.entriesOfSlot('conversation.input.model.options').find(row => row.options.id === 'agent-team'); return entry ? { Component: entry.component, injected: entry.inject?.(sessionId) ?? {}, t: scope.locale.bind(entry.locale ?? 'agent-team') } : null })(),
        insertDelegation: (id, span) => {
          if (!canDelegate(sessionId)) return false
          const binding = scope.sessions.binding(sessionId)
          return binding?.ctx.bail('slash/input-insert-reference', { reference: delegationReference(id), span }) === true
        },
        focusInput: () => { const binding = scope.sessions.binding(sessionId); if (binding) scope.conversation.input.for(binding.ctx).focus() },
      }),
    }, NativeAgentControls))
    // Left side, after the keepalive chip (order 40): outcome check and quota resume.
    scope.slots.inject('conversation.input.left', () => scope.slots.register({
      name: 'conversation.input.left', id: 'codexhost-task-controls', order: 50, locale: NS,
      inject: sessionId => ({ sessionId, hostDirectory: directoryFor(sessionId),
        resume: async text => {
          const session = scope.sessions.binding(sessionId)?.session
          if (!session) throw new Error(t('quotaSessionGone'))
          unwrap(await session.prompt([{ type: 'text', text }], 'queue'))
        },
      }),
    }, NativeLeftControls))
    scope.slots.inject('conversation.input.permission', () => {
      const native = scope.slots.entriesOfSlot('conversation.input.permission')[0]
      if (!native || native.children) throw new Error('CodexHost requires the native permission seat without child declarations')
      return scope.slots.register({
        name: 'conversation.input.permission', priority: (native.options.priority ?? 0) - 100,
        locale: native.locale,
        inject: sessionId => ({ ...native.inject?.(sessionId), sessionId, hostDirectory: directoryFor(sessionId), hostT: t, NativePermission: native.component }),
      }, PermissionSeat)
    })
    scope.slots.inject('conversation.hero.agentPreset', () => {
      const native = scope.slots.entriesOfSlot('conversation.hero.agentPreset')[0]
      if (!native) return () => {}
      const views = new WeakMap()
      return scope.slots.register({ name: 'conversation.hero.agentPreset', priority: (native.options.priority ?? 0) - 100, locale: native.locale,
        inject: sessionId => {
          const props = native.inject?.(sessionId) ?? {}
          const source = props.hooks?.agentPresetSeat
          if (source && !views.has(source)) views.set(source, dshPresetView(source))
          return { ...props, ...(source ? { hooks: { ...props.hooks, agentPresetSeat: views.get(source) } } : {}), NativePreset: native.component }
        },
      }, HeroPresetSeat)
    })
    scope.slots.inject('sidebar.session.row.leading', () => scope.slots.register({
      name: 'sidebar.session.row.leading', id: 'codexhost-session-agent', order: 0, locale: NS,
    }, SessionAgentMark))
  })
  ctx.inject(['uiSession', 'uiConversation', 'remote.session', 'sidebarRight', 'fileDrag'], scope => {
    scope.effect(() => installNativeRepliesClient(scope), 'codexhost: native reply display')
    scope.effect(() => installNativeCompactionClient(scope), 'codexhost: native compaction display')
    scope.effect(() => installNativeTurnUsageClient(scope), 'codexhost: native turn usage display')
    scope.slots.inject('tool.call.toolview', () => scope.effect(() => {
      const aliases = { Read: 'read', Write: 'write', Edit: 'edit', Grep: 'grep', Glob: 'glob', Bash: 'bash', PowerShell: 'pwsh', exec_command: 'pwsh', fileChange: 'edit' }
      const disposers = []
      let unsubscribe, installed = false
      const mount = () => {
        if (installed) return
        const entries = scope.slots.entriesOfSlot('tool.call.toolview')
        const viewFor = key => entries.find(entry => entry.options.key === key) ?? (key === 'pwsh' ? entries.find(entry => entry.options.key === 'bash') : undefined)
        if (Object.values(aliases).some(key => !viewFor(key))) return
        installed = true
        unsubscribe?.()
        for (const [alias, key] of Object.entries(aliases)) {
          const native = viewFor(key)
          disposers.push(scope.slots.register({ name: 'tool.call.toolview', key: alias, priority: (native.options.priority ?? 0) - 100, locale: native.locale,
            inject: sessionId => ({ ...native.inject?.(sessionId), NativeToolView: native.component, nativeToolName: key }),
          }, NativeToolViewSeat))
        }
      }
      mount()
      if (!installed) unsubscribe = scope.slots.subscribe('tool.call.toolview', mount)
      return () => { unsubscribe?.(); for (const dispose of disposers.reverse()) dispose() }
    }))
    scope.slots.inject('conversation.composer.dock', () => scope.effect(() => {
      const disposers = []
      let unsubscribe, installed = false
      const mount = () => {
        if (installed) return
        const entries = scope.slots.entriesOfSlot('conversation.composer.dock')
        const originals = ['activity', 'usage'].map(id => entries.find(entry => entry.options.id === id))
        if (originals.some(entry => !entry)) return
        installed = true
        unsubscribe?.() // Stop before any mutation of the watched registry.
        for (const native of originals) disposers.push(scope.slots.register({ name: 'conversation.composer.dock', id: native.options.id, priority: (native.options.priority ?? 0) - 100, order: native.options.order,
          locale: native.locale, inject: sessionId => ({ ...native.inject?.(sessionId), NativeSeat: native.component, hostT: t }),
        }, NativeStatisticsSeat))
      }
      mount()
      if (!installed) unsubscribe = scope.slots.subscribe('conversation.composer.dock', mount)
      disposers.push(scope.slots.register({ name: 'conversation.composer.dock', id: 'codexhost-context', order: 3, locale: 'conversation' }, NativeContextSeat))
      disposers.push(scope.slots.register({ name: 'conversation.composer.dock', id: 'codexhost-api-value', order: 2, locale: NS }, ApiValueSeat))
      return () => { unsubscribe?.(); for (const dispose of disposers.reverse()) dispose() }
    }))
  })
}

function unwrap(result) {
  if (result?.ok === false) throw new Error(result.error?.message ?? String(result.error))
  return result?.ok === true ? result.value : result
}

class CatalogDirectory {
  constructor(remote, sessionId, t) {
    this.t = t
    this.remote = remote
    this.sessionId = sessionId
    this.state = { status: 'idle', catalog: null, error: '' }
    this.listeners = new Set()
    this.generation = 0
    this.modelStore = { subscribe: this.subscribe, getSnapshot: () => {
      if (this.modelState !== this.state) {
        this.modelState = this.state
        this.modelSnapshot = hostModelSnapshot(this.state, this.t?.('legacyClaudeDefault'))
      }
      return this.modelSnapshot
    } }
  }
  getSnapshot = () => this.state
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  set(state) { this.state = state; for (const listener of this.listeners) listener() }
  dispose() { this.generation++; this.listeners.clear(); this.disposed = true }
  async load(preset) {
    if (this.state.status === 'selecting' && this.state.pending) return
    if (preset !== undefined && this.loadedPreset === preset && this.state.status === 'ready' && Date.now() - this.loadedAt < 60000) return
    const generation = ++this.generation
    this.set({ ...this.state, status: this.state.catalog?.status === 'ready' ? 'ready' : 'loading', error: '' })
    try {
      const catalog = unwrap(await this.remote.catalog(this.sessionId))
      if (this.disposed || generation !== this.generation) return
      this.loadedPreset = preset
      this.loadedAt = Date.now()
      this.set({ status: catalog.status === 'error' ? 'error' : 'ready', catalog, error: catalog.error ?? '' })
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.set({ ...this.state, status: 'error', error: error.message })
    }
  }
  async delegationTargets(refresh = false) {
    if (refresh) this.targetRead = undefined
    this.targetRead ??= this.remote.delegationTargets(this.sessionId).then(unwrap).catch(error => { this.targetRead = undefined; throw error })
    return this.targetRead
  }
  async checkRecovery() { return unwrap(await this.remote.recovery(this.sessionId)) }
  async reconcileRecovery(expected) { return unwrap(await this.remote.reconcile(this.sessionId, { expected, acknowledgeStopped: true })) }
  async selectAgent(agentId) {
    this.targetRead = undefined
    this.set({ ...this.state, status: 'selecting', error: '' })
    try { unwrap(await this.remote.selectAgent(this.sessionId, agentId)); await this.load() }
    catch (error) { this.set({ ...this.state, status: 'error', error: error.message }) }
  }
  async configure(configuration) {
    const generation = ++this.generation
    const selection = this.state.catalog?.selection
    this.set({ ...this.state, status: 'selecting', error: '', pending: {
      provider: this.state.catalog?.agentId, model: configuration.modelId ?? selection?.modelId,
      reasoningEffort: configuration.thinkingOptionId,
    } })
    try {
      const catalog = unwrap(await this.remote.configure(this.sessionId, configuration))
      if (!this.disposed && generation === this.generation) this.set({ status: 'ready', catalog, error: '' })
      return { ok: true, value: undefined }
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.set({ ...this.state, status: 'error', error: error.message, pending: null })
      return { ok: false, error: { code: 'host/configure', message: error.message } }
    }
  }
}

function agentId(preset) { return preset === 'codexhost-codex' ? 'codex' : preset === 'codexhost-claude-code' ? 'claude-code' : preset === 'codexhost-antigravity' ? 'antigravity' : 'deepseek-harness' }
function icon(id, size = 20) { return h('img', { src: AGENT_ICONS[id], width: size, height: size, alt: '', draggable: false, style: { objectFit: 'contain', flex: 'none' } }) }
function thinkingLabel(option) { return option?.id }
function SessionAgentMark({ sessionId, useSessions }) {
  const summary = useSessions(state => state.byId[sessionId])
  if (!summary) return null
  const owner = agentId(summary.projectionValues?.agentPreset)
  const label = AGENTS.find(agent => agent.id === owner).label
  return h('img', { src: AGENT_ICONS[owner], width: 16, height: 16, alt: label, title: label,
    draggable: false, 'data-codexhost-session-agent': owner, style: { objectFit: 'contain', flex: 'none' } })
}
function HeroPresetSeat(props) {
  const preset = props.useProjection('agentPreset')
  return agentId(preset) === 'deepseek-harness' ? h(props.NativePreset, props) : null
}

function NativeStatisticsSeat(props) {
  const preset = props.useProjection('agentPreset')
  const observation = props.useProjection('codexHostObservation')
  const external = agentId(preset) !== 'deepseek-harness'
  const useProjection = key => {
    const native = props.useProjection(key)
    return external ? externalProjection(key, native, observation) : native
  }
  const average = external && observation?.usage?.outputTokensPerSecond === undefined && observation?.usage?.turnAverageTokensPerSecond > 0
  const t = average && props.hostT ? (key, params) => key === 'stats.dialog.speed' ? props.hostT('hostTurnAverage') : key === 'message.tokensPerSecond' ? props.hostT('hostAveragePrefix') + props.t(key, params) : props.t(key, params) : props.t
  return h(props.NativeSeat, { ...props, useProjection, t })
}

function ApiValueSeat({ useProjection, t }) {
  const preset = useProjection('agentPreset')
  const hostObserved = useProjection('codexHostObservation')
  const nativeCost = useProjection('sessionApiCost')
  const observed = agentId(preset) === 'deepseek-harness' ? nativeCost : hostApiCostObservation(hostObserved, nativeCost)
  const [open, setOpen] = useState(false)
  // Keep the seat stable even when this DSH session has no Host price record.
  // Unknown pricing is explicitly unavailable, never represented as zero.
  const label = observed?.cost ? hostCostLabel(observed.usage, observed.cost) : undefined
  const usage = observed?.usage ?? {}
  const locale = t('hostLocale')
  const count = value => value === undefined ? '-' : hostFormat.formatRendererTokenCount(value)
  const rate = value => value === undefined ? undefined : hostFormat.formatRendererTokenRate(value, locale)
  const latency = value => value === undefined ? undefined : hostFormat.formatRendererLatency(value, locale)
  const costDisplay = (observed?.cost?.unpricedRequests > 0 || observed?.cost?.lowerBound) && label && !label.startsWith('≥') ? `≥${label}` : label
  const groups = [
    [t('hostSession'), [[t('hostCost'), costDisplay], [t('hostCredits'), usage.totalCredits === undefined ? undefined : hostFormat.formatRendererCredits(usage.totalCredits)], [t('hostAverageCache'), usage.sessionCacheHitRatePercent === undefined ? undefined : `${Number(usage.sessionCacheHitRatePercent.toFixed(1))}%`], [t('hostRecentCache'), usage.cacheHitRatePercent === undefined ? undefined : `${Number(usage.cacheHitRatePercent.toFixed(1))}%`]]],
    [t('hostTurn'), [[t('hostTps'), rate(usage.outputTokensPerSecond)], [t('hostTurnAverage'), rate(usage.turnAverageTokensPerSecond)], [t('hostApiTps'), rate(usage.apiOutputTokensPerSecond)], [t('hostTtft'), latency(usage.timeToFirstOutputMs)]]],
    ['Token', [[t('hostInputOutput'), usage.inputTokens === undefined && usage.outputTokens === undefined ? undefined : `${count(usage.inputTokens)} / ${count(usage.outputTokens)}`], [t('hostCacheReadWrite'), usage.cacheWriteInputTokens > 0 ? `${count(usage.cachedInputTokens)} / ${count(usage.cacheWriteInputTokens)}` : undefined], [t('cacheRead'), !usage.cacheWriteInputTokens && usage.cachedInputTokens !== undefined ? count(usage.cachedInputTokens) : undefined], [t('hostTotal'), usage.totalTokens === undefined ? undefined : count(usage.totalTokens)]]],
  ]
  return h(Menu, { open, onClose: () => setOpen(false), side: 'top', align: 'end', portal: true, listClassName: 'ch-host-usage-menu',
    anchor: h('button', { type: 'button', className: 'ch-host-stat-trigger', 'data-codexhost-api-value': '', onClick: () => setOpen(value => !value), 'aria-label': t('apiValue') + ': ' + (costDisplay ?? t('unknown')), 'aria-haspopup': 'dialog', 'aria-expanded': open }, costDisplay ?? '$ —'),
  }, h('div', { role: 'dialog', 'aria-label': t('apiValue'), className: 'ch-host-usage-content' },
    h('strong', null, t('hostUsage')),
    usage.contextUsedTokens !== undefined && usage.contextWindowTokens > 0 ? h('dl', null, h('dt', null, t('context')), h('dd', null, hostFormat.formatRendererContextSummary(usage.contextUsedTokens, usage.contextWindowTokens))) : null,
    ...groups.map(([name, rows]) => { const visible = rows.filter(([, value]) => value !== undefined); return visible.length ? h('section', { key: name }, h('h4', null, name), h('dl', null, ...visible.flatMap(([label, value]) => [h('dt', { key: label }, label), h('dd', { key: label + ':value' }, value)]))) : null }),
    !label ? h('p', null, t('priceUnavailable')) : null,
    observed?.cost?.readingComplete === false ? h('p', null, t('priceRefreshing')) : null,
    observed?.cost?.unpricedRequests > 0 ? h('p', null, `${t('unpriced')}: ${observed.cost.unpricedRequests}`) : null,
    observed?.cost?.unpricedModels?.length ? h('p', null, t('unpriced') + ': ' + observed.cost.unpricedModels.join(', ')) : null))
}

function NativeContextSeat(props) {
  const preset = props.useProjection('agentPreset')
  if (agentId(preset) === 'deepseek-harness') return null
  return h('span', { 'data-codexhost-context': '' }, h(NativeStatisticsSeat, { ...props, NativeSeat: ContextMeter }))
}

function NativeToolViewSeat({ NativeToolView, nativeToolName, ...props }) {
  const block = props.block
  const call = 'kind' in block ? block.call : block
  if (!call) return h(NativeToolView, props)
  let args
  try { args = JSON.parse(call.argsRaw) } catch { return h(NativeToolView, props) }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return h(NativeToolView, props)
  if (props.toolName === 'fileChange') {
    if (!Array.isArray(args.changes) || args.changes.length !== 1) return h(NativeToolView, props)
    args = { ...args, file_path: args.changes[0].path }
  }
  if (['bash', 'pwsh'].includes(nativeToolName) && typeof args.command === 'string' && !args.description) args = { ...args, description: args.command }
  const adapted = { ...block, ...('kind' in block ? { call: { ...call, name: nativeToolName, argsRaw: JSON.stringify(args) } } : { name: nativeToolName, argsRaw: JSON.stringify(args) }) }
  return h(NativeToolView, { ...props, toolName: nativeToolName, block: adapted })
}

function NativeModelSeat(props) {
  const renderSlot = (name, owner, options) => {
    const entries = props.modelSlots[name] ?? []
    if (!entries.length) return options?.fallback ?? null
    const visible = name === 'conversation.input.model.label' ? entries.slice(0, 1) : entries
    return visible.map((entry, index) => h(entry.Component, { ...props, ...entry.injected, ...owner, t: entry.t, key: index }))
  }
  return h(getNativeModelSelect(), { ...props, renderSlot, EffortPane: NativeEffortSliderPane })
}

// Adapt catalog data and commands; the native model source owns the menu UI.
function hostModelSnapshot(state, legacyDefaultLabel) {
  const catalog = state.catalog
  const owner = catalog?.agentId
  const selection = catalog?.selection
  const models = (catalog?.models ?? []).filter(model => owner !== 'claude-code'
    || hostModelPresentation(owner, model.id).kind !== 'default' || model.id === selection?.modelId)
  return {
    status: state.status, error: state.error || null, pending: state.pending ?? null, failures: [], routable: null,
    current: selection?.modelId ? { provider: owner, model: selection.modelId, reasoningEffort: selection.thinkingOptionId } : null,
    groups: owner ? [{ id: owner, name: AGENTS.find(agent => agent.id === owner)?.label ?? owner,
      models: models.map(model => ({ id: model.id, name: model.resolvedLabel ?? (owner === 'claude-code' && hostModelPresentation(owner, model.id).kind === 'default' ? legacyDefaultLabel ?? model.label : model.label),
        ...(model.thinkingOptions?.length ? { reasoning: {
          efforts: model.thinkingOptions.map(option => ({ id: option.id, name: option.label ?? option.id })),
          ...(model.id === selection?.modelId && selection.thinkingOptionId !== undefined ? { defaultEffort: selection.thinkingOptionId } : {}),
        } } : {}),
      })),
    }] : [],
  }
}

function HostModelSelect({ hostDirectory, nativeModel, nativeTeam, teamProps, disabled }) {
  const renderSlot = (name, owner, options) => name === 'conversation.input.model.options'
    ? nativeTeam ? h(nativeTeam.Component, { ...teamProps, ...nativeTeam.injected, ...owner, t: nativeTeam.t }) : null
    : options?.fallback ?? null
  return h(getNativeModelSelect(), {
    EffortPane: NativeEffortSliderPane,
    available: true, locked: disabled, directory: hostDirectory.modelStore, t: nativeModel.t,
    load: () => { void hostDirectory.load() }, resolveText: text => typeof text === 'string' ? text : '', renderSlot,
    select: selection => {
      const catalog = hostDirectory.getSnapshot().catalog
      const model = catalog?.models?.find(model => model.id === selection.model)
      const sameModel = selection.model === catalog?.selection?.modelId
      if (selection.provider !== catalog?.agentId || !model || (catalog.agentId === 'claude-code' && hostModelPresentation(catalog.agentId, model.id).kind === 'default' && (!sameModel || selection.reasoningEffort === undefined))) {
        return Promise.resolve({ ok: false, error: { code: 'host/model-unavailable', message: teamProps.t('error') } })
      }
      return hostDirectory.configure({ ...(sameModel ? {} : { modelId: selection.model }),
        ...(selection.reasoningEffort === undefined ? {} : { thinkingOptionId: selection.reasoningEffort }),
      })
    },
  })
}

function NativeAgentControls(props) {
  const { sessionId, hostDirectory, useProjection, useSessions, useInput, inputActions, insertDelegation, focusInput, t, openConsole, nativeTeam } = props
  const preset = useProjection('agentPreset')
  const owner = agentId(preset)
  const summary = useSessions(state => state.byId[sessionId])
  const state = useSyncExternalStore(hostDirectory.subscribe, hostDirectory.getSnapshot)
  const external = owner !== 'deepseek-harness'
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const child = addressedChild || summary?.origin === 'subagent'
  const input = useInput(value => value)
  const busy = summary?.running === true || ['loading', 'selecting'].includes(state.status)
  useEffect(() => { if (external && !child) void hostDirectory.load(preset) }, [hostDirectory, preset, external, child])
  if (child) return h(ChildAgentIdentity, { owner, useProjection, t })
  return h('div', { className: 'ch-native-controls', 'data-codexhost-footer': '', 'data-external': String(external) },
    external ? h(HostModelSelect, { hostDirectory, nativeModel: props.nativeModel, nativeTeam, teamProps: props, disabled: summary?.running === true }) : null,
    h(Picker, { label: t('agent'), caption: '', image: icon(owner), disabled: busy || summary?.blank !== true,
      title: summary?.blank !== true ? t('locked') : `${t('agent')}: ${AGENTS.find(agent => agent.id === owner)?.label}`,
      selected: owner, options: AGENTS.map(agent => ({ ...agent, icon: icon(agent.id) })), onSelect: id => hostDirectory.selectAgent(id), iconOnly: true,
    }),
    h(DelegationPicker, { external, hostDirectory, input, inputActions, insertDelegation, focusInput, t }),
    state.error ? h('span', { className: 'ch-native-error', role: 'status', title: state.error },
      h('button', { type: 'button', onClick: () => hostDirectory.load(), 'aria-label': `${t('retry')}: ${state.error}` }, '!'),
      h('button', { type: 'button', onClick: openConsole }, t('openConsole')),
    ) : null,
  )
}

// Addressed children expose persisted facts only; ordinary Agent RPCs cannot address them.
function ChildAgentIdentity({ owner, useProjection, t }) {
  const selection = useProjection('modelSelection')
  const observation = useProjection('codexHostObservation')
  const identity = useProjection('codexHostModelIdentity')
  const recorded = identity?.harnessId === owner ? identity : undefined
  const model = owner === 'deepseek-harness' ? selection?.lastUsed?.model
    : recorded ? recorded.model ?? recorded.selectedModel : observation?.harnessId === owner ? observation.model : undefined
  const selectedOnly = owner !== 'deepseek-harness' && recorded && !recorded.model
  const label = AGENTS.find(agent => agent.id === owner)?.label ?? owner
  const presentation = hostModelPresentation(owner, model)
  const caption = presentation.kind === 'model' ? selectedOnly ? t('childModelSelection').replace('{model}', presentation.value) : presentation.value : presentation.kind === 'default' ? t('childModelDefault')
    : presentation.kind === 'selection' ? t('childModelSelection').replace('{model}', presentation.value) : t('childModelPending')
  return h('div', { className: 'ch-native-controls ch-child-identity', 'data-external': String(owner !== 'deepseek-harness'), 'data-child-engine': owner, role: 'group', 'aria-label': `${label}: ${caption}`, title: `${label}: ${caption}` },
    icon(owner), h('span', { className: 'ch-child-engine' }, label), h('span', { className: 'ch-native-caption' }, caption))
}

function NativeRecoveryControl({ hostDirectory, disabled, t }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const generation = useRef(0), inFlight = useRef(false)
  useEffect(() => { setOpen(false); setResult(null); setAcknowledged(false); setBusy(false); setError(''); return () => { generation.current++ } }, [hostDirectory])
  useEffect(() => { if (disabled) { setOpen(false); setAcknowledged(false); setResult(null); setBusy(false); generation.current++ } }, [disabled])
  const run = async commit => {
    if (inFlight.current || disabled || (commit && (!acknowledged || result?.status !== 'recoverable'))) return
    inFlight.current = true; const current = ++generation.current
    setBusy(true); setError(''); setAcknowledged(false)
    try {
      const next = commit ? await hostDirectory.reconcileRecovery(result.expected) : await hostDirectory.checkRecovery()
      if (current !== generation.current) return
      setResult(next)
      if (commit) await hostDirectory.load()
    } catch (e) { if (current === generation.current) { setError(e.message); setResult(null) } }
    finally { inFlight.current = false; if (current === generation.current) setBusy(false) }
  }
  return h(Menu, { open, onClose: () => setOpen(false), side: 'top', align: 'start', portal: true, listClassName: 'ch-recovery-menu',
    anchor: h('button', { type: 'button', className: 'ch-left-chip', 'data-kind': 'recovery', disabled, title: t('recoveryTitle'), 'aria-label': t('recovery'), 'aria-haspopup': 'dialog', 'aria-expanded': open,
      onClick: () => { setOpen(value => !value); if (!open) { setResult(null); void run(false) } } }, h(RecoveryGlyph), t('recovery')),
  }, h('div', { role: 'dialog', 'aria-label': t('recovery'), className: 'ch-recovery-content', 'aria-busy': busy },
    h('strong', null, t('recovery')),
    h('p', { role: 'status', className: 'ch-recovery-status', 'data-state': busy ? 'busy' : result?.status ?? 'idle' }, busy ? t('recoveryChecking') : result ? t('recovery_' + result.reason) : ''),
    result?.outcome ? h('p', null, `${t('recoveryOutcome')}：${t('recovery_' + result.outcome)}`) : null,
    error ? h('p', { role: 'alert', className: 'ch-recovery-error' }, error) : null,
    h('p', { className: 'ch-recovery-note' }, t('recoveryNote')),
    result?.status === 'recoverable' ? h('label', { className: 'ch-recovery-check' }, h('input', { type: 'checkbox', checked: acknowledged, disabled: busy, onChange: e => setAcknowledged(e.target.checked) }), t('recoveryAcknowledge')) : null,
    h('div', { className: 'ch-recovery-actions' }, h('button', { type: 'button', disabled: busy || disabled, onClick: () => run(false) }, t('recoveryCheck')),
      result?.status === 'recoverable' ? h('button', { type: 'button', 'data-primary': '', disabled: busy || disabled || !acknowledged, onClick: () => run(true) }, t('recoveryConfirm')) : null)))
}

const RecoveryGlyph = () => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
  h('rect', { x: 3, y: 2.5, width: 10, height: 11.5, rx: 2 }), h('path', { d: 'M6 2.5V2h4v.5M5.8 8.6l1.6 1.6 3-3.2' }))
const ResumeGlyph = () => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
  h('circle', { cx: 8, cy: 8, r: 5.8 }), h('path', { d: 'M8 4.8V8l2.2 1.4' }))

// Left composer group for external engines: keepalive (other plugin) | outcome check | quota resume.
function NativeLeftControls(props) {
  const { sessionId, hostDirectory, useProjection, useSessions, useSession, resume, t } = props
  const owner = agentId(useProjection('agentPreset'))
  const quota = useProjection(QUOTA_PAUSE_KEY)
  const summary = useSessions(state => state.byId[sessionId])
  const addressedChild = useSession(snapshot => snapshot.subagent !== null)
  const pending = useSession(snapshot => snapshot.pendingSubmissions?.length ?? 0)
  if (owner === 'deepseek-harness' || addressedChild || summary?.origin === 'subagent') return null
  const running = summary?.running === true
  return h('div', { className: 'ch-left-controls', 'data-codexhost-left': '' },
    h(NativeRecoveryControl, { hostDirectory, disabled: running, t }),
    owner === 'claude-code' && quota?.paused ? h(QuotaResumeControl, { sessionId, quota, running, pending, resume, t }) : null)
}

const QUOTA_PAUSE_KEY = 'codexHostQuotaPause'
const QUOTA_RESUME_DELAY_MS = 120000
const QUOTA_RESUME_MAX_STREAK = 3
const QUOTA_RESUME_STALE_MS = 6 * 3600 * 1000
const QUOTA_PREF_KEY = 'codexhost.quotaResume.enabled'
const quotaClaimKey = (sessionId, seq) => `codexhost.quotaResume.claim.${sessionId}.${seq}`
const safeStorage = {
  get(key) { try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value) } catch {} },
}

/** Due time: announced reset + 2 min. A reset already in the past at failure time
 * means the gateway had not refreshed usage yet; then wait 10 min after the failure. */
function quotaResumeDueAt(paused) {
  if (!Number.isFinite(paused?.resetAt)) return undefined
  const due = paused.resetAt + QUOTA_RESUME_DELAY_MS
  return due < paused.failedAt + QUOTA_RESUME_DELAY_MS ? paused.failedAt + 600000 : due
}

const beijingClock = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000)), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : String(mm)) + ':' + String(ss).padStart(2, '0')
}

function QuotaResumeControl({ sessionId, quota, running, pending, resume, t }) {
  const paused = quota.paused
  const claimKey = quotaClaimKey(sessionId, paused.seq)
  const dueAt = quotaResumeDueAt(paused)
  const [enabled, setEnabled] = useState(() => safeStorage.get(QUOTA_PREF_KEY) !== 'off')
  const [claimed, setClaimed] = useState(() => safeStorage.get(claimKey) !== null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false), [sending, setSending] = useState(false), [error, setError] = useState('')
  // Spread devices/tabs a little so two open clients rarely fire in the same instant.
  const jitter = useRef(Math.floor(Math.random() * 15000))
  const inFlight = useRef(false)
  useEffect(() => { setClaimed(safeStorage.get(claimKey) !== null); setError(''); setSending(false) }, [claimKey])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const exhausted = quota.streak > QUOTA_RESUME_MAX_STREAK
  const send = async manual => {
    if (inFlight.current || safeStorage.get(claimKey) !== null && !manual) return
    inFlight.current = true
    safeStorage.set(claimKey, String(Date.now())); setClaimed(true); setSending(true); setError('')
    try { await resume(t('quotaResumePrompt')) } catch (e) { setError(e?.message ?? String(e)) }
    finally { inFlight.current = false; setSending(false) }
  }
  const fireAt = dueAt === undefined ? undefined : dueAt + jitter.current
  const due = fireAt !== undefined && now >= fireAt
  // Reopening DSH long after the window must not silently start old work.
  const stale = fireAt !== undefined && now > fireAt + QUOTA_RESUME_STALE_MS
  useEffect(() => {
    if (!enabled || claimed || exhausted || stale || !due || running || pending > 0) return
    if (safeStorage.get(claimKey) !== null) { setClaimed(true); return }
    void send(false)
  }, [enabled, claimed, exhausted, stale, due, running, pending, claimKey])
  const toggle = value => { setEnabled(value); safeStorage.set(QUOTA_PREF_KEY, value ? 'on' : 'off') }
  const skip = () => { safeStorage.set(claimKey, 'skipped'); setClaimed(true); setOpen(false) }
  const state = error ? 'error' : sending ? 'sending' : claimed ? 'done' : exhausted ? 'stopped' : stale ? 'stale' : !enabled ? 'off' : dueAt === undefined ? 'unknown' : due ? 'waiting' : 'scheduled'
  const caption = state === 'scheduled' ? t('quotaChipCountdown').replace('{time}', countdown(fireAt - now))
    : t('quotaChip_' + state)
  const summary = dueAt === undefined ? t('quotaNoReset')
    : t('quotaSchedule').replace('{reset}', beijingClock(paused.resetAt)).replace('{due}', beijingClock(dueAt))
  return h(Menu, { open, onClose: () => setOpen(false), side: 'top', align: 'start', portal: true, listClassName: 'ch-recovery-menu',
    anchor: h('button', { type: 'button', className: 'ch-left-chip', 'data-kind': 'quota', 'data-state': state, title: summary, 'aria-label': t('quotaResume') + '：' + caption, 'aria-haspopup': 'dialog', 'aria-expanded': open,
      onClick: () => setOpen(value => !value) }, h(ResumeGlyph), h('span', { className: 'ch-left-chip-text' }, caption)),
  }, h('div', { role: 'dialog', 'aria-label': t('quotaResume'), className: 'ch-recovery-content ch-quota-content' },
    h('strong', null, t('quotaResume')),
    h('p', { role: 'status', className: 'ch-recovery-status', 'data-state': state }, summary),
    state === 'scheduled' ? h('p', { className: 'ch-quota-count' }, countdown(fireAt - now)) : null,
    exhausted ? h('p', { className: 'ch-recovery-error' }, t('quotaExhausted').replace('{n}', String(quota.streak))) : null,
    error ? h('p', { role: 'alert', className: 'ch-recovery-error' }, t('quotaSendFailed') + error) : null,
    h('label', { className: 'ch-recovery-check' }, h('input', { type: 'checkbox', checked: enabled, onChange: e => toggle(e.target.checked) }), t('quotaAuto')),
    h('p', { className: 'ch-recovery-note' }, t('quotaNote')),
    h('div', { className: 'ch-recovery-actions' },
      h('button', { type: 'button', 'data-primary': '', disabled: sending || running, onClick: () => { setOpen(false); void send(true) } }, t('quotaNow')),
      claimed ? null : h('button', { type: 'button', disabled: sending, onClick: skip }, t('quotaSkip')))))
}

function PermissionSeat(props) {
  const preset = props.useProjection('agentPreset')
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (agentId(preset) === 'deepseek-harness') return h(props.NativePermission, props)
  if (addressedChild || listedChild) return null
  return h(HostPermission, props)
}

function HostPermission({ sessionId, hostDirectory, useSessions, hostT: t }) {
  const summary = useSessions(state => state.byId[sessionId])
  const state = useSyncExternalStore(hostDirectory.subscribe, hostDirectory.getSnapshot)
  const catalog = state.catalog
  const nativeSelected = catalog?.permissionModes?.find(mode => mode.id === catalog.selection?.permissionModeId)
  const selected = nativeSelected ? hostPermissionPresentation(catalog.agentId, nativeSelected) : undefined
  const choices = hostPermissionOptions(catalog?.agentId, catalog?.permissionModes)
  const [confirmation, setConfirmation] = useState(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const disabled = summary?.running === true || state.status !== 'ready'
  const permissionLabel = mode => mode.labelKey ? t(mode.labelKey) : mode.label
  const permissionIcon = mode => {
    const glyph = { 'read-only': PermissionIconReadOnlyRegular, 'workspace-write': PermissionIconWorkspaceWriteRegular, 'full-access': PermissionIconFullAccessRegular }[mode.iconKind]
    return glyph ? h(glyph) : null
  }
  const cancel = () => { setConfirmation(null); setAcknowledged(false) }
  useEffect(() => { if (disabled) cancel() }, [disabled])
  useEffect(cancel, [hostDirectory, catalog?.agentId])
  return h('span', { className: 'ch-permission-seat' }, h(Picker, { label: t('permission'), caption: selected ? permissionLabel(selected) : t('loading'),
    image: selected ? permissionIcon(selected) : null, nativePermission: true,
    disabled, selected: selected?.id,
    options: choices.map(mode => ({ ...mode, label: permissionLabel(mode), icon: permissionIcon(mode) })), onSelect: permissionModeId => {
      const choice = choices.find(mode => mode.id === permissionModeId)
      if (disabled || !choice || permissionModeId === selected?.id) return
      if (choice.dangerous) { setAcknowledged(false); setConfirmation(choice); return }
      return hostDirectory.configure({ permissionModeId: choice.id })
    },
  }), confirmation ? h(RiskConfirmation, { open: true, title: t('confirmTitle').replace('{mode}', permissionLabel(confirmation)), description: t('confirmDescription'),
    acknowledgeLabel: t('acknowledge'), cancelLabel: t('cancel'), closeLabel: t('close'), confirmLabel: t('enable'),
    acknowledged, disabled, onAcknowledgedChange: setAcknowledged, onCancel: cancel,
    onConfirm: () => { if (!acknowledged || disabled) return; const id = confirmation.id; cancel(); void hostDirectory.configure({ permissionModeId: id }) },
  }) : null)
}

function Picker({ label, caption, image, options, selected, onSelect, disabled, iconOnly = false, title, nativePermission = false, nativeTeam, teamProps }) {
  const [open, setOpen] = useState(false), [teamError, setTeamError] = useState('')
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return h(Menu, { open, items: options, selectedId: selected, onClose: () => setOpen(false),
    onSelect: id => { setOpen(false); void onSelect(id) }, side: 'top', align: iconOnly ? 'end' : 'start', portal: true, autoFocus: true, listClassName: 'ch-picker-menu',
    anchor: h('button', { type: 'button', className: iconOnly ? 'ch-native-trigger ch-native-agent' : 'ch-native-trigger', disabled,
      title: title ?? `${label}: ${caption}`, 'aria-label': `${label}${caption ? `: ${caption}` : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: () => setOpen(value => !value), onKeyDown: event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } },
    }, image, caption ? h('span', { className: 'ch-native-caption' }, caption) : null, !iconOnly ? h('span', { 'aria-hidden': true, className: `ch-native-chevron${open ? ' ch-native-chevron-open' : ''}` }, h(IconChevronDownOutlineRegular)) : null),
  }, nativeTeam ? h(nativeTeam.Component, { ...teamProps, ...nativeTeam.injected, t: nativeTeam.t, locked: disabled, dismiss: () => setOpen(false), reportFailure: setTeamError }) : null,
  teamError ? h('div', { role: 'alert' }, teamError) : null)
}

function NativeEffortSliderPane(props) {
  return h(ThinkingSlider, { ...props, inline: true })
}

function ThinkingSlider({ label, caption, modelLabel, options, selected, onSelect, disabled, inline = false, saving = false }) {
  const Slider = getSliderPrimitive()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const thumbRef = useRef(null), dragging = useRef(false), cancelled = useRef(false), lastCommit = useRef(selected)
  const max = Math.max(0, options.length - 1)
  const current = Math.max(0, options.findIndex(option => option.id === selected))
  const active = inline || open
  const index = Math.max(0, Math.min(max, active && draft !== null ? draft : current))
  const choice = options[Math.round(index)], optionKey = options.map(option => option.id).join('\0')
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
  useEffect(() => {
    if (disabled) { setOpen(false); dragging.current = false }
    if (!dragging.current && !(inline && saving)) setDraft(current)
    lastCommit.current = selected
  }, [active, current, disabled, saving, optionKey, modelLabel, selected])
  useEffect(() => {
    if (!active || disabled) return
    const frame = requestAnimationFrame(() => thumbRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [active])
  const commit = value => {
    const next = Math.max(0, Math.min(max, Math.round(value))), option = options[next]
    dragging.current = false; setDraft(next)
    if (!disabled && option && option.id !== selected && option.id !== lastCommit.current) { lastCommit.current = option.id; void onSelect(option.id) }
  }
  const cancel = () => { cancelled.current = true; dragging.current = false; setDraft(current) }
  const card = h('div', { className: 'ch-thinking-card', 'data-saving': inline && saving ? 'true' : undefined, style: { '--ch-thinking-color': `hsl(${Math.round(210 + (max > 0 ? index / max : 0) * 125)} 78% 58%)` } },
    h('strong', { className: 'ch-thinking-value' }, choice?.label), h('span', { className: 'ch-thinking-model' }, modelLabel),
    h(Slider.Root, { className: 'ch-thinking-range', min: 0, max: Math.max(1, max), step: .001, value: [index], disabled: (disabled && !saving) || options.length < 2, 'aria-busy': saving,
      onPointerDownCapture: event => { if (saving) { event.preventDefault(); event.stopPropagation() } },
      onValueChange: values => { if (!disabled) setDraft(values[0]) },
      onValueCommit: values => { if (!cancelled.current) commit(values[0]) },
      onPointerDown: () => { dragging.current = true; cancelled.current = false }, onPointerCancel: cancel,
      onKeyDown: event => {
        if (!keys.includes(event.key)) return
        event.stopPropagation(); event.preventDefault()
        if (disabled) return
        cancelled.current = false
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? max : Math.max(0, Math.min(max, Math.round(index) + (['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key) ? 1 : -1)))
        setDraft(next)
      },
      onKeyUp: event => { if (keys.includes(event.key)) { event.stopPropagation(); commit(index) } },
    }, h(Slider.Track, { className: 'ch-thinking-track' },
      h(Slider.Range, { className: 'ch-thinking-fill' }),
      h('span', { className: 'ch-thinking-dots', 'aria-hidden': true }, options.map(option => h('span', { key: option.id })))),
      h(Slider.Thumb, { ref: thumbRef, className: 'ch-thinking-thumb', 'aria-label': label, 'aria-disabled': disabled, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuetext': choice?.label }),
    ),
  )
  if (inline) return card
  return h(Menu, { open, onClose: () => { cancel(); setOpen(false) }, side: 'top', align: 'end', portal: true, listClassName: 'ch-thinking-menu',
    anchor: h('button', { type: 'button', className: 'ch-native-trigger ch-thinking-trigger', disabled, 'aria-label': `${label}: ${caption}`, 'aria-haspopup': 'dialog', 'aria-expanded': open,
      onClick: () => { cancelled.current = false; setDraft(current); setOpen(value => !value) },
    }, caption, h('span', { 'aria-hidden': true, className: `ch-native-chevron${open ? ' ch-native-chevron-open' : ''}` }, h(IconChevronDownOutlineRegular))),
  }, card)
}

const css = `
.ch-native-controls { order:2; display:flex; align-items:center; gap:4px; min-width:0; position:relative; }
:has(> .ch-native-controls[data-external="true"]) > :not(.ch-native-controls) { display:none !important; }
:has(> div > .ch-native-controls[data-external="true"]) > :not(:has(> .ch-native-controls)) { display:none !important; }
.ch-native-models { display:flex; align-items:center; gap:3px; min-width:0; }
.ch-child-identity { max-width:min(300px,45vw); gap:6px; font-size:13px; color:var(--dsw-alias-label-secondary); }
.ch-child-engine { flex:none; white-space:nowrap; }
.ch-native-picker { display:inline-flex; min-width:0; }
.ch-native-trigger { display:inline-flex; align-items:center; justify-content:center; gap:4px; height:28px; min-width:0; max-width:220px; border:0; border-radius:var(--dsw-radius-sm); padding:0 4px 0 8px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; line-height:20px; font-weight:500; cursor:pointer; }
.ch-native-trigger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.ch-native-trigger:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); }
.ch-native-trigger:disabled { color:var(--dsw-alias-label-dimmed); cursor:default; }
.ch-native-trigger > svg { width:14px; height:14px; flex:none; }
.ch-native-agent { width:30px; padding:0; flex:none; }
.ch-native-caption { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; }
.ch-native-chevron { display:inline-flex; align-items:center; justify-content:center; flex:none; line-height:0; color:var(--dsw-alias-label-caption); transition:transform 120ms ease; }
.ch-native-chevron-open { transform:rotate(180deg); }
.ch-picker-menu { min-width:min(224px,calc(100vw - 24px)); }
.ch-permission-seat { display:inline-flex; align-items:center; min-width:0; }
.ch-thinking-trigger { font-weight:400; }
.ch-thinking-menu { width:min(240px,calc(100vw - 24px)); min-width:0; box-sizing:border-box; }
.ch-thinking-card { display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 10px 10px; width:100%; min-width:0; box-sizing:border-box; }
.ch-thinking-value { color:var(--ch-thinking-color,var(--dsw-alias-state-business-primary)); font-size:15px; line-height:20px; font-weight:500; }
.ch-thinking-model { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-caption); font-size:12px; line-height:16px; }
.ch-thinking-range { --ch-thinking-thumb:28px; position:relative; display:flex; align-items:center; width:100%; min-width:0; height:32px; margin:6px 2px 0; padding:2px 6px; box-sizing:border-box; user-select:none; touch-action:none; }
.ch-thinking-track { position:relative; display:block; flex:1; height:24px; border-radius:12px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3, #0000001a); overflow:hidden; }
.ch-thinking-fill { position:absolute; height:100%; border-radius:12px 0 0 12px; background:linear-gradient(90deg,#3a83f7,var(--ch-thinking-color,#3a83f7)); pointer-events:none; }
.ch-thinking-thumb { display:block; width:var(--ch-thinking-thumb); height:var(--ch-thinking-thumb); box-sizing:border-box; background:#fff; border:.5px solid var(--dsw-alias-border-strong, #00000033); border-radius:50%; box-shadow:0 0 2px #0000001a; cursor:grab; }
.ch-thinking-thumb:active { cursor:grabbing; }
.ch-thinking-thumb:focus-visible { outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:0; }
.ch-thinking-dots { position:absolute; inset:0 calc(var(--ch-thinking-thumb) / 2); display:flex; justify-content:space-between; align-items:center; pointer-events:none; }
.ch-thinking-dots span { width:4px; height:4px; border-radius:50%; background:color-mix(in srgb, var(--dsw-alias-label-caption) 50%, transparent); }
.ch-thinking-range[data-disabled] { opacity:.6; }
.ch-thinking-card[data-saving="true"] .ch-thinking-range[data-disabled] { opacity:1; }
@media(prefers-reduced-motion:reduce) { .ch-native-chevron { transition:none; } }
.ch-native-error button { color:#b54738; border:0; background:transparent; cursor:pointer; font-weight:500; }
.ch-host-stats { display:inline-flex; min-width:0; }
.ch-host-stat-trigger { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:1px 8px; border:0; border-radius:var(--dsw-radius-sm); background:transparent; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:12px; line-height:20px; font-variant-numeric:tabular-nums; cursor:pointer; flex-wrap:wrap; }
.ch-host-stat-trigger > svg { width:14px; height:14px; }
.ch-host-stat-trigger:hover, .ch-host-stat-trigger[aria-expanded=true] { background:var(--dsw-alias-interactive-bg-hover); }
.ch-host-stat-trigger:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); }
.ch-host-usage-menu { width:min(330px,calc(100vw - 24px)); }
.ch-host-usage-content { padding:12px; font-size:13px; }
.ch-host-usage-content strong { font-weight:500; }
.ch-host-usage-content section { margin-top:10px; }
.ch-host-usage-content h4 { margin:0 0 5px; font:inherit; font-weight:600; color:var(--dsw-alias-label-secondary); }
.ch-host-usage-content dl { margin:6px 0 0; display:grid; grid-template-columns:1fr auto; gap:8px 16px; }
.ch-host-usage-content dt { color:var(--dsw-alias-label-tertiary); }
.ch-host-usage-content dd { margin:0; font-variant-numeric:tabular-nums; text-align:right; }
[data-composer-dock]:has([data-codexhost-context]) > span:last-child { display:none; }

.ch-console-panel { height:100%; min-height:0; display:flex; flex-direction:column; }
.ch-console-header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:12px 16px 12px max(16px,var(--dsh-frame-leading-clearance,0px)); border-bottom:1px solid #8883; font-size:12px; }
.ch-console-header span { flex:1; opacity:.65; }
.ch-console-header button { padding:5px 9px; border:1px solid #8884; border-radius:6px; color:inherit; background:transparent; cursor:pointer; }
.ch-console-frame { border:0; flex:1; width:100%; min-height:0; background:transparent; }
.ch-console-feedback { padding:24px; white-space:pre-wrap; }
/* Outcome check / quota popovers: keepalive (dsh-warm-manual) palette and glass.
   Fixed width + reserved status height + no position-try fallbacks: the card stays
   pinned above its chip, left-aligned, instead of jumping when the text changes. */
.ch-recovery-menu {
  --dw-base:var(--dsw-alias-bg-base,Canvas); --dw-fg:var(--dsw-alias-label-primary,CanvasText);
  --dw-muted:color-mix(in srgb,var(--dw-fg) 66%,var(--dw-base)); --dw-border:color-mix(in srgb,var(--dw-fg) 12%,transparent);
  --dw-accent:color-mix(in srgb,#4d6bfe 82%,var(--dw-fg)); --dw-soft:color-mix(in srgb,var(--dw-base) 52%,transparent);
  --dw-solid:color-mix(in srgb,var(--dw-base) 96%,#6b84ea); --dw-green:color-mix(in srgb,#198965 80%,var(--dw-fg));
  --dw-red:color-mix(in srgb,#d64b58 82%,var(--dw-fg)); --dw-amber:color-mix(in srgb,#b77a29 80%,var(--dw-fg));
  box-sizing:border-box; width:min(340px,calc(100vw - 24px)) !important; min-width:min(340px,calc(100vw - 24px)) !important; max-width:min(340px,calc(100vw - 24px)) !important;
  padding:0 !important; overflow:hidden !important; color:var(--dw-fg);
  background:radial-gradient(ellipse at 6% 0%,#6b99ff20,transparent 55%),radial-gradient(ellipse at 95% 95%,#8bd8f81a,transparent 55%),color-mix(in srgb,var(--dw-base) 85%,transparent) !important;
  backdrop-filter:blur(30px) saturate(1.3) !important; -webkit-backdrop-filter:blur(30px) saturate(1.3) !important;
  border:1px solid color-mix(in srgb,var(--dw-base) 60%,#a4b7f7) !important; border-radius:16px !important;
  box-shadow:0 18px 60px #0e19422b,0 2px 10px #17396b0a,inset 0 1px 0 #ffffff33 !important;
  position-try-fallbacks:none !important; transition:none !important;
}
.ch-recovery-content { padding:14px 16px 16px; font-size:13px; line-height:1.6; overflow-wrap:anywhere; text-align:left; }
.ch-recovery-content > strong { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600; letter-spacing:.2px; }
.ch-recovery-content > strong::before { content:''; width:8px; height:8px; border-radius:50%; background:var(--dw-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--dw-accent) 18%,transparent); flex:none; }
.ch-recovery-content p { white-space:pre-wrap; margin:10px 0; }
.ch-recovery-status { min-height:3.2em; display:flex; align-items:center; padding:9px 12px; border-radius:11px; color:var(--dw-fg); background:var(--dw-soft); border:1px solid var(--dw-border); }
.ch-recovery-status[data-state=busy] { color:var(--dw-muted); }
.ch-recovery-status[data-state=busy]::before { content:''; width:12px; height:12px; margin-right:8px; flex:none; border-radius:50%; border:2px solid color-mix(in srgb,var(--dw-accent) 25%,transparent); border-top-color:var(--dw-accent); animation:ch-spin .8s linear infinite; }
.ch-recovery-status[data-state=clear], .ch-recovery-status[data-state=done], .ch-recovery-status[data-state=scheduled] { border-color:color-mix(in srgb,var(--dw-green) 28%,transparent); background:color-mix(in srgb,var(--dw-green) 8%,var(--dw-soft)); }
.ch-recovery-status[data-state=recoverable], .ch-recovery-status[data-state=waiting], .ch-recovery-status[data-state=running] { border-color:color-mix(in srgb,var(--dw-amber) 30%,transparent); background:color-mix(in srgb,var(--dw-amber) 8%,var(--dw-soft)); }
.ch-recovery-status[data-state=blocked], .ch-recovery-status[data-state=error], .ch-recovery-status[data-state=stopped] { border-color:color-mix(in srgb,var(--dw-red) 30%,transparent); background:color-mix(in srgb,var(--dw-red) 7%,var(--dw-soft)); }
@keyframes ch-spin { to { transform:rotate(360deg) } }
.ch-recovery-note { color:var(--dw-muted); font-size:12px; line-height:1.55; }
.ch-recovery-error { color:var(--dw-red); }
.ch-recovery-check { display:flex; align-items:flex-start; gap:8px; margin:12px 0; }
.ch-recovery-check input { margin-top:4px; flex:none; accent-color:var(--dw-accent); }
.ch-recovery-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.ch-recovery-actions button { color:var(--dw-fg); background:color-mix(in srgb,var(--dw-base) 70%,transparent); border:1px solid var(--dw-border); border-radius:9px; padding:6px 12px; font:inherit; font-size:12.5px; cursor:pointer; transition:background .15s,border-color .15s; }
.ch-recovery-actions button:hover:not(:disabled) { border-color:color-mix(in srgb,var(--dw-accent) 45%,transparent); background:color-mix(in srgb,var(--dw-accent) 8%,var(--dw-base)); }
.ch-recovery-actions button[data-primary] { color:#fff; background:var(--dw-accent); border-color:transparent; }
.ch-recovery-actions button[data-primary]:hover:not(:disabled) { background:color-mix(in srgb,var(--dw-accent) 88%,#000); }
.ch-recovery-actions button:disabled { opacity:.45; cursor:default; }
.ch-recovery-content :focus-visible { outline:2px solid #6b85f5; outline-offset:2px; }
.ch-quota-count { font-size:22px; font-weight:600; letter-spacing:.5px; font-variant-numeric:tabular-nums; margin:4px 0 !important; color:var(--dw-accent); }
@media (prefers-reduced-transparency: reduce) { .ch-recovery-menu { background:var(--dw-solid) !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important; } }
@media (forced-colors: active) { .ch-recovery-menu { background:Canvas !important; border-color:CanvasText !important; } }
@media (prefers-reduced-motion: reduce) { .ch-recovery-status[data-state=busy]::before { animation:none; } }
.ch-left-controls { display:inline-flex; align-items:center; gap:2px; min-width:0; }
.ch-left-chip { display:inline-flex; align-items:center; gap:5px; height:28px; min-width:0; max-width:170px; padding:0 8px; border:0; border-radius:7px; background:transparent; color:var(--dsw-alias-label-tertiary,#858585); font:inherit; font-size:12px; line-height:20px; white-space:nowrap; cursor:pointer; transition:background .15s,color .15s; }
.ch-left-chip > svg { width:14px; height:14px; flex:none; }
.ch-left-chip-text { overflow:hidden; text-overflow:ellipsis; font-variant-numeric:tabular-nums; }
.ch-left-chip:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,#8881); color:var(--dsw-alias-label-primary,CanvasText); }
.ch-left-chip:disabled { color:var(--dsw-alias-label-dimmed,#8888); cursor:default; }
.ch-left-chip[aria-expanded=true] { background:var(--dsw-alias-interactive-bg-hover,#8881); color:var(--dsw-alias-label-primary,CanvasText); }
.ch-left-chip:focus-visible { outline:2px solid var(--dsw-focus-ring-color,#6b85f5); outline-offset:-2px; }
.ch-left-chip[data-kind=quota] { color:#4f82b8; background:#4f82b814; }
.ch-left-chip[data-kind=quota][data-state=waiting], .ch-left-chip[data-kind=quota][data-state=sending] { color:#2f7d5b; background:#2f7d5b14; }
.ch-left-chip[data-kind=quota][data-state=error], .ch-left-chip[data-kind=quota][data-state=stopped] { color:var(--dsw-alias-state-danger-primary,#b54738); background:#b5473812; }
.ch-left-chip[data-kind=quota][data-state=off], .ch-left-chip[data-kind=quota][data-state=done], .ch-left-chip[data-kind=quota][data-state=stale] { color:var(--dsw-alias-label-tertiary,#858585); background:transparent; }
@media(max-width:600px) { .ch-native-trigger { max-width:155px; } .ch-native-models { gap:0; } }
`
