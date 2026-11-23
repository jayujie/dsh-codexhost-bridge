import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { backendEnvironment } from '../backend-paths.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { completeExternalTitle } from '../native-title.mjs'

const policy = { enabled: true, maxInputBytes: 16000, maxOutputTokens: 128, timeoutMs: 15000 }

test('only the owned backend and its children disable native automatic titles', () => {
  const parent = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '0', ANTHROPIC_API_KEY: 'test-only' }
  const child = backendEnvironment({ nodePath: 'C:/node.exe', runtimePath: 'C:/plugin/host-runtime.mjs', descriptorPath: 'C:/private/bridge.json', stockCodexPath: 'C:/codex.exe' }, {}, parent)
  assert.equal(child.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1')
  assert.equal(parent.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '0')
  assert.equal(child.ANTHROPIC_API_KEY, parent.ANTHROPIC_API_KEY)
})

test('actual bundled Claude SDK query disables titles while retaining its real SDK identity', async () => {
  const source = await readFile(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  const match = source.match(/env: withNodeRuntimeOnPath\((\{\s*\.\.\.dshCollaborationChildEnvironment\(this\.#environment\),\s*(?:\.\.\.dshNativeWebEnvironment\(this\.#environment\),\s*)?(?:\.\.\.dshUnifiedWakeEnvironment\(this\.#environment\),\s*)?(?:\.\.\.dshClaudeMainRetryEnvironment\(this\.#environment\),\s*)?(?:\.\.\.this\.#dsh503Relay \? [^\n]* : \{\},\s*)?(?:ENABLE_PROMPT_CACHING_1H: "1",\s*)?CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,[\s\S]*?\n {8,10}\})\)/)
  assert.ok(match, 'the actual SDK transport query environment must be found')
  const environment = { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '0', ANTHROPIC_API_KEY: 'test-only', DSH_COLLABORATION_TOKEN: 'private-fixture', DSH_WEB_BRIDGE_TOKEN: 'private-web-fixture' }
  const sdk = await readFile(new URL('../claude-collaboration-sdk.txt', import.meta.url), 'utf8')
  const webSdk = await readFile(new URL('../claude-native-web.txt', import.meta.url), 'utf8')
  const wake = await readFile(new URL('../claude-wake-policy.txt', import.meta.url), 'utf8')
  const retry = await readFile(new URL('../claude-network-retry.txt', import.meta.url), 'utf8')
  const queryEnv = vm.runInNewContext(wake + '\n' + retry + '\n' + sdk + '\n' + webSdk + '\n(' + match[1].replaceAll('this.#environment', 'environment').replaceAll('this.#dsh503Relay', 'undefined') + ')', { environment, SESSION_ENTRYPOINT: 'codexhost-sdk', CLIENT_APP: 'codexhost-claude-code-adapter/0.0.0' })
  assert.equal(queryEnv.DSH_COLLABORATION_TOKEN, undefined)
  assert.equal(queryEnv.DSH_WEB_BRIDGE_TOKEN, undefined)
  assert.equal(queryEnv.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1')
  assert.equal(queryEnv.CLAUDE_CODE_ENTRYPOINT, 'codexhost-sdk')
  assert.equal(queryEnv.CLAUDE_AGENT_SDK_CLIENT_APP, 'codexhost-claude-code-adapter/0.0.0')
  assert.equal(queryEnv.ANTHROPIC_API_KEY, environment.ANTHROPIC_API_KEY)
})

test('actual bundled explicit SDK title method returns without sending a control request', async () => {
  const source = await readFile(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  const match = source.match(/async generateSessionTitle\(e, t\) \{([\s\S]*?)\n  \}/)
  assert.ok(match)
  const holder = vm.runInNewContext('({' + match[0] + '})')
  let requests = 0
  holder.request = () => { requests++; throw new Error('title must not request') }
  assert.equal(await holder.generateSessionTitle('a user conversation', { persist: true }), null)
  assert.equal(requests, 0)
})

for (const kind of ['fallback', 'provider', 'user']) {
  test(`Claude Host title notifications preserve the DSH ${kind} title under DSH title policy`, async () => {
    const events = [], listeners = new Set()
    const current = { title: kind === 'fallback' ? 'raw prompt' : 'DSH 或手动标题', eventSeq: 5, source: { kind, ...(kind === 'provider' ? { provider: 'codexhost-dsh-title' } : {}) } }
    const session = { id: 'local', header: { cwd: 'D:/work' }, snapshotEvents: () => [{ type: 'plugin:codexhost/thread', ignorable: true, data: { version: 1, phase: 'ready', harnessId: 'claude-code', threadId: 'external', sessionId: 'local', appliedConfiguration: { modelId: 'claude-test' } } }], append: (type, data) => events.push({ type, data }) }
    const agent = { id: 'local', session }
    const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
      if (method === 'codexhost/thread/usage/inspect') return {}
      if (method === 'thread/read') return { thread: { name: 'raw native first prompt' } }
      if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'claude-test' }, label: 'Claude test' }] } }
      throw new Error(method)
    } }
    const ctx = { agentPresets: { presetForSession: () => 'codexhost-claude-code' }, agents: { list: () => [agent] }, get: key => key === 'sessionTitle' ? { get: () => current } : undefined, sessionPersistence: { flush: async () => {} } }
    const driver = new NativeSessionDriver(ctx, {}, { connect: async () => peer, titlePolicy: policy })
    try {
      assert.equal((await driver.catalog(agent)).status, 'ready')
      for (const callback of listeners) callback({ method: 'thread/name/updated', params: { threadId: 'external', threadName: 'later native fallback' } })
      assert.equal(events.filter(event => event.type === 'session/title').length, 0)
      assert.equal(current.source.kind, kind)
    } finally { await driver.dispose() }
  })
}

test('DSH generates the missing Claude title once and keeps the selected DSH model route and user title', async () => {
  let generated = 0, current = { title: 'raw first prompt', eventSeq: 1, source: { kind: 'fallback' } }
  const events = [], route = { provider: 'dsh-provider', model: 'dsh-title-model' }
  const session = { append(type, data) { events.push({ type, data }); current = { ...data, eventSeq: current.eventSeq + 1 } } }
  const ctx = { get: key => key === 'sessionTitle' ? { get: () => current } : {}, loader: { async import(name) {
    if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
    if (name === '@deepseek-ai/dsh-session-title-llm') return { async executeSessionTitleLlm(_services, options) {
      generated++; assert.equal(options.provider, route.provider); assert.equal(options.model, route.model); assert.equal(options.maxOutputTokens, 128)
      return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '标题请求修复' }], model: route }
    } }
    throw new Error(name)
  } } }
  const agent = { session, model: { current: () => route } }, signal = new AbortController().signal
  await completeExternalTitle(ctx, agent, { seq: 1, text: 'first human request' }, signal, policy)
  await completeExternalTitle(ctx, agent, { seq: 2, text: 'later request' }, signal, policy)
  assert.equal(generated, 1); assert.equal(events[0].data.title, '标题请求修复'); assert.equal(events[0].data.source.provider, 'codexhost-dsh-title')
  current = { title: '用户手动标题', eventSeq: 3, source: { kind: 'user' } }
  await completeExternalTitle(ctx, agent, { seq: 3, text: 'another turn' }, signal, policy)
  assert.equal(generated, 1); assert.equal(current.title, '用户手动标题')
})
