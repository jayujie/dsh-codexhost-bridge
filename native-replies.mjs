/** Thread-level, display-only reception. Never resumes a Thread or submits/replays input. */
export const NATIVE_MESSAGE = 'plugin:codexhost/native-message'
const THREAD_RECORD = 'plugin:codexhost/thread'
const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const MAX_HISTORY_BYTES = 24 * 1024 * 1024
const identity = (turn, item) => JSON.stringify([turn, item])
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const normalize = text => text.replace(/\s+/gu, ' ').trim()

/** Item completion and execution outcome are separate: a later API error cannot cancel earlier text. */
export function nativeReplyItemStatus(turn, item, lastMessage = turn.items.findLast(value => value.type === 'agentMessage')) {
  if (['completed', 'failed', 'interrupted'].includes(item.status)) return item.status
  if (lastMessage !== item) return 'completed'
  return TERMINAL.has(turn.status) ? turn.status : 'streaming'
}

async function observeUntilAbort(operation, signal) {
  if (!signal) return operation
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function replyMapping(agent, owner) {
  const state = agent.session.snapshotEvents().findLast(e => e.type === THREAD_RECORD && e.ignorable === true)?.data
  if (!state || state.version !== 1 || !owner || state.harnessId !== owner || !nonempty(state.threadId)
    || (state.sessionId !== undefined && state.sessionId !== agent.id)
    || (agent.session.header?.parentSession !== undefined && state.sessionId !== agent.id)
    || !['ready', 'submitted'].includes(state.phase)) return undefined
  return state
}

/** Covers only the exact requested Turn's already committed text, not arbitrary quoted history. */
export function locallyCovered(session, hostTurnId, text) {
  if (!text.trim()) return true
  const events = session.snapshotEvents()
  const local = events.findLast(e => e.type === THREAD_RECORD && e.ignorable === true && e.data.hostTurnId === hostTurnId)?.data.localTurn
  if (!Number.isSafeInteger(local)) return false
  const visible = events.filter(e => e.type === 'assistant/message' && e.surfaceOp === 'append' && e.data.turn === local)
    .flatMap(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n')
  return normalize(visible).includes(normalize(text))
}

/**
 * Thread status plus the newest Turns' status only (no Items). A running Turn is always
 * among the newest, so ownership checks never need the full history.
 */
export async function readRecentTurns(peer, threadId, { signal, limit = 5 } = {}) {
  const request = async (method, params) => {
    signal?.throwIfAborted()
    const result = await observeUntilAbort(peer.request(method, params, { signal, timeoutMs: 15000 }), signal)
    signal?.throwIfAborted()
    return result
  }
  const thread = (await request('thread/read', { threadId, includeTurns: false })).thread
  if (thread?.id !== threadId) throw new Error('Native reply Thread identity mismatch')
  const page = await request('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'notLoaded' })
  if (!Array.isArray(page?.data)) throw new Error('Native Turn page is invalid')
  return { ...thread, turns: [...page.data].reverse() }
}

/**
 * Newest-first, bounded catch-up. Walks `thread/turns/list` backwards (works for both
 * legacy and paginated External Threads) and stops at the first terminal Turn that
 * `isCovered` reports as already persisted. A long Session therefore transfers only
 * its recent Turns (~0.3 MB) instead of the whole history (9.5 MB measured
 * 2026-11-22, which with the old framing crashed the DSH host). Without a covered
 * Turn (new import, first run) it pages back through everything, as before.
 * Returned Turns are oldest-first.
 */
export async function readNativeReplies(peer, threadId, { unchangedAt, dirty = true, signal, isCovered = () => false, pageSize = 5 } = {}) {
  const request = async (method, params) => {
    signal?.throwIfAborted()
    const result = await observeUntilAbort(peer.request(method, params, { signal, timeoutMs: 15000 }), signal)
    signal?.throwIfAborted()
    return result
  }
  const read = await request('thread/read', { threadId, includeTurns: false })
  const thread = read.thread
  if (thread?.id !== threadId) throw new Error('Native reply Thread identity mismatch')
  if (!dirty && Number.isFinite(unchangedAt) && thread.updatedAt === unchangedAt && thread.status?.type === 'idle') return { ...thread, turns: [], unchanged: true }
  const newestFirst = [], cursors = new Set(), ids = new Set()
  let cursor, bytes = 0, truncated = false
  pages: do {
    const page = await request('thread/turns/list', { threadId, limit: pageSize, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page.data) || page.data.some(t => !Array.isArray(t.items) || (t.itemsView && t.itemsView !== 'full'))) throw new Error('Native replies page is not full history')
    const pageBytes = Buffer.byteLength(JSON.stringify(page.data))
    // Keep the newest Turns rather than failing the whole read on a huge backlog.
    if (newestFirst.length > 0 && (bytes + pageBytes > MAX_HISTORY_BYTES || newestFirst.length + page.data.length > 10000)) { truncated = true; break }
    bytes += pageBytes
    for (const turn of page.data) {
      if (!nonempty(turn.id) || ids.has(turn.id)) throw new Error('Native reply Turn identity repeats')
      ids.add(turn.id)
      // Everything older was persisted by an earlier sync; stop without fetching it.
      if (TERMINAL.has(turn.status) && isCovered(turn)) break pages
      newestFirst.push(turn)
    }
    cursor = page.nextCursor
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Native replies pagination repeats')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return { ...thread, turns: newestFirst.reverse(), ...(truncated ? { truncated: true } : {}) }
}

/**
 * A terminal Turn is covered when it has at least one reply and every reply is already
 * held terminal with identical text (in memory or persisted), or was shown by the
 * local DSH Turn that submitted it. Message-less Turns never stop the catch-up.
 */
export function coveredTurn(state, turn) {
  const replies = turn.items.filter(item => item?.type === 'agentMessage' && nonempty(item.id) && typeof item.text === 'string' && item.text.trim())
  if (replies.length === 0) return false
  return replies.every(item => {
    const entry = state.items.get(identity(turn.id, item.id))
    if (entry && TERMINAL.has(entry.status) && entry.text === item.text) return true
    return locallyCovered(state.agent.session, turn.id, item.text)
  })
}

/**
 * Newest Turn that an import already placed in this Session. Everything at or before it is
 * covered (or was deliberately left out of a trimmed import), so catch-up never pages past it.
 */
export function importedThroughTurn(session, threadId) {
  const record = session.snapshotEvents().findLast(e => e.type === 'plugin:codexhost/import' && e.ignorable === true && e.data?.threadId === threadId && nonempty(e.data.newestTurnId))
  return record?.data.newestTurnId
}

/** Durable folding is keyed by native Thread/Turn/Item, not local model Step. */
export function savedReplies(session, threadId) {
  const items = new Map()
  for (const event of session.snapshotEvents()) {
    const d = event.data
    if (event.type !== NATIVE_MESSAGE || event.ignorable !== true || d?.version !== 1 || d.threadId !== threadId
      || !nonempty(d.hostTurnId) || !nonempty(d.itemId) || !Number.isSafeInteger(d.revision) || d.revision < 1 || typeof d.text !== 'string') continue
    const key = identity(d.hostTurnId, d.itemId), previous = items.get(key)
    if (previous && d.revision <= previous.revision) continue
    items.set(key, { ...d, text: d.append === true ? (previous?.text ?? '') + d.text : d.text, persistedText: d.append === true ? (previous?.text ?? '') + d.text : d.text, persistedStatus: d.status, persistedTurnStatus: d.turnStatus, liveVersion: 0 })
  }
  return items
}

/** Wait before committing a new request while a native autonomous Turn owns the Thread. */
export async function waitForNativeIdle(peer, threadId, signal, timeoutMs, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    signal.throwIfAborted()
    const { thread } = await peer.request('thread/read', { threadId, includeTurns: false }, { signal, timeoutMs: 15000 })
    if (thread?.id !== threadId) throw new Error('Native busy check returned a different Thread')
    if (thread.status?.type !== 'active') return
    if (Date.now() >= deadline) { const error = new Error('Native Thread is still active; no new request was submitted'); error.code = 'HOST_THREAD_BUSY_TIMEOUT'; throw error }
    await new Promise((resolve, reject) => {
      let off, timer
      const finish = error => { clearTimeout(timer); off?.(); signal.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const abort = () => finish(signal.reason ?? new Error('Cancelled while waiting for native Thread'))
      off = peer.subscribe(message => { if (message.params?.threadId === threadId && ['turn/completed', 'thread/status/changed'].includes(message.method)) finish() })
      timer = setTimeout(() => finish(), Math.min(pollMs, deadline - Date.now()))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

export class NativeReplySync {
  constructor(ctx, helpers, { connect, owner, isRequested = () => false, pollMs = 15000, flushMs = 250, reconnectMs = 1000 } = {}) {
    this.ctx = ctx; this.helpers = helpers; this.connect = connect; this.owner = owner; this.isRequested = isRequested
    for (const value of [pollMs, flushMs, reconnectMs]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Native reply intervals must be positive integers')
    this.pollMs = pollMs; this.flushMs = flushMs; this.reconnectMs = reconnectMs
    this.states = new Map(); this.operations = new Set(); this.closed = false; this.version = 0; this.abort = new AbortController()
  }
  install() {
    const track = agent => { this.track(agent); return undefined }
    this.ctx.on('agent/created', ({ agent }) => track(agent))
    this.ctx.on('agent/disposed', ({ agent }) => this.untrack(agent))
    for (const agent of this.ctx.agents.list?.() ?? []) this.track(agent)
  }
  track(agent) {
    if (this.closed) return
    const mapping = replyMapping(agent, this.owner(agent))
    if (!mapping) return
    const previous = this.states.get(agent.id)
    if (previous?.agent === agent && previous.threadId === mapping.threadId) return previous
    if (previous) this.untrack(previous.agent)
    const state = { agent, threadId: mapping.threadId, harnessId: mapping.harnessId, items: savedReplies(agent.session, mapping.threadId), importedThrough: importedThroughTurn(agent.session, mapping.threadId), dirty: true, stopped: false }
    this.states.set(agent.id, state)
    this.requestSync(state)
    return state
  }
  valid(state) {
    if (this.closed || state.stopped || this.states.get(state.agent.id) !== state) return false
    const mapping = replyMapping(state.agent, this.owner(state.agent))
    // Refuse ambiguous ownership and fork aliases rather than mixing Session histories.
    return mapping?.threadId === state.threadId && [...this.states.values()].filter(s => !s.stopped && s.threadId === state.threadId).length === 1
  }
  untrack(agent) {
    const state = this.states.get(agent.id)
    if (!state || state.agent !== agent) return
    state.stopped = true; clearTimeout(state.timer); clearTimeout(state.flushTimer)
    this.states.delete(agent.id)
  }
  attach(peer) {
    if (this.closed || this.peer === peer) return
    this.off?.(); this.peer = peer
    this.off = peer.subscribe(message => this.accept(message))
    void peer.closed.then(() => {
      if (this.peer !== peer) return
      this.off?.(); this.off = undefined; this.peer = undefined
      for (const state of this.states.values()) {
        state.dirty = true
        for (const item of state.items.values()) item.incomplete = true
        this.schedule(state, this.reconnectMs)
      }
    })
    for (const state of this.states.values()) this.requestSync(state)
  }
  schedule(state, delay = this.pollMs) {
    if (!this.valid(state)) return
    const due = Date.now() + delay
    if (state.timer && state.nextReadAt <= due) return
    clearTimeout(state.timer); state.nextReadAt = due
    state.timer = setTimeout(() => { state.timer = undefined; state.nextReadAt = undefined; this.requestSync(state) }, delay)
    state.timer.unref?.()
  }
  requestSync(state) {
    if (!this.valid(state)) return Promise.resolve()
    if (state.syncing) { state.again = true; return state.syncing }
    clearTimeout(state.timer); state.timer = undefined; state.nextReadAt = undefined
    const task = this.sync(state).catch(error => {
      if (this.valid(state)) this.ctx.logger?.warn(`Native reply sync unavailable: ${error.code ?? error.name}`)
    }).finally(() => {
      state.syncing = undefined; this.operations.delete(task)
      if (state.again) { state.again = false; this.schedule(state, 0) } else this.schedule(state)
    })
    state.syncing = task; this.operations.add(task)
    return task
  }
  async sync(state) {
    const peer = await observeUntilAbort(this.connect(), this.abort.signal)
    if (!this.valid(state)) return
    this.attach(peer)
    const version = this.version
    const snapshot = await readNativeReplies(peer, state.threadId, { unchangedAt: state.lastUpdatedAt, dirty: state.dirty || state.lastWasMetadataOnly, signal: this.abort.signal,
      isCovered: turn => turn.id === state.importedThrough || coveredTurn(state, turn) })
    if (!this.valid(state) || this.peer !== peer) return
    for (const turn of snapshot.turns) {
      if (!nonempty(turn.id) || !Array.isArray(turn.items)) throw new Error('Invalid native reply Turn')
      const lastMessage = turn.items.findLast(item => item.type === 'agentMessage')
      for (const item of turn.items) {
        if (item.type !== 'agentMessage' || !nonempty(item.id) || typeof item.text !== 'string') continue
        const status = nativeReplyItemStatus(turn, item, lastMessage)
        this.update(state, turn.id, item.id, item.text, status, { snapshotVersion: version, turnStatus: turn.status, nativeTime: turn.startedAtMs ?? item.startedAtMs })
      }
    }
    state.dirty = this.version !== version
    state.lastUpdatedAt = snapshot.updatedAt
    state.lastWasMetadataOnly = snapshot.unchanged === true // updatedAt can be coarse: never skip two full reads in succession.
    await this.flush(state)
  }
  accept(message) {
    if (this.closed || message.id !== undefined) return // Never execute/reply to native tool or approval requests here.
    const p = message.params ?? {}, turnId = p.turnId ?? p.turn?.id
    if (!nonempty(p.threadId)) return
    const states = [...this.states.values()].filter(s => s.threadId === p.threadId && this.valid(s))
    if (states.length !== 1) return
    const state = states[0]
    const item = p.item
    if (message.method === 'item/agentMessage/delta' && nonempty(turnId) && nonempty(p.itemId) && typeof p.delta === 'string') {
      const key = identity(turnId, p.itemId), old = state.items.get(key)
      // An Item without its start can have a missing prefix; keep it buffered until an authoritative snapshot.
      if (!old || old.incomplete || old.snapshotOwned) { state.dirty = true; this.schedule(state, this.flushMs); return }
      this.update(state, turnId, p.itemId, old.text + p.delta, 'streaming', { live: true })
    } else if (['item/started', 'item/completed'].includes(message.method) && nonempty(turnId) && item?.type === 'agentMessage' && nonempty(item.id) && typeof item.text === 'string') {
      this.update(state, turnId, item.id, item.text, message.method === 'item/completed' ? 'completed' : 'streaming', { live: true, nativeTime: item.startedAtMs })
    } else if (message.method === 'turn/completed' && nonempty(turnId)) {
      for (const entry of state.items.values()) if (entry.hostTurnId === turnId) this.update(state, turnId, entry.itemId, entry.text, entry.status === 'streaming' ? (TERMINAL.has(p.turn?.status) ? p.turn.status : 'completed') : entry.status, { live: true, turnStatus: p.turn?.status })
      state.dirty = true; this.schedule(state, 0)
    } else if (['turn/started', 'thread/status/changed'].includes(message.method)) {
      state.dirty = true; this.schedule(state, 0)
    }
  }
  update(state, turnId, itemId, text, status, { live = false, snapshotVersion, nativeTime, turnStatus } = {}) {
    if (!this.valid(state)) return
    const key = identity(turnId, itemId), previous = state.items.get(key)
    if (snapshotVersion !== undefined && previous?.liveVersion > snapshotVersion && (!text.startsWith(previous.text) || TERMINAL.has(previous.status))) return
    // A late partial snapshot/delta cannot regress a terminal Item or discard its prefix.
    if (previous && TERMINAL.has(previous.status) && status === 'streaming') return
    const entry = { ...previous, version: 1, harnessId: state.harnessId, threadId: state.threadId, hostTurnId: turnId, itemId,
      text, status, incomplete: false, snapshotOwned: snapshotVersion !== undefined && status === 'streaming', liveVersion: live ? ++this.version : previous?.liveVersion ?? 0,
      ...(typeof turnStatus === 'string' ? { turnStatus } : {}),
      ...(Number.isFinite(nativeTime) && nativeTime > 0 ? { nativeTime } : {}) }
    state.items.set(key, entry)
    if (state.flushTimer) return
    state.flushTimer = setTimeout(() => { state.flushTimer = undefined; void this.flush(state).catch(error => this.ctx.logger?.warn(`Native reply persistence unavailable: ${error.code ?? error.name}`)) }, this.flushMs)
    state.flushTimer.unref?.()
  }
  async flush(state) {
    if (!this.valid(state)) return
    clearTimeout(state.flushTimer); state.flushTimer = undefined
    for (const entry of state.items.values()) {
      if (!entry.text.trim() || this.isRequested(state.threadId, entry.hostTurnId)) continue
      // Cheap equality first: locallyCovered scans the whole Session log per Item.
      if (entry.persistedText === entry.text && entry.persistedStatus === entry.status && entry.persistedTurnStatus === entry.turnStatus) continue
      if (locallyCovered(state.agent.session, entry.hostTurnId, entry.text)) continue
      // Each durable update is independently replayable from a paged window.
      // Coalesce live deltas in memory; never persist a suffix that needs an older page.
      const record = { version: 1, harnessId: state.harnessId, threadId: state.threadId, hostTurnId: entry.hostTurnId, itemId: entry.itemId,
        revision: (entry.revision ?? 0) + 1, text: entry.text, status: entry.status, ...(entry.turnStatus ? { turnStatus: entry.turnStatus } : {}),
        ...(entry.nativeTime ? { nativeTime: entry.nativeTime } : {}) }
      this.helpers.appendPluginRecord(state.agent.session, NATIVE_MESSAGE, record)
      entry.revision = record.revision; entry.persistedText = entry.text; entry.persistedStatus = entry.status; entry.persistedTurnStatus = entry.turnStatus
    }
    // Only ignorable plugin records were appended: no local Turns/Steps, model messages, tools or usage.
    await this.ctx.sessionPersistence.flush()
  }
  async syncAgent(agent) {
    const state = this.track(agent)
    if (state) { await this.requestSync(state); await this.flush(state) }
  }
  async close() {
    this.closed = true; this.abort.abort(new Error('Native reply observer unloaded')); this.off?.(); this.off = undefined
    for (const state of this.states.values()) { state.stopped = true; clearTimeout(state.timer); clearTimeout(state.flushTimer) }
    await Promise.allSettled([...this.operations]); this.states.clear()
  }
}
