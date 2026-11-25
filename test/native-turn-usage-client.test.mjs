import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

function flattenText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    if (typeof node[0] === 'string' || typeof node[0] === 'function') {
      return node.slice(2).map(flattenText).join('')
    }
    return node.map(flattenText).join('')
  }
  return ''
}

function findNode(node, predicate) {
  if (!Array.isArray(node)) return null
  if (predicate(node)) return node
  for (let index = 0; index < node.length; index++) {
    const found = findNode(node[index], predicate)
    if (found) return found
  }
  return null
}

async function loadTurnUsageAction(performanceStore) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  vm.runInNewContext(source, {
    Symbol,
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
  })
  let stateValue = false
  const refs = new Map()
  let refIdx = 0
  const module = loaded.factory((name) => {
    if (name === 'react') return {
      createElement: (...args) => args,
      useEffect: () => {},
      useMemo: value => value(),
      useRef: initial => {
        const key = refIdx++
        if (!refs.has(key)) refs.set(key, { current: initial })
        return refs.get(key)
      },
      useState: () => [stateValue, next => { stateValue = typeof next === 'function' ? next(stateValue) : next }],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
    if (name === 'react-dom') return { createPortal: (...args) => args[0] }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      Menu() {},
      RiskConfirmation() {},
      IconDatabaseOutlineRegular: () => ['svg', { 'data-icon': 'db' }],
    }
    throw new Error(`unexpected module ${name}`)
  })
  const registrations = []
  const turnTailEntry = performanceStore
    ? { options: { key: 'turn-tail' }, inject: () => ({ hooks: { performanceUsage: performanceStore } }) }
    : null
  const binding = { ctx: { effect() {} } }
  const nativeModel = { component: () => null, options: {}, locale: 'model' }
  const nativePermission = { component: () => null, options: {}, locale: 'permissionAccess', inject: () => ({}) }
  const nativePreset = { component: () => null, options: {}, locale: 'settings.agentPreset', inject: () => ({}) }
  const toolViews = ['read', 'write', 'edit', 'grep', 'glob', 'bash'].map(key => ({ options: { key }, locale: 'conversation', component: () => key, inject: () => ({}) }))
  const ctx = {
    effect() {},
    inject(_names, callback) {
      callback({
        inject: ctx.inject.bind(ctx),
        inputTriggers: { registerSource: () => () => {} },
        effect: fn => fn(),
        slots: ctx.slots,
        sessions: ctx.sessions,
        uiConversation: { events: { register: () => () => {} } },
        locale: ctx.locale,
        remoteAccess: ctx.remoteAccess,
        layout: {},
        remote: { codexHost: {}, codexHostConsole: {} },
      })
    },
    locale: { register() {}, bind: () => key => key },
    sessions: { binding: () => binding, subagentAddress: () => undefined },
    remoteAccess: { whenAccess() {} },
    remote: { async $mount() { return () => {} } },
    slots: {
      subscribe: () => () => {},
      inject: (_name, callback) => callback(),
      entriesOfSlot(name) {
        if (name === 'conversation.chat.node') return turnTailEntry ? [turnTailEntry] : []
        if (name === 'conversation.input.model') return [nativeModel]
        if (name === 'conversation.input.model.options') return []
        if (name === 'tool.call.toolview') return toolViews
        if (name === 'conversation.composer.dock') return []
        if (name === 'conversation.hero.agentPreset') return [nativePreset]
        return [nativePermission]
      },
      register(spec, component) {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  await module.apply(ctx)
  const entry = registrations.find(item => item.spec.name === 'conversation.chat.assistant-actions' && item.spec.id === 'codexhost-turn-usage')
  assert.ok(entry, 'codexhost-turn-usage must register in conversation.chat.assistant-actions')
  assert.equal(entry.spec.locale, 'chat')
  const injected = entry.spec.inject('session-1')
  const render = (props, { open = false } = {}) => {
    stateValue = open
    refIdx = 0
    return entry.component({ ...injected, ...props })
  }
  return { entry, injected, render, getOpen: () => stateValue }
}

const zhChatDict = {
  'message.turnUsage.title': '本轮用量',
  'message.turnUsage.consumed': '用量 {total}',
  'message.turnUsage.model': '提供方 / 模型',
  'message.turnUsage.cacheHit': '缓存命中',
  'message.turnUsage.input': '未缓存输入',
  'message.turnUsage.cacheRead': '缓存读取',
  'message.turnUsage.cacheWrite': '缓存写入',
  'message.turnUsage.output': '输出',
  'message.turnUsage.reasoning': '（其中推理 {tokens}）',
  'message.turnUsage.count': '{count} tok',
  'number.thousand': '{value}K',
  'number.million': '{value}M',
  'number.groupSeparator': ',',
}

function tChat(key, params = {}) {
  let text = zhChatDict[key] ?? key
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

function makeSnapshot(nodesList, turnKeys = {}) {
  const byKey = new Map(nodesList.map((node, index) => [node.key ?? `node-${index}`, node]))
  return {
    nodes: {
      values: () => [...byKey.values()],
      get: key => byKey.get(key),
    },
    locations: {
      getTurn: turn => turnKeys[turn] ?? [],
    },
  }
}

test('external multi-tool turn displays TurnUsage pill and exact details dialog when native tokenUsage is undefined', async () => {
  let mode = 'detailed'
  const perfStore = { subscribe: () => () => {}, getSnapshot: () => mode }
  const { render, getOpen } = await loadTurnUsageAction(perfStore)

  const usage = {
    inputTokens: 56542,
    outputTokens: 10004,
    totalTokens: 5109239,
    cacheReadTokens: 5042693,
    cacheWriteTokens: 0,
    reasoningTokens: 2500,
  }
  const snapshot = makeSnapshot([
    {
      key: 'tail-30',
      kind: 'turn-tail',
      data: {
        turn: 30,
        seq: 4406,
        time: 1700000000000,
        closing: { finalNode: { messageId: 'msg-30', seq: 4404, usage }, usage },
        branchUnavailable: false,
      },
    },
  ])

  const projections = {
    agentPreset: 'codexhost-antigravity',
    codexHostModelIdentity: { harnessId: 'antigravity', model: 'claude-opus-4-6-thinking' },
    codexHostObservation: null,
  }
  const baseProps = {
    messageId: 'msg-30',
    useChat: selector => selector(snapshot),
    useProjection: key => projections[key],
    t: tChat,
  }

  // Closed pill shows compact total matching DSH native format.
  const closed = render(baseProps, { open: false })
  assert.ok(closed, 'Expected turn usage pill for multi-tool external turn')
  assert.equal(closed[1]['data-codexhost-turn-usage'], '')
  assert.equal(flattenText(closed), '用量 5.1M tok')
  const trigger = findNode(closed, node => node[0] === 'button')
  assert.equal(trigger[1]['aria-expanded'], false)
  trigger[1].onClick()
  assert.equal(getOpen(), true)

  // Open dialog renders exact counts, route, cache hit, and reasoning sub-breakdown.
  const opened = render(baseProps, { open: true })
  const dialog = findNode(opened, node => node[1]?.role === 'dialog')
  assert.ok(dialog, 'Expected portaled turn usage dialog when open')
  const dialogText = flattenText(dialog)
  assert.match(dialogText, /本轮用量/)
  assert.match(dialogText, /5,109,239 tok/)
  assert.match(dialogText, /codexhost\/antigravity\/claude-opus-4-6-thinking/)
  assert.match(dialogText, /98\.9%/)
  assert.match(dialogText, /56,542 tok/)
  assert.match(dialogText, /5,042,693 tok/)
  assert.match(dialogText, /10,004 tok/)
  assert.match(dialogText, /（其中推理 2,500 tok）/)

  // Compact performanceUsage mode hides the pill just like native TurnTailNodeView.
  mode = 'compact'
  assert.equal(render(baseProps, { open: false }), null)
})

test('does not duplicate when native tokenUsage is already present and never renders on native DSH sessions', async () => {
  const { render } = await loadTurnUsageAction()
  const usage = { inputTokens: 120, outputTokens: 80, totalTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }

  // 0-tool external turn where native deriveTurnTokenUsage succeeded.
  const nativeCovered = makeSnapshot([
    {
      key: 'tail-1',
      kind: 'turn-tail',
      data: {
        turn: 1,
        seq: 10,
        closing: { finalNode: { messageId: 'msg-1', seq: 9, usage }, usage },
        tokenUsage: { uncachedInputTokens: 120, outputTokens: 80, totalTokens: 200 },
      },
    },
  ])
  assert.equal(render({
    messageId: 'msg-1',
    useChat: selector => selector(nativeCovered),
    useProjection: key => key === 'agentPreset' ? 'codexhost-codex' : null,
    t: tChat,
  }), null)

  // Native DSH session without tokenUsage stays untouched.
  const nativeDsh = makeSnapshot([
    {
      key: 'tail-2',
      kind: 'turn-tail',
      data: {
        turn: 2,
        seq: 20,
        closing: { finalNode: { messageId: 'msg-2', seq: 19, usage }, usage },
      },
    },
  ])
  for (const preset of ['coding', 'deepseek-harness', undefined]) {
    assert.equal(render({
      messageId: 'msg-2',
      useChat: selector => selector(nativeDsh),
      useProjection: key => key === 'agentPreset' ? preset : null,
      t: tChat,
    }), null)
  }
})

test('falls back to same-turn assistant-step usage, rejects invalid usage, and preserves honest high cache hit formatting', async () => {
  const { render } = await loadTurnUsageAction()

  // Fallback to assistant-step in the same turn + partial 99.96% cache hit must not round to 100%.
  const stepUsage = { inputTokens: 4, outputTokens: 100, totalTokens: 10100, cacheReadTokens: 9996, cacheWriteTokens: 0 }
  const fallbackSnap = makeSnapshot([
    { key: 'step-1', kind: 'assistant-step', data: { turn: 5, step: 1, finalNode: { usage: stepUsage } } },
    { key: 'tail-5', kind: 'turn-tail', data: { turn: 5, seq: 50, closing: { finalNode: { messageId: 'msg-5', seq: 49 } } } },
  ], { 5: ['step-1', 'tail-5'] })

  const opened = render({
    messageId: 'msg-5',
    useChat: selector => selector(fallbackSnap),
    useProjection: key => key === 'agentPreset' ? 'codexhost-claude-code' : key === 'codexHostObservation' ? { harnessId: 'claude-code', model: 'claude-sonnet-4-6' } : null,
    t: tChat,
  }, { open: true })
  assert.ok(opened)
  const text = flattenText(opened)
  assert.match(text, /99\.96%/)
  assert.match(text, /codexhost\/claude-code\/claude-sonnet-4-6/)

  // Invalid usage shapes return null cleanly.
  for (const bad of [
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: 10, outputTokens: 10, totalTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: 10, outputTokens: 10, totalTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 20 },
  ]) {
    const snap = makeSnapshot([
      { key: 'tail-bad', kind: 'turn-tail', data: { turn: 6, seq: 60, closing: { finalNode: { messageId: 'msg-bad', seq: 59, usage: bad } } } },
    ])
    assert.equal(render({
      messageId: 'msg-bad',
      useChat: selector => selector(snap),
      useProjection: key => key === 'agentPreset' ? 'codexhost-codex' : null,
      t: tChat,
    }), null)
  }
})
