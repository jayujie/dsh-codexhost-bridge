import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { dshClaudeThinkingOptionIds } from '../claude-efforts.mjs'

const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
function fixture(options = {}) {
  const state = [], calls = []; let cursor = 0
  const slider = { Root() {}, Track() {}, Range() {}, Thumb() {} }, icon = function NativeDshChevron() {}
  const api = vm.runInNewContext(source + '\n;({ThinkingSlider,Picker,css})', {
    h: (tag, props, ...children) => ({ tag, props, children }), Menu() {}, IconChevronDownOutlineRegular: icon,
    getSliderPrimitive: () => slider, useEffect() {},
    useState(initial) { const at = cursor++; if (!(at in state)) state[at] = initial; return [state[at], value => { state[at] = typeof value === 'function' ? value(state[at]) : value }] },
    useRef(initial) { const at = cursor++; if (!(at in state)) state[at] = { current: initial }; return state[at] },
  })
  const props = { label: '思考', caption: 'high', modelLabel: 'test model', options: ['low','medium','high','xhigh','max'].map(id => ({ id, label: id })), selected: 'high', onSelect: id => calls.push(id), disabled: false, ...options }
  const render = () => { cursor = 0; return api.ThinkingSlider(props) }
  const root = () => render().children[0].children[2]
  const open = () => { render().props.anchor.props.onClick(); return root() }
  return { api, props, calls, render, root, open, slider, icon }
}

test('every dropdown uses the actual DSH chevron rather than a text glyph', () => {
  const f = fixture()
  const picker = f.api.Picker({ label: '模型', caption: 'test', options: [] })
  assert.equal(picker.props.anchor.children.at(-1).children[0].tag, f.icon)
  assert.equal(f.render().props.anchor.children.at(-1).children[0].tag, f.icon)
  assert.doesNotMatch(source, /['"]⌄['"]/)
})

test('Radix drag previews fractional positions but commits exactly one declared effort on release', () => {
  const f = fixture(), root = f.open()
  assert.equal(root.tag, f.slider.Root)
  root.props.onPointerDown()
  for (const value of [.2, .8, 1.1, 2.2, 2.7]) root.props.onValueChange([value])
  assert.equal(f.calls.length, 0); assert.equal(f.root().props.value[0], 2.7)
  f.root().props.onValueCommit([2.7]); f.root().props.onValueCommit([2.7])
  assert.deepEqual(f.calls, ['xhigh'])
})

test('pointer cancellation rolls back without dispatch and the next gesture remains usable', () => {
  const f = fixture(), root = f.open()
  root.props.onPointerDown(); root.props.onValueChange([4]); root.props.onPointerCancel(); f.root().props.onValueCommit([4])
  assert.equal(f.calls.length, 0); assert.equal(f.root().props.value[0], 2)
  f.root().props.onPointerDown(); f.root().props.onValueCommit([4]); assert.deepEqual(f.calls, ['max'])
})

test('keyboard navigates whole catalog positions and commits on key release', () => {
  const f = fixture(); f.open()
  let stopped = 0, prevented = 0
  const event = { key: 'Home', stopPropagation() { stopped++ }, preventDefault() { prevented++ } }
  f.root().props.onKeyDown(event); assert.equal(f.calls.length, 0); assert.equal(f.root().props.value[0], 0)
  f.root().props.onKeyUp(event); assert.deepEqual(f.calls, ['low']); assert.ok(stopped > 0 && prevented > 0)
})

test('disabled and single-level sliders cannot dispatch an unsupported setting', () => {
  const f = fixture({ disabled: true }); f.open(); f.root().props.onValueChange([4]); f.root().props.onValueCommit([4]); assert.equal(f.calls.length, 0)
  const single = fixture({ options: [{ id: 'high', label: 'high' }] }); single.open()
  assert.equal(single.root().props.disabled, true); assert.equal(single.root().props.max, 1)
  assert.equal(single.root().children[1].props['aria-valuemax'], 0)
})

test('saving an inline level preserves the focusable thumb while blocking duplicate gestures', () => {
  const f = fixture({ inline: true, saving: true, disabled: true })
  const card = f.render(), root = card.children[2]
  assert.equal(card.props['data-saving'], 'true')
  assert.equal(root.props.disabled, false, 'Do not disable/remount the Radix thumb during a save')
  assert.equal(root.props['aria-busy'], true)
  let prevented = 0
  root.props.onPointerDownCapture({ preventDefault() { prevented++ }, stopPropagation() {} })
  root.props.onKeyDown({ key: 'End', preventDefault() { prevented++ }, stopPropagation() {} })
  root.props.onValueChange([4]); root.props.onValueCommit([4])
  assert.equal(prevented, 2)
  assert.equal(f.calls.length, 0)
})

test('old overflow wrapper and drag shrink/lag animations are gone', () => {
  const f = fixture()
  assert.doesNotMatch(f.api.css, /ch-thinking-thumb-position|scale\(\.94\)|ch-range-progress/)
  assert.match(f.api.css, /\.ch-thinking-track[^}]*overflow:hidden/)
  assert.match(f.api.css, /\.ch-thinking-track[^}]*height:24px/)
  assert.match(f.api.css, /\.ch-thinking-thumb[^}]*width:var\(--ch-thinking-thumb\)/)
  assert.doesNotMatch(f.api.css, /border:2px solid var\(--dsw-alias-state-business-primary\)/)
})

test('vendored Radix runtime matches its reviewed output manifest and stays lazy/shared-React', async () => {
  const text = await readFile(new URL('../slider-runtime.mjs', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../slider-build-manifest.json', import.meta.url), 'utf8'))
  assert.equal(createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex'), manifest.outputSha256)
  assert.equal(manifest.package, '@radix-ui/react-slider'); assert.equal(manifest.version, '1.3.6')
  assert.match(text, /export function getSliderPrimitive/); assert.match(text, /if \(sliderPrimitive\) return sliderPrimitive/)
})

test('Claude explicit CLI capabilities limit xhigh/max instead of advertising five levels for every model', () => {
  assert.deepEqual(dshClaudeThinkingOptionIds({ supportsEffort: true, supportedEffortLevels: ['low','medium','high'] }), ['off','auto','low','medium','high'])
  assert.deepEqual(dshClaudeThinkingOptionIds({ supportsEffort: true, supportedEffortLevels: ['max','high','low','xhigh','medium'] }), ['off','auto','low','medium','high','xhigh','max','ultracode'])
  assert.deepEqual(dshClaudeThinkingOptionIds({ supportsEffort: false, supportedEffortLevels: ['max'] }), ['off','auto'])
  assert.deepEqual(dshClaudeThinkingOptionIds({}), ['off','auto'])
  assert.deepEqual(dshClaudeThinkingOptionIds({ supportsThinkingOff: false, supportedEffortLevels: ['high','invented'] }), ['auto','high'])
})

test('actual shipped Claude adapter preserves CLI capability fields and sends selected effort IDs unchanged', async () => {
  const text = await readFile(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  assert.match(text, /supportedThinkingOptionIds: dshClaudeThinkingOptionIds\(row\)/)
  assert.match(text, /supportedEffortLevels: external_exports\.array\(external_exports\.string\(\)\)\.optional\(\)/)
  const from = text.indexOf('function claudeThinkingConfiguration('), to = text.indexOf('var CLAUDE_MODEL_REF_PREFIX', from)
  const api = vm.runInNewContext(text.slice(from, to) + '\n;({claudeThinkingConfiguration,claudeThinkingFlagSettings})', { parseClaudeThinkingOptionId: id => id })
  for (const id of ['low','medium','high','xhigh','max']) {
    const thinking = api.claudeThinkingConfiguration(id)
    assert.equal(thinking.effort, id); assert.equal(api.claudeThinkingFlagSettings(thinking).effortLevel, id)
  }
})
