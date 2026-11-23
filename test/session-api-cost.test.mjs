import { zodUrl } from './zod-resolver.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { costRequest, requestCost, sessionCostView, installSessionApiCost, loadLocalPriceLookup } from '../session-api-cost.mjs'
import { ModelPriceLookup } from '../local-model-prices.mjs'
import { turnTimingUsage, mergeObservedUsage } from '../native-observations.mjs'
import { externalProjection } from '../native-ui-projections.mjs'
const lookup = new ModelPriceLookup({ providers: { vendor: { model: [2, 10, .2, 2.5, true] } } })
const event = { type: 'assistant/message', surfaceOp: 'append', data: { message: { id: 'one', source: { kind: 'model', provider: 'vendor', model: 'model' } }, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 200 } } }
test('native disjoint token buckets price once, including reads and writes', () => {
  const r = costRequest(event)
  assert.equal(requestCost(r, lookup), .0014)
  assert.equal(costRequest({ ...event, surfaceOp: 'replace' }), undefined)
  const host = { ...event, data: { ...event.data, message: { ...event.data.message, source: { kind: 'model', provider: 'codexhost/codex', model: 'model' } } } }
  assert.equal(requestCost(costRequest(host), lookup), .0014)
  assert.equal(costRequest({ ...host, data: { ...host.data, usage: undefined } }), undefined)
})
test('unknown models and missing usage produce a lower bound, never a fabricated bill', () => {
  const r = costRequest(event)
  const result = sessionCostView({ one: r, two: { ...r, id: 'two', model: 'unknown' } }, lookup)
  assert.equal(result.usage.totalCostUsd, .0014)
  assert.equal(result.cost.unpricedRequests, 1)
  assert.equal(sessionCostView({ two: { ...r, model: 'unknown' } }, lookup).usage.totalCostUsd, undefined)
  assert.equal(requestCost({ ...r, usage: undefined }, lookup), undefined)
})
test('positive cache buckets cannot silently use zero for missing prices', () => {
  const bare = new ModelPriceLookup({ providers: { vendor: { model: [2, 10] } } })
  assert.equal(requestCost(costRequest(event), bare), undefined)
})
test('native local lookup resolves current exact model IDs without launching a backend', async () => {
  const local = await loadLocalPriceLookup({ backendDataDir: 'C:/__nonexistent_dsh_price_test__' })
  assert.ok(local.find('gpt-6.1-sol'))
  // Unknown/ambiguous IDs must not be guessed from a similar model.
  assert.equal(local.find('__unknown_model__'), null)
})
test('price projection deduplicates assistant IDs and serves a wire view on replay', async () => {
  let definition
  const z = (await import(zodUrl())).z
  await installSessionApiCost({ loader: { import: async () => ({ z }) }, sessionProjections: { register: async value => { definition = value } } }, { backendDataDir: 'C:/__nonexistent_dsh_price_test__' })
  assert.equal(definition.stateVersion, 3)
  let state = definition.init()
  const sequenced = { ...event, seq: 42 }
  state = definition.apply(state, sequenced)
  assert.equal(definition.apply(state, sequenced), state)
  assert.equal(definition.wire.view(state).cost.latestUsageSeq, 42)
  definition.stateSchema.parse(state)
  definition.wire.viewSchema.parse(definition.wire.view(state))
  assert.equal(Object.keys(state).length, 1)
})
test('recorded Astra Host Turn prices once without an observation or intermediate-message charges', () => {
  // Usage-only fixture from session-hosttask-5690f1ebeaebd84ebfeb79ab78aaf122 seq 34.
  const prices = new ModelPriceLookup({ providers: { openai: { 'gpt-6.2-astra': [8, 40, .4, 10, true] } } })
  const host = { type: 'assistant/message', surfaceOp: 'append', data: {
    message: { id: 'bace28fc-0fb1-42fd-a6be-831c4fdb13b7', source: { kind: 'model', provider: 'codexhost/codex', model: 'gpt-6.2-astra' } },
    usage: { inputTokens: 21756, outputTokens: 619, cacheReadTokens: 47744, cacheWriteTokens: 0 },
  } }
  assert.equal(costRequest({ ...host, data: { ...host.data, usage: undefined } }), undefined)
  const request = costRequest(host)
  const view = sessionCostView({ [request.id]: request }, prices)
  assert.ok(Math.abs(view.usage.totalCostUsd - .2179056) < 1e-12)
  assert.equal(view.cost.unpricedRequests, 0)
})
test('57 token batched reply uses full measured turn duration, not its 6ms drain', () => {
  const timing = turnTimingUsage({ outputTokens: 0 }, { outputTokens: 57 }, 5180, false)
  assert.equal(timing.outputTimingReliable, 0)
  assert.ok(Math.abs(timing.turnAverageTokensPerSecond - 11.003861) < .00001)
  const prev = { inputTokens: 32901, outputTokens: 57, totalTokens: 32958, ...timing }
  const merged = mergeObservedUsage(prev, { inputTokens: 32901, outputTokens: 57, totalTokens: 32958, outputTokensPerSecond: 9500 }, true)
  assert.equal(merged.outputTokensPerSecond, undefined)
  const stats = externalProjection('sessionStats', { decodeTokens: 57, decodeMs: 6 }, { usage: merged })
  assert.equal(stats.decodeTokens, timing.turnAverageTokensPerSecond)
})
test('timing does not manufacture counters or carry previous turn reliability to a new turn', () => {
  assert.equal(turnTimingUsage(undefined, { outputTokens: 57 }, 5000, false).turnAverageTokensPerSecond, undefined)
  const next = mergeObservedUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2, outputTimingReliable: 0 }, { inputTokens: 2, outputTokens: 2, totalTokens: 4, outputTokensPerSecond: 20 }, true)
  assert.equal(next.outputTokensPerSecond, 20)
})
