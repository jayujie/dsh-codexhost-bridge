import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
function mount(directory) {
  const state = [], deps = [], cleanups = [], effects = []
  let i = 0, tree, props = { hostDirectory: directory, disabled: false, t: x => x }
  const component = vm.runInNewContext(source + '\n;NativeRecoveryControl', {
    Menu: 'menu', h: (type, p, ...children) => ({ type, props: p ?? {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) }),
    useState(value) { const k = i++; if (!(k in state)) state[k] = value; return [state[k], value => { state[k] = typeof value === 'function' ? value(state[k]) : value }] },
    useRef(value) { return state[i++] ??= { current: value } },
    useEffect(fn, next) { const k = i++; if (!deps[k] || next.some((v, n) => v !== deps[k][n])) { effects.push(() => { cleanups[k]?.(); cleanups[k] = fn() }); deps[k] = next } },
  })
  const render = () => { i = 0; tree = component(props); while (effects.length) effects.shift()(); return tree }
  const text = n => typeof n === 'object' ? n.children.map(text).join('') : String(n)
  const nodes = (n = tree) => typeof n === 'object' ? [n, ...(n.props.anchor ? nodes(n.props.anchor) : []), ...n.children.flatMap(c => nodes(c))] : []
  render(); render()
  return { render, nodes, text: () => text(tree), button: label => nodes().find(n => n.type === 'button' && text(n) === label), setDirectory(value) { props = { ...props, hostDirectory: value }; render(); render() }, async settle() { await new Promise(r => setImmediate(r)); render() } }
}

test('outcome recovery sits in the left composer group for external engines only', () => {
  const h = (type, props, ...children) => ({ type, props, children })
  const { NativeAgentControls, NativeLeftControls, NativeRecoveryControl, QuotaResumeControl } = vm.runInNewContext(source + '\n;({ NativeAgentControls, NativeLeftControls, NativeRecoveryControl, QuotaResumeControl })', {
    h, AGENT_ICONS: {}, DelegationPicker() {}, useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  })
  const hostDirectory = { subscribe() {}, getSnapshot: () => ({ status: 'error' }) }
  const hooks = (preset, summary, quota) => ({ sessionId: 'test', hostDirectory, useProjection: key => key === 'agentPreset' ? preset : quota,
    useSessions: select => select({ byId: { test: summary } }), useSession: select => select({ subagent: null, pendingSubmissions: [] }), useInput: select => select({}), t: key => key })
  function control(preset, summary) {
    const tree = NativeLeftControls(hooks(preset, summary))
    return tree?.children.find(child => child?.type === NativeRecoveryControl)
  }
  for (const preset of ['codexhost-claude-code', 'codexhost-codex']) {
    assert.equal(control(preset, {}).props.hostDirectory, hostDirectory)
    assert.equal(control(preset, {}).props.disabled, false)
    assert.equal(control(preset, { running: true }).props.disabled, true)
    assert.equal(control(preset, { origin: 'subagent' }), undefined)
    const right = NativeAgentControls(hooks(preset, {}))
    assert.equal(right.children.some(child => child?.type === NativeRecoveryControl), false, 'Right group no longer carries the outcome check')
  }
  assert.equal(control('deepseek-harness', {}), undefined)
  const paused = { streak: 1, paused: { turn: 1, resetAt: 1, failedAt: 0, seq: 9 } }
  const quotaOf = preset => NativeLeftControls(hooks(preset, {}, paused)).children.find(child => child?.type === QuotaResumeControl)
  assert.equal(quotaOf('codexhost-claude-code').props.quota, paused)
  assert.equal(quotaOf('codexhost-codex'), undefined, 'Quota resume is Claude-only')
  assert.equal(NativeLeftControls(hooks('codexhost-claude-code', {})).children.some(child => child?.type === QuotaResumeControl), false)
})

test('recovery dialog requires acknowledgement and prevents duplicate commit', async () => {
  let commits = 0, finish
  const ui = mount({ checkRecovery: async () => ({ status: 'recoverable', reason: 'terminal-confirmed', expected: 'a'.repeat(64), outcome: 'failed' }), reconcileRecovery: () => { commits++; return new Promise(resolve => { finish = resolve }) }, load: async () => {} })
  ui.button('recovery').props.onClick(); ui.render(); await ui.settle()
  assert.match(ui.text(), /recovery_failed/)
  assert.equal(ui.button('recoveryConfirm').props.disabled, true)
  await ui.button('recoveryConfirm').props.onClick()
  assert.equal(commits, 0)
  ui.nodes().find(n => n.type === 'input').props.onChange({ target: { checked: true } }); ui.render()
  const commit = ui.button('recoveryConfirm').props.onClick
  const pending = commit(); await commit(); ui.render()
  assert.equal(commits, 1)
  finish({ status: 'recovered', reason: 'unlocked', outcome: 'failed' }); await pending; ui.render()
  assert.match(ui.text(), /recovery_unlocked/)
  assert.equal(ui.button('recoveryConfirm'), undefined)
})

test('late recovery response from the previous session is not shown in the new session', async () => {
  let finish
  const ui = mount({ checkRecovery: () => new Promise(resolve => { finish = resolve }) })
  ui.button('recovery').props.onClick(); ui.render()
  ui.setDirectory({ checkRecovery: async () => ({ status: 'clear', reason: 'no-pending' }) })
  finish({ status: 'recoverable', reason: 'terminal-confirmed', expected: 'a'.repeat(64) }); await ui.settle()
  assert.equal(ui.button('recoveryConfirm'), undefined)
  assert.doesNotMatch(ui.text(), /recovery_terminal-confirmed/)
})

test('recovery read failure shows an error but does not offer a force-reset button', async () => {
  const ui = mount({ checkRecovery: async () => { throw new Error('offline') } })
  ui.button('recovery').props.onClick(); ui.render(); await ui.settle()
  assert.match(ui.text(), /offline/)
  assert.equal(ui.button('recoveryConfirm'), undefined)
})
