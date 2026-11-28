import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver, nativeThreadState } from '../native-session-driver.mjs'
import { nativeRemoteDescriptors } from '../remote-contract.mjs'
import { HostConnectionError } from '../native-host-client.mjs'
import { BUSY_START_MESSAGE, rejectedStartEvidence, inspectRejectedStart } from '../rejected-start.mjs'

const pending = { version: 1, sessionId: 'session-a', phase: 'submitted', harnessId: 'codex', threadId: 'thread-a', hostTurnId: 'turn-a', localTurn: 1 }
function setup(mapping = pending, options = {}) {
  const events = [], calls = [], listeners = new Set()
  const session = { id: 'session-a', header: { cwd: 'D:/work' }, snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  if (mapping) session.append('plugin:dsh-host/thread', { ...mapping })
  let thread = { id: 'thread-a', updatedAt: 123, status: { type: 'idle' }, turns: [{ id: 'turn-a', status: 'completed' }] }
  const peer = { closed: new Promise(() => {}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, close() {}, async request(method, params) {
    calls.push({ method, params })
    if (options.request) { const result = await options.request(method, params, session); if (result !== undefined) return result }
    if (method === 'thread/read') return { thread }
    if (method === 'thread/turns/list') return { data: thread.turns.slice(-1), nextCursor: null }
    if (method === 'model/list') return { data: [{ model: 'test-model', isDefault: true, supportedReasoningEfforts: [] }] }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-a' } }
    if (method === 'turn/start') throw new Error('simulated remote rejection')
    if (method === 'codexhost/thread/usage/inspect') return {}
    throw new Error('unexpected method: ' + method)
  } }
  const helpers = { appendPluginRecord: (s, name, data) => s.append(name, data), agentEvents: () => ({ emit() {} }), AssistantStreamAccumulator: class { push(x) { return x } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } } }
  const ctx = { agentPresets: { presetForSession: () => options.preset ?? 'dsh-host-codex' }, sessionPersistence: { async flush() { await options.flush?.(session) } } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, cancelTimeoutMs: 1, turnTimeoutMs: 1000 })
  const agent = { id: session.id, session, async runMaintenance(fn) { return fn() } }
  return { driver, agent, session, calls, events, set thread(value) { thread = value }, get thread() { return thread } }
}

test('outcome check reads the exact terminal Turn; explicit commit only unlocks and records audit', async () => {
  const f = setup(), original = JSON.stringify(nativeThreadState(f.session))
  const result = await f.driver.recovery(f.agent)
  assert.equal(result.status, 'recoverable'); assert.equal(result.outcome, 'completed')
  assert.equal(JSON.stringify(nativeThreadState(f.session)), original, 'checking never mutates mapping')
  const confirmed = await f.driver.reconcile(f.agent, { expected: result.expected, acknowledgeStopped: true })
  assert.equal(confirmed.status, 'recovered')
  assert.equal(nativeThreadState(f.session).phase, 'ready')
  assert.equal(nativeThreadState(f.session).lastHostTurnId, 'turn-a')
  assert.ok(f.events.some(e => e.type === 'plugin:dsh-host/reconciled' && e.data.historyReplayed === false))
  assert.ok(f.calls.every(c => ['thread/read', 'thread/turns/list'].includes(c.method)), 'no resume, interrupt, replay or model request')
  assert.equal(f.calls.some(c => c.params?.includeTurns === true), false, 'legacy Threads no longer pull the full history either')
})

for (const mode of ['paginated', 'legacy']) test(mode + ' history uses only the last Turn with a bounded read', async () => {
  const f = setup(); f.thread = { ...f.thread, historyMode: mode }
  assert.equal((await f.driver.recovery(f.agent)).status, 'recoverable')
  const read = f.calls.find(c => c.method === 'thread/turns/list')
  assert.equal(read.params.limit, 1); assert.equal(read.params.sortDirection, 'desc')
  assert.equal(f.calls.some(c => c.method === 'thread/read' && c.params.includeTurns === true), false)
})

for (const outcome of ['failed', 'interrupted']) test(`confirmed ${outcome} is an ended task, not a successful reply or a reason to replay`, async () => {
  const f = setup(); f.thread.turns[0].status = outcome
  const result = await f.driver.recovery(f.agent)
  assert.equal(result.status, 'recoverable'); assert.equal(result.outcome, outcome)
})

test('missing identities, unexpected latest Turn and unknown states remain blocked', async () => {
  for (const state of [{ ...pending, phase: 'creating', threadId: undefined, hostTurnId: undefined }, { ...pending, hostTurnId: undefined }]) {
    const f = setup(state)
    assert.equal((await f.driver.recovery(f.agent)).reason, 'identity-missing')
    assert.equal(f.calls.length, 0)
  }
  const f = setup(); f.thread.turns.push({ id: 'other-turn', status: 'completed' })
  assert.equal((await f.driver.recovery(f.agent)).reason, 'turn-missing')
  f.thread.turns = [{ id: 'turn-a', status: 'unknown' }]
  assert.equal((await f.driver.recovery(f.agent)).reason, 'status-unknown')
})

test('active native task remains protected, even if a previous Turn ended', async () => {
  const f = setup(); f.thread.status.type = 'active'
  assert.equal((await f.driver.recovery(f.agent)).status, 'running')
  assert.equal(f.calls.length, 1)
  assert.equal(nativeThreadState(f.session).phase, 'submitted')
})

test('changed native history during inspection cannot be unlocked', async () => {
  let reads = 0
  const f = setup(pending, { request(method) { if (method === 'thread/read' && ++reads === 2) return { thread: { id: 'thread-a', status: { type: 'idle' }, updatedAt: 999 } } } })
  assert.equal((await f.driver.recovery(f.agent)).reason, 'history-changed')
})

test('confirmation rechecks remote state, rejects stale revisions and missing acknowledgement', async () => {
  const f = setup(), result = await f.driver.recovery(f.agent)
  await assert.rejects(f.driver.reconcile(f.agent, { expected: result.expected, acknowledgeStopped: false }), /explicitly acknowledge/)
  f.thread.status.type = 'active'
  await assert.rejects(f.driver.reconcile(f.agent, { expected: result.expected, acknowledgeStopped: true }), /not confirmed/)
  f.thread.status.type = 'idle'
  f.session.append('plugin:dsh-host/thread', { ...pending, localTurn: 2 })
  await assert.rejects(f.driver.reconcile(f.agent, { expected: result.expected, acknowledgeStopped: true }), /conversation changed/)
  assert.equal(nativeThreadState(f.session).phase, 'submitted')
})

test('fork ownership and disconnected checks cannot reset a mapping', async () => {
  const fork = setup({ ...pending, sessionId: 'parent-session' })
  await assert.rejects(fork.driver.recovery(fork.agent), /fork/)
  assert.equal(fork.calls.length, 0)
  const disconnected = setup(pending, { request() { throw new Error('disconnected') } })
  await assert.rejects(disconnected.driver.recovery(disconnected.agent), /disconnected/)
  assert.equal(nativeThreadState(disconnected.session).phase, 'submitted')
})

const message = { content: [{ type: 'text', text: 'test' }], source: { kind: 'user' } }
test('cancellation during durable creation but before dispatch stays safely retryable', async () => {
  const controller = new AbortController()
  let cancel = true
  const f = setup(null, { flush(session) { if (cancel && nativeThreadState(session)?.phase === 'creating') { cancel = false; controller.abort() } } })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 1, step: 1, signal: controller.signal }))
  assert.equal(nativeThreadState(f.session).notDispatched, true)
  assert.equal(f.calls.some(c => c.method === 'thread/start'), false)
  assert.equal((await f.driver.recovery(f.agent)).reason, 'not-sent')
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }), /simulated remote rejection/)
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1)
})

test('cancellation after submitted intent but before turn/start restores ready without replay', async () => {
  const controller = new AbortController()
  const f = setup({ ...pending, phase: 'ready', hostTurnId: undefined }, { flush(session) { if (nativeThreadState(session)?.phase === 'submitted') controller.abort() } })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: controller.signal }))
  assert.equal(nativeThreadState(f.session).phase, 'ready')
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false)
})

test('failure after dispatch without a confirmed Turn identity never auto-unlocks', async () => {
  const f = setup({ ...pending, phase: 'ready', hostTurnId: undefined })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }), /simulated remote rejection/)
  assert.equal(nativeThreadState(f.session).phase, 'submitted')
  assert.equal((await f.driver.recovery(f.agent)).reason, 'identity-missing')
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
})

test('explicit Host busy rejection restores ready without retrying the rejected input', async () => {
  const f = setup({ ...pending, phase: 'ready', hostTurnId: undefined }, { request(method) {
    if (method === 'turn/start') throw new HostConnectionError(-32072, BUSY_START_MESSAGE)
  } })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }), /active Turn/)
  assert.equal(nativeThreadState(f.session).phase, 'ready')
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
})

for (const error of [new HostConnectionError('HOST_REQUEST_TIMEOUT', BUSY_START_MESSAGE), new HostConnectionError(-32072, 'different denial'), new Error(BUSY_START_MESSAGE)]) {
  test(`unconfirmed error stays pending: ${error.code ?? error.name} ${error.message}`, async () => {
    const f = setup({ ...pending, phase: 'ready', hostTurnId: undefined }, { request(method) { if (method === 'turn/start') throw error } })
    await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }))
    assert.equal(nativeThreadState(f.session).phase, 'submitted')
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  })
}

test('busy-looking error after obtaining a Turn identity does not unlock it', async () => {
  const f = setup({ ...pending, phase: 'ready', hostTurnId: undefined }, {
    request(method) { if (method === 'turn/start') return { turn: { id: 'accepted-turn' } } },
    flush(session) { if (nativeThreadState(session)?.hostTurnId === 'accepted-turn') throw new HostConnectionError(-32072, BUSY_START_MESSAGE) },
  })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }))
  assert.equal(nativeThreadState(f.session).phase, 'submitted')
  assert.equal(nativeThreadState(f.session).hostTurnId, 'accepted-turn')
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
})

function legacyBusy() {
  const f = setup({ ...pending, harnessId: 'claude-code', hostTurnId: undefined, lastHostTurnId: 'turn-a' })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: BUSY_START_MESSAGE } } })
  return f
}

test('legacy busy evidence is bound to the exact own mapping and ended local Turn', () => {
  const f = legacyBusy(), state = nativeThreadState(f.session)
  assert.deepEqual(rejectedStartEvidence(f.session, state), { mappingSeq: 0, errorSeq: 1, localTurn: 1 })
  for (const patch of [{ sessionId: 'other' }, { localTurn: 2 }, { hostTurnId: 'unknown' }, { harnessId: 'codex' }, { lastHostTurnId: undefined }]) {
    assert.equal(rejectedStartEvidence(f.session, { ...state, ...patch }), undefined)
  }
  f.events[1].data.reason.error.message = 'disconnected'
  assert.equal(rejectedStartEvidence(f.session, state), undefined)
})

test('legacy rejected start only clears after stable idle terminal history with the previous anchor', async () => {
  const f = legacyBusy(), state = nativeThreadState(f.session)
  const peer = { request: async (method, params) => { f.calls.push({ method, params }); return { thread: f.thread } } }
  assert.equal((await inspectRejectedStart(peer, state)).latestOutcome, 'completed')
  assert.equal(nativeThreadState(f.session).phase, 'submitted', 'read-only inspection does not mutate')
  assert.ok(f.calls.every(c => c.method === 'thread/read'))
  for (const thread of [
    { ...f.thread, id: 'other' }, { ...f.thread, status: { type: 'active' } },
    { ...f.thread, updatedAt: undefined }, { ...f.thread, historyMode: 'paginated' },
    { ...f.thread, turns: [] }, { ...f.thread, turns: [{ id: 'other', status: 'completed' }] },
    { ...f.thread, turns: [{ id: 'turn-a', status: 'inProgress' }] },
  ]) {
    assert.equal(await inspectRejectedStart({ request: async () => ({ thread }) }, state), undefined)
  }
  let n = 0
  assert.equal(await inspectRejectedStart({ request: async () => ({ thread: { ...f.thread, updatedAt: ++n } }) }, state), undefined)
})

test('legacy busy recovery on new input audits rejection and submits only the new input once', async () => {
  const f = setup({ ...pending, harnessId: 'claude-code', hostTurnId: undefined, lastHostTurnId: 'turn-a',
    appliedConfiguration: { modelId: 'test-model', permissionModeId: 'bypassPermissions' } }, {
    preset: 'dsh-host-claude-code', request(method) {
      if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test-model' }, label: 'Opus' }] }, permissionModes: { modes: [{ id: 'bypassPermissions' }] } }
    },
  })
  f.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: BUSY_START_MESSAGE } } })
  await assert.rejects(f.driver.run({ agent: f.agent, messages: [message], turn: 2, step: 1, signal: new AbortController().signal }), /simulated remote rejection/)
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  assert.equal(f.calls.find(c => c.method === 'turn/start').params.input[0].text, 'test')
  const audit = f.events.find(e => e.type === 'plugin:dsh-host/reconciled')
  assert.equal(audit.data.outcome, 'rejected-before-start')
  assert.equal(audit.data.historyReplayed, false)
})

test('recovery contract requires Session-authorized lookup and exact confirmation fields', () => {
  const endpoint = nativeRemoteDescriptors.find(d => d.method === 'reconcile')
  assert.equal(endpoint.parameters[0].lookup, 'agent')
  const parse = endpoint.parameters[1].codec.create().parse
  assert.doesNotThrow(() => parse({ expected: 'a'.repeat(64), acknowledgeStopped: true }))
  for (const invalid of [{ expected: 'a'.repeat(64) }, { expected: 'a'.repeat(64), acknowledgeStopped: true, threadId: 'other' }, { expected: 'invalid', acknowledgeStopped: true }]) assert.throws(() => parse(invalid))
})
