import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { readLastAgentSync, writeLastAgent, defaultPresetForLastAgent } from '../last-agent.mjs'

function makeHarness(lastAgentPath) {
  const listeners = new Map()
  const presetsBySession = new Map()
  const flushed = { count: 0 }
  const ctx = {
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter(item => item !== fn))
      }
    },
    effect() {},
    logger: { warn() {} },
    agents: {
      list: () => [],
      get: () => undefined,
      turnBoundaryOf: session => session._boundary ?? { lastTurn: 0, openTurnStartSeq: null },
    },
    agentPresets: {
      defaultId: 'research-lite',
      presetForSession: session => presetsBySession.get(session.id) ?? session.header?.agentPreset ?? 'research-lite',
      async select(agent, preset) {
        presetsBySession.set(agent.session.id, preset)
        agent.session._events.push({ type: 'agent-preset/selected', data: { agentPreset: preset } })
        return preset
      },
    },
    sessionPersistence: { async flush() { flushed.count++ } },
  }
  const helpers = {
    appendPluginRecord(session, type, data) {
      session._events.push({ type, ignorable: true, data })
    },
  }
  const driver = new NativeSessionDriver(ctx, helpers, { lastAgentPath })
  driver.install()
  const emit = async (name, ...args) => {
    for (const fn of listeners.get(name) ?? []) await fn(...args)
  }
  const makeAgent = (id, { preset = 'research-lite', origin = 'user', parentSession, isSeeded = false, boundary, events = [] } = {}) => {
    presetsBySession.set(id, preset)
    const session = {
      id,
      header: { cwd: 'D:/work', agentPreset: preset, origin, ...(parentSession !== undefined ? { parentSession } : {}), ...(isSeeded ? { isSeeded: true } : {}) },
      _events: [...events],
      _boundary: boundary,
      snapshotEvents() { return [...this._events] },
    }
    return {
      id,
      session,
      async runMaintenance(fn) { return fn() },
      cancel() {},
    }
  }
  return { ctx, driver, emit, makeAgent, presetsBySession, flushed }
}

test('last-agent helper validates, persists, and resolves default presets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-host-last-agent-'))
  try {
    const file = path.join(dir, 'last-agent.json')
    assert.equal(readLastAgentSync(file), undefined)
    await writeLastAgent(file, 'antigravity')
    assert.equal(readLastAgentSync(file), 'antigravity')
    assert.equal(defaultPresetForLastAgent('antigravity'), 'dsh-host-antigravity')
    assert.equal(defaultPresetForLastAgent('deepseek-harness'), undefined)
    await writeLastAgent(file, 'deepseek-harness')
    assert.equal(readLastAgentSync(file), 'deepseek-harness')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('selecting an external agent persists and defaults subsequent new blank sessions to that agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-host-last-agent-'))
  try {
    const file = path.join(dir, 'last-agent.json')
    const first = makeHarness(file)
    const s1 = first.makeAgent('s1')
    await first.driver.selectAgent(s1, 'antigravity')
    assert.equal(first.presetsBySession.get('s1'), 'dsh-host-antigravity')
    assert.equal(first.driver.lastUsedAgent(), 'antigravity')
    await first.driver.dispose()

    // Simulate DSH restart with a fresh driver instance reading last-agent.json
    const second = makeHarness(file)
    assert.equal(second.driver.lastUsedAgent(), 'antigravity')

    const s2 = second.makeAgent('s2')
    await second.emit('agent/created', { agent: s2, source: 'startup' })
    assert.equal(second.presetsBySession.get('s2'), 'dsh-host-antigravity')
    // Switching back to DSH restores original preset (research-lite) and remembers deepseek-harness
    await second.driver.selectAgent(s2, 'deepseek-harness')
    assert.equal(second.presetsBySession.get('s2'), 'research-lite')
    assert.equal(second.driver.lastUsedAgent(), 'deepseek-harness')

    const s3 = second.makeAgent('s3')
    await second.emit('agent/created', { agent: s3, source: 'startup' })
    assert.equal(second.presetsBySession.get('s3'), 'research-lite')
    await second.driver.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent/created skips resumed, subagent, forked, non-blank, and explicitly-configured sessions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-host-last-agent-'))
  try {
    const file = path.join(dir, 'last-agent.json')
    await writeLastAgent(file, 'claude-code')
    const h = makeHarness(file)

    const resumed = h.makeAgent('resumed')
    await h.emit('agent/created', { agent: resumed, source: 'resume' })
    assert.equal(h.presetsBySession.get('resumed'), 'research-lite')

    const sub = h.makeAgent('sub', { origin: 'subagent' })
    await h.emit('agent/created', { agent: sub, source: 'startup' })
    assert.equal(h.presetsBySession.get('sub'), 'research-lite')

    const fork = h.makeAgent('fork', { parentSession: 'parent-1' })
    await h.emit('agent/created', { agent: fork, source: 'startup' })
    assert.equal(h.presetsBySession.get('fork'), 'research-lite')

    const nonBlank = h.makeAgent('non-blank', { boundary: { lastTurn: 1, openTurnStartSeq: null } })
    await h.emit('agent/created', { agent: nonBlank, source: 'startup' })
    assert.equal(h.presetsBySession.get('non-blank'), 'research-lite')

    const explicitPreset = h.makeAgent('explicit-preset', { preset: 'ptc' })
    await h.emit('agent/created', { agent: explicitPreset, source: 'startup' })
    assert.equal(h.presetsBySession.get('explicit-preset'), 'ptc')

    // Top-level user message updates last agent; subagent user message does not
    const codexSession = h.makeAgent('codex-s', { preset: 'dsh-host-codex' })
    await h.emit('session/event', codexSession.session, { type: 'user/message', data: { source: { kind: 'user' } } })
    assert.equal(h.driver.lastUsedAgent(), 'codex')

    const subDsh = h.makeAgent('sub-dsh', { origin: 'subagent', preset: 'research-lite' })
    await h.emit('session/event', subDsh.session, { type: 'user/message', data: { source: { kind: 'user' } } })
    assert.equal(h.driver.lastUsedAgent(), 'codex')

    await h.driver.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('client bundle passes last used agent preset into sessions.create and restores on dispose', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const storage = new Map([['dsh-host.lastAgent', 'antigravity']])
  let loaded
  vm.runInNewContext(source, {
    Symbol,
    localStorage: {
      getItem: k => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
    },
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
  })
  const mod = loaded.factory(name => {
    if (name === 'react') return { createElement: (...a) => a, useEffect: () => {}, useMemo: v => v(), useRef: v => ({ current: v }), useState: v => [v, () => {}], useSyncExternalStore: (_s, g) => g() }
    if (name === 'react-dom') return { createPortal: (...a) => a[0] }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Menu() {}, RiskConfirmation() {} }
    throw new Error(name)
  })
  const calls = []
  let failOnce = false
  const originalCreate = async opts => {
    calls.push(opts)
    if (failOnce && opts.agentPreset === 'dsh-host-antigravity') {
      failOnce = false
      const err = new Error('not found')
      err.rpcError = { code: 'agent-preset/not-found' }
      throw err
    }
    return 'created-id'
  }
  const disposers = []
  const binding = { ctx: { effect() {} } }
  const sessions = { create: originalCreate, binding: () => binding, subagentAddress: () => undefined }
  const nativeModel = { component: () => null, options: {}, locale: 'model' }
  const nativePermission = { component: () => null, options: {}, locale: 'permissionAccess', inject: () => ({}) }
  const nativePreset = { component: () => null, options: {}, locale: 'settings.agentPreset', inject: () => ({}) }
  const ctx = {
    effect() {},
    inject(_names, cb) {
      cb({
        inject() {},
        effect: fn => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
        slots: {
          subscribe: () => () => {},
          inject: (_n, f) => f(),
          entriesOfSlot: n => n === 'conversation.input.model' ? [nativeModel] : n === 'conversation.input.model.options' ? [] : n === 'conversation.hero.agentPreset' ? [nativePreset] : n === 'conversation.input.permission' ? [nativePermission] : [],
          register: () => () => {},
        },
        sessions,
        uiConversation: { events: { register: () => () => {} } },
        locale: { register() {}, bind: () => k => k },
        remoteAccess: { whenAccess() {} },
        layout: {},
        remote: { dshHost: {}, dshHostConsole: {} },
      })
    },
    locale: { register() {}, bind: () => k => k },
    sessions,
    remoteAccess: { whenAccess() {} },
    remote: { async $mount() { return () => {} } },
    slots: { subscribe: () => () => {}, inject: (_n, f) => f(), entriesOfSlot: () => [], register: () => () => {} },
  }
  await mod.apply(ctx)

  // Default new session uses saved antigravity preset
  await sessions.create({ workspaceId: 'ws-1' })
  assert.deepEqual({ ...calls.at(-1) }, { workspaceId: 'ws-1', agentPreset: 'dsh-host-antigravity' })

  // Explicit agentPreset is preserved untouched
  await sessions.create({ workspaceId: 'ws-1', agentPreset: 'ptc' })
  assert.deepEqual({ ...calls.at(-1) }, { workspaceId: 'ws-1', agentPreset: 'ptc' })

  // Fallback to default when external preset is unavailable
  failOnce = true
  await sessions.create({ workspaceId: 'ws-1' })
  assert.deepEqual(calls.slice(-2).map(item => ({ ...item })), [{ workspaceId: 'ws-1', agentPreset: 'dsh-host-antigravity' }, { workspaceId: 'ws-1' }])

  // Switching lastAgent to deepseek-harness stops injecting external preset
  storage.set('dsh-host.lastAgent', 'deepseek-harness')
  await sessions.create({ workspaceId: 'ws-1' })
  assert.deepEqual({ ...calls.at(-1) }, { workspaceId: 'ws-1' })

  // Dispose restores original sessions.create
  for (const d of disposers.reverse()) d()
  assert.equal(sessions.create, originalCreate)
})
