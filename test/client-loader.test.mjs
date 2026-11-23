import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('client artifact mounts native remotes and additive Composer controls without creating a conversation panel', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  vm.runInNewContext(source, {
    Symbol,
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
  })
  assert.equal(loaded.id, '@local/dsh-codexhost-bridge')
  const module = loaded.factory((name) => {
    if (name === 'react') return {
      createElement: (...args) => args,
      useEffect: () => {},
      useMemo: value => value(),
      useRef: value => ({ current: value }),
      useState: value => [value, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
    if (name === 'react-dom') return { createPortal: (...args) => args[0] }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Menu() {}, RiskConfirmation() {} }
    throw new Error(`unexpected module ${name}`)
  })
  const registrations = [], replyDefinitions = []
  const injections = []
  const mounted = [], scopedDisposers = [], triggerSources = new Set()
  const binding = { ctx: { effect() {} } }
  let addressedChild = false
  const nativeTeam = { component: () => 'native Team toggle', options: { id: 'agent-team' }, locale: 'agent-team', inject: () => ({ selectTeamMode: async () => null, requestDisableConfirmation() {} }) }
  const nativeModel = { component: () => 'native ModelSelect', options: {}, locale: 'model' }
  const nativePermission = { component: () => null, options: {}, locale: 'permissionAccess', inject: () => ({ native: true }) }
  const nativePreset = { component: () => 'native DSH preset', options: {}, locale: 'settings.agentPreset', inject: () => ({ native: true }) }
  const nativeBar = { component: () => 'native Composer', options: {}, locale: 'conversation', children: { 'conversation.composer.dock': {} }, inject: () => ({ native: true }) }
  const nativeUsage = { component: () => 'native usage', options: { id: 'usage', order: 1 }, locale: 'conversation', inject: () => ({ native: true }) }
  const nativeActivity = { component: () => 'native activity', options: { id: 'activity', order: 0 }, locale: 'conversation', inject: () => ({ native: true }) }
  let dockReady = false
  const dockListeners = new Set()
  const toolViews = ['read', 'write', 'edit', 'grep', 'glob', 'bash'].map(key => ({ options: { key }, locale: 'conversation', component: () => key, inject: () => ({ native: true }) }))
  const ctx = {
    effect() {},
    inject(names, callback) {
      injections.push(names)
      callback({ inject: ctx.inject.bind(ctx), inputTriggers: { registerSource(source) { triggerSources.add(source); return () => triggerSources.delete(source) } }, effect: fn => { const off = fn(); if (typeof off === 'function') scopedDisposers.push(off); return off }, slots: ctx.slots, sessions: ctx.sessions, uiConversation: { events: { register(definition) { replyDefinitions.push(definition); return () => {} } } }, locale: ctx.locale, remoteAccess: ctx.remoteAccess, layout: {}, remote: { codexHost: {}, codexHostConsole: {} } })
    },
    locale: {
      register() {},
      bind() { return key => key },
    },
    sessions: { binding() { return binding }, subagentAddress() { return addressedChild ? { parentSessionId: 'parent' } : undefined } },
    remoteAccess: { whenAccess(_name, callback) { for (const _dispose of callback()) {} } },
    remote: { async $mount(contribution) { mounted.push(contribution); return () => {} } },
    slots: {
      subscribe(key, callback) { assert.equal(key, 'conversation.composer.dock'); dockListeners.add(callback); return () => dockListeners.delete(callback) },
      inject(name, callback) {
        const result = callback()
        if (result?.next) for (const _dispose of result) {}
        return result
      },
      entriesOfSlot(name) { return name === 'conversation.input.model' ? [nativeModel] : name === 'conversation.input.model.options' ? [nativeTeam] : name === 'tool.call.toolview' ? toolViews : name === 'conversation.composer.dock' ? (dockReady ? [nativeUsage, nativeActivity] : []) : [name === 'conversation.composer.bar' ? nativeBar : name === 'conversation.hero.agentPreset' ? nativePreset : nativePermission] },
      register(spec, component) {
        if (spec.id === 'usage' || spec.id === 'activity') assert.equal(dockListeners.size, 0, 'Stop observing before shadowing the native registry')
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  await module.apply(ctx)
  assert.deepEqual(replyDefinitions.map(d => d.target).sort(), ['chat', 'trajectory'])
  assert.equal(dockListeners.size, 1, 'Wait for actual native entries, not just the slot declaration')
  dockReady = true
  for (const callback of dockListeners) callback()
  assert.equal(dockListeners.size, 0)
  assert.ok(injections.some(names => names.includes('remote.codexHost') && names.includes('remote.agentPresets') && names.includes('conversation') && names.includes('uiWorkspace')))
  const right = registrations.find(entry => entry.spec.name === 'conversation.input.right')
  assert.equal(right.spec.id, 'codexhost-agent-controls')
  assert.equal(typeof right.component, 'function')
  const left = registrations.find(entry => entry.spec.name === 'conversation.input.left')
  assert.equal(left.spec.id, 'codexhost-task-controls')
  assert.ok(left.spec.order > 40, 'Outcome check sits to the right of the keepalive chip (order 40)')
  assert.equal(left.spec.inject('test-session').hostDirectory, right.spec.inject('test-session').hostDirectory)
  assert.equal(typeof left.spec.inject('test-session').resume, 'function')
  const controlProps = right.spec.inject('test-session')
  assert.equal(controlProps.nativeTeam.Component, nativeTeam.component, 'External model menu reuses the original Team switch and its confirmation callbacks')
  const renderedControls = right.component({ ...controlProps, useProjection: () => 'codexhost-codex', useSession: select => select({ subagent: null }), useSessions: select => select({ byId: {} }), useInput: () => ({ occurrences: [] }), t: key => key })
  const modelPicker = renderedControls[2]
  const renderedPicker = modelPicker[0](modelPicker[1])
  assert.equal(typeof renderedPicker[0], 'function', 'Native ModelSelect source is bundled with an effort-pane extension')
  assert.equal(typeof renderedPicker[1].EffortPane, 'function')
  assert.equal(renderedPicker[1].directory, controlProps.hostDirectory.modelStore)
  const nativeModelSeat = registrations.find(entry => entry.spec.name === 'conversation.input.model')
  const renderedNative = nativeModelSeat.component({ ...nativeModelSeat.spec.inject('test-session') })
  assert.equal(renderedNative[0], renderedPicker[0], 'DSH and Host share the same native menu with slider pane')
  assert.equal(renderedNative[1].EffortPane, renderedPicker[1].EffortPane)
  assert.equal(nativeModelSeat.spec.children, undefined, 'Original native entry retains child-slot declarations')
  const owner = { locked: false, dismiss() {}, reportFailure() {} }
  const team = renderedPicker[1].renderSlot('conversation.input.model.options', owner)
  assert.equal(team[0], nativeTeam.component)
  assert.equal(team[1].selectTeamMode, controlProps.nativeTeam.injected.selectTeamMode)
  assert.equal(team[1].dismiss, owner.dismiss)
  assert.equal(team[1].reportFailure, owner.reportFailure)
  assert.equal(renderedControls.some(node => node?.[0]?.name === 'NativeRecoveryControl'), false)
  assert.equal(registrations.find(entry => entry.spec.name === 'conversation.input.permission').spec.inject('test-session').NativePermission, nativePermission.component)
  const hero = registrations.find(entry => entry.spec.name === 'conversation.hero.agentPreset')
  assert.equal(hero.component({ useProjection: () => 'codexhost-codex' }), null)
  assert.equal(hero.component({ useProjection: () => 'codexhost-claude-code' }), null)
  assert.equal(hero.component({ useProjection: () => 'coding', NativePreset: nativePreset.component })[0], nativePreset.component)
  const marker = registrations.find(entry => entry.spec.name === 'sidebar.session.row.leading')
  assert.equal(marker.spec.id, 'codexhost-session-agent')
  for (const [preset, id, label] of [['codexhost-codex', 'codex', 'Codex'], ['codexhost-claude-code', 'claude-code', 'Claude Code'], ['custom-dsh-preset', 'deepseek-harness', 'DSH'], [undefined, 'deepseek-harness', 'DSH']]) {
    const mark = marker.component({ sessionId: 'saved', useSessions: select => select({ byId: { saved: { projectionValues: { agentPreset: preset } } } }) })
    assert.equal(mark[0], 'img')
    assert.equal(mark[1]['data-codexhost-session-agent'], id)
    assert.equal(mark[1].alt, label)
    assert.equal(mark[1].width, 16)
  }
  assert.equal(marker.component({ sessionId: 'missing', useSessions: select => select({ byId: {} }) }), null)
  assert.equal(registrations.find(entry => entry.spec.name === 'main').spec.key, 'codexhost-console')
  assert.equal(registrations.find(entry => entry.spec.name === 'sidebar.footer.action').spec.id, 'codexhost-console')
  assert.equal(registrations.some(entry => entry.spec.name === 'sidebar.panellist'), false)
  for (const native of [nativeUsage, nativeActivity]) {
    const registration = registrations.find(entry => native === nativeBar ? entry.spec.name === 'conversation.composer.bar' : entry.spec.id === native.options.id)
    const rendered = registration.component({ NativeSeat: native.component, useProjection: key => key === 'agentPreset' ? 'coding' : { key } })
    assert.equal(rendered[0], native.component)
    assert.deepEqual(rendered[1].useProjection('contextPressure'), { key: 'contextPressure' })
    assert.equal(registration.spec.children, undefined, 'Original Composer retains ownership of its child declarations')
  }
  assert.equal(registrations.some(entry => entry.spec.name === 'conversation.composer.bar'), false)
  const shellAlias = registrations.find(entry => entry.spec.key === 'exec_command')
  const view = shellAlias.component({ ...shellAlias.spec.inject('saved'), toolName: 'exec_command', block: { kind: 'tool-result', call: { name: 'exec_command', argsRaw: '{"command":"17*19"}' }, content: [] } })
  assert.equal(view[0], toolViews.find(view => view.options.key === 'bash').component)
  assert.equal(view[1].block.call.name, 'pwsh')
  assert.deepEqual(JSON.parse(view[1].block.call.argsRaw), { command: '17*19', description: '17*19' })
  assert.equal(registrations.some(entry => /conversation.view/.test(entry.spec.name)), false)
  assert.equal(triggerSources.size, 1)
  assert.equal([...triggerSources][0].trigger, '@')
  assert.equal(await [...triggerSources][0].codec.serialize('deepseek-harness', new AbortController().signal), '[@DSH](subagent://codexhost.deepseek-harness)')
  addressedChild = true
  const delegationSource = [...triggerSources][0]
  assert.equal((await delegationSource.candidates({ sessionId: 'test-session' }, { query: '', signal: new AbortController().signal })).length, 0, 'child completion must not call an ordinary Agent RPC')
  assert.throws(() => delegationSource.onPick({ session: { sessionId: 'test-session' }, candidate: { value: 'codex' } }), /delegateSessionUnavailable/)
  for (const off of scopedDisposers.reverse()) off()
  assert.equal(triggerSources.size, 0, 'Unloading removes the reference source')
})
