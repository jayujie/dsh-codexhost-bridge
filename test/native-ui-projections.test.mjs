import test from 'node:test'
import assert from 'node:assert/strict'
import { externalProjection, hostCostLabel, hostModelPresentation } from '../native-ui-projections.mjs'
import { observedCost } from '../native-observations.mjs'

test('Claude model refs are selections, never fabricated resolved models', () => {
  const ref = value => 'claude-model-v1.' + Buffer.from(value).toString('base64url')
  assert.deepEqual(hostModelPresentation('claude-code', ref('default')), { kind: 'default' })
  assert.deepEqual(hostModelPresentation('claude-code', ref('haiku')), { kind: 'selection', value: 'haiku' })
  assert.deepEqual(hostModelPresentation('claude-code', ref('模型-测试')), { kind: 'selection', value: '模型-测试' })
  assert.deepEqual(hostModelPresentation('claude-code', 'claude-opus-5-5'), { kind: 'model', value: 'claude-opus-5-5' })
  assert.deepEqual(hostModelPresentation('codex', 'gpt-6.1-sol'), { kind: 'model', value: 'gpt-6.1-sol' })
  for (const value of [undefined, '', 'claude-model-v1.', ref('default') + '=', 'claude-model-v1._w', ref('bad\u0000model')]) assert.deepEqual(hostModelPresentation('claude-code', value), { kind: 'unknown' })
})

test('Original DSH stats and context components consume measured external facts', () => {
  const observation = { usage: { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50, outputTokensPerSecond: 25, contextUsedTokens: 800, contextWindowTokens: 10000 } }
  assert.deepEqual(externalProjection('tokenUsage', {}, observation), { uncachedInputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50 })
  assert.deepEqual(externalProjection('contextPressure', {}, observation), { pressureTokens: 800, contextWindow: 10000 })
  assert.equal(externalProjection('contextBreakdown', { systemTokens: 5000 }, observation), undefined)
  const stats = externalProjection('sessionStats', { steps: 5, turns: 2 }, observation)
  assert.equal(stats.decodeTokens / (stats.decodeMs / 1000), 25)
  assert.equal(stats.steps, 5)
  assert.equal(externalProjection('tokenUsage', {}, { usage: { inputTokens: 100 } }), undefined)
})

test('missing native decode timing never reuses batched bridge arrival TPS', () => {
  const native = { steps: 1, turns: 1, decodeTokens: 95, decodeMs: 10 }
  for (const rate of [undefined, 0, -1, NaN, Infinity]) {
    const stats = externalProjection('sessionStats', native, { usage: { outputTokensPerSecond: rate } })
    assert.equal(stats.decodeMs, 0)
    assert.equal(stats.decodeTokens, 0)
    assert.equal(stats.turns, 1)
  }
  assert.equal(native.decodeMs, 10)
})

test('Host price is reused verbatim, with original formatting and unpriced lower bound', () => {
  const usage = { totalCostUsd: 1.23456, costSource: 'publicPrice', unpricedModels: ['unknown-model'] }
  assert.deepEqual(observedCost(usage), { source: 'publicPrice', unpricedModels: ['unknown-model'] })
  assert.equal(hostCostLabel(usage, observedCost(usage)), '≥$1.23')
  assert.equal(hostCostLabel({ totalCostUsd: .12345 }, { source: 'native' }), '$0.123')
  assert.equal(hostCostLabel({}), undefined)
  assert.equal(observedCost({ totalCostUsd: 0 }), undefined)
})
