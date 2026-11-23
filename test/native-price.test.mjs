import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { mergeObservedUsage } from '../native-observations.mjs'

test('Metadata-only observations retain Claude context on the same route, never across a model change', () => {
  const previous = { totalTokens: 9000, contextUsedTokens: 5000, contextWindowTokens: 1000000 }
  assert.deepEqual(mergeObservedUsage(previous, { totalTokens: 9100 }, true), { totalTokens: 9100, contextUsedTokens: 5000, contextWindowTokens: 1000000 })
  assert.deepEqual(mergeObservedUsage(previous, { totalTokens: 9100 }, false), { totalTokens: 9100 })
  assert.deepEqual(mergeObservedUsage(previous, { totalTokens: 9100, contextUsedTokens: 0, contextWindowTokens: 1000000 }, true).contextUsedTokens, 5000)
  assert.equal(mergeObservedUsage(previous, { contextUsedTokens: 1200, contextWindowTokens: 1000000 }, true).contextUsedTokens, 1200)
  assert.equal(mergeObservedUsage({ contextUsedTokens: 0, contextWindowTokens: 1000000 }, { contextUsedTokens: 0, contextWindowTokens: 1000000 }, true).contextUsedTokens, 0)
})

test('Native DSH leaves price history to the on-demand console and never starts Host for decoration', { timeout: 1000 }, async () => {
  let connects = 0, records = 0
  const driver = new NativeSessionDriver({ agentPresets: { presetForSession: () => 'coding' } },
    { appendPluginRecord: () => { records++ } }, { connect: async () => { connects++; throw new Error('unexpected Host startup') } })
  try {
    const catalog = await driver.catalog({ id: 'native-dsh', session: { id: 'native-dsh', header: { cwd: 'D:/workspace' } } })
    assert.equal(catalog.status, 'ready')
    assert.equal(connects, 0)
    assert.equal(records, 0)
  } finally { await driver.dispose() }
})
