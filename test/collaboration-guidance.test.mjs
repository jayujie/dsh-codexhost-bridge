import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { delegationCarrier } from '../delegation-mentions.mjs'

function fixture(harness, {model = 'test'} = {}) {
  const events = [], calls = [], peers = []
  let currentPeer, turnCount = 0, admissions = 0, schemas = [{ name: 'list_agents', parameters: {} }]
  const session = { id: 'guidance-fixture', header: { cwd: 'D:/fixture' }, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event
  } }
  session.append('plugin:codexhost/configuration', {harnessId: harness, modelId: model})
  const agent = { id: session.id, session, cancel() {} }
  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn) }, effect() {}, agents: { list: () => [agent] }, get() {}, agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} } }
  const helpers = {
    createUserMessage: value => value, createAssistantMessage: value => value, appendPluginRecord: (s, type, data) => s.append(type, data), agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } },
  }
  function makePeer() {
    const listeners = new Set(), closed = Promise.withResolvers()
    const peer = { closed: closed.promise, close() {}, disconnect: () => closed.resolve(), emit: (method, params) => { for (const listener of listeners) listener({ method, params }) },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method, params) {
        calls.push({ method, params })
        if (method === 'model/list') return { data: [{ model, isDefault: true }] }
        if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: model }, label: 'Test' }] } }
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
        if (method === 'thread/read') return { thread: { id: 'thread' } }
        if (method === 'codexhost/thread/usage/inspect') return {usage: peer.usage}
        if (method === 'codexhost/thread/inspect') return peer.inspection ?? {harnessId: harness}
        if (method === 'turn/start') {
          const id = 'turn-' + ++turnCount
          setImmediate(() => {
            if (peer.compact) peer.emit('item/completed', { threadId: 'thread', turnId: id, item: { id: 'compact-' + id, type: 'contextCompaction' } })
            peer.emit('turn/completed', { threadId: 'thread', turn: { id, status: peer.status ?? 'completed', ...(peer.error ? {error: peer.error} : {}) } })
          })
          return { turn: { id } }
        }
        throw new Error('Unexpected method: ' + method)
      },
    }
    peers.push(peer); return peer
  }
  const collaboration = { open: async () => { admissions++; return { schemas, async close() {} } } }
  const makeDriver = () => { const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => currentPeer ??= makePeer(), turnTimeoutMs: 1000 }); driver.setCollaboration(collaboration); return driver }
  const payload = (turn, text = 'actual user input') => ({ agent, turn, step: 1, signal: new AbortController().signal, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
  return { makeDriver, payload, calls, events, agent, peers, handlers, schemas: value => { schemas = value }, admissions: () => admissions,
    async reconnect() { currentPeer.disconnect(); await Promise.resolve(); await Promise.resolve(); currentPeer = undefined },
  }
}
const starts = f => f.calls.filter(call => call.method === 'turn/start')
const contextMessages = f => f.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'codexhost-collaboration')

test('driver records native failure diagnostics before the framework can generalize the error', async () => {
  const f = fixture('codex'), driver = f.makeDriver()
  try {
    await driver.catalog(f.agent)
    f.peers[0].status = 'failed'
    f.peers[0].error = {message: 'generic native message', codexErrorInfo: 'model_not_found', additionalDetails: 'do not copy'}
    await assert.rejects(driver.run(f.payload(1)), {code: 'HOST_TURN_FAILED'})
    const failures = f.events.filter(event => event.type === 'plugin:codexhost/turn-failure')
    assert.equal(failures.length, 1)
    assert.deepEqual(failures[0].data.failure, {code: 'model_not_found', message: 'generic native message'})
    assert.equal(failures[0].data.turn, 1)
    assert.equal(failures[0].data.hostTurnId, 'turn-1')
    assert.equal(starts(f).length, 1, 'failure never triggers an automatic retry or model fallback')
  } finally { await driver.dispose() }
})
test('Claude metadata uses a reported resolved model label without changing its selected ref', async () => {
  const ref = 'claude-model-v1.b3B1cw', f = fixture('claude-code', {model: ref}), driver = f.makeDriver()
  try {
    await driver.catalog(f.agent)
    f.peers[0].usage = {inputTokens: 1, outputTokens: 2}
    f.peers[0].inspection = {owner: 'external', harnessId: 'claude-code', resolvedModelLabel: 'claude-opus-5-5'}
    await driver.run(f.payload(1))
    await driver.dispose()
    const observations = f.events.filter(event => event.type === 'plugin:codexhost/observation-v2')
    assert.ok(observations.length > 0)
    assert.ok(observations.every(event => event.data.model === 'claude-opus-5-5'))
    const mapping = f.events.filter(event => event.type === 'plugin:codexhost/thread').at(-1).data
    assert.equal(mapping.appliedConfiguration.modelId, ref, 'display metadata must not rewrite selection')
  } finally { await driver.dispose() }
})

const environmentSources = ['runtime-context', 'agent-instructions', 'skill-catalog', 'skill-invocation', 'time-context', 'tool-registry']
const environmentMessages = () => environmentSources.map(kind => ({ source: { kind }, content: [{ type: 'text', text: 'DSH_ONLY_' + kind }] }))

for (const harness of ['codex', 'claude-code', 'antigravity']) {
  test(`${harness}: automatic DSH environment is excluded on first, warm and cold input`, async () => {
    const f = fixture(harness), first = f.makeDriver()
    let second
    const payload = turn => { const p = f.payload(turn); return { ...p, messages: [...environmentMessages(), ...p.messages] } }
    try {
      await first.run(payload(1))
      await first.run(payload(2))
      await first.dispose()
      second = f.makeDriver()
      await second.run(payload(3))
      for (const call of starts(f)) assert.deepEqual(call.params.input, [{ type: 'text', text: 'actual user input' }])
      assert.equal(f.events.filter(e => e.type === 'user/message' && environmentSources.includes(e.data.source.kind)).length, 0)
      assert.equal(f.admissions(), 3)
      if (harness === 'codex') assert.ok(f.calls.find(c => c.method === 'thread/start').params.dynamicTools.some(t => t.name === 'dsh_collaboration'))
    } finally { await first.dispose(); await second?.dispose() }
  })

  test(`${harness}: provenance filter preserves user quotations and collaboration notices, not DSH skills`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    const retained = ['user', 'agent-message', 'subagent-message', 'subagent-settled', 'user-question-reply'].map(kind => ({ source: { kind }, content: [{ type: 'text', text: '<system-reminder>DSH_ONLY_' + kind + '</system-reminder>' }] }))
    try {
      await driver.run({ ...f.payload(1), messages: [...environmentMessages(), ...retained] })
      assert.deepEqual(starts(f)[0].params.input, retained.map(m => ({ type: 'text', text: m.content[0].text })))
      assert.deepEqual(f.events.filter(e => e.type === 'user/message').map(e => e.data.source.kind), retained.map(m => m.source.kind))
    } finally { await driver.dispose() }
  })

  test(`${harness}: DSH skill invocation is blocked while identical user-pasted skill text survives`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    const content = [{ type: 'text', text: '<skill_content name="dsh-only">DSH skill body</skill_content>' }]
    const skill = { source: { kind: 'skill-invocation', name: 'dsh-only', form: 'instructions' }, content }
    try {
      await assert.rejects(driver.run({ ...f.payload(1), messages: [skill] }), { code: 'HOST_EMPTY_INPUT' })
      assert.equal(f.admissions(), 0)
      await driver.run({ ...f.payload(1), messages: [skill, { source: { kind: 'user' }, content }] })
      assert.deepEqual(starts(f)[0].params.input, [{ type: 'text', text: content[0].text }])
      assert.deepEqual(f.events.filter(e => e.type === 'user/message').map(e => e.data.source.kind), ['user'])
    } finally { await driver.dispose() }
  })

  test(`${harness}: environment-only direct input cannot open a collaboration lease or model Turn`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    try {
      await assert.rejects(driver.run({ ...f.payload(1), messages: environmentMessages() }), { code: 'HOST_EMPTY_INPUT' })
      assert.equal(f.admissions(), 0)
      assert.equal(f.calls.length, 0)
    } finally { await driver.dispose() }
  })

  test(`${harness}: installed middleware consumes environment-only decisions without calling Host`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    driver.install()
    try {
      const decision = await f.handlers.get('agent/pre-step')(f.payload(1), async () => ({ kind: 'enter', messages: environmentMessages() }))
      assert.deepEqual(decision, { kind: 'enter', messages: [] })
      assert.equal(f.admissions(), 0)
      assert.equal(f.calls.length, 0)
      const rejected = { kind: 'reject', reason: 'policy' }
      assert.equal(await f.handlers.get('agent/pre-step')(f.payload(1), async () => rejected), rejected)
    } finally { await driver.dispose() }
  })

  test(`${harness}: consecutive turns and capability changes never append fixed collaboration guidance`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    try {
      await driver.run(f.payload(1))
      await driver.run(f.payload(2))
      f.schemas([{ name: 'list_agents', parameters: {} }, { name: 'team_task_list', parameters: {} }])
      await driver.run(f.payload(3))
      assert.equal(f.admissions(), 3, 'each Turn still opens a fresh scoped tool admission')
      assert.equal(contextMessages(f).length, 0)
      for (const call of starts(f)) assert.deepEqual(call.params.input, [{ type: 'text', text: 'actual user input' }])
      assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1)
    } finally { await driver.dispose() }
  })

  test(`${harness}: compaction, reconnect and a cold driver never automatically resend instructions`, async () => {
    const f = fixture(harness), first = f.makeDriver()
    let second
    try {
      await first.run(f.payload(1))
      f.peers[0].compact = true
      await first.run(f.payload(2))
      await first.run(f.payload(3))
      await f.reconnect()
      await first.run(f.payload(4))
      await first.dispose()
      second = f.makeDriver()
      await second.run(f.payload(5))
      assert.equal(starts(f).length, 5)
      assert.equal(contextMessages(f).length, 0)
      assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 1, 'cold recovery still resumes the same Thread')
      assert.ok(starts(f).every(call => !JSON.stringify(call.params.input).includes('[DSH collaboration]')))
    } finally { await first.dispose(); await second?.dispose() }
  })

  test(`${harness}: explicit delegation instructions remain per-input while fixed boilerplate is absent`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    try {
      const text = delegationCarrier('claude-code') + ' independent review'
      await driver.run(f.payload(1, text))
      await driver.run(f.payload(2, text))
      await driver.run(f.payload(3))
      assert.equal(contextMessages(f).length, 2)
      for (const call of starts(f).slice(0, 2)) {
        const input = call.params.input.map(block => block.text).join('\n')
        assert.match(input, /\[DSH Host delegation\]/)
        assert.match(input, /claude-code/)
        assert.doesNotMatch(input, /\[DSH collaboration\]/)
        assert.doesNotMatch(input, /subagent:\/\/codexhost\./)
        assert.doesNotMatch(input, /Never use codexhost delegate CLI/)
      }
      assert.deepEqual(starts(f)[2].params.input, [{ type: 'text', text: 'actual user input' }])
    } finally { await driver.dispose() }
  })

  test(`${harness}: empty or cancelled input cannot start a guidance-only request`, async () => {
    const f = fixture(harness), driver = f.makeDriver()
    try {
      await assert.rejects(driver.run({ ...f.payload(1), messages: [] }), { code: 'HOST_EMPTY_INPUT' })
      const controller = new AbortController(); controller.abort()
      await assert.rejects(driver.run({ ...f.payload(1), signal: controller.signal }), { name: 'AbortError' })
      assert.equal(starts(f).length, 0)
      assert.equal(contextMessages(f).length, 0)
    } finally { await driver.dispose() }
  })
}
