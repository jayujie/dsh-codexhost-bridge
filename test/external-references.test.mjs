import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareExternalReferences, NativeSessionDriver } from '../native-session-driver.mjs'
const signal = () => new AbortController().signal
const direct = { source: { kind: 'user' }, content: [{ type: 'text', text: '@[source](dsh-session:InNvdXJjZSI) inspect' }] }
const agent = { model: { current: () => ({ provider: 'saved', model: 'saved' }) } }
const helpers = { parseSessionReferenceText(text) { return { text: '@source inspect', references: [{ sessionId: 'source', label: 'source' }] } } }

test('external engines receive a DSH snapshot after the canonical reference is resolved', async () => {
  const snapshot = { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'untrusted actual DSH transcript' }] }
  let reads = 0
  const ctx = { get: () => ({ async prepare(target, content, references, route, receivedSignal) { reads++; assert.equal(target, agent); assert.equal(references[0].sessionId, 'source'); assert.equal(route.provider, 'saved'); receivedSignal.throwIfAborted(); return { content, additionalContext: snapshot } } }) }
  const result = await prepareExternalReferences(ctx, helpers, agent, [direct], signal())
  assert.equal(reads, 1); assert.equal(result[0].content[0].text, '@source inspect'); assert.equal(result[1], snapshot)
  assert.ok(direct.content[0].text.includes('dsh-session:'), 'original input is preserved')
})

test('reference failures stop dispatch instead of exposing opaque DSH ids to the engine', async () => {
  await assert.rejects(prepareExternalReferences({ get: () => undefined }, helpers, agent, [direct], signal()), { code: 'HOST_SESSION_REFERENCE_UNAVAILABLE' })
  await assert.rejects(prepareExternalReferences({ get: () => ({ prepare() { throw new Error('cannot read source') } }) }, helpers, agent, [direct], signal()), /cannot read source/)
})

test('plain messages and non-user quoted reference tokens are preserved', async () => {
  const plain = { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  const quote = { ...direct, source: { kind: 'session-reference' } }
  assert.deepEqual(await prepareExternalReferences({ get() { throw new Error('not required') } }, {}, agent, [plain, quote], signal()), [plain, quote])
})

for (const harness of ['codex', 'claude-code']) test(`${harness} driver sends and durably records the resolved DSH snapshot`, async () => {
  const events = [], listeners = new Set(), sent = []
  const session = { id: 'local', header: { cwd: 'D:/test' }, snapshotEvents: () => events, append(type, data) { const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  session.append('plugin:dsh-host/thread', { version: 1, sessionId: 'local', phase: 'ready', harnessId: harness, threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: harness === 'codex' ? 'read-only' : 'plan' } })
  session.append('plugin:dsh-host/configuration', { harnessId: harness, modelId: 'test', permissionModeId: harness === 'codex' ? 'read-only' : 'plan' })
  const snapshot = { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'actual DSH transcript fixture' }] }
  const ctx = { get: key => key === 'sessionReferenceResolver' ? { async prepare(_agent, content) { return { content, additionalContext: snapshot } } } : undefined, agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} } }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method, params) {
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'codexhost/thread/usage/inspect') return {}
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'turn/start') { sent.push(params.input); setImmediate(() => { for (const listener of listeners) listener({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } }) }); return { turn: { id: 'turn' } } }
    throw new Error(method)
  } }
  const driverHelpers = { ...helpers, appendPluginRecord: (s, type, data) => s.append(type, data), agentEvents: () => ({ emit() {} }), AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } } }
  const driver = new NativeSessionDriver(ctx, driverHelpers, { connect: async () => peer, turnTimeoutMs: 2000 })
  try {
    await driver.run({ agent: { ...agent, id: 'local', session }, messages: [direct], turn: 1, step: 1, signal: signal() })
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0].text, '@source inspect'); assert.equal(sent[0][1].text, 'actual DSH transcript fixture')
    assert.ok(!JSON.stringify(sent).includes('dsh-session:'))
    assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'session-reference' && event.data.content[0].text === 'actual DSH transcript fixture'))
  } finally { await driver.dispose() }
})

test('cancelled reference preparation cannot read or send', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(prepareExternalReferences({ get() { throw new Error('must not read') } }, helpers, agent, [direct], controller.signal), { name: 'AbortError' })
})
