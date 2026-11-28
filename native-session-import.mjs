import { hostRecord, isHostRecord } from './host-identity.mjs'
import { createHash } from 'node:crypto'
import { presetForEngine, engineLabel, hostProvider } from './external-engines.mjs'
import path from 'node:path'
import { NativeTurnProjector } from './native-turn-projector.mjs'
import { nativeThreadState } from './native-session-driver.mjs'
import { OBSERVATION, observedUsage, observedCost } from './native-observations.mjs'

export const importSessionId = (harness, thread) => `session-host-${createHash('sha256').update(`${harness}\0${thread}`).digest('hex').slice(0, 32)}`
export function isRunning(thread) {
  return ['active', 'running', 'inProgress'].includes(thread.status?.type) || (thread.turns ?? []).some(turn => turn.status === 'inProgress')
}
// Newest-first budget for one import. The 24 MiB check in historySeed stays as a hard
// safety net; staying well under it means a long Session imports its recent Turns instead
// of being refused outright. The native Thread keeps its full history either way.
export const IMPORT_BUDGET_BYTES = 16 * 1024 * 1024
const turnBytes = turn => Buffer.byteLength(JSON.stringify(turn))
/** Legacy (non-paginated) history arrives whole; drop the oldest Turns past the budget. */
function keepNewestTurns(thread, maxBytes) {
  if (!Array.isArray(thread.turns)) return thread
  let bytes = 0, keepFrom = thread.turns.length
  while (keepFrom > 0) {
    const size = turnBytes(thread.turns[keepFrom - 1])
    if (keepFrom < thread.turns.length && bytes + size > maxBytes) break
    bytes += size; keepFrom--
  }
  return keepFrom === 0 ? thread : { ...thread, turns: thread.turns.slice(keepFrom), truncated: true }
}
export async function readImportHistory(peer, threadId, { maxBytes = IMPORT_BUDGET_BYTES } = {}) {
  const thread = (await peer.request('thread/read', { threadId, includeTurns: false })).thread
  if (isRunning(thread)) throw new Error('会话正在原客户端运行，请先停止后导入。')
  if (thread.historyMode !== 'paginated') return keepNewestTurns((await peer.request('thread/read', { threadId, includeTurns: true })).thread, maxBytes)
  const newestFirst = [], cursors = new Set()
  let cursor, bytes = 0, truncated = false
  pages: do {
    const page = await peer.request('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page.data) || page.data.some(t => t.itemsView && t.itemsView !== 'full')) throw new Error('原生历史仅返回摘要，已停止导入。')
    for (const turn of page.data) {
      const size = turnBytes(turn)
      // Always keep the newest Turn, even if it alone exceeds the budget.
      if (newestFirst.length > 0 && bytes + size > maxBytes) { truncated = true; break pages }
      bytes += size; newestFirst.push(turn)
    }
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('原生历史分页重复，已停止导入。')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const latest = (await peer.request('thread/read', { threadId, includeTurns: false })).thread
  if (isRunning(latest) || latest.updatedAt !== thread.updatedAt) throw new Error('原客户端的会话已发生变化，请停止后重新导入。')
  return { ...thread, turns: newestFirst.reverse(), ...(truncated ? { truncated: true } : {}) }
}
export function historySeed(thread, harnessId, selection, helpers, usageSnapshot) {
  if (!Array.isArray(thread.turns)) throw new Error('原生 Agent 没有返回完整历史，已停止导入。')
  if (Buffer.byteLength(JSON.stringify(thread)) > 24 * 1024 * 1024) throw new Error('会话历史超过本次导入上限，未创建不完整的 DSH 会话。')
  const events = [], id = importSessionId(harnessId, thread.id)
  let at = (thread.createdAt || Date.now() / 1000) * 1000, revision = 0
  const session = { id, append(type, data, options) {
    const event = { type, seq: events.length, time: Math.floor(at), data, ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}) }
    if (type.startsWith('plugin:')) event.ignorable = true
    events.push(event); return event
  } }
  let n = 0
  for (const nativeTurn of thread.turns) {
    const turn = ++n, step = 1
    if (!Array.isArray(nativeTurn.items)) throw new Error('原生历史未完整加载，已停止导入。')
    at = nativeTurn.startedAtMs ?? (typeof nativeTurn.startedAt === 'number' ? nativeTurn.startedAt * 1000 : undefined) ?? nativeTurn.items.find(item => item.startedAtMs)?.startedAtMs ?? at
    const startTime = at
    session.append('turn/start', { turn }); session.append('step/start', { turn, step })
    const projector = new NativeTurnProjector({ agent: { id, session }, turn, step, helpers, dispatch: { emit() {} }, nextRevision: () => ++revision, provider: hostProvider(harnessId), model: selection.modelId ?? thread.model ?? '' })
    for (const item of nativeTurn.items) {
      if (item.type === 'userMessage') {
        const content = (item.content ?? []).map(block => block.type === 'text' ? { type: 'text', text: block.text }
          : { type: 'text', text: `[${block.type}: ${block.path ?? block.url ?? block.name ?? '原生附件'}]` })
        if (content.length) session.append('user/message', helpers.createUserMessage({ content, source: { kind: 'user' } }), { surfaceOp: 'append' })
      } else projector.accept({ method: 'item/completed', params: { threadId: thread.id, turnId: nativeTurn.id, item } })
    }
    at = nativeTurn.completedAtMs ?? (typeof nativeTurn.completedAt === 'number' ? nativeTurn.completedAt * 1000 : undefined) ?? (typeof nativeTurn.durationMs === 'number' ? startTime + nativeTurn.durationMs : startTime)
    projector.settle({ interrupted: nativeTurn.status !== 'completed' })
    session.append('step/end', { turn, step })
    const reason = nativeTurn.status === 'completed' ? { kind: 'completed' }
      : nativeTurn.status === 'failed' ? { kind: 'error', error: { code: 'NATIVE_HISTORY_FAILED', message: nativeTurn.error?.message ?? '此轮在原生 Agent 中执行失败。' } }
        : { kind: 'aborted', reason: { kind: 'hook', reason: '此轮已在原生 Agent 中停止。' } }
    session.append('turn/end', { turn, reason })
  }
  at = Date.now()
  session.append(hostRecord('configuration'), { harnessId, ...selection })
  session.append(hostRecord('thread'), { version: 1, sessionId: id, harnessId, threadId: thread.id, phase: 'ready', appliedConfiguration: selection })
  // newestTurnId is the sync watermark: every Turn at or before it is already in this Session
  // (or deliberately left out when truncated), so reply sync must not page back past it.
  const newestTurnId = thread.turns.at(-1)?.id
  session.append(hostRecord('import'), { version: 1, harnessId, threadId: thread.id, importedAt: at, turns: n, ...(typeof newestTurnId === 'string' && newestTurnId ? { newestTurnId } : {}), ...(thread.truncated === true ? { truncated: true } : {}) })
  const named = (thread.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const preview = (thread.preview || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  const title = named || (preview.length > 80 ? `${preview.slice(0, 80).trimEnd()}…` : preview)
  const messageSeqs = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').map(e => e.seq)
  if (title && messageSeqs.length) session.append('session/title', {
    title: Buffer.from(title).subarray(0, 500).toString('utf8').replace(/\uFFFD$/, ''),
    messageSeqs,
    source: named ? { kind: 'provider', provider: 'dsh-host-native-title' } : { kind: 'fallback' },
  })
  const usage = observedUsage(usageSnapshot), cost = observedCost(usageSnapshot)
  if (usage) session.append(OBSERVATION, { threadId: thread.id, harnessId, model: selection.modelId ?? '', observedAt: at, usage, ...(cost ? { cost } : {}) })
  // Imported messages were not streamed by DSH. Do not infer TPS or TTFT from
  // the milliseconds spent replaying history in this importer.
  for (const event of events) if (['assistant/message', 'assistant/attempt'].includes(event.type)) event.data.stream = []
  return events
}

const OWNERSHIP_BATCH_LIMIT = 100
/** The Host requires unique IDs and a complete, identity-matched answer per bounded batch. */
export async function readThreadOwnership(peer, threadIds) {
  if (!Array.isArray(threadIds) || threadIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('Invalid Thread identity in import list')
  const ids = [...new Set(threadIds)], owners = new Map()
  for (let offset = 0; offset < ids.length; offset += OWNERSHIP_BATCH_LIMIT) {
    const batch = ids.slice(offset, offset + OWNERSHIP_BATCH_LIMIT)
    const result = await peer.request('codexhost/thread/ownership/list', { threadIds: batch })
    if (!Array.isArray(result?.threads) || result.threads.length !== batch.length) throw new Error('Incomplete Thread ownership metadata; import stopped')
    const expected = new Set(batch)
    for (const row of result.threads) {
      if (!row || !expected.delete(row.threadId) || !['codex', 'external'].includes(row.owner) || (row.owner === 'external' && (typeof row.harnessId !== 'string' || !row.harnessId.trim() || row.harnessId.length > 256))) throw new Error('Invalid or mismatched Thread ownership metadata; import stopped')
      owners.set(row.threadId, row)
    }
    if (expected.size) throw new Error('Incomplete Thread ownership metadata; import stopped')
  }
  return ids.map(id => owners.get(id))
}

const canonicalImportCwd = p => {
  if (typeof p !== 'string' || !p.trim()) return ''
  const stripped = p.startsWith('\\\\?\\') ? p.slice(4) : p
  return path.resolve(stripped).toLowerCase()
}

function formatImportListTitle(raw, { isPreview = false } = {}) {
  if (typeof raw !== 'string') return ''
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (!isPreview || cleaned.length <= 120) return cleaned
  return `${cleaned.slice(0, 120).trimEnd()}…`
}

/** Imports observations, never executes a tool or submits a model turn. */
export class NativeSessionImporter {
  #pending = new Map()
  #storedMetaCache = new Map()
  constructor(ctx, driver, helpers) { this.ctx = ctx; this.driver = driver; this.helpers = helpers }
  async #knownDshTitles(harnessId, threadRows) {
    const known = new Map()
    const missing = new Set()
    const neededCwds = new Set()
    for (const row of threadRows) {
      if (typeof row.name === 'string' && row.name.trim()) continue
      missing.add(row.id)
      const c = canonicalImportCwd(row.cwd)
      if (c) neededCwds.add(c)
    }
    if (missing.size === 0) return known
    const titleService = this.ctx?.get?.('sessionTitle')
    for (const agent of this.ctx?.agents?.list?.() ?? []) {
      try {
        const state = nativeThreadState(agent.session)
        if (!state || state.harnessId !== harnessId || !missing.has(state.threadId)) continue
        if (state.sessionId !== undefined && state.sessionId !== agent.id) continue
        const snap = titleService?.get?.(agent.session)
        if (snap?.title && snap.source?.kind !== 'fallback') {
          known.set(state.threadId, snap.title)
          missing.delete(state.threadId)
        }
      } catch {}
    }
    if (missing.size === 0 || typeof this.ctx?.sessionPersistence?.list !== 'function') return known
    try {
      const stored = await this.ctx.sessionPersistence.list()
      const candidates = []
      for (const entry of stored) {
        if (!entry?.header?.id || entry.formatStatus === 'migration-required') continue
        const entryCwd = canonicalImportCwd(entry.header.cwd)
        if (neededCwds.size > 0 && entryCwd && !neededCwds.has(entryCwd)) continue
        candidates.push(entry)
        if (candidates.length >= 200) break
      }
      const inspectOne = async entry => {
        if (missing.size === 0) return
        const cacheKey = `${entry.header.id}:${entry.revision ?? ''}`
        let meta = this.#storedMetaCache.get(cacheKey)
        if (meta === undefined) {
          meta = null
          try {
            const handle = await this.ctx.sessionPersistence.open(entry.header.id, 'read')
            try {
              const threadEvents = []
              let latestTitle = null
              for (let offset = 0; ; offset += 512) {
                const { events } = await handle.read(offset, 512)
                for (const ev of events) {
                  if (isHostRecord(ev.type, 'thread')) threadEvents.push(ev)
                  else if (ev.type === 'session/title' && typeof ev.data?.title === 'string' && ev.data.title.trim()) latestTitle = ev.data
                }
                if (events.length < 512) break
              }
              const state = nativeThreadState({ snapshotEvents: () => threadEvents })
              if (state && (state.sessionId === undefined || state.sessionId === entry.header.id) && latestTitle && latestTitle.source?.kind !== 'fallback') {
                meta = { harnessId: state.harnessId, threadId: state.threadId, title: latestTitle.title }
              }
            } finally { await handle.close() }
          } catch {}
          if (this.#storedMetaCache.size > 512) this.#storedMetaCache.clear()
          this.#storedMetaCache.set(cacheKey, meta)
        }
        if (meta && meta.harnessId === harnessId && missing.has(meta.threadId)) {
          known.set(meta.threadId, meta.title)
          missing.delete(meta.threadId)
        }
      }
      const concurrency = Math.min(4, candidates.length)
      let cursor = 0
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (cursor < candidates.length && missing.size > 0) await inspectOne(candidates[cursor++])
      }))
    } catch {}
    return known
  }
  async list(peer, { harnessId, query = '', cursor, offset = 0 }) {
    const [page, native] = await Promise.all([
      cursor === 'end' ? { data: [], nextCursor: null } : peer.request('thread/list', { limit: 100, sortKey: 'updated_at', ...(cursor ? { cursor } : {}), ...(query.trim() ? { searchTerm: query.trim() } : {}) }),
      harnessId !== 'codex'
        ? peer.request('codexhost/harness/session-import/list', { harnessId, query, offset, limit: 20 })
          .catch(error => /Harness Session import is unsupported/i.test(error?.message ?? '') ? { candidates: [], total: 0 } : Promise.reject(error))
        : { candidates: [], total: 0 },
    ])
    if (!Array.isArray(page?.data)) throw new Error('Invalid native Thread list; import stopped')
    const ownership = await readThreadOwnership(peer, page.data.map(row => row?.id))
    const unique = new Map()
    for (const row of page.data) if (!unique.has(row.id)) unique.set(row.id, row)
    const uniqueRows = [...unique.values()]
    const owners = new Map(ownership.map(row => [row.threadId, row.owner === 'codex' ? 'codex' : row.harnessId]))
    const matchingRows = uniqueRows.filter(row => owners.get(row.id) === harnessId)
    const dshTitles = await this.#knownDshTitles(harnessId, matchingRows)
    const rows = matchingRows.map(row => {
      const explicitName = formatImportListTitle(row.name)
      const dshTitle = formatImportListTitle(dshTitles.get(row.id))
      const previewTitle = formatImportListTitle(row.preview, { isPreview: true })
      return { kind: 'thread', id: row.id, title: explicitName || dshTitle || previewTitle || row.id, cwd: row.cwd, updatedAt: row.updatedAt, running: isRunning(row) ? true : null }
    })
    rows.push(...native.candidates.map(row => ({ ...row, updatedAt: row.updatedAt > 100000000000 ? row.updatedAt / 1000 : row.updatedAt, id: row.nativeSessionId, kind: 'native', title: formatImportListTitle(row.title) || row.nativeSessionId })))
    return { rows, nextCursor: page.nextCursor ?? null, nextOffset: offset + 20 < native.total ? offset + 20 : null, nativeTotal: native.total }
  }
  import(peer, input) {
    const key = `${input.harnessId}:${input.kind}:${input.id}`
    if (!this.#pending.has(key)) this.#pending.set(key, this.#import(peer, input).finally(() => this.#pending.delete(key)))
    return this.#pending.get(key)
  }
  async #existing(id, threadId, harnessId) {
    const agent = this.ctx.agents.get(id)
    if (agent) {
      const state = nativeThreadState(agent.session)
      if (state?.threadId !== threadId || state?.harnessId !== harnessId || state.phase !== 'ready' || (state.sessionId !== undefined && state.sessionId !== id)) throw new Error('此 DSH 会话已属于另一个原生 Agent或映射不允许续聊，已停止导入。')
      return { exists: true, cwd: agent.session?.header?.cwd }
    }
    const stat = await this.ctx.sessionPersistence.stat(id)
    if (!stat) return null
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      const state = nativeThreadState({ snapshotEvents: () => events })
      if (state?.threadId !== threadId || state?.harnessId !== harnessId || state.phase !== 'ready' || (state.sessionId !== undefined && state.sessionId !== id)) throw new Error('已保存的会话映射不一致，已停止导入。')
      return { exists: true, cwd: stat.header?.cwd }
    } finally { await handle.close() }
  }
  async #findStored(threadId, harnessId, cwd) {
    const canonical = canonicalImportCwd, matches = [], unreadable = []
    for (const { header, formatStatus } of await this.ctx.sessionPersistence.list()) {
      if (!header.cwd || formatStatus === 'migration-required' || canonical(header.cwd) !== canonical(cwd)) continue
      const live = this.ctx.agents.get(header.id)
      let state
      try {
        if (live) state = nativeThreadState(live.session)
        else {
          const handle = await this.ctx.sessionPersistence.open(header.id, 'read')
          try {
            const records = []
            for (let offset = 0; ; offset += 512) {
              const { events } = await handle.read(offset, 512)
              records.push(...events.filter(e => isHostRecord(e.type, 'thread')))
              if (events.length < 512) break
            }
            state = nativeThreadState({ snapshotEvents: () => records })
          } finally { await handle.close() }
        }
      } catch (error) {
        if (error?.name !== 'SessionPersistenceCorruptionError') throw error
        unreadable.push(header.id); continue
      }
      // A reference-only copy retains its source mapping; it is not an executable owner.
      if (state?.sessionId !== undefined && state.sessionId !== header.id) continue
      if (state?.threadId !== threadId || state.harnessId !== harnessId) continue
      if (state.phase !== 'ready') throw new Error('此会话在 DSH 中仍有未确认的任务，请先检查现有会话。')
      matches.push(header.id)
    }
    if (matches.length > 1) throw new Error('同一原生 Thread 存在多个可续聊映射，已停止导入，避免重复写入。')
    if (matches.length === 1) return matches[0]
    if (unreadable.length) throw new Error(`同一工作目录存在无法读取的历史会话，无法确认唯一归属，未创建重复会话：${unreadable.join(', ')}`)
  }
  async #import(peer, input) {
    if (input.acknowledgeIdle !== true) throw new Error('请先在原客户端停止此会话，再确认导入。')
    let threadId = input.id
    if (input.kind === 'native') threadId = (await peer.request('codexhost/harness/session-import/import', { harnessId: input.harnessId, nativeSessionId: input.id })).threadId
    const [owner] = await readThreadOwnership(peer, [threadId])
    if ((owner.owner === 'codex' ? 'codex' : owner.harnessId) !== input.harnessId) throw new Error('此会话不属于所选 Agent。')
    const thread = await readImportHistory(peer, threadId)
    if (thread.id !== threadId) throw new Error('原生会话身份不一致，已停止导入。')
    if (isRunning(thread)) throw new Error('会话正在原客户端运行，请先停止后导入。')
    if (!path.isAbsolute(thread.cwd)) throw new Error('原会话没有有效工作目录，已停止导入。')
    const prior = this.ctx.agents.list().find(agent => {
      try { const s = nativeThreadState(agent.session); return s?.threadId === threadId && s.harnessId === input.harnessId && (s.sessionId === undefined || s.sessionId === agent.id) } catch { return false }
    })
    if (prior && nativeThreadState(prior.session)?.phase !== 'ready') throw new Error('此会话在 DSH 中仍有未确认的任务，请先检查现有会话。')
    const candidateId = importSessionId(input.harnessId, threadId)
    const deterministic = prior ? null : await this.#existing(candidateId, threadId, input.harnessId)
    const storedId = prior || deterministic ? undefined : await this.#findStored(threadId, input.harnessId, thread.cwd)
    const sessionId = prior?.id ?? storedId ?? candidateId
    const reused = Boolean(prior || deterministic || storedId)
    const existingCwd = prior?.session?.header?.cwd ?? deterministic?.cwd
    const targetCwd = reused && typeof existingCwd === 'string' && path.isAbsolute(existingCwd) ? existingCwd : thread.cwd
    // Native registry validates existence/canonical path and creates a Workspace if absent. Never substitute another cwd.
    const existingWorkspace = typeof this.ctx.workspaceRegistry.resolveByPath === 'function'
      ? await this.ctx.workspaceRegistry.resolveByPath(targetCwd).catch(() => undefined)
      : undefined
    const workspace = await this.ctx.workspaceRegistry.create(targetCwd)
    const workspaceCreated = typeof this.ctx.workspaceRegistry.resolveByPath === 'function' ? !existingWorkspace : false
    const canonicalCwd = typeof workspace.path === 'string' && workspace.path ? workspace.path : targetCwd
    let truncated = false // true only when this call created the Session from a trimmed history
    if (!reused) {
      const preset = presetForEngine(input.harnessId)
      // Use native model identity when supplied. Missing effort/permission falls back to
      // catalog defaults on continuation; importing itself changes no native settings.
      const selection = { ...(thread.model ? { modelId: thread.model } : {}), ...(thread.reasoningEffort ? { thinkingOptionId: thread.reasoningEffort } : {}), permissionModeId: input.harnessId === 'codex' ? 'read-only' : 'default' }
      if (input.harnessId !== 'codex') {
        const inspection = await peer.request('codexhost/harness/inspect', { harnessId: input.harnessId, cwd: canonicalCwd, refresh: false })
        if (inspection.status !== 'ready') throw new Error(inspection.error?.message ?? `${engineLabel(input.harnessId)} 尚未就绪。`)
        // External thread metadata can contain an encoded Host route. Resolve IDs against
        // the actual catalog rather than persisting that transport string as a model.
        const native = await peer.request('codexhost/thread/inspect', { threadId })
        const model = inspection.catalog.models.find(m => m.ref.id === native.effectiveModel?.id || m.ref.id === thread.model || m.resolvedModelLabel === thread.model)
        selection.modelId = model?.ref.id ?? inspection.catalog.defaultModel?.id ?? inspection.catalog.models[0]?.ref.id
        selection.permissionModeId = native.effectivePermissionModeId ?? inspection.permissionModes?.defaultModeId ?? 'default'
        if (native.effectiveThinkingOptionId) selection.thinkingOptionId = native.effectiveThinkingOptionId
        else delete selection.thinkingOptionId
      }
      let usage
      try { usage = (await peer.request('codexhost/thread/usage/inspect', { threadId }, { timeoutMs: 10000 })).usage } catch {}
      const seed = historySeed(thread, input.harnessId, selection, this.helpers, usage)
      truncated = thread.truncated === true
      const defaults = this.ctx.get('agentDefaultModel')
      const current = defaults?.currentSelection()
      const handle = await this.ctx.agents.create({ sessionId, meta: { cwd: canonicalCwd, agentPreset: preset }, seed,
        ...(current ? { agentOptions: { provider: current.provider, model: current.model, reasoningEffort: current.reasoningEffort } } : {}),
        setup: async actx => {
          this.helpers.installModelSelection?.(actx)
          await this.ctx.agentPresets.mount(actx, preset)
        },
      })
      this.ctx.effect(() => () => handle.dispose())
      await this.ctx.sessionPersistence.flush()
    }
    await workspace.attachSession(sessionId)
    let unarchived = false
    if (Array.isArray(this.ctx.workspaceRegistry.archivedSessionIds)
      && this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
      && typeof this.ctx.workspaceRegistry.unarchiveSession === 'function') {
      await this.ctx.workspaceRegistry.unarchiveSession(sessionId)
      unarchived = true
    }
    return {
      sessionId,
      threadId,
      workspaceId: workspace.id,
      ...(typeof workspace.title === 'string' && workspace.title ? { workspaceTitle: workspace.title } : {}),
      cwd: canonicalCwd,
      ...(workspaceCreated ? { workspaceCreated: true } : {}),
      ...(reused ? { reused: true } : {}),
      ...(unarchived ? { unarchived: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    }
  }
}
