import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { hostCostLabel, hostApiCostObservation } from '../native-ui-projections.mjs'

const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
const api = vm.runInNewContext(source + '\n;({ApiValueSeat,ThinkingSlider})', {
  h: (tag, props, ...children) => ({ tag, props, children }), Menu: 'Menu', IconChevronDownOutlineRegular: 'Chevron',
  useState: initial => [initial, () => {}], useEffect() {}, useRef: () => ({ current: null }),
  hostCostLabel, hostApiCostObservation,
  getSliderPrimitive: () => ({ Root: 'Root', Track: 'Track', Range: 'Range', Thumb: 'Thumb' }),
})
test('DSH without a Host observation keeps an explicit unavailable price seat', () => {
  const view = api.ApiValueSeat({ useProjection: () => undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$ —')
  assert.equal(view.props.anchor.props['data-dsh-host-api-value'], '')
})
test('native DSH uses its local expense projection, not a stale Host observation', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'sessionApiCost' ? { usage: { totalCostUsd: .123 }, cost: { source: 'publicPrice' } } : key === 'dshHostObservation' ? { usage: { totalCostUsd: 99 }, cost: { source: 'native' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.123')
})

test('Host without a cost observation prices recorded Turn usage locally', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'agentPreset' ? 'dsh-host-codex' : key === 'sessionApiCost' ? { usage: { totalCostUsd: .218 }, cost: { source: 'publicPrice' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.218')
})
test('Host reported cost wins over local pricing without summing both totals', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'agentPreset' ? 'dsh-host-codex' : key === 'sessionApiCost' ? { usage: { totalCostUsd: .218 }, cost: { source: 'publicPrice' } } : key === 'dshHostObservation' ? { usage: { totalCostUsd: .3 }, cost: { source: 'native' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.300')
})
for (const preset of ['dsh-host-codex', 'dsh-host-claude-code']) {
  for (const scenario of [
    { name: 'fresh Host total, including zero, stays authoritative', recordedSeq: 50, latestUsageSeq: 40, hostTotal: 0, localTotal: .218, expected: '$0.000' },
    { name: 'newer usage marks overlapping public ledgers as a lower bound, never a sum', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: .218, expected: '≥$0.218' },
    { name: 'unpriced latest usage retains known money only as a lower bound', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: undefined, expected: '≥$0.100' },
    { name: 'incomplete local history cannot erase an older larger Host subtotal', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .3, localTotal: .218, expected: '≥$0.300' },
    { name: 'stale native bills are never mixed with public estimates', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: .218, source: 'native', expected: '≥$0.100' },
  ]) test(`${preset}: ${scenario.name}`, () => {
    const projections = { agentPreset: preset,
      dshHostObservation: { recordedSeq: scenario.recordedSeq, usage: { totalCostUsd: scenario.hostTotal }, cost: { source: scenario.source ?? 'publicPrice' } },
      sessionApiCost: { usage: scenario.localTotal === undefined ? {} : { totalCostUsd: scenario.localTotal }, cost: { source: 'publicPrice', latestUsageSeq: scenario.latestUsageSeq } },
    }
    const view = api.ApiValueSeat({ useProjection: key => projections[key], t: key => key })
    assert.equal(view.props.anchor.children[0], scenario.expected)
  })
}
test('thinking preview color changes continuously with the selected native level', () => {
  const options = ['low', 'medium', 'high', 'max'].map(id => ({ id, label: id }))
  const colors = options.map(({ id }) => api.ThinkingSlider({ label: 'Thinking', options, selected: id }).children[0].props.style['--ch-thinking-color'])
  assert.equal(new Set(colors).size, 4)
  assert.equal(colors[0], 'hsl(210 78% 58%)')
  assert.equal(colors[3], 'hsl(335 78% 58%)')
})
test('shared dock orders price before context, matching the native trailing context meter', () => {
  assert.match(source, /id: 'dsh-host-api-value', order: 2/)
  assert.match(source, /id: 'dsh-host-context', order: 3/)
})

test('DSH and external agents render the same unified cost breakdown card when buckets match', () => {
  const breakdown = {
    totalCostUsd: 71.73,
    inputCostUsd: 18.2,
    cacheReadCostUsd: 30.0,
    cacheWriteCostUsd: 0,
    outputCostUsd: 23.53,
    cacheSavingsUsd: 142.8,
    sessionCacheHitRatePercent: 93,
  }
  const collectText = node => {
    if (node == null || typeof node === 'boolean') return []
    if (typeof node === 'string' || typeof node === 'number') return [String(node)]
    if (Array.isArray(node)) return node.flatMap(collectText)
    return collectText(node.children)
  }
  for (const preset of [undefined, 'dsh-host-antigravity', 'dsh-host-codex', 'dsh-host-claude-code']) {
    const projections = {
      agentPreset: preset,
      sessionApiCost: { usage: breakdown, cost: { source: 'publicPrice', readingComplete: true, latestUsageSeq: 10 } },
      dshHostObservation: preset ? { recordedSeq: 10, usage: { totalCostUsd: 71.73, sessionCacheHitRatePercent: 93 }, cost: { source: 'publicPrice' } } : undefined,
    }
    const view = api.ApiValueSeat({ useProjection: key => projections[key], t: key => key })
    const texts = collectText(view.children)
    assert.ok(texts.includes('$71.73'), `${preset ?? 'dsh'}: hero total`)
    assert.ok(texts.includes('costInputWithCache'), `${preset ?? 'dsh'}: input incl cache label`)
    assert.ok(texts.includes('$48.20'), `${preset ?? 'dsh'}: input incl cache usd`)
    assert.ok(texts.includes('costOutput'), `${preset ?? 'dsh'}: output label`)
    assert.ok(texts.includes('$23.53'), `${preset ?? 'dsh'}: output usd`)
    assert.ok(texts.includes('93%'), `${preset ?? 'dsh'}: cache hit percent`)
    assert.ok(!texts.includes('publicPriceBadge'), `${preset ?? 'dsh'}: omits estimate badge`)
    assert.ok(!texts.includes('publicPrice'), `${preset ?? 'dsh'}: omits static public-price footnote`)
    assert.ok(!texts.includes('nativeCost'), `${preset ?? 'dsh'}: omits static native-cost footnote`)
  }
})

test('Host observation breakdown is preserved even when local sessionApiCost drifts', () => {
  const merged = hostApiCostObservation(
    {
      recordedSeq: 20,
      usage: { totalCostUsd: 50.09, inputCostUsd: 23.0, cacheReadCostUsd: 15.76, cacheWriteCostUsd: 0, outputCostUsd: 11.33, cacheSavingsUsd: 356.78 },
      cost: { source: 'publicPrice' },
    },
    {
      usage: { totalCostUsd: 64.34, inputCostUsd: 37.28, cacheReadCostUsd: 15.76, cacheWriteCostUsd: 0, outputCostUsd: 11.30 },
      cost: { source: 'publicPrice', latestUsageSeq: 20 },
    },
  )
  assert.equal(merged.usage.totalCostUsd, 50.09)
  assert.equal(merged.usage.inputCostUsd, 23.0)
  assert.equal(merged.usage.outputCostUsd, 11.33)
  assert.equal(merged.usage.cacheSavingsUsd, 356.78)
})

test('Claude Host total with 1h cache writes still borrows the local ledger breakdown', () => {
  // Real session 1f7a6fd1: local ledger prices cache writes at the 5m rate; Host bills the 1h rate.
  const merged = hostApiCostObservation(
    { recordedSeq: 215, usage: { totalCostUsd: 1.084355 }, cost: { source: 'publicPrice' } },
    { usage: { totalCostUsd: .954515, inputCostUsd: .02174, cacheReadCostUsd: .208895, cacheWriteCostUsd: .2164, outputCostUsd: .50748, cacheSavingsUsd: 3.96901 },
      cost: { source: 'publicPrice', latestUsageSeq: 212 } },
  )
  assert.equal(merged.usage.totalCostUsd, 1.084355)
  assert.ok(Math.abs(merged.usage.cacheWriteCostUsd - .34624) < 1e-9)
  assert.equal(merged.usage.outputCostUsd, .50748)
  // An unexplained gap (no cache writes to absorb it) keeps the panel summary-only.
  const plain = hostApiCostObservation(
    { recordedSeq: 215, usage: { totalCostUsd: 1.084355 }, cost: { source: 'publicPrice' } },
    { usage: { totalCostUsd: .7, inputCostUsd: .2, cacheReadCostUsd: 0, cacheWriteCostUsd: 0, outputCostUsd: .5 }, cost: { source: 'publicPrice', latestUsageSeq: 212 } },
  )
  assert.equal(plain.usage.inputCostUsd, undefined)
})
