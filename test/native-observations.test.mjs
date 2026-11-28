import { zodRequire } from './zod-resolver.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZERO_USAGE, hasBillingCounters, observedUsage, mergeObservedUsage, turnUsage, acceptNativeTitle, foldHostModelIdentity, foldHostContextBreakdown, enrichObservationCostBreakdown, foldHostObservation, installObservationProjection } from '../native-observations.mjs'
import { ModelPriceLookup } from '../local-model-prices.mjs'
import { nativeFilePath, installWorkspaceFilePaths } from '../workspace-file-paths.mjs'
import { createRequire } from 'node:module'

const threadEvent = (harnessId, modelId, threadId = 'thread') => ({ type: 'plugin:dsh-host/thread', ignorable: true, data: { version: 1, harnessId, threadId, appliedConfiguration: { modelId } } })
const messageEvent = (harnessId, model) => ({ type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'codexhost/' + harnessId, model } } } })
for (const harness of ['codex', 'claude-code']) test(`${harness} model identity replays without any usage snapshot`, () => {
  const selected = harness === 'codex' ? 'gpt-selected' : 'claude-model-v1.c29ubmV0'
  const events = [threadEvent(harness, selected), messageEvent(harness, 'actual-model'), threadEvent(harness, selected)]
  const state = events.reduce(foldHostModelIdentity, null)
  assert.equal(state.model, 'actual-model')
  assert.equal(state.selectedModel, selected)
  assert.deepEqual(events.slice(1).reduce(foldHostModelIdentity, events.slice(0, 1).reduce(foldHostModelIdentity, null)), state)
  assert.equal(foldHostModelIdentity(state, { type: 'turn/end', data: {} }), state)
  assert.equal(foldHostModelIdentity(state, messageEvent('unrelated', 'wrong')), state)
  assert.equal(foldHostModelIdentity(state, threadEvent(harness, 'changed')).model, undefined)
  assert.equal(foldHostModelIdentity(state, threadEvent(harness, selected, 'different-thread')).model, undefined)
})
test('legacy Claude default observation does not erase an assistant model record', () => {
  const selected = 'claude-model-v1.ZGVmYXVsdA'
  const state = [threadEvent('claude-code', selected), messageEvent('claude-code', 'claude-reported')].reduce(foldHostModelIdentity, null)
  assert.equal(foldHostModelIdentity(state, {type: 'plugin:dsh-host/observation-v2', ignorable: true, data: {harnessId: 'claude-code', threadId: 'thread', model: selected}}), state)
})
test('model identity stays separate while usage snapshots retain their recorded sequence', async () => {
  const {z} = zodRequire(import.meta.url)('zod'), definitions = []
  const usage = await installObservationProjection({loader: {import: async () => ({z})}, sessionProjections: {register: async definition => {definitions.push(definition); return definition}}})
  assert.equal(usage.key, 'dshHostObservation')
  assert.equal(usage.stateVersion, 4)
  const observation = { threadId: 'thread', harnessId: 'codex', model: 'gpt-test', observedAt: 100, usage: { totalCostUsd: .1 }, cost: { source: 'publicPrice' } }
  const observed = usage.apply(usage.init(), { type: 'plugin:dsh-host/observation-v2', ignorable: true, seq: 17, data: observation })
  assert.equal(observed.recordedSeq, 17)
  assert.deepEqual(usage.stateSchema.parse(observed), { ...observation, recordedSeq: 17 })
  const priced = usage.apply(observed, { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'dsh-host/codex', model: 'gpt-reply' } } } })
  assert.deepEqual(usage.stateSchema.parse(priced), { ...observation, recordedSeq: 17, pricingModel: 'gpt-reply' })
  const identity = definitions.find(definition => definition.key === 'dshHostModelIdentity')
  const state = identity.apply(identity.init(), threadEvent('codex', 'gpt-selected'))
  assert.deepEqual(identity.stateSchema.parse(state), state)
  assert.deepEqual(identity.wire.viewSchema.parse(identity.wire.view(state)), state)
})

test('Host usage becomes disjoint DSH billing without counting cached input twice', () => {
  const after = { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 1050 }
  assert.deepEqual(turnUsage(ZERO_USAGE, after), { inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50, reasoningTokens: 10, totalTokens: 1050 })
  assert.deepEqual(turnUsage(after, { ...after, inputTokens: 1400, cachedInputTokens: 900, outputTokens: 70, totalTokens: 1470 }), { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 420 })
  // Polluted reasoningOutputTokens on a prior partial/error observation omits reasoningTokens instead of dropping the whole Turn.
  assert.deepEqual(turnUsage({ ...after, reasoningOutputTokens: 0 }, { ...after, inputTokens: 1400, cachedInputTokens: 900, outputTokens: 70, reasoningOutputTokens: 45, totalTokens: 1470 }), { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 20, totalTokens: 420 })
  // Zero-delta (failed/no-op) turns do not emit bogus 0 tok badges.
  assert.equal(turnUsage(after, after), undefined)
  assert.equal(turnUsage(undefined, after), undefined)
  assert.equal(turnUsage(after, ZERO_USAGE), undefined)
  assert.equal(turnUsage(ZERO_USAGE, { ...after, totalTokens: 0 }), undefined)
  assert.equal(turnUsage(ZERO_USAGE, { ...after, cachedInputTokens: undefined }), undefined)
  assert.deepEqual(observedUsage({ inputTokens: -1, totalCostUsd: 2 }), { totalCostUsd: 2 })
  assert.equal(hasBillingCounters(after), true)
  assert.equal(hasBillingCounters({ inputTokens: 10, outputTokens: 5 }), false)
  // Same-counter partial/error observations retain cache buckets and positive reasoning counters.
  const merged = mergeObservedUsage(after, { inputTokens: 1000, outputTokens: 50, reasoningOutputTokens: 0, totalTokens: 1050 }, true)
  assert.equal(merged.cachedInputTokens, 600)
  assert.equal(merged.cacheWriteInputTokens, 100)
  assert.equal(merged.reasoningOutputTokens, 10)
})

test('Native title events replace fallback names but never override user names', () => {
  const events = [{ type: 'user/message', seq: 2, data: { source: { kind: 'user' } } }, { type: 'session/title', data: { title: 'first prompt', source: { kind: 'fallback' } } }]
  const session = { append(type, data) { events.push({ type, data }) } }
  assert.equal(acceptNativeTitle(session, null), false)
  assert.equal(acceptNativeTitle(session, '原生摘要标题', { ...events.at(-1).data, messageSeqs: [2] }), true)
  assert.equal(events.at(-1).data.title, '原生摘要标题')
  assert.deepEqual(events.at(-1).data.messageSeqs, [2])
  assert.equal(acceptNativeTitle(session, '原生摘要标题', events.at(-1).data), false)
  events.push({ type: 'session/title', data: { title: 'My name', source: { kind: 'user' } } })
  assert.equal(acceptNativeTitle(session, 'A different native name', events.at(-1).data), false)
})

test('Windows Markdown paths use the existing file service with reversible adaptation', () => {
  assert.equal(nativeFilePath('D:/workspace', '/D:/workspace/a.html'), 'D:/workspace/a.html')
  assert.equal(nativeFilePath('/workspace', '/D:/workspace/a.html'), '/D:/workspace/a.html')
  assert.equal(nativeFilePath('D:/workspace', '//server/share/a'), '//server/share/a')
  const calls = [], releases = []
  class Files { stat(scope, path, signal) { calls.push({ scope, path, signal }); return 'native-result' } }
  for (const name of ['read', 'readBytes', 'list', 'changes']) Files.prototype[name] = Files.prototype.stat
  const files = new Files()
  installWorkspaceFilePaths({ inject(_keys, callback) { callback({ workspaceFiles: files, effect(callback) { releases.push(callback()) } }) } })
  const scope = { workspaceRoot: 'D:/workspace', sessionId: 'session' }, signal = new AbortController().signal
  assert.equal(files.stat(scope, '/D:/workspace/a.html', signal), 'native-result')
  assert.deepEqual(calls[0], { scope, path: 'D:/workspace/a.html', signal })
  releases[0]()
  assert.equal(Object.hasOwn(files, 'stat'), false)
})

test('observation wire view derives exact cost breakdown from Host cumulative counters', () => {
  const lookup = new ModelPriceLookup({ providers: { google: { 'gemini-4-neon': [3, 15, .15, 0, true] } } })
  const state = {
    threadId: 't1', harnessId: 'antigravity', model: 'gemini-4-neon', observedAt: 100,
    usage: { inputTokens: 43_006_905, cachedInputTokens: 40_713_620, cacheWriteInputTokens: 0, outputTokens: 253_778, totalCostUsd: 16.793568 },
    cost: { source: 'publicPrice' },
  }
  const enriched = enrichObservationCostBreakdown(state, lookup)
  assert.ok(Math.abs((enriched.usage.inputCostUsd + enriched.usage.cacheReadCostUsd) - 12.986898) < 1e-6)
  assert.ok(Math.abs(enriched.usage.outputCostUsd - 3.80667) < 1e-6)
  assert.ok(enriched.usage.cacheSavingsUsd > 116)
  // Mismatched multi-model total must not be overwritten with single-model breakdown.
  const mismatched = enrichObservationCostBreakdown({ ...state, usage: { ...state.usage, totalCostUsd: 40 } }, lookup)
  assert.equal(mismatched.usage.inputCostUsd, undefined)
})

test('Claude observation prices the concrete reply model and absorbs the 1h cache-write premium', () => {
  const lookup = new ModelPriceLookup({ providers: { anthropic: { 'claude-opus-5-5': [4, 20, .2, 5, true] } } })
  const observed = { type: 'plugin:dsh-host/observation-v2', ignorable: true, seq: 215, data: {
    threadId: 't1', harnessId: 'claude-code', model: 'claude-model-v1.b3B1cw', observedAt: 100,
    // Real session 1f7a6fd1: Host total bills 43,280 cache-write tokens at the 1h rate ($8/M).
    usage: { inputTokens: 1_093_190, cachedInputTokens: 1_044_475, cacheWriteInputTokens: 43_280, outputTokens: 25_374, totalCostUsd: 1.084355 },
    cost: { source: 'publicPrice' } } }
  const reply = { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'dsh-host/claude-code', model: 'claude-opus-5-5' } } } }
  // The catalog alias alone is unpriced.
  assert.equal(enrichObservationCostBreakdown(foldHostObservation(null, observed), lookup).usage.inputCostUsd, undefined)
  // A later observation keeps the model learned from the engine reply.
  const state = foldHostObservation(foldHostObservation(foldHostObservation(null, observed), reply), observed)
  assert.equal(state.pricingModel, 'claude-opus-5-5')
  const u = enrichObservationCostBreakdown(state, lookup).usage
  assert.ok(Math.abs(u.outputCostUsd - .50748) < 1e-9)
  assert.ok(Math.abs(u.cacheWriteCostUsd - .34624) < 1e-9)
  assert.ok(Math.abs(u.inputCostUsd + u.cacheReadCostUsd + u.cacheWriteCostUsd + u.outputCostUsd - 1.084355) < 1e-9)
  assert.ok(u.cacheSavingsUsd > 3.9)
  // A gap the cache-write premium cannot explain still drops the breakdown.
  const off = foldHostObservation(state, { ...observed, data: { ...observed.data, usage: { ...observed.data.usage, totalCostUsd: 2 } } })
  assert.equal(enrichObservationCostBreakdown(off, lookup).usage.inputCostUsd, undefined)
})

test('foldHostObservation retains last positive speed when later same-thread observations omit speed or report zero', () => {
  const first = foldHostObservation(null, {
    type: 'plugin:dsh-host/observation-v2', ignorable: true, seq: 10,
    data: { threadId: 't1', harnessId: 'codex', model: 'gpt-6-astra', observedAt: 100, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, turnAverageTokensPerSecond: 45, outputTimingReliable: 1 } },
  })
  const reloaded = foldHostObservation(first, {
    type: 'plugin:dsh-host/observation-v2', ignorable: true, seq: 20,
    data: { threadId: 't1', harnessId: 'codex', model: 'gpt-6.2-astra', observedAt: 200, usage: { inputTokens: 1500, outputTokens: 260, totalTokens: 1760 } },
  })
  assert.equal(reloaded.usage.turnAverageTokensPerSecond, 45)
  const abortedZero = foldHostObservation(reloaded, {
    type: 'plugin:dsh-host/observation-v2', ignorable: true, seq: 30,
    data: { threadId: 't1', harnessId: 'codex', model: 'gpt-6.2-astra', observedAt: 300, usage: { inputTokens: 1500, outputTokens: 260, totalTokens: 1760, turnAverageTokensPerSecond: 0, outputTimingReliable: 0 } },
  })
  assert.equal(abortedZero.usage.turnAverageTokensPerSecond, 45)
})

test('dshHostContextBreakdown tracks tool vs message tokens and resets on new compaction without wiping updates', async () => {
  const { z } = zodRequire(import.meta.url)('zod'), definitions = []
  await installObservationProjection({
    loader: { import: async () => ({ z }) },
    sessionProjections: { register: async def => { definitions.push(def); return def } },
  })
  const ctxProj = definitions.find(def => def.key === 'dshHostContextBreakdown')
  assert.ok(ctxProj)
  let s = ctxProj.init()
  s = foldHostContextBreakdown(s, { type: 'turn/start', data: { turn: 1 } })
  s = foldHostContextBreakdown(s, { type: 'user/message', data: { content: [{ type: 'text', text: 'a'.repeat(400) }] } })
  s = foldHostContextBreakdown(s, { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'Read', arguments: '{"path":"' + 'x'.repeat(200) + '"}' }] } } })
  s = foldHostContextBreakdown(s, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'b'.repeat(4000) }] } } })
  s = foldHostContextBreakdown(s, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'c'.repeat(800) }] } } })
  assert.ok(s.activeToolTokens > 1000)
  assert.ok(s.activeMessageTokens > 300)

  // New compaction resets active counters; subsequent update to the same compactionId does NOT wipe post-compaction activity.
  s = foldHostContextBreakdown(s, { seq: 10, type: 'plugin:dsh-host/compaction', ignorable: true, data: { compactionId: 'c1', phase: 'started' } })
  assert.equal(s.activeToolTokens, 0)
  assert.equal(s.activeMessageTokens, 0)
  assert.equal(s.lastCompactionSeq, 10)
  // AGY read_file byte summary ("317 lines, 14565 bytes") estimates tokens from actual byte size, not the 22-char summary string.
  s = foldHostContextBreakdown(s, { seq: 11, type: 'tool/result', data: { message: { content: [{ type: 'text', text: '317 lines, 14565 bytes' }] } } })
  assert.ok(s.activeToolTokens > 4000, `expected >4000 tokens from 14565-byte read_file summary, got ${s.activeToolTokens}`)
  const toolBeforeUpdate = s.activeToolTokens
  s = foldHostContextBreakdown(s, { seq: 12, type: 'plugin:dsh-host/compaction', ignorable: true, data: { compactionId: 'c1', phase: 'completed', afterTokens: 20_096, summary: 'Summary text'.repeat(20) } })
  assert.equal(s.activeToolTokens, toolBeforeUpdate)
  assert.ok(s.activeMessageTokens > 0)
  assert.equal(s.lastCompactionSeq, 12)
  assert.equal(s.lastCompactionAfterTokens, 20_096)
  // Fresh post-compaction observation learns static systemBaselineTokens.
  s = foldHostContextBreakdown(s, { seq: 15, type: 'plugin:dsh-host/observation-v2', ignorable: true, data: { usage: { contextUsedTokens: toolBeforeUpdate + s.activeMessageTokens + 18_500 } } })
  assert.equal(s.systemBaselineTokens, 18_500)

  ctxProj.stateSchema.parse(s)
  ctxProj.wire.viewSchema.parse(ctxProj.wire.view(s))
})
