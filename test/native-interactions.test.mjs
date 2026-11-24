import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { NativeInteractionBridge, nativeInteraction, nativeQuestionAnswer } from '../native-interactions.mjs'
import { NativeSessionDriver, nativeThreadState } from '../native-session-driver.mjs'

const deferred = () => Promise.withResolvers()
const request = (method = 'item/commandExecution/requestApproval', extra = {}, id = 1) => ({ id, method, params: { threadId: 'thread', turnId: 'turn', ...extra } })
const question = extra => request('item/tool/requestUserInput', { questions: [{ id: 'q', question: '如何处理？', options: [{ label: '保留' }, { label: '替换' }], isOther: true, ...extra }] })
function fixture(options = {}) {
  const events = options.events ?? [{ type: 'approval/policy', data: { policy: options.policy ?? 'ask' } }], replies = [], errors = [], asks = [], approvals = [], waiters = []
  const asked = deferred(), failed = deferred(), abort = new AbortController()
  const session = { id: 'local', header: { cwd: 'D:/test', origin: options.origin }, snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length + 1, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  const agent = { id: session.id, session }
  const globalPolicy = { policy: 'never' }
  const approval = { async request(value) {
    approvals.push(value); asked.resolve(value)
    const policy = events.findLast(event => event.type === 'approval/policy')?.data.policy ?? globalPolicy.policy
    if (policy === 'never') return 'rejected'
    if (!options.approve) return options.outcome ?? 'allowed-once'
    // Mirror the real ApprovalService's guaranteed cancellation settlement.
    if (value.signal.aborted) return 'cancelled'
    return await new Promise((resolve, reject) => {
      const cancel = () => { value.signal.removeEventListener('abort', cancel); resolve('cancelled') }
      value.signal.addEventListener('abort', cancel, { once: true })
      Promise.resolve(options.approve(value)).then(outcome => { value.signal.removeEventListener('abort', cancel); resolve(outcome) }, error => { value.signal.removeEventListener('abort', cancel); reject(error) })
    })
  } }
  const userQuestions = { async ask(value) { asks.push(value); asked.resolve(value); return options.answer ? options.answer(value) : { answers: value.questions.map(item => ({ id: item.id, selected: ['保留'] })) } } }
  const services = {
    approval: options.noApproval ? undefined : approval,
    userQuestions: options.noQuestions ? undefined : userQuestions,
    ...(options.subagents ? { subagents: options.subagents } : {}),
    ...(options.agents ? { agents: options.agents } : {}),
  }
  const ctx = { get: key => services[key], sessionPersistence: { async flush() { await options.flush?.() } } }
  const helpers = { appendPluginRecord: (s, type, data) => s.append(type, data) }
  const peer = { async respond(id, result) {
    replies.push({ id, result }); for (const waiter of waiters) if (replies.length >= waiter.n) waiter.resolve()
    if (options.writeError) throw options.writeError
  } }
  const waitStates = []
  const bridge = new NativeInteractionBridge({ ctx, agent, peer, helpers, threadId: 'thread', turnId: () => 'turn', turn: 1, signal: abort.signal,
    permissionModeId: options.permission ?? 'plan', enableApprovalPrompts: options.enablePrompts === true,
    onError(error) { errors.push(error); failed.resolve(error) },
    onWaitingChange(waiting) { waitStates.push(waiting); options.onWaitingChange?.(waiting) },
  })
  return { bridge, events, replies, errors, asks, approvals, waitStates, asked: asked.promise, failed: failed.promise, abort, agent, ctx, helpers, globalPolicy,
    written(n = 1) { if (replies.length >= n) return Promise.resolve(); const wait = deferred(); waiters.push({ n, resolve: wait.resolve }); return wait.promise },
  }
}

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
  test(`${method} reuses DSH approval and responds only once with the exact one-time native result`, async () => {
    const human = deferred(), f = fixture({ approve: () => human.promise })
    const message = request(method, { command: 'test-only', cwd: 'D:/test', reason: 'review this exact operation' })
    f.bridge.accept(message); f.bridge.accept(message)
    const ask = await f.asked
    assert.equal(f.replies.length, 0); assert.equal(ask.agent, f.agent); assert.match(ask.reason, /test-only/)
    human.resolve('allowed-once'); await f.written(); await f.bridge.close()
    assert.equal(f.approvals.length, 1); assert.deepEqual(f.replies, [{ id: 1, result: { decision: 'accept' } }])
    assert.ok(f.events.some(event => event.data.phase === 'written'))
  })
}
for (const outcome of ['rejected', 'cancelled', 'unavailable', 'invented']) {
  test(`DSH approval outcome ${outcome} never becomes a native grant`, async () => {
    const f = fixture({ outcome }); f.bridge.accept(request()); await f.written(); await f.bridge.close()
    assert.deepEqual(f.replies[0].result, { decision: 'decline' })
  })
}

test('approval attaches only to the exact already-advertised native tool call', async () => {
  const f = fixture()
  f.events.push({ type: 'tool/call', data: { callId: 'codexhost:1:item-a' } })
  f.bridge.accept(request(undefined, { itemId: 'item-a' }))
  const ask = await f.asked; assert.equal(ask.callId, 'codexhost:1:item-a')
  await f.written(); await f.bridge.close()
})

test('cancelling an approval waits for the service outcome before closing the bridge', async () => {
  const f = fixture({ approve: () => new Promise(() => {}) })
  f.bridge.accept(request()); const ask = await f.asked
  f.abort.abort(); await f.bridge.close()
  assert.equal(ask.signal.aborted, true); assert.equal(f.replies.length, 0)
  assert.equal(f.events.findLast(event => event.data.phase === 'decision').data.outcome, 'cancelled')
})

test('missing approval provider fails closed without changing a policy', async () => {
  const f = fixture({ noApproval: true, policy: 'never', enablePrompts: true })
  f.bridge.accept(request()); await f.written(); await f.bridge.close()
  assert.deepEqual(f.replies[0].result, { decision: 'decline' }); assert.equal(f.events.filter(e => e.type === 'approval/policy').length, 1)
})

test('explicit opt-in enables ask only for this non-full external session, not the global default', async () => {
  const f = fixture({ policy: 'never', enablePrompts: true })
  f.bridge.accept(request()); await f.written()
  assert.equal(f.events.findLast(e => e.type === 'approval/policy').data.policy, 'ask')
  assert.equal(f.globalPolicy.policy, 'never'); assert.deepEqual(f.replies[0].result, { decision: 'accept' })
  // A later explicit never wins; the bridge must not keep undoing it.
  f.agent.session.append('approval/policy', { policy: 'never' })
  f.bridge.accept(request(undefined, {}, 2)); await f.written(2); await f.bridge.close()
  assert.deepEqual(f.replies[1].result, { decision: 'decline' })
})
for (const options of [{ enablePrompts: false }, { enablePrompts: true, permission: 'bypassPermissions' }, { enablePrompts: true, permission: 'full-access' }, { enablePrompts: true, origin: 'subagent' }]) {
  test(`never is preserved without non-full root opt-in: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ policy: 'never', ...options }); f.bridge.accept(request()); await f.written(); await f.bridge.close()
    assert.deepEqual(f.replies[0].result, { decision: 'decline' }); assert.equal(f.events.findLast(e => e.type === 'approval/policy').data.policy, 'never')
  })
}

test('DSH question service receives native choices and its human answer is translated, not resubmitted as a new turn', async () => {
  const human = deferred(), f = fixture({ answer: () => human.promise })
  f.bridge.accept(question({ multiSelect: true }))
  const ask = await f.asked
  assert.equal(ask.agent, f.agent); assert.equal(ask.questions[0].multiSelect, true); assert.equal(f.replies.length, 0)
  human.resolve({ answers: [{ id: 'q', selected: ['保留'], custom: '补充说明' }] })
  await f.written(); await f.bridge.close()
  assert.deepEqual(f.replies[0].result, { answers: { q: { answers: ['保留', '补充说明'] } } })
  assert.ok(f.events.every(e => e.type !== 'user/message'))
})

test('skipping a required question cancels the native batch; optional empty answers stay empty', () => {
  const skipped = { answers: [{ id: 'q', selected: [] }] }
  assert.deepEqual(nativeQuestionAnswer(nativeInteraction(question()), skipped), { answers: {} })
  assert.deepEqual(nativeQuestionAnswer(nativeInteraction(question({ isOptional: true })), skipped), { answers: { q: { answers: [] } } })
})
for (const answer of [{ answers: [] }, { answers: [{ id: 'foreign', selected: ['保留'] }] }, { answers: [{ id: 'q', selected: ['invented'] }] }, { answers: [{ id: 'q', selected: ['保留', '替换'] }] }]) {
  test(`malformed or ambiguous human answer is rejected: ${JSON.stringify(answer)}`, () => {
    assert.throws(() => nativeQuestionAnswer(nativeInteraction(question()), answer), /answer|question/i)
  })
}

test('custom answers are not allowed when the native question disallows Other', () => {
  assert.throws(() => nativeQuestionAnswer(nativeInteraction(question({ isOther: false })), { answers: [{ id: 'q', selected: [], custom: 'unoffered' }] }), /custom/)
})

test('secret, duplicate, URL and unreviewed native interactions fail closed before a UI call', () => {
  assert.throws(() => nativeInteraction(question({ isSecret: true })), /Secret/)
  const duplicate = question(); duplicate.params.questions.push(duplicate.params.questions[0]); assert.throws(() => nativeInteraction(duplicate), /unique/)
  assert.throws(() => nativeInteraction(request('mcpServer/elicitation/request', { mode: 'url', url: 'https://invalid.test' })), /not a reviewed/)
  assert.throws(() => nativeInteraction(request('unknown/request')), /not connected/)
  assert.throws(() => nativeInteraction(request(undefined, { command: 'x'.repeat(40000) })), /display budget/)
})

for (const how of ['abort', 'resolve', 'close']) test(`${how} removes the pending question and discards a late human answer`, async () => {
  const human = deferred(), f = fixture({ answer: () => human.promise }); f.bridge.accept(question()); const ask = await f.asked
  if (how === 'abort') f.abort.abort()
  else if (how === 'resolve') f.bridge.resolve(1)
  else f.bridge.cancel()
  human.resolve({ answers: [{ id: 'q', selected: ['保留'] }] })
  await f.bridge.close(); assert.equal(ask.signal.aborted, true); assert.equal(f.replies.length, 0); assert.equal(f.errors.length, 0)
})

test('expired native question withdraws the UI and replies with cancellation, never a guessed default', async () => {
  const f = fixture({ answer: () => new Promise(() => {}) }), message = question(); message.params.autoResolutionMs = 0
  f.bridge.accept(message); const ask = await f.asked; await f.written(); await f.bridge.close()
  assert.equal(ask.signal.aborted, true); assert.deepEqual(f.replies[0].result, { answers: {} })
})

test('a failed or uncertain reply write is never replayed', async () => {
  const f = fixture({ writeError: new Error('uncertain write') }), message = request()
  f.bridge.accept(message); await f.failed; f.bridge.accept(message); await f.bridge.close()
  assert.equal(f.replies.length, 1)
})

test('a failed durable decision prevents a grant write', async () => {
  let flushes = 0
  const f = fixture({ flush: () => { if (++flushes === 2) throw new Error('decision persistence failed') } })
  f.bridge.accept(request()); await f.failed; await f.bridge.close(); assert.equal(f.replies.length, 0)
})

test('request identity and exact thread/turn ownership cannot be changed or reused', async () => {
  const f = fixture({ approve: () => new Promise(() => {}) }), message = request()
  assert.throws(() => f.bridge.accept(request(undefined, { threadId: 'another' })), /another thread/)
  assert.throws(() => f.bridge.accept(request(undefined, { turnId: 'another' })), /another thread/)
  f.bridge.accept(message); await f.asked
  assert.throws(() => f.bridge.accept(request(undefined, { command: 'different' })), /reused/)
  await f.bridge.close(); assert.equal(f.replies.length, 0)
})

const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')
const start = runtime.indexOf('function isRecord7('), end = runtime.indexOf('function projectCodexThreadUsage(', start)
const projections = vm.runInNewContext(runtime.slice(start, end) + '\n;({projectCodexApprovalRequest,projectCodexQuestionRequest})', { TITLE_MAX_LENGTH: 150, DESCRIPTION_MAX_LENGTH: 500, SERVER_NAME_MAX_LENGTH: 80, ELLIPSIS: '…' })

test('actual shipped Claude approval projection preserves complete scope and round-trips only allowOnce', async () => {
  const interaction = { interactionId: 'native-approval', turnId: 'turn', title: 'T'.repeat(300), description: 'D'.repeat(900), subject: { type: 'nativeAction', command: 'offline-test-only' }, actions: [
    { id: 'once', label: 'Allow once', effect: 'allowOnce' }, { id: 'session', label: 'Allow session', effect: 'allowForSession' }, { id: 'always', label: 'Always', effect: 'allowAlways' }, { id: 'deny', label: 'Deny', effect: 'deny' },
  ] }
  const projected = projections.projectCodexApprovalRequest({ threadId: 'thread', serverName: 'Claude Code', interaction })
  const f = fixture(); f.bridge.accept({ id: -123, ...JSON.parse(JSON.stringify(projected.request)) }); await f.written(); await f.bridge.close()
  assert.ok(f.approvals[0].reason.includes(interaction.description))
  const result = projected.parseResponse(f.replies[0].result)
  assert.equal(result.actionId, 'once'); assert.equal(f.replies[0].result._meta, undefined)
})

test('actual shipped Claude question projection preserves multiple/optional flags and round-trips selected labels to native values', async () => {
  const interaction = { turnId: 'turn', questions: [
    { id: 'q', type: 'choice', prompt: '选择方案', multiple: true, optional: false, allowOther: true, options: [{ label: '保留', value: 'keep' }, { label: '替换', value: 'replace' }] },
    { id: 'note', type: 'text', prompt: '补充信息', secret: false, optional: true },
  ] }
  const projected = projections.projectCodexQuestionRequest({ threadId: 'thread', itemId: 'item', interaction })
  assert.equal(projected.request.params.questions[0].multiSelect, true); assert.equal(projected.request.params.questions[1].isOptional, true)
  const f = fixture({ answer: async () => ({ answers: [{ id: 'q', selected: ['保留', '替换'] }, { id: 'note', selected: [] }] }) })
  f.bridge.accept({ id: -124, ...JSON.parse(JSON.stringify(projected.request)) }); await f.written(); await f.bridge.close()
  const result = projected.parseResponse(f.replies[0].result)
  assert.deepEqual(Array.from(result.answers.q), ['keep', 'replace']); assert.deepEqual(Array.from(result.answers.note), [])
})

for (const harness of ['codex', 'claude-code']) test(`actual ${harness} driver pauses for a native interaction, writes the answer, and completes the same native Turn`, async () => {
  const events = [], calls = [], listeners = new Set(), human = deferred(), seen = deferred()
  const session = { id: 'local', header: { cwd: 'D:/test' }, snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  session.append('plugin:codexhost/thread', { version: 1, sessionId: 'local', phase: 'ready', harnessId: harness, threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: harness === 'codex' ? 'workspace-write' : 'plan' } })
  session.append('plugin:codexhost/configuration', { harnessId: harness, modelId: 'test', permissionModeId: harness === 'codex' ? 'workspace-write' : 'plan' })
  const emit = value => { for (const listener of listeners) listener(value) }
  const message = harness === 'codex' ? request() : question()
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    calls.push(method)
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'codexhost/thread/usage/inspect') return {}
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'turn/start') { queueMicrotask(() => emit(message)); return { turn: { id: 'turn' } } }
    throw new Error(method)
  }, async respond(id, result) { calls.push('respond'); assert.equal(id, 1); if (harness === 'codex') assert.equal(result.decision, 'accept'); else assert.deepEqual(result, { answers: { q: { answers: ['保留'] } } }); queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } })) } }
  const services = { approval: { async request() { seen.resolve(); return human.promise } }, userQuestions: { async ask() { seen.resolve(); return human.promise } } }
  const ctx = { get: key => services[key], agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} } }
  const helpers = { appendPluginRecord: (s, type, data) => s.append(type, data), agentEvents: () => ({ emit() {} }), AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000, cancelTimeoutMs: 10, nativeInteractionApprovals: true })
  const agent = { id: 'local', session }, signal = new AbortController().signal
  try {
    const running = driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'test only' }] }], turn: 1, step: 1, signal })
    await seen.promise; assert.equal(calls.includes('respond'), false); assert.equal(nativeThreadState(session).phase, 'submitted')
    human.resolve(harness === 'codex' ? 'allowed-once' : { answers: [{ id: 'q', selected: ['保留'] }] })
    await running; assert.equal(nativeThreadState(session).phase, 'ready')
    assert.equal(calls.filter(method => method === 'turn/start').length, 1); assert.equal(calls.filter(method => method === 'respond').length, 1); assert.equal(calls.includes('turn/interrupt'), false)
  } finally { await driver.dispose() }
})

test('subagent question escalates to the live root agent with subagent identity and waits for human reply', async () => {
  const human = deferred()
  const rootEvents = [{ type: 'approval/policy', data: { policy: 'ask' } }]
  const root = { id: 'root-session', session: { id: 'root-session', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
  const f = fixture({
    origin: 'subagent',
    policy: 'never',
    answer: () => human.promise,
    subagents: { rootOf: () => root, namesOf: () => ({ self: 'worker-1', parent: 'lead' }) },
    agents: { get: id => (id === root.id ? root : undefined) },
  })
  f.bridge.accept(question({ header: '部署方式' }))
  const ask = await f.asked
  assert.equal(ask.agent, root)
  assert.equal(ask.questions[0].header, '子代理 worker-1 · 部署方式')
  assert.equal(f.replies.length, 0)
  assert.deepEqual(f.waitStates, [true])
  human.resolve({ answers: [{ id: 'q', selected: ['替换'] }] })
  await f.written(); await f.bridge.close()
  assert.deepEqual(f.replies[0].result, { answers: { q: { answers: ['替换'] } } })
  assert.equal(f.events.findLast(e => e.data.phase === 'decision').data.delegatedTo, 'root-session')
  assert.deepEqual(f.waitStates, [true, false])
})

test('subagent approval escalates to live root via approval-intent question card and grants only on exact one-time match', async () => {
  const human = deferred()
  const rootEvents = [{ type: 'approval/policy', data: { policy: 'ask' } }]
  const root = { id: 'root-session', session: { id: 'root-session', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
  const f = fixture({
    origin: 'subagent',
    policy: 'never',
    permission: 'workspace-write',
    enablePrompts: true,
    answer: () => human.promise,
    subagents: { rootOf: () => root, namesOf: () => ({ self: 'executor-1', parent: 'lead' }) },
    agents: { get: id => (id === root.id ? root : undefined) },
  })
  f.bridge.accept(request('item/commandExecution/requestApproval', { command: 'npm test', cwd: 'D:/test' }))
  const ask = await f.asked
  assert.equal(ask.agent, root)
  assert.equal(ask.questions.length, 1)
  const item = ask.questions[0]
  assert.equal(item.intent.kind, 'approval')
  assert.equal(item.intent.always, undefined)
  assert.equal(item.multiSelect, false)
  assert.match(item.detail, /npm test/)
  assert.deepEqual(item.options.map(o => o.label), [item.intent.approve, item.intent.reject])
  assert.equal(f.replies.length, 0)
  assert.deepEqual(f.waitStates, [true])
  human.resolve({ answers: [{ id: item.id, selected: [item.intent.approve] }] })
  await f.written(); await f.bridge.close()
  assert.deepEqual(f.replies[0].result, { decision: 'accept' })
  assert.equal(f.events.findLast(e => e.type === 'approval/policy').data.policy, 'never')
  assert.equal(f.events.findLast(e => e.data.phase === 'decision').data.delegatedTo, 'root-session')
  assert.deepEqual(f.waitStates, [true, false])
})

test('subagent approval still escalates when root is in danger-full-access preset with approval/policy never', async () => {
  const rootEvents = [
    { type: 'permission/preset', data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'never' } },
  ]
  const root = { id: 'root-full', session: { id: 'root-full', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
  const f = fixture({
    origin: 'subagent',
    policy: 'never',
    permission: 'workspace-write',
    enablePrompts: true,
    answer: value => ({ answers: [{ id: value.questions[0].id, selected: [value.questions[0].intent.approve] }] }),
    subagents: { rootOf: () => root, namesOf: () => ({ self: 'codex-child' }) },
    agents: { get: id => (id === root.id ? root : undefined) },
  })
  f.bridge.accept(request('item/commandExecution/requestApproval', { command: 'curl https://example.com' }))
  await f.written(); await f.bridge.close()
  assert.deepEqual(f.replies[0].result, { decision: 'accept' })
  assert.equal(f.asks.length, 1)
  assert.equal(f.asks[0].agent, root)
})

for (const scenario of [
  { name: 'reject option selected', rootPolicy: 'ask', liveRoot: true, reply: item => ({ answers: [{ id: item.id, selected: [item.intent.reject] }] }) },
  { name: 'skipped empty answer', rootPolicy: 'ask', liveRoot: true, reply: item => ({ answers: [{ id: item.id, selected: [] }] }) },
  { name: 'custom text attached', rootPolicy: 'ask', liveRoot: true, reply: item => ({ answers: [{ id: item.id, selected: [item.intent.approve], custom: 'extra' }] }) },
  { name: 'root policy is never', rootPolicy: 'never', liveRoot: true, reply: item => ({ answers: [{ id: item.id, selected: [item.intent.approve] }] }) },
  { name: 'root is not live', rootPolicy: 'ask', liveRoot: false, reply: item => ({ answers: [{ id: item.id, selected: [item.intent.approve] }] }) },
]) {
  test(`subagent approval fails closed when ${scenario.name}`, async () => {
    const rootEvents = [{ type: 'approval/policy', data: { policy: scenario.rootPolicy } }]
    const root = { id: 'root-session', session: { id: 'root-session', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
    const f = fixture({
      origin: 'subagent',
      policy: 'never',
      permission: 'workspace-write',
      enablePrompts: true,
      answer: value => scenario.reply(value.questions[0]),
      subagents: { rootOf: () => root, namesOf: () => ({ self: 'executor-2' }) },
      agents: { get: id => (scenario.liveRoot && id === root.id ? root : undefined) },
    })
    f.bridge.accept(request())
    await f.written(); await f.bridge.close()
    assert.deepEqual(f.replies[0].result, { decision: 'decline' })
    assert.equal(f.events.findLast(e => e.type === 'approval/policy').data.policy, 'never')
  })
}

test('cancelling a subagent while waiting on root approval card aborts the UI card and logs cancelled', async () => {
  const rootEvents = [{ type: 'approval/policy', data: { policy: 'ask' } }]
  const root = { id: 'root-session', session: { id: 'root-session', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
  const f = fixture({
    origin: 'subagent',
    policy: 'never',
    permission: 'workspace-write',
    enablePrompts: true,
    answer: () => new Promise(() => {}),
    subagents: { rootOf: () => root, namesOf: () => ({ self: 'executor-3' }) },
    agents: { get: id => (id === root.id ? root : undefined) },
  })
  f.bridge.accept(request())
  const ask = await f.asked
  f.abort.abort(); await f.bridge.close()
  assert.equal(ask.signal.aborted, true)
  assert.equal(f.replies.length, 0)
  assert.equal(f.events.findLast(e => e.data.phase === 'decision').data.outcome, 'cancelled')
  assert.deepEqual(f.waitStates, [true, false])
})

test('driver pauses turnTimeoutMs while waiting for a human subagent interaction', async () => {
  const events = [], listeners = new Set(), human = deferred(), seen = deferred()
  const rootEvents = [{ type: 'approval/policy', data: { policy: 'ask' } }]
  const root = { id: 'root-local', session: { id: 'root-local', header: { cwd: 'D:/test' }, snapshotEvents: () => rootEvents } }
  const session = { id: 'child-local', header: { cwd: 'D:/test', origin: 'subagent' }, snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  session.append('plugin:codexhost/thread', { version: 1, sessionId: 'child-local', phase: 'ready', harnessId: 'codex', threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: 'workspace-write' } })
  session.append('plugin:codexhost/configuration', { harnessId: 'codex', modelId: 'test', permissionModeId: 'workspace-write' })
  const emit = value => { for (const listener of listeners) listener(value) }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'codexhost/thread/usage/inspect') return {}
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'turn/start') { queueMicrotask(() => emit(request('item/commandExecution/requestApproval', { command: 'echo ok' }))); return { turn: { id: 'turn' } } }
    throw new Error(method)
  }, async respond(id, result) {
    assert.equal(id, 1); assert.deepEqual(result, { decision: 'accept' })
    queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }))
  } }
  const services = {
    subagents: { rootOf: () => root, namesOf: () => ({ self: 'slow-worker' }) },
    agents: { get: id => (id === root.id ? root : undefined) },
    userQuestions: { async ask(value) { seen.resolve(value); return human.promise } },
  }
  const ctx = { get: key => services[key], agentPresets: { presetForSession: () => 'codexhost-codex' }, sessionPersistence: { async flush() {} } }
  const helpers = { appendPluginRecord: (s, type, data) => s.append(type, data), agentEvents: () => ({ emit() {} }), AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 120, cancelTimeoutMs: 20, nativeInteractionApprovals: true })
  const agent = { id: 'child-local', session }, signal = new AbortController().signal
  try {
    const running = driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'run task' }] }], turn: 1, step: 1, signal })
    const ask = await seen.promise
    // Wait longer than turnTimeoutMs (120ms) while human is deciding.
    await new Promise(resolve => setTimeout(resolve, 200))
    human.resolve({ answers: [{ id: ask.questions[0].id, selected: [ask.questions[0].intent.approve] }] })
    await running
    assert.equal(nativeThreadState(session).phase, 'ready')
  } finally { await driver.dispose() }
})
