import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {hostModelPresentation} from '../native-ui-projections.mjs'

const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
function fixture({owner = 'deepseek-harness', addressed = true, listed = false, observation, identity, selection = {lastUsed: {provider: 'native', model: 'actual-native-model'}}} = {}) {
  const loads = [], state = {status: 'error', error: 'ordinary Agent RPC cannot address this child', catalog: null}
  const h = (tag, props, ...children) => ({tag, props, children})
  const api = vm.runInNewContext(source + '\n;({NativeAgentControls,ChildAgentIdentity,PermissionSeat,hostModelSnapshot,zh})', {
    h, hostModelPresentation, useState: initial => [initial, () => {}], useRef: value => ({ current: value }), useEffect: fn => fn(), useSyncExternalStore: (_subscribe, get) => get(),
    AGENT_ICONS: {codex: 'codex', 'claude-code': 'claude', antigravity: 'agy', 'deepseek-harness': 'dsh'}, DelegationPicker() {},
    Menu() {}, RiskConfirmation() {}, IconChevronDownOutlineRegular() {},
  })
  const props = {sessionId: 'child', hostDirectory: {subscribe() {}, getSnapshot: () => state, modelStore: { getSnapshot: () => null }, load: preset => loads.push(preset)},
    useProjection: key => key === 'agentPreset' ? owner === 'deepseek-harness' ? 'research-lite' : 'codexhost-' + owner : key === 'modelSelection' ? selection : key === 'dshHostObservation' ? observation : key === 'dshHostModelIdentity' ? identity : undefined,
    useSession: select => select({subagent: addressed ? {parentSessionId: 'parent'} : null}),
    useSessions: select => select({byId: {child: {origin: listed ? 'subagent' : 'user', running: false, blank: false}}}),
    useInput: select => select({phase: 'plain'}), t: key => api.zh[key] ?? key,
  }
  return {api, props, loads, state, render: () => api.NativeAgentControls(props)}
}
for (const owner of ['deepseek-harness', 'codex', 'claude-code', 'antigravity']) {
  test(`${owner} addressed child reads engine/model facts without catalog RPC or console error`, () => {
    const f = fixture({owner, observation: {harnessId: owner, model: 'actual-host-model'}})
    const control = f.render()
    assert.equal(control.tag, f.api.ChildAgentIdentity)
    const identity = control.tag(control.props)
    assert.equal(identity.props['data-child-engine'], owner)
    assert.equal(identity.props.role, 'group')
    assert.match(identity.props['aria-label'], owner === 'deepseek-harness' ? /actual-native-model/ : /actual-host-model/)
    assert.equal(f.loads.length, 0)
    assert.equal(identity.children.some(child => child?.tag === 'button'), false, 'identity is not a model or permission selector')
    assert.doesNotMatch(JSON.stringify(identity), /打开控制台|ordinary Agent RPC/)
  })
}
for (const owner of ['codex', 'claude-code', 'antigravity']) test(`${owner} child shows recorded identity without usage observations`, () => {
  const f = fixture({owner, identity: {harnessId: owner, model: 'recorded-model'}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /recorded-model/)
  assert.doesNotMatch(identity.props['aria-label'], /模型尚未记录/)
  assert.equal(f.loads.length, 0)
})
test('selected-only Codex model is explicitly labelled before an assistant record exists', () => {
  const f = fixture({owner: 'codex', identity: {harnessId: 'codex', selectedModel: 'gpt-selected'}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /gpt-selected（已选模型）/)
})
test('current identity takes precedence over a stale usage observation', () => {
  const f = fixture({owner: 'claude-code', identity: {harnessId: 'claude-code', model: 'claude-recorded'}, observation: {harnessId: 'claude-code', model: 'claude-model-v1.ZGVmYXVsdA'}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /claude-recorded/)
})
test('the actual screenshot default ref is shown as unresolved default, not an opaque id or guessed model', () => {
  const f = fixture({owner: 'claude-code', observation: {harnessId: 'claude-code', model: 'claude-model-v1.ZGVmYXVsdA'}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /默认（具体型号未记录）/)
  assert.doesNotMatch(identity.props['aria-label'], /claude-model-v1|Opus|Haiku|Sonnet/)
})
test('Claude model menu excludes default while preserving an existing default selection label', () => {
  const f = fixture({owner: 'claude-code', addressed: false})
  const ref = value => 'claude-model-v1.' + Buffer.from(value).toString('base64url')
  f.state.status = 'ready'; f.state.error = ''
  f.state.catalog = {agentId: 'claude-code', models: ['default','opus','sonnet'].map(value => ({id:ref(value),label:value,thinkingOptions:[]})), selection:{modelId:ref('default')}}
  const current = f.api.hostModelSnapshot(f.state)
  assert.equal(current.current.model, ref('default'), 'Retain the legacy selection without switching it')
  f.state.catalog.selection.modelId = ref('opus')
  const next = f.api.hostModelSnapshot(f.state)
  assert.deepEqual(Array.from(next.groups[0].models, model => model.id), [ref('opus'), ref('sonnet')])
})
test('listed child protection also applies before its addressed snapshot arrives', () => {
  const f = fixture({owner: 'codex', addressed: false, listed: true})
  assert.equal(f.render().tag, f.api.ChildAgentIdentity)
  assert.equal(f.loads.length, 0)
})
test('external children never display an unrelated native model or an unsupported permission picker', () => {
  const f = fixture({owner: 'claude-code', observation: {harnessId: 'codex', model: 'other-model'}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /模型尚未记录/)
  assert.doesNotMatch(identity.props['aria-label'], /actual-native-model|other-model/)
  assert.equal(f.api.PermissionSeat(f.props), null)
})
test('a planned native model is not presented as an actual execution record', () => {
  const f = fixture({selection: {lastUsed: null, next: {model: 'planned-only'}}})
  const control = f.render(), identity = control.tag(control.props)
  assert.match(identity.props['aria-label'], /模型尚未记录/)
  assert.doesNotMatch(identity.props['aria-label'], /planned-only/)
})
test('native root controls do not query Host catalogs just to show a DSH icon', () => {
  const f = fixture({addressed: false})
  f.render()
  assert.equal(f.loads.length, 0)
})
for (const owner of ['codex', 'claude-code', 'antigravity']) test(`${owner} ordinary root retains catalog loads and visible real Host failures`, () => {
  const f = fixture({owner, addressed: false})
  const control = f.render()
  assert.equal(f.loads.length, 1)
  assert.ok(control.children.some(child => child?.props?.className === 'ch-native-error'))
})
