import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { apply as currentPreset } from '../native-preset-driver.mjs'

// The retained pre-0.3.5 preset contract: it executes before returning consumed input.
function retainedLegacyPreset(ctx) {
  ctx.on('agent/pre-step', async payload => {
    await ctx.get('dshHostNative').run(payload)
    return { kind: 'enter', messages: [] }
  })
}
function fixture({ preset = currentPreset, external = true } = {}) {
  const events = [], calls = [], hooks = [], listeners = new Set()
  let driver, turnCount = 0
  const session = { id: 'admission-fixture', header: { cwd: 'D:/fixture' }, snapshotEvents: () => [...events], append(type, data) {
    const event = { type, data, seq: events.length }; events.push(event); return event
  } }
  const agent = { id: session.id, session }
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data), createAssistantMessage: value => value, createUserMessage: value => value,
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { rows = []; push(value) { this.rows.push(value); return value } snapshot() { return this.rows } },
    BlockAssembler: class { push() {} blocks() { return [] } },
  }
  const ctx = {
    on(name, fn, options) { if (name === 'agent/pre-step') options?.prepend ? hooks.unshift(fn) : hooks.push(fn) }, effect() {},
    get(name) { if (name === 'dshHostNative') return driver },
    agentPresets: { presetForSession: () => external ? 'dsh-host-codex' : 'research-lite' },
    subagents: { namesOf: () => ({ self: 'lead' }) },
    sessionPersistence: { async flush() {} },
  }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method, params) {
    calls.push({ method, params })
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'codexhost/thread/usage/inspect') return {}
    if (method === 'turn/start') {
      const id = 'host-turn-' + ++turnCount
      setImmediate(() => { for (const send of listeners) send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed' } } }) })
      return { turn: { id } }
    }
    throw new Error('Unexpected Host method: ' + method)
  } }
  const makeDriver = () => new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 1000 })
  driver = makeDriver()
  if (preset) preset(ctx)
  driver.install()
  const payload = (turn = 1, step = 1) => ({ agent, turn, step, signal: new AbortController().signal, messages: [{ content: [{ type: 'text', text: 'actual user input' }], source: { kind: 'user' } }] })
  const admit = async (input, terminal = { kind: 'enter', messages: input.messages }) => {
    const invoke = i => i === hooks.length ? Promise.resolve(terminal) : hooks[i](input, () => invoke(i + 1))
    return invoke(0)
  }
  return { driver, makeDriver, session, events, calls, hooks, payload, admit }
}
const starts = f => f.calls.filter(call => call.method === 'turn/start')

test('retained legacy preset and new outer driver consume one step once', async () => {
  const f = fixture({ preset: retainedLegacyPreset })
  f.driver.setCollaboration({ open: async () => ({ schemas: [], async close() {} }) })
  try {
    assert.deepEqual(await f.admit(f.payload()), { kind: 'enter', messages: [] })
    assert.equal(starts(f).length, 1)
    assert.deepEqual(f.events.filter(e => e.type === 'step/start' || e.type === 'step/end').map(e => [e.type, e.data.step]), [['step/start', 1], ['step/end', 1]])
  } finally { await f.driver.dispose() }
})

test('current preset forwards fully assembled input exactly once', async () => {
  const f = fixture(), input = f.payload()
  const context = { content: [{ type: 'text', text: 'admitted context' }], source: { kind: 'test-context' } }
  try {
    await f.admit(input, { kind: 'enter', messages: [...input.messages, context] })
    assert.equal(starts(f).length, 1)
    assert.deepEqual(starts(f)[0].params.input.map(x => x.text), ['actual user input', 'admitted context'])
  } finally { await f.driver.dispose() }
})

for (const decision of [{ kind: 'enter', messages: [] }, { kind: 'reject' }]) test(`consumed or rejected input never opens a Host request: ${decision.kind}`, async () => {
  const f = fixture()
  try {
    assert.deepEqual(await f.admit(f.payload(), decision), decision)
    assert.equal(f.calls.length, 0)
    assert.equal(f.events.length, 0)
  } finally { await f.driver.dispose() }
})

test('duplicate direct run is rejected before network work, also in a fresh driver generation', async () => {
  const f = fixture(), next = f.makeDriver()
  try {
    await f.driver.run(f.payload())
    const count = f.calls.length
    for (const driver of [f.driver, next]) await assert.rejects(driver.run(f.payload()), error => error.code === 'HOST_STEP_ALREADY_STARTED')
    assert.equal(f.calls.length, count)
    assert.equal(starts(f).length, 1)
    await next.run(f.payload(1, 2))
    assert.equal(starts(f).length, 2, 'a genuinely new step is still executable')
  } finally { await f.driver.dispose(); await next.dispose() }
})

test('an already open step is refused rather than silently marked consumed', async () => {
  const f = fixture()
  f.session.append('step/start', { turn: 1, step: 1 })
  try {
    await assert.rejects(f.admit(f.payload()), error => error.code === 'HOST_STEP_ALREADY_STARTED')
    assert.equal(f.calls.length, 0)
  } finally { await f.driver.dispose() }
})

test('empty direct execution cannot turn automatic guidance into a new request', async () => {
  const f = fixture()
  f.driver.setCollaboration({ open: async () => { throw new Error('Empty admission must be refused before collaboration opens') } })
  try {
    await assert.rejects(f.driver.run({ ...f.payload(), messages: [] }), error => error.code === 'HOST_EMPTY_INPUT')
    assert.equal(f.calls.length, 0)
  } finally { await f.driver.dispose() }
})

test('another external wrapper cannot execute the same admitted step twice', async () => {
  const f = fixture()
  f.driver.install()
  try { await f.admit(f.payload()); assert.equal(starts(f).length, 1) }
  finally { await f.driver.dispose() }
})

test('non-Host agents preserve the native admission decision', async () => {
  const f = fixture({ preset: null, external: false }), input = f.payload()
  try {
    assert.deepEqual(await f.admit(input), { kind: 'enter', messages: input.messages })
    assert.equal(f.calls.length, 0)
  } finally { await f.driver.dispose() }
})
