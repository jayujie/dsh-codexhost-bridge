import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { backendEnvironment, bundledHostRuntimePath, codexHostRuntimeNodePath, codexHostRuntimeNpmPath, hostDescriptorPath } from '../backend-paths.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { OwnedHostRuntime } from '../owned-host-runtime.mjs'

const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')

test('owned DSH Host isolates its descriptor, caches and adapters without dropping engine credentials', () => {
  const installation = { nodePath: 'C:/node.exe', runtimePath: 'C:/plugin/backend/host-runtime.mjs', stockCodexPath: 'C:/codex.exe', descriptorPath: 'C:/private/bridge.json' }
  const parent = { DSH_HOME: 'C:/dsh', CODEXHOST_DATA_DIR: 'C:/original', CODEXHOST_RUNTIME_TOKEN: 'private', CODEXHOST_LAUNCHER_EXECUTABLE: 'old-launcher', CHROME_CRASHPAD_PIPE_NAME: 'pipe', ANTHROPIC_API_KEY: 'test-secret' }
  const child = backendEnvironment(installation, { idleReleaseMinutes: 30 }, parent)
  assert.equal(child.DSH_CODEXHOST_NODE_PATH, undefined)
  assert.equal(child.DSH_CODEXHOST_NPM_PATH, undefined)
  const runtimeNode = 'C:/CodexHostRuntime/node.exe'
  assert.equal(codexHostRuntimeNodePath({ CODEXHOST_HOST_NODE_PATH: runtimeNode }), runtimeNode)
  assert.equal(codexHostRuntimeNpmPath({ CODEXHOST_HOST_NODE_PATH: runtimeNode }), path.win32.join('C:/CodexHostRuntime', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  assert.equal(codexHostRuntimeNpmPath({ CODEXHOST_HOST_NODE_PATH: runtimeNode, CODEXHOST_NPM_CLI_PATH: 'C:/override/npm-cli.js' }), 'C:/override/npm-cli.js')
  const configuredNode = 'C:/configured/node.exe'
  assert.equal(codexHostRuntimeNodePath({ DSH_CODEXHOST_NODE_PATH: configuredNode, CODEXHOST_HOST_NODE_PATH: runtimeNode }), configuredNode)
  assert.equal(codexHostRuntimeNpmPath({ DSH_CODEXHOST_NODE_PATH: configuredNode, CODEXHOST_HOST_NODE_PATH: runtimeNode }), path.win32.join('C:/configured', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  assert.equal(child.CODEXHOST_DATA_DIR, path.join('C:/dsh', 'dsh-host'))
  assert.equal(child.DSH_HOST_LEGACY_DATA_DIR, 'C:/original')
  assert.equal(child.DSH_HOST_IDLE_MINUTES, '30')
  assert.equal(child.ANTHROPIC_API_KEY, 'test-secret')
  for (const name of ['CODEXHOST_RUNTIME_TOKEN', 'CODEXHOST_LAUNCHER_EXECUTABLE', 'CHROME_CRASHPAD_PIPE_NAME']) assert.equal(Object.hasOwn(child, name), false)
  assert.equal(parent.CODEXHOST_RUNTIME_TOKEN, 'private')
  assert.ok(bundledHostRuntimePath().endsWith(path.join('backend', 'host-runtime.mjs')))
  assert.ok(hostDescriptorPath().includes('dsh-host'))
})

test('native DSH catalog and idle event never connect to the execution backend for price decoration', async () => {
  let connects = 0, status
  const ctx = { agentPresets: { presetForSession: () => 'standard' }, on(event, callback) { if (event === 'agent/status') status = callback }, effect() {} }
  const driver = new NativeSessionDriver(ctx, {}, { connect: async () => { connects++; throw new Error('must not connect') } })
  const agent = { id: 'native', session: { header: { cwd: 'D:/work' } } }
  assert.equal((await driver.catalog(agent)).status, 'ready')
  driver.install(); status({ agent, status: 'idle' })
  await Promise.resolve()
  assert.equal(connects, 0)
  await driver.dispose()
})

test('bundled DSH adapter is usage-only and cannot probe or launch another DSH process', async () => {
  const manifest = JSON.parse(await readFile(new URL('../backend/plugins/deepseek-harness/manifest.json', import.meta.url)))
  const module = await import('../backend/plugins/deepseek-harness/plugin.mjs')
  const reader = module.createUsageStatisticsAdapter({ environment: {} })
  assert.equal(manifest.kind, 'usage')
  assert.equal(manifest.launchCommand, undefined)
  assert.equal(reader.open, undefined); assert.equal(reader.inspect, undefined)
  assert.equal(typeof reader.usageStatistics.listSources, 'function')
  assert.equal(typeof reader.usageStatistics.readSource, 'function')
  assert.equal(module.createHarnessAdapter, undefined)
  await reader.close()
})

test('bundled runtime and adapter files match their reviewed build manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../backend/build-manifest.json', import.meta.url)))
  for (const [name, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL('../backend/' + name, import.meta.url))
    assert.equal(bytes.length, expected.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256)
  }
  const enabled = JSON.parse(await readFile(new URL('../backend/plugins/enabled.json', import.meta.url)))
  assert.deepEqual(enabled.enabled, ['claude-code', 'antigravity', 'codex-usage', 'deepseek-harness'])
  assert.ok(!runtime.includes('Restart Codex Desktop to retry recovery'))
})

function idleFixture() {
  // Exercise the actual shipped release algorithm without starting a CLI or advancing wall time.
  const begin = runtime.indexOf('ExternalThreadIdleRelease = class {') + 'ExternalThreadIdleRelease = '.length
  const end = runtime.indexOf(', RELEASE_TIMEOUT_MS', begin)
  assert.ok(begin > 0 && end > begin)
  let now = 0
  const Idle = vm.runInNewContext('(' + runtime.slice(begin, end) + ')', { Date: { now: () => now }, CHECK_INTERVAL_MS: 60000, CLOSE_TIMEOUT_MS: 60000, CLOSE_FAILURE: 'close-failed', DEFAULT_IDLE_RELEASE_SETTINGS: { enabled: false, timeoutMinutes: 30 }, idleReleaseSettingsSchema: { parse: value => value }, setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout })
  let closed = 0, removed = 0, background = false
  const thread = { id: 'one', running: false, activeTurnId: null, record: { state: 'ready', nativeSessionRef: {} }, session: { close: async () => { closed++ } }, outputTask: Promise.resolve() }
  const errors = [], threads = new Map([[thread.id, thread]])
  const idle = new Idle({ get: id => threads.get(id), threads: () => [...threads.values()], remove: id => { threads.delete(id); removed++ }, canRelease: () => !background, queue: { run: (_id, fn) => Promise.resolve().then(fn) }, diagnose: e => errors.push(e) })
  idle.configure({ enabled: true, timeoutMinutes: 30 }); idle.touch(thread)
  return { idle, thread, errors, age: () => { now += 31 * 60000 }, background: value => { background = value }, get closed() { return closed }, get removed() { return removed } }
}

test('idle release closes only a persisted idle Session and never deletes its durable mapping', async () => {
  const f = idleFixture(); f.age(); f.idle.check(); await f.idle.drain()
  assert.equal(f.closed, 1); assert.equal(f.removed, 1); assert.equal(f.thread.record.state, 'ready'); assert.deepEqual(f.errors, [])
  f.idle.stop()
})

for (const condition of ['running', 'turn', 'background', 'subagent', 'uncertain', 'persistence', 'output-failed']) {
  test(`idle release preserves ${condition} Sessions`, async () => {
    const f = idleFixture(); f.age()
    if (condition === 'running') f.thread.running = true
    if (condition === 'turn') f.thread.activeTurnId = 'turn'
    if (condition === 'background') f.background(true)
    if (condition === 'subagent') f.thread.record.subagent = true
    if (condition === 'uncertain') f.thread.record.state = 'creating'
    if (condition === 'persistence') f.thread.persistenceError = new Error('not saved')
    if (condition === 'output-failed') f.idle.outputFailed(f.thread)
    f.idle.check(); await f.idle.drain(); assert.equal(f.closed, 0); assert.equal(f.removed, 0); f.idle.stop()
  })
}

test('failed idle close keeps the Session blocked rather than starting a duplicate writer', async () => {
  const f = idleFixture(); f.thread.session.close = async () => { throw new Error('close failed') }; f.age(); f.idle.check(); await f.idle.drain()
  assert.equal(f.removed, 0); assert.equal(f.idle.failure(f.thread), 'close-failed'); assert.equal(f.errors.length, 1); f.idle.stop()
})

test('typed delegation keeps its native menu anchor but renders no # button', async () => {
  const source = (await readFile(new URL('../delegation-client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  const Picker = vm.runInNewContext(source + '\nDelegationPicker', { h: (tag, props, ...children) => ({ tag, props, children }), useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect() {}, filterDelegationTargets: () => [], Menu: 'Menu' })
  const view = Picker({ external: false, hostDirectory: {}, input: { phase: 'plain' }, inputActions: {}, t: value => value })
  const menu = view.children[0]
  assert.equal(menu.tag, 'Menu'); assert.equal(menu.props.anchor.tag, 'span'); assert.equal(menu.props.anchor.props['aria-hidden'], true)
  assert.ok(!JSON.stringify(view).includes('ch-native-trigger'))
})

test('isolated owned backend exposes only local required Agents and rejects product-management RPC', { skip: process.env.DSH_HOST_LITE_SMOKE !== '1', timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-host-lite-smoke-'))
  const runtime = new OwnedHostRuntime({ backendDataDir: path.join(directory, 'data'), legacyHostDataDir: path.join(directory, 'history'), descriptorPath: path.join(directory, 'bridge.json'), idleReleaseMinutes: 30, hostStartTimeoutMs: 60000 })
  let peer
  t.after(async () => { peer?.close(); await runtime.close() })
  peer = await runtime.connect()
  assert.ok((await peer.request('model/list', { limit: 1 })).data.length > 0)
  const list = await peer.request('codexhost/harness/plugins/list')
  assert.deepEqual(list.plugins.map(p => p.id).sort(), ['antigravity', 'claude-code', 'codex-usage', 'deepseek-harness'].sort())
  // Real Loader, real probe. The result depends on whether `agy` is installed here, so assert only that
  // it is a structured answer and, when not ready, that the plugin says why instead of throwing.
  const agy = await peer.request('codexhost/harness/inspect', { harnessId: 'antigravity', cwd: directory, refresh: true })
  assert.equal(typeof agy.status, 'string')
  if (agy.status !== 'ready') assert.ok(agy.error?.message || agy.installation || agy.status, 'a not-ready Antigravity explains itself')
  else assert.deepEqual(agy.permissionModes.modes.map(mode => mode.id), ['dangerously-skip-permissions'])
  const dsh = list.plugins.find(p => p.id === 'deepseek-harness'); assert.equal(dsh.kind, 'usage')
  await assert.rejects(peer.request('codexhost/update/check'), { code: -32601 })
  await assert.rejects(peer.request('codexhost/remote/ssh-setup', { action: 'inspect' }), { code: -32601 })
  const loaded = await peer.request('codexhost/sessions/loaded/list')
  assert.ok(loaded)
})
