import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeReplySync, NATIVE_MESSAGE, savedReplies, locallyCovered, readNativeReplies, waitForNativeIdle } from '../native-replies.mjs'

const mapping = { version: 1, sessionId: 'a', phase: 'ready', harnessId: 'claude-code', threadId: 'thread' }
function fixture({ history = [], request, requested = () => false, reconnectMs = 100000 } = {}) {
  const events = [], callbacks = new Map(), agents = new Map(), calls = [], listeners = new Set(), closed = Promise.withResolvers()
  const session = { id: 'a', header: {}, snapshotEvents: () => events, append(type, data, options) { const e = { type, data, seq: events.length, time: 1000, ...(type.startsWith('plugin:') ? { ignorable: true } : {}), ...options }; events.push(e); return e } }
  session.append('plugin:codexhost/thread', { ...mapping })
  const agent = { id: 'a', session }; agents.set('a', agent)
  let thread = { id: 'thread', status: { type: 'idle' }, updatedAt: 1, historyMode: 'legacy', turns: history }
  const peer = { closed: closed.promise, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method, params) {
    calls.push({ method, params })
    if (request) { const result = await request(method, params); if (result !== undefined) return result }
    if (method === 'thread/turns/list') {
      // Host semantics: newest-first pages; the cursor is the next start offset.
      assert.equal(params.sortDirection, 'desc'); assert.equal(params.itemsView, 'full')
      const ordered = [...thread.turns].reverse(), start = params.cursor ? Number(params.cursor) : 0, end = start + params.limit
      return structuredClone({ data: ordered.slice(start, end), nextCursor: end < ordered.length ? String(end) : null })
    }
    assert.equal(method, 'thread/read', 'Observer never sends a mutating or model request')
    return { thread: structuredClone(params.includeTurns ? thread : { ...thread, turns: [] }) }
  } }
  const ctx = { agents: { list: () => [...agents.values()], get: id => agents.get(id) }, on(name, callback) { callbacks.set(name, callback) }, sessionPersistence: { async flush() {} }, logger: { warn() {} } }
  const helpers = { appendPluginRecord: (s, type, data) => s.append(type, data) }
  const sync = new NativeReplySync(ctx, helpers, { connect: async () => peer, owner: () => 'claude-code', isRequested: requested, pollMs: 100000, flushMs: 100000, reconnectMs })
  const start = async () => { const state = sync.track(agent); await state.syncing; return state }
  const emit = (method, params) => { for (const fn of [...listeners]) fn({ method, params: { threadId: 'thread', ...params } }) }
  return { sync, session, agent, agents, events, ctx, helpers, peer, calls, callbacks, listeners, closed, start, emit, get thread() { return thread }, set thread(t) { thread = t }, messages: () => events.filter(e => e.type === NATIVE_MESSAGE) }
}
const native = (id, text, status = 'completed', itemId = id + '-item') => ({ id, status, items: [{ id: itemId, type: 'agentMessage', text }] })

test('a failed Turn preserves already completed Item text rather than marking every message stopped', async () => {
  const f=fixture({history:[{id:'failure-turn',status:'failed',items:[{type:'agentMessage',id:'progress',text:'审稿意见已到'},{type:'agentMessage',id:'error',text:'API Error: Request rejected (429)'}]}]})
  try{await f.start();const messages=f.messages();assert.equal(messages[0].data.status,'completed');assert.equal(messages[0].data.turnStatus,'failed');assert.equal(messages[1].data.status,'failed')}finally{await f.sync.close()}
})

test('completed live Items are not retroactively interrupted by a later provider failure', async () => {
  const f=fixture();try{const s=await f.start();f.emit('item/completed',{turnId:'t',item:{type:'agentMessage',id:'i',text:'完整正文'}});f.emit('turn/completed',{turn:{id:'t',status:'failed'}});await f.sync.flush(s);assert.equal(f.messages().at(-1).data.status,'completed');assert.equal(f.messages().at(-1).data.turnStatus,'failed')}finally{await f.sync.close()}
})

test('completed requested Turn is not mistaken for all Thread work; autonomous replies are display-only', async () => {
  const f = fixture({ history: [native('owned', 'already shown'), native('auto', '后续回复')] })
  f.session.append('plugin:codexhost/thread', { ...mapping, phase: 'submitted', localTurn: 2, hostTurnId: 'owned' })
  f.session.append('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'already shown' }] } }, { surfaceOp: 'append' })
  try {
    await f.start()
    assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].data.text, '后续回复')
    assert.equal(f.messages()[0].surfaceOp, undefined); assert.equal(f.messages()[0].ignorable, true)
    assert.ok(f.calls.every(c => ['thread/read', 'thread/turns/list'].includes(c.method)), 'Read-only methods only')
    assert.equal(f.events.some(e => ['turn/start', 'step/start', 'tool/call'].includes(e.type)), false)
    assert.equal(f.events.findLast(e => e.type === 'plugin:codexhost/thread').data.phase, 'submitted')
  } finally { await f.sync.close() }
})

test('late autonomous stream survives original request completion; delta storage, final snapshot and reconnect are idempotent', async () => {
  const f = fixture()
  try {
    const s = await f.start()
    f.emit('item/started', { turnId: 'auto', item: { id: 'item', type: 'agentMessage', text: '' } })
    f.emit('item/agentMessage/delta', { turnId: 'auto', itemId: 'item', delta: '原文' }); await f.sync.flush(s)
    f.emit('item/agentMessage/delta', { turnId: 'auto', itemId: 'item', delta: '继续' }); await f.sync.flush(s)
    assert.equal(f.messages()[1].data.append, undefined); assert.equal(f.messages()[1].data.text, '原文继续', 'Every paged live snapshot retains its complete prefix')
    f.emit('item/completed', { turnId: 'auto', item: { id: 'item', type: 'agentMessage', text: '原文继续' } }); await f.sync.flush(s)
    assert.equal(f.messages().at(-1).data.append, undefined)
    f.thread = { ...f.thread, updatedAt: 2, turns: [native('auto', '原文继续', 'completed', 'item')] }
    s.dirty = true; await f.sync.requestSync(s)
    const count = f.messages().length
    s.dirty = true; await f.sync.requestSync(s)
    assert.equal(f.messages().length, count)
    const folded = [...savedReplies(f.session, 'thread').values()]
    assert.equal(folded.length, 1); assert.equal(folded[0].text, '原文继续'); assert.equal(folded[0].status, 'completed')
  } finally { await f.sync.close() }
})

test('restart folds persisted identities; 21 native items never collapse to the last local step', async () => {
  const f = fixture({ history: Array.from({ length: 21 }, (_, i) => native('turn' + i, '正文' + i)) })
  try {
    await f.start(); assert.equal(f.messages().length, 21)
    await f.sync.close()
    const sync = new NativeReplySync(f.ctx, f.helpers, { connect: async () => f.peer, owner: () => 'claude-code' })
    try { const s = sync.track(f.agent); await s.syncing; assert.equal(f.messages().length, 21) } finally { await sync.close() }
  } finally { await f.sync.close() }
})

test('normal active request is withheld until its own projector commits, without leaking history to new input', async () => {
  let requested = true
  const f = fixture({ history: [native('owned', 'answer')], requested: () => requested })
  try {
    const s = await f.start(); assert.equal(f.messages().length, 0)
    f.session.append('plugin:codexhost/thread', { ...mapping, hostTurnId: 'owned', localTurn: 1 })
    f.session.append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'answer' }] } }, { surfaceOp: 'append' })
    requested = false; await f.sync.flush(s); assert.equal(f.messages().length, 0)
    assert.equal(locallyCovered(f.session, 'other', 'answer'), false, 'A quote or another Turn is not a receipt')
  } finally { await f.sync.close() }
})

test('older in-flight read cannot overwrite newer live output', async () => {
  let block = false, pending
  const f = fixture({ request(method, params) { if (block && method === 'thread/turns/list') { pending = Promise.withResolvers(); return pending.promise } } })
  try {
    const s = await f.start()
    f.emit('item/started', { turnId: 'auto', item: { id: 'item', type: 'agentMessage', text: '前缀' } })
    block = true; s.dirty = true; const reading = f.sync.requestSync(s)
    while (!pending) await new Promise(resolve => setImmediate(resolve))
    f.emit('item/agentMessage/delta', { turnId: 'auto', itemId: 'item', delta: '新增' })
    pending.resolve({ data: [native('auto', '前缀', 'inProgress', 'item')], nextCursor: null })
    await reading; await f.sync.flush(s)
    assert.equal([...savedReplies(f.session, 'thread').values()][0].text, '前缀新增')
  } finally { await f.sync.close() }
})

test('missing start does not invent a prefix; authoritative read catches it up', async () => {
  const f = fixture()
  try {
    const s = await f.start()
    f.emit('item/agentMessage/delta', { turnId: 'auto', itemId: 'item', delta: '后半段' }); await f.sync.flush(s)
    assert.equal(f.messages().length, 0)
    f.thread.turns = [native('auto', '完整前后半段', 'completed', 'item')]
    s.dirty = true; await f.sync.requestSync(s)
    assert.equal(f.messages()[0].data.text, '完整前后半段')
  } finally { await f.sync.close() }
})

test('mapping fork, mismatched Session identity and ambiguous Thread owners remain isolated', async () => {
  for (const patch of [{ sessionId: 'parent' }, { harnessId: 'codex' }]) {
    const f = fixture({ history: [native('auto', 'secret')] })
    f.events[0].data = { ...mapping, ...patch }
    assert.equal(f.sync.track(f.agent), undefined); assert.equal(f.messages().length, 0); await f.sync.close()
  }
  const f = fixture()
  try {
    await f.start()
    const other = { id: 'b', session: { id: 'b', header: {}, snapshotEvents: () => [{ type: 'plugin:codexhost/thread', ignorable: true, data: { ...mapping, sessionId: 'b' } }] } }
    const s2 = f.sync.track(other); assert.equal(f.sync.valid(s2), false)
    f.emit('item/completed', { turnId: 'auto', item: { id: 'item', type: 'agentMessage', text: 'secret' } })
    assert.equal(f.messages().length, 0)
  } finally { await f.sync.close() }
})

test('late disposal of an old Agent object cannot untrack its replacement', async () => {
  const f = fixture()
  try { await f.start(); const replacement = { ...f.agent }; const state = f.sync.track(replacement); f.sync.untrack(f.agent); assert.equal(f.sync.states.get('a'), state) } finally { await f.sync.close() }
})

test('observer never answers tool/approval server requests or changes a Turn mapping', async () => {
  const f = fixture()
  try {
    const s = await f.start(), count = f.events.length
    f.sync.accept({ id: 'native-tool', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'auto', item: { type: 'agentMessage', id: 'fake', text: 'not a reply' } } })
    await f.sync.flush(s); assert.equal(f.events.length, count)
  } finally { await f.sync.close() }
})

test('bounded paginated reads retain multiple items and reject repeated cursors', async () => {
  let page = 0
  const peer = { request: async (method, params) => method === 'thread/read' ? { thread: { id: 't', historyMode: 'paginated' } } : { data: [native('turn' + (++page), 'reply')], nextCursor: page === 1 ? 'next' : null } }
  assert.equal((await readNativeReplies(peer, 't')).turns.length, 2)
  page = 0
  peer.request = async method => method === 'thread/read' ? { thread: { id: 't', historyMode: 'paginated' } } : { data: [native('turn' + (++page), 'reply')], nextCursor: 'loop' }
  await assert.rejects(readNativeReplies(peer, 't'), /repeats/)
  await assert.rejects(readNativeReplies({ request: async () => ({ thread: { id: 'other' } }) }, 't'), /identity mismatch/)
})

test('unchanged idle history uses a metadata check instead of replaying full history', async () => {
  const f = fixture({ history: [native('auto', 'reply')] })
  try { const s = await f.start(); f.calls.length = 0; await f.sync.requestSync(s); assert.ok(f.calls.every(c => c.params.includeTurns === false)); assert.equal(f.messages().length, 1) } finally { await f.sync.close() }
})

test('read may lead the event stream: a late included delta must not duplicate text', async () => {
  const f = fixture()
  try {
    const s = await f.start()
    f.emit('item/started', { turnId: 'auto', item: { id: 'item', type: 'agentMessage', text: 'a' } })
    f.thread.turns = [native('auto', 'ab', 'inProgress', 'item')]; f.thread.status.type = 'active'
    s.dirty = true; await f.sync.requestSync(s)
    f.emit('item/agentMessage/delta', { turnId: 'auto', itemId: 'item', delta: 'b' }); await f.sync.flush(s)
    assert.equal([...savedReplies(f.session, 'thread').values()][0].text, 'ab')
  } finally { await f.sync.close() }
})

test('observer close aborts an in-flight read even if transport ignores its signal', async () => {
  const started = Promise.withResolvers()
  const f = fixture({ request() { started.resolve(); return new Promise(() => {}) } })
  f.sync.track(f.agent); await started.promise
  await Promise.race([f.sync.close(), new Promise((_, reject) => setTimeout(() => reject(Error('shutdown blocked on read')), 200))])
  assert.equal(f.messages().length, 0)
})

test('coarse unchanged updatedAt cannot suppress a full catch-up indefinitely', async () => {
  const f = fixture()
  try {
    const s = await f.start(); await f.sync.requestSync(s)
    f.thread.turns = [native('missed', 'same second reply')]
    await f.sync.requestSync(s)
    assert.equal(f.messages()[0].data.text, 'same second reply')
  } finally { await f.sync.close() }
})

test('new input waits for native autonomous Turn, cancellation submits nothing', async () => {
  const listeners = new Set(); let active = true, reads = 0
  const peer = { request: async method => { assert.equal(method, 'thread/read'); reads++; return { thread: { id: 't', status: { type: active ? 'active' : 'idle' } } } }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  const controller = new AbortController(), waiting = waitForNativeIdle(peer, 't', controller.signal, 1000)
  await new Promise(resolve => setImmediate(resolve)); active = false
  for (const callback of [...listeners]) callback({ method: 'turn/completed', params: { threadId: 't' } })
  await waiting; assert.equal(reads, 2); assert.equal(listeners.size, 0)
  active = true
  const stopped = waitForNativeIdle(peer, 't', controller.signal, 1000)
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error('user cancelled'))
  await assert.rejects(stopped, /user cancelled/); assert.equal(listeners.size, 0)
})

test('long Session: later syncs fetch only the newest page, not the whole history', async () => {
  const history = Array.from({ length: 60 }, (_, i) => native('t' + i, 'reply ' + i))
  const f = fixture({ history })
  try {
    const s = await f.start()
    assert.equal(f.messages().length, 60, 'first run with nothing saved still catches up everything')
    f.calls.length = 0
    f.thread.turns = [...history, native('t60', 'new reply')]; f.thread.updatedAt = 2
    s.dirty = true; await f.sync.requestSync(s)
    const pages = f.calls.filter(c => c.method === 'thread/turns/list')
    assert.equal(pages.length, 1, 'stops at the first already-persisted Turn')
    assert.equal(pages[0].params.cursor, undefined)
    assert.equal(f.calls.some(c => c.params.includeTurns === true), false, 'never reads the full history frame')
    assert.equal(f.messages().at(-1).data.text, 'new reply')
    assert.equal(f.messages().length, 61)
  } finally { await f.sync.close() }
})

test('after restart persisted replies bound the catch-up; missed Turns are all recovered', async () => {
  const history = Array.from({ length: 40 }, (_, i) => native('t' + i, 'reply ' + i))
  const first = fixture({ history })
  await first.start(); await first.sync.close()
  // New process: same Session log, three Turns (one without any reply) happened meanwhile.
  const f = fixture({ history: [...history, native('m1', 'missed 1'), { id: 'tools', status: 'completed', items: [{ id: 'x', type: 'commandExecution' }] }, native('m2', 'missed 2')] })
  for (const e of first.events.filter(e => e.type === NATIVE_MESSAGE)) f.session.append(e.type, e.data)
  try {
    await f.start()
    const pages = f.calls.filter(c => c.method === 'thread/turns/list')
    assert.ok(pages.length <= 2, `paged ${pages.length} times`)
    assert.deepEqual(f.messages().slice(-2).map(m => m.data.text), ['missed 1', 'missed 2'])
  } finally { await f.sync.close() }
})

test('a Turn already shown by its local DSH Turn also bounds the catch-up', async () => {
  const history = Array.from({ length: 30 }, (_, i) => native('t' + i, 'reply ' + i))
  const f = fixture({ history: [...history, native('owned', 'shown locally'), native('after', 'autonomous')] })
  f.session.append('plugin:codexhost/thread', { ...mapping, phase: 'ready', localTurn: 7, hostTurnId: 'owned' })
  f.session.append('assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'shown locally' }] } }, { surfaceOp: 'append' })
  try {
    await f.start()
    assert.equal(f.calls.filter(c => c.method === 'thread/turns/list').length, 1)
    assert.deepEqual(f.messages().map(m => m.data.text), ['autonomous'])
  } finally { await f.sync.close() }
})

test('an in-progress newest Turn is never treated as covered', async () => {
  const f = fixture({ history: [native('t0', 'old'), native('live', 'partial', 'inProgress', 'li')] })
  try {
    const s = await f.start()
    f.thread.turns = [native('t0', 'old'), native('live', 'partial more', 'inProgress', 'li')]; f.thread.status.type = 'active'
    s.dirty = true; await f.sync.requestSync(s); await f.sync.flush(s)
    assert.equal([...savedReplies(f.session, 'thread').values()].find(r => r.hostTurnId === 'live').text, 'partial more')
  } finally { await f.sync.close() }
})

test('an oversized backlog keeps the newest Turns instead of failing the read', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024)
  const turns = Array.from({ length: 10 }, (_, i) => native('b' + i, big + i))
  const peer = { request: async (method, params) => method === 'thread/read' ? { thread: { id: 't', status: { type: 'idle' } } }
    : (() => { const ordered = [...turns].reverse(), start = Number(params.cursor ?? 0), end = start + params.limit; return { data: ordered.slice(start, end), nextCursor: end < ordered.length ? String(end) : null } })() }
  const result = await readNativeReplies(peer, 't')
  assert.equal(result.truncated, true)
  assert.equal(result.turns.at(-1).id, 'b9', 'newest Turn kept, oldest-first order')
  assert.ok(result.turns.length < 10)
})

test('a freshly imported Session catches up only past the import watermark', async () => {
  const history = Array.from({ length: 30 }, (_, i) => native('p' + String(i).padStart(2, '0'), 'reply ' + i))
  const f = fixture({ history })
  // historySeed records the newest imported Turn; everything at or before it is already in the Session.
  f.session.append('plugin:codexhost/import', { version: 1, harnessId: 'claude-code', threadId: 'thread', importedAt: 1, turns: 28, newestTurnId: 'p27' })
  try {
    await f.start()
    assert.deepEqual(f.messages().map(m => m.data.hostTurnId), ['p28', 'p29'], 'only Turns newer than the import are synced')
    assert.equal(f.calls.filter(c => c.method === 'thread/turns/list').length, 1, 'one page; no walk through the imported history')
  } finally { await f.sync.close() }
})

test('without an import watermark the first sync still pages through the history, as before', async () => {
  const history = Array.from({ length: 12 }, (_, i) => native('q' + String(i).padStart(2, '0'), 'reply ' + i))
  const f = fixture({ history })
  try {
    await f.start()
    assert.equal(f.messages().length, 12)
    assert.ok(f.calls.filter(c => c.method === 'thread/turns/list').length > 1)
  } finally { await f.sync.close() }
})
