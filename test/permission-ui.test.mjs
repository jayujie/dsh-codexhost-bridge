import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { hostPermissionOptions, hostPermissionPresentation } from '../permission-presentation.mjs'

const claudeModes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'].map(id => Object.freeze({ id, label: id }))
const codexModes = ['read-only', 'workspace-write', 'full-access'].map(id => ({ id, label: id }))

test('Claude presentation contains exactly three native modes, preserving IDs and source catalog', () => {
  const options = hostPermissionOptions('claude-code', claudeModes)
  assert.deepEqual(options.map(mode => mode.id), ['plan', 'acceptEdits', 'bypassPermissions'])
  assert.deepEqual(options.map(mode => mode.labelKey), ['permissionPlan', 'permissionEdit', 'permissionFullAccess'])
  assert.deepEqual(options.map(mode => mode.iconKind), ['read-only', 'workspace-write', 'full-access'])
  assert.deepEqual(options.map(mode => mode.dangerous), [false, false, true])
  assert.equal(claudeModes.length, 5)
  assert.equal(claudeModes[3].dangerous, undefined)
})

test('missing upstream modes are not fabricated and native default/auto are never remapped', () => {
  assert.deepEqual(hostPermissionOptions('claude-code', claudeModes.filter(mode => mode.id === 'plan')).map(mode => mode.id), ['plan'])
  for (const id of ['default', 'auto']) {
    const view = hostPermissionPresentation('claude-code', { id, label: 'upstream value' })
    assert.equal(view.id, id); assert.equal(view.iconKind, undefined)
    assert.equal(view.labelKey, id === 'default' ? 'permissionNativeDefault' : 'permissionNativeAuto')
  }
  assert.deepEqual(hostPermissionOptions('unknown', claudeModes), [])
})

test('Codex keeps native policies and shares the DSH permission artwork roles', () => {
  const modes = hostPermissionOptions('codex', codexModes)
  assert.deepEqual(modes.map(mode => mode.id), ['read-only', 'workspace-write', 'full-access'])
  assert.deepEqual(modes.map(mode => mode.iconKind), ['read-only', 'workspace-write', 'full-access'])
  assert.equal(modes[2].dangerous, true)
})

const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
function fixture(agentId = 'claude-code', permissionModeId = 'plan', running = false, locked = false) {
  const stored = [], calls = []
  let cursor = 0
  const icons = { PermissionIconReadOnlyRegular: function DshReadOnly() {}, PermissionIconWorkspaceWriteRegular: function DshWorkspaceWrite() {}, PermissionIconFullAccessRegular: function DshFullAccess() {}, IconChevronDownOutlineRegular: function DshChevron() {} }
  const catalog = { agentId, selection: { permissionModeId }, permissionModes: agentId === 'codex' ? codexModes : claudeModes }
  const state = { status: 'ready', catalog }
  const bindings = {
    ...icons, hostPermissionOptions, hostPermissionPresentation,
    h: (tag, props, ...children) => ({ tag, props, children }), Menu: function Menu() {}, RiskConfirmation: function RiskConfirmation() {},
    useState(initial) { const slot = cursor++; if (!(slot in stored)) stored[slot] = initial; return [stored[slot], next => { stored[slot] = typeof next === 'function' ? next(stored[slot]) : next }] },
    useEffect() {}, useSyncExternalStore: () => state,
  }
  const api = vm.runInNewContext(source + '\n;({HostPermission,Picker,zh})', bindings)
  const directory = { subscribe() {}, getSnapshot: () => state, configure: async value => calls.push(value) }
  const render = () => { cursor = 0; return api.HostPermission({ sessionId: 'one', hostDirectory: directory, locked, useSessions: fn => fn({ byId: { one: { running } } }), hostT: key => api.zh[key] ?? key }) }
  const menu = () => render().children[0]
  const risk = () => render().children[1]
  return { menu, risk, calls, icons, api, state, render }
}

for (const agent of ['claude-code', 'codex']) {
  test(`${agent} menu and trigger render the actual shared DSH permission glyph components`, () => {
    const f = fixture(agent)
    const picker = f.menu()
    assert.deepEqual(Array.from(picker.props.options, option => option.label), agent === 'claude-code' ? ['规划模式', '编辑模式', '完全权限'] : ['仅可查看', '工作区内修改', '完全权限'])
    assert.deepEqual(Array.from(picker.props.options, option => option.icon.tag), [f.icons.PermissionIconReadOnlyRegular, f.icons.PermissionIconWorkspaceWriteRegular, f.icons.PermissionIconFullAccessRegular])
    assert.equal(picker.props.nativePermission, true)
    const menu = f.api.Picker(picker.props)
    const chevron = menu.props.anchor.children.at(-1)
    assert.equal(chevron.children[0].tag, f.icons.IconChevronDownOutlineRegular)
  })
}

test('Claude edit selection sends acceptEdits unchanged and hidden modes cannot be picked', async () => {
  const f = fixture()
  await f.menu().props.onSelect('acceptEdits')
  assert.deepEqual(f.calls.map(value => value.permissionModeId), ['acceptEdits'])
  await f.menu().props.onSelect('default'); await f.menu().props.onSelect('auto'); await f.menu().props.onSelect('invented')
  assert.equal(f.calls.length, 1)
})

test('existing native default is displayed truthfully without changing or escalating it', () => {
  const f = fixture('claude-code', 'default')
  assert.equal(f.menu().props.caption, '默认（原生）')
  assert.equal(f.menu().props.selected, 'default')
  assert.equal(f.calls.length, 0)
})

for (const [agent, target] of [['claude-code', 'bypassPermissions'], ['codex', 'full-access']]) {
  test(`${agent} full permission requires a separate acknowledged confirmation even if upstream omits dangerous`, async () => {
    const f = fixture(agent)
    await f.menu().props.onSelect(target)
    assert.equal(f.calls.length, 0)
    let risk = f.risk(); assert.ok(risk)
    assert.equal(risk.props.title, '启用完全权限？')
    risk.props.onConfirm(); assert.equal(f.calls.length, 0)
    risk.props.onAcknowledgedChange(true)
    risk = f.risk(); risk.props.onConfirm()
    assert.deepEqual(f.calls.map(value => value.permissionModeId), [target])
  })
}

test('running conversations can queue permission changes for the next turn when composer is not locked', async () => {
  const f = fixture('claude-code', 'plan', true, false)
  assert.equal(f.menu().props.disabled, false)
  await f.menu().props.onSelect('acceptEdits')
  assert.deepEqual(f.calls.map(value => value.permissionModeId), ['acceptEdits'])
  await f.menu().props.onSelect('bypassPermissions')
  assert.ok(f.risk())
})

test('locked conversations cannot change permissions through a stale selection callback', async () => {
  const f = fixture('claude-code', 'plan', false, true)
  assert.equal(f.menu().props.disabled, true)
  await f.menu().props.onSelect('acceptEdits'); await f.menu().props.onSelect('bypassPermissions')
  assert.equal(f.calls.length, 0); assert.equal(f.risk(), null)
})
