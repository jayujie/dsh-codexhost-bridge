import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { dshHostTokenUsageNotification } from '../live-token-usage.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { ZERO_USAGE, turnUsage } from '../native-observations.mjs'

const totals = { inputTokens: 32901, cachedInputTokens: 0, cacheWriteInputTokens: 26767, outputTokens: 57, totalTokens: 32958 }

test('terminal notification uses exact ledger buckets even without context, reasoning or prices', () => {
  const message = dshHostTokenUsageNotification('thread', 'turn', totals)
  assert.equal(message.params.turnId, 'turn')
  assert.deepEqual(turnUsage(ZERO_USAGE, message.params.tokenUsage.total), { inputTokens: 6134, outputTokens: 57, totalTokens: 32958, cacheReadTokens: 0, cacheWriteTokens: 26767 })
  assert.equal(message.params.tokenUsage.modelContextWindow, undefined)
})

test('missing, impossible and empty counters never become invented zero usage', () => {
  for (const patch of [{ cachedInputTokens: undefined }, { cacheWriteInputTokens: undefined }, { totalTokens: undefined }, { totalTokens: 42 }, { cacheWriteInputTokens: 33000 }, { inputTokens: -1 }, { outputTokens: 1.5 }, { reasoningOutputTokens: 58 }]) {
    assert.equal(dshHostTokenUsageNotification('thread', 'turn', { ...totals, ...patch }), null)
  }
  assert.equal(dshHostTokenUsageNotification('thread', 'turn', ZERO_USAGE), null)
  assert.equal(dshHostTokenUsageNotification('thread', undefined, totals), null)
})

const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')
function shippedMeter() {
  const start = runtime.indexOf('function hostUsageTotals(requests) {')
  const end = runtime.indexOf('\nfunction nativeTurnKey', start)
  assert.ok(start > 0 && end > start)
  const context = vm.createContext({ hostDerivedUsageFields: [], parseHostUsage: x => x, parseHostUsageRequest: x => {
    if (!x.requestId) throw new Error('invalid request')
    return x
  } })
  vm.runInContext(runtime.slice(start, end) + '\nglobalThis.Meter = UsageMeter;', context)
  return new context.Meter()
}

test('shipped meter publishes only complete deduplicated counters and never invokes price derivation', () => {
  const meter = shippedMeter()
  meter.recordRequest({ ...totals, requestId: 'one' }, 'turn')
  meter.recordRequest({ ...totals, requestId: 'one' }, 'turn')
  assert.equal(meter.dshTokenUsage(), undefined)
  meter.recordHistory(false)
  assert.equal(meter.dshTokenUsage(), undefined)
  meter.recordHistory(true)
  assert.deepEqual(JSON.parse(JSON.stringify(meter.dshTokenUsage())), totals)
  meter.recordRequest({}, 'turn')
  assert.equal(meter.dshTokenUsage(), undefined)
})

test('shipped backend emits the actual terminal notification before turn/completed projection', async () => {
  // Execute the shipped terminal insertion, not an independently copied implementation.
  // esbuild may fold the preceding expression into the if condition; retain
  // the actual terminal guard/body without depending on surrounding whitespace.
  const match = runtime.match(/(event\.type === "turn.completed" && !ephemeralTurn)\) \{([\s\S]*?)\n    \}/)
  assert.ok(match)
  assert.ok(runtime.indexOf(match[0]) < runtime.indexOf('let result = projection.projector.project(event);', runtime.indexOf(match[0])))
  const body = match[2].replace('this.#writer.json', 'writer.json')
  const calls = []
  const execute = vm.runInNewContext('(async function(event, ephemeralTurn, thread, writer) { if (' + match[1] + ') {' + body + '} })', { dshHostTokenUsageNotification })
  await execute({ type: 'turn.completed', turnId: 'turn-2' }, false, { id: 'thread', usageMeter: { dshTokenUsage: () => totals } }, { json: async x => calls.push(x) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.turnId, 'turn-2')
  assert.equal(calls[0].params.tokenUsage.total.cacheWriteInputTokens, 26767)
  await execute({ type: 'turn.completed', turnId: 'compaction' }, true, { id: 'thread', usageMeter: { dshTokenUsage() { throw new Error('ephemeral turn is not billed as a chat turn') } } }, {})
})

for (const harness of ['claude-code', 'codex']) for (const metadataMode of ['pending', 'failed', 'empty', 'context-only']) test(`${harness} exact per-turn usage persists with ${metadataMode} background metadata`, { timeout: 5000 }, async () => {
  const events = [], frames = [], listeners = new Set()
  let number = 0, metadataPending = false, releaseMetadata
  const session = { id: 'local', header: { cwd: 'D:/fixture' }, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
    events.push(event); return event
  } }
  session.append('plugin:codexhost/configuration', {harnessId: harness, modelId: 'test'})
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data), createAssistantMessage: x => x,
    agentEvents: () => ({ emit: (_type, value) => frames.push(value.frame) }),
    AssistantStreamAccumulator: class { rows = []; push(value) { this.rows.push(value); return value } snapshot() { return this.rows } },
    BlockAssembler: class { push() {} blocks() { return [{ type: 'text', text: 'hello' }] } },
  }
  const aggregate = () => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value * number]))
  const ctx = { get() {}, agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} } }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'codexhost/thread/usage/inspect') {
      if (metadataPending && metadataMode !== 'pending') {
        metadataPending = false
        if (metadataMode === 'failed') throw new Error('fixture inspection failure')
        return { usage: metadataMode === 'context-only' ? { contextWindowTokens: 512000 } : {} }
      }
      if (metadataPending) { metadataPending = false; return new Promise(resolve => { releaseMetadata = () => resolve({ usage: { ...aggregate(), outputTokensPerSecond: 9500 } }) }) }
      // Reproduce the first-turn metadata-only snapshot that used to suppress ZERO_USAGE.
      return { usage: number === 0 ? { contextWindowTokens: 512000 } : aggregate() }
    }
    if (method === 'turn/start') {
      const id = 'turn-' + ++number
      setImmediate(() => {
        for (const send of listeners) {
          send({ method: 'item/completed', params: { threadId: 'thread', turnId: id, item: { id, type: 'agentMessage', text: 'hello' } } })
          send(dshHostTokenUsageNotification('other-thread', id, { ...totals, outputTokens: 999, totalTokens: 33900 }))
          send(dshHostTokenUsageNotification('thread', 'wrong-turn', { ...totals, outputTokens: 999, totalTokens: 33900 }))
          send(dshHostTokenUsageNotification('thread', id, aggregate()))
          send(dshHostTokenUsageNotification('thread', id, aggregate())) // duplicate does not double count
          metadataPending = true
          send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed' } } })
        }
      })
      return { turn: { id } }
    }
    throw new Error(method)
  } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000 })
  const agent = { id: 'local', session }
  try {
    for (let turn = 1; turn <= 2; turn++) {
      await driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }], turn, step: 1, signal: new AbortController().signal })
      const message = events.filter(event => event.type === 'assistant/message').at(-1)
      assert.equal(message.data.usage.totalTokens, 32958)
      assert.equal(message.data.usage.cacheWriteTokens, 26767)
      assert.equal(message.data.usage.inputTokens, 6134)
      assert.equal(message.data.stream.filter(row => row.chunk.type === 'usage').length, 1)
      if (metadataMode === 'pending') {
        assert.equal(typeof releaseMetadata, 'function', 'run completed while background metadata is still pending')
        releaseMetadata(); releaseMetadata = undefined
      }
      await new Promise(resolve => setImmediate(resolve))
      const observation = events.filter(event => event.type === 'plugin:codexhost/observation-v2').at(-1).data
      assert.equal(observation.usage.outputTokensPerSecond, undefined, 'batched completion cannot expose its 9500 tok/s drain rate')
      assert.ok(observation.usage.turnAverageTokensPerSecond > 0)
      assert.equal(observation.usage.totalTokens, totals.totalTokens * turn)
      if (metadataMode !== 'pending') assert.equal(observation.cost, undefined, 'failed price inspection must not invent money')
    }
    assert.equal(events.filter(event => event.type === 'assistant/message').length, 2)
    assert.equal(frames.filter(frame => frame.type === 'end').length, 2)
  } finally { releaseMetadata?.(); await driver.dispose() }
})

for (const harness of ['claude-code', 'antigravity']) test(`${harness} late zero-total thread/tokenUsage/updated and partial pre-turn inspect never erase turn usage or stall turn completion`, { timeout: 5000 }, async () => {
  const events = [], frames = [], listeners = new Set()
  let number = 0, preTurnInspectShouldFail = false, releaseBackgroundObserve
  let currentTurnId = null
  const session = { id: 'local', header: { cwd: 'D:/fixture' }, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
    events.push(event); return event
  } }
  session.append('plugin:codexhost/configuration', { harnessId: harness, modelId: 'test' })
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data), createAssistantMessage: x => x,
    agentEvents: () => ({ emit: (_type, value) => frames.push(value.frame) }),
    AssistantStreamAccumulator: class { rows = []; push(value) { this.rows.push(value); return value } snapshot() { return this.rows } },
    BlockAssembler: class { push() {} blocks() { return [{ type: 'text', text: 'hello' }] } },
  }
  const aggregate = () => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value * number]))
  const zeroPlaceholder = turnId => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'thread', turnId, tokenUsage: { total: { ...ZERO_USAGE }, last: { totalTokens: 42000 }, modelContextWindow: 512000 } },
  })
  const ctx = {
    get() {},
    agentPresets: { presetForSession: () => 'codexhost-' + harness },
    sessionPersistence: {
      async flush() {
        // Reproduce Claude Code's async #requestContextUsage("summary") arriving
        // after turn/completed while #save() is flushing ready state to disk.
        if (currentTurnId) {
          for (const send of listeners) send(zeroPlaceholder(currentTurnId))
        }
      },
    },
  }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'codexhost/thread/usage/inspect') {
      if (preTurnInspectShouldFail) {
        preTurnInspectShouldFail = false
        return { usage: { contextUsedTokens: 42000, contextWindowTokens: 512000 } }
      }
      if (number > 0 && currentTurnId !== null) {
        return new Promise(resolve => { releaseBackgroundObserve = () => resolve({ usage: { ...aggregate(), contextUsedTokens: 42000, contextWindowTokens: 512000 } }) })
      }
      return { usage: { contextWindowTokens: 512000 } }
    }
    if (method === 'turn/start') {
      const id = 'turn-' + ++number
      currentTurnId = id
      setImmediate(() => {
        for (const send of listeners) {
          send(zeroPlaceholder(id))
          send({ method: 'item/completed', params: { threadId: 'thread', turnId: id, item: { id, type: 'agentMessage', text: 'hello' } } })
          send(dshHostTokenUsageNotification('thread', id, aggregate()))
          send(zeroPlaceholder(id))
          send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed' } } })
        }
      })
      return { turn: { id } }
    }
    throw new Error(method)
  } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000 })
  const agent = { id: 'local', session }
  try {
    // Turn 1: zero-total thread/tokenUsage/updated arrives before, after exact notification, AND during post-completion flush.
    await driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 1' }] }], turn: 1, step: 1, signal: new AbortController().signal })
    assert.equal(typeof releaseBackgroundObserve, 'function', 'Turn 1 must settle without waiting for background usage inspection')
    const msg1 = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.equal(msg1.data.usage?.totalTokens, 32958)
    assert.equal(msg1.data.usage?.cacheWriteTokens, 26767)
    releaseBackgroundObserve(); releaseBackgroundObserve = undefined
    currentTurnId = null
    await new Promise(resolve => setImmediate(resolve))
    const obs1 = events.filter(event => event.type === 'plugin:codexhost/observation-v2').at(-1)?.data
    assert.ok(obs1.usage.turnAverageTokensPerSecond > 0)

    // Turn 2: pre-turn inspect returns context-only without billing counters; fallback to obs1 must keep per-turn usage intact.
    preTurnInspectShouldFail = true
    await driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 2' }] }], turn: 2, step: 1, signal: new AbortController().signal })
    assert.equal(typeof releaseBackgroundObserve, 'function', 'Turn 2 must settle without waiting for background usage inspection')
    const msg2 = events.filter(event => event.type === 'assistant/message').at(-1)
    assert.equal(msg2.data.usage?.totalTokens, 32958)
    assert.equal(msg2.data.usage?.inputTokens, 6134)
    releaseBackgroundObserve(); releaseBackgroundObserve = undefined
    await new Promise(resolve => setImmediate(resolve))
  } finally { releaseBackgroundObserve?.(); await driver.dispose() }
})

test('aborted turn without turn/completed computes elapsed speed when output increased and keeps previous speed when zero output', { timeout: 5000 }, async () => {
  const events = [], frames = [], listeners = new Set()
  let number = 0, currentUsage = { ...ZERO_USAGE }
  const session = { id: 'local', header: { cwd: 'D:/fixture' }, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
    events.push(event); return event
  } }
  session.append('plugin:codexhost/configuration', { harnessId: 'codex', modelId: 'test' })
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data), createAssistantMessage: x => x,
    agentEvents: () => ({ emit: (_type, value) => frames.push(value.frame) }),
    AssistantStreamAccumulator: class { rows = []; push(value) { this.rows.push(value); return value } snapshot() { return this.rows } },
    BlockAssembler: class { push() {} blocks() { return [{ type: 'text', text: 'partial' }] } },
  }
  const ctx = { get() {}, agentPresets: { presetForSession: () => 'codexhost-codex' }, sessionPersistence: { async flush() {} } }
  const observationOf = () => events.filter(e => e.type === 'plugin:codexhost/observation-v2').at(-1)?.data
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'codexhost/thread/usage/inspect') return { usage: { ...currentUsage } }
    if (method === 'turn/interrupt') return {}
    if (method === 'turn/start') {
      const id = 'turn-' + ++number
      if (number === 1) {
        currentUsage = { ...totals }
        setTimeout(() => {
          for (const send of listeners) send(dshHostTokenUsageNotification('thread', id, currentUsage))
        }, 15)
      }
      return { turn: { id } }
    }
    throw new Error(method)
  } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000, cancelTimeoutMs: 60, observationOf })
  const agent = { id: 'local', session }
  try {
    const abort1 = new AbortController()
    setTimeout(() => abort1.abort(), 30)
    await assert.rejects(driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 1' }] }], turn: 1, step: 1, signal: abort1.signal }))
    await new Promise(resolve => setTimeout(resolve, 25))
    const obs1 = observationOf()
    assert.ok(obs1?.usage?.turnAverageTokensPerSecond > 0, `expected positive speed on aborted turn with output, got ${obs1?.usage?.turnAverageTokensPerSecond}`)

    session.append('plugin:codexhost/thread', { version: 1, phase: 'ready', harnessId: 'codex', threadId: 'thread', sessionId: 'local', appliedConfiguration: { modelId: 'test', permissionModeId: 'full-access' } })
    const abort2 = new AbortController()
    setTimeout(() => abort2.abort(), 20)
    await assert.rejects(driver.run({ agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 2' }] }], turn: 2, step: 1, signal: abort2.signal }))
    await new Promise(resolve => setTimeout(resolve, 25))
    const obs2 = observationOf()
    assert.equal(obs2?.usage?.turnAverageTokensPerSecond, obs1.usage.turnAverageTokensPerSecond)
  } finally { await driver.dispose() }
})
