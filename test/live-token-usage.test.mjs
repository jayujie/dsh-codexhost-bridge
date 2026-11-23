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
