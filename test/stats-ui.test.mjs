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
  assert.equal(view.props.anchor.props['data-codexhost-api-value'], '')
})
test('native DSH uses its local expense projection, not a stale Host observation', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'sessionApiCost' ? { usage: { totalCostUsd: .123 }, cost: { source: 'publicPrice' } } : key === 'codexHostObservation' ? { usage: { totalCostUsd: 99 }, cost: { source: 'native' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.123')
})

test('Host without a cost observation prices recorded Turn usage locally', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'agentPreset' ? 'codexhost-codex' : key === 'sessionApiCost' ? { usage: { totalCostUsd: .218 }, cost: { source: 'publicPrice' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.218')
})
test('Host reported cost wins over local pricing without summing both totals', () => {
  const view = api.ApiValueSeat({ useProjection: key => key === 'agentPreset' ? 'codexhost-codex' : key === 'sessionApiCost' ? { usage: { totalCostUsd: .218 }, cost: { source: 'publicPrice' } } : key === 'codexHostObservation' ? { usage: { totalCostUsd: .3 }, cost: { source: 'native' } } : undefined, t: key => key })
  assert.equal(view.props.anchor.children[0], '$0.300')
})
for (const preset of ['codexhost-codex', 'codexhost-claude-code']) {
  for (const scenario of [
    { name: 'fresh Host total, including zero, stays authoritative', recordedSeq: 50, latestUsageSeq: 40, hostTotal: 0, localTotal: .218, expected: '$0.000' },
    { name: 'newer usage marks overlapping public ledgers as a lower bound, never a sum', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: .218, expected: '≥$0.218' },
    { name: 'unpriced latest usage retains known money only as a lower bound', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: undefined, expected: '≥$0.100' },
    { name: 'incomplete local history cannot erase an older larger Host subtotal', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .3, localTotal: .218, expected: '≥$0.300' },
    { name: 'stale native bills are never mixed with public estimates', recordedSeq: 30, latestUsageSeq: 40, hostTotal: .1, localTotal: .218, source: 'native', expected: '≥$0.100' },
  ]) test(`${preset}: ${scenario.name}`, () => {
    const projections = { agentPreset: preset,
      codexHostObservation: { recordedSeq: scenario.recordedSeq, usage: { totalCostUsd: scenario.hostTotal }, cost: { source: scenario.source ?? 'publicPrice' } },
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
  assert.match(source, /id: 'codexhost-api-value', order: 2/)
  assert.match(source, /id: 'codexhost-context', order: 3/)
})
