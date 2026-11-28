import test from 'node:test'
import assert from 'node:assert/strict'
import { externalProjection, externalContextBreakdown, hostCostLabel, hostModelPresentation } from '../native-ui-projections.mjs'
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

test('externalContextBreakdown reconciles tool and message tokens against measured contextUsedTokens (Scheme A)', () => {
  const obs = { recordedSeq: 100, usage: { contextUsedTokens: 180_000, contextWindowTokens: 516_000 } }
  // Within system ceiling: exact residual goes to systemTokens.
  const within = { recordedSeq: 100, usage: { contextUsedTokens: 85_000, contextWindowTokens: 516_000 } }
  assert.deepEqual(externalContextBreakdown(within, { toolTokens: 48_000, messageTokens: 15_000 }), {
    systemTokens: 22_000, toolsTokens: 48_000, messageTokens: 15_000,
  })
  // Large unmirrored gap (e.g. truncated tool outputs) must not bloat systemTokens; excess goes to toolsTokens.
  assert.deepEqual(externalContextBreakdown(obs, { toolTokens: 48_000, messageTokens: 15_000, systemBaselineTokens: 20_000 }), {
    systemTokens: 20_000, toolsTokens: 145_000, messageTokens: 15_000,
  })
  assert.deepEqual(externalProjection('contextBreakdown', { systemTokens: 1 }, obs, { toolTokens: 48_000, messageTokens: 15_000, systemBaselineTokens: 20_000 }), {
    systemTokens: 20_000, toolsTokens: 145_000, messageTokens: 15_000,
  })
  // Stale pre-compaction observation (lastCompactionSeq > recordedSeq) must not attribute pre-compaction 521K to systemTokens.
  const stalePreCompact = { recordedSeq: 15164, usage: { contextUsedTokens: 520_893, contextWindowTokens: 516_000 } }
  const postCompactActivity = { toolTokens: 17_300, messageTokens: 18_700, lastCompactionSeq: 15171, systemBaselineTokens: 18_000 }
  assert.deepEqual(externalContextBreakdown(stalePreCompact, postCompactActivity), {
    systemTokens: 18_000, toolsTokens: 17_300, messageTokens: 18_700,
  })
  assert.deepEqual(externalProjection('contextPressure', undefined, stalePreCompact, postCompactActivity), {
    pressureTokens: 54_000, contextWindow: 516_000,
  })
  // Immediately after compaction starts (zero active tokens yet), never fall back to pre-compaction 521K.
  assert.deepEqual(externalProjection('contextPressure', undefined, stalePreCompact, { toolTokens: 0, messageTokens: 0, lastCompactionSeq: 15171, systemBaselineTokens: 18_000 }), {
    pressureTokens: 18_000, contextWindow: 516_000,
  })
  // Once compaction records exact afterTokens (20096), contextPressure reflects it immediately even before a fresh observation.
  assert.deepEqual(externalProjection('contextPressure', undefined, stalePreCompact, { toolTokens: 0, messageTokens: 3_300, lastCompactionSeq: 15172, lastCompactionAfterTokens: 20_096 }), {
    pressureTokens: 20_096, contextWindow: 516_000,
  })
  // When heuristic sum exceeds measured contextUsed (e.g. engine pruned tool outputs), scale proportionally.
  const scaled = externalContextBreakdown(obs, { toolTokens: 300_000, messageTokens: 100_000 })
  assert.equal(scaled.systemTokens, 0)
  assert.equal(scaled.toolsTokens + scaled.messageTokens, 180_000)
  assert.equal(scaled.toolsTokens, 135_000)
  assert.equal(scaled.messageTokens, 45_000)
  // Zero activity never invents a 100% system breakdown.
  assert.equal(externalContextBreakdown(obs, { toolTokens: 0, messageTokens: 0 }), undefined)
})
