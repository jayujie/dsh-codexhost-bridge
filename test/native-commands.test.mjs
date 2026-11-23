import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { nativeCommandInput, nativeCommandDescriptor } from '../native-commands.mjs'
import { NativeSessionDriver, nativeThreadState } from '../native-session-driver.mjs'
import { apply as preset } from '../native-command-preset.mjs'
import { patchClaudeCommands } from '../patch-claude-commands.mjs'

const message = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
for (const text of ['explain /goal', '`/compact`', '/goals x', '/compactness', '普通消息']) test(`not a command: ${text}`, () => assert.equal(nativeCommandInput([message(text)]), undefined))
for (const [text, name, args] of [['/compact', 'compact', ''], [' /compact 保留 seed\n和单位 ', 'compact', '保留 seed\n和单位'], ['/goal', 'goal', ''], ['/goal clear', 'goal', 'clear'], ['/goal 运行测试直到通过', 'goal', '运行测试直到通过']]) test(`parse native ${text}`, () => assert.deepEqual(nativeCommandInput([message(text)]), { name, text: args, message: message(text) }))
test('attachments, merged humans and unbounded arguments are rejected', () => {
  assert.throws(() => nativeCommandInput([{ ...message('/goal'), content: [...message('/goal').content, { type: 'image' }] }]), { code: 'HOST_COMMAND_INPUT' })
  assert.throws(() => nativeCommandInput([message('/compact'), message('also do this')]), { code: 'HOST_COMMAND_INPUT' })
  assert.throws(() => nativeCommandInput([message('/goal ' + 'x'.repeat(65536))]), { code: 'HOST_COMMAND_INPUT' })
})
test('descriptor uses only the exact advertised invocation', () => {
  assert.equal(nativeCommandDescriptor({ commands: [{ id: 'native-id', invocation: '/goal', argumentMode: 'text' }] }, 'goal').id, 'native-id')
  assert.throws(() => nativeCommandDescriptor({ commands: [{ id: 'guessed', invocation: '/goals' }] }, 'goal'), { code: 'HOST_COMMAND_UNSUPPORTED' })
})

function fixture({ harness = 'claude-code', missing = false, status = 'completed', reject, hold = false } = {}) {
  const events = [], calls = [], listeners = new Set(), queued = [], started = Promise.withResolvers()
  const session = { id: 'command-fixture', header: { cwd: 'D:/fixture' }, snapshotEvents: () => [...events], append(type, data) { const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } }
  session.append('plugin:codexhost/configuration', { harnessId: harness, modelId: 'test' })
  const agent = { id: session.id, session, followup: m => queued.push(m), cancel() {} }
  const emit = (method, params) => { for (const fn of listeners) fn({ method, params }) }
  let sequence = 0
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method, params) {
    calls.push({ method, params })
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'Test' }] } }
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
    if (method === 'codexhost/thread/usage/inspect') return {}
    if (method === 'codexhost/thread/commands/inspect') return { commands: missing ? [] : ['compact', 'goal'].map(name => ({ id: 'native.' + name, invocation: '/' + name, argumentMode: 'text' })) }
    if (method === 'codexhost/thread/command/execute' || method === 'turn/start') {
      if (reject) throw reject
      const id = 'turn-' + ++sequence
      started.resolve()
      if (!hold) queueMicrotask(() => emit('turn/completed', { threadId: 'thread', turn: { id, status, ...(status === 'failed' ? { error: { message: 'native failure' } } : {}) } }))
      return method === 'turn/start' ? { turn: { id } } : { accepted: true, turnId: id }
    }
    if (method === 'turn/interrupt') { emit('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'interrupted' } }); return {} }
    throw new Error(method)
  } }
  const helpers = { createUserMessage: x => x, createAssistantMessage: x => x, appendPluginRecord: (s, type, data) => s.append(type, data), agentEvents: () => ({ emit() {} }), AssistantStreamAccumulator: class { push(x) { return x } snapshot() { return [] } }, BlockAssembler: class { push() {} blocks() { return [] } } }
  const ctx = { agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} }, get() {}, on() {}, effect() {} }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 1000, cancelTimeoutMs: 100 })
  const payload = (text, turn = 1, signal = new AbortController().signal) => ({ agent, turn, step: 1, signal, messages: [message(text)] })
  return { driver, agent, events, calls, payload, queued, emit, started: started.promise }
}
const executions = f => f.calls.filter(c => c.method === 'codexhost/thread/command/execute')
for (const text of ['/compact', '/compact 保留参数', '/goal', '/goal clear', '/goal 验证报告']) test(`driver executes ${text} natively, never as a prompt`, async () => {
  const f = fixture()
  try {
    await f.driver.run(f.payload(text))
    assert.equal(executions(f).length, 1)
    assert.equal(f.calls.some(c => c.method === 'turn/start'), false)
    assert.equal(nativeThreadState(f.agent.session).phase, 'ready')
    assert.equal(f.events.filter(e => e.type === 'step/start').length, 1)
    assert.equal(f.events.filter(e => e.type === 'step/end').length, 1)
    const parsed = nativeCommandInput([message(text)])
    assert.deepEqual(executions(f)[0].params, { threadId: 'thread', commandId: 'native.' + parsed.name, ...(parsed.text ? { arguments: { text: parsed.text } } : {}) })
  } finally { await f.driver.dispose() }
})
test('ordinary prompt and compact resume the same native Thread', async () => {
  const f = fixture()
  try { await f.driver.run(f.payload('hello')); await f.driver.run(f.payload('/compact', 2)); assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1); assert.equal(f.calls.filter(c => c.method === 'thread/resume').length, 1); assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1) }
  finally { await f.driver.dispose() }
})
test('missing capability refuses without submission or fallback', async () => {
  const f = fixture({ missing: true })
  try { await assert.rejects(f.driver.run(f.payload('/goal x')), { code: 'HOST_COMMAND_UNSUPPORTED' }); assert.equal(executions(f).length, 0); assert.equal(f.calls.some(c => c.method === 'turn/start'), false); assert.equal(nativeThreadState(f.agent.session).phase, 'ready') }
  finally { await f.driver.dispose() }
})
test('Codex cannot execute either unadapted command, including direct plain-text input', async () => {
  const f = fixture({ harness: 'codex' })
  try { for (const name of ['compact', 'goal']) { await assert.rejects(f.driver.run(f.payload('/' + name)), { code: 'HOST_COMMAND_UNSUPPORTED' }); assert.throws(() => f.driver.submitCommand(f.agent, name, '', new AbortController().signal), { code: 'HOST_COMMAND_UNSUPPORTED' }) }; assert.equal(f.calls.length, 0); assert.equal(f.queued.length, 0) }
  finally { await f.driver.dispose() }
})
test('native failure settles ready; unknown network outcome remains pending and never repeats', async () => {
  const failed = fixture({ status: 'failed' }), unknown = fixture({ reject: new Error('transport lost') })
  try {
    await assert.rejects(failed.driver.run(failed.payload('/compact')), { code: 'HOST_TURN_FAILED' }); assert.equal(nativeThreadState(failed.agent.session).phase, 'ready')
    await assert.rejects(unknown.driver.run(unknown.payload('/goal x')), /transport lost/); assert.equal(nativeThreadState(unknown.agent.session).phase, 'submitted')
    await assert.rejects(unknown.driver.run(unknown.payload('/goal x', 2)), { code: 'HOST_OUTCOME_UNKNOWN' }); assert.equal(executions(unknown).length, 1)
  } finally { await failed.driver.dispose(); await unknown.driver.dispose() }
})
test('command cancellation interrupts the exact native Turn without replay', async () => {
  const f = fixture({ hold: true }), controller = new AbortController()
  try {
    const running = f.driver.run(f.payload('/goal x', 1, controller.signal))
    const failed = assert.rejects(running, { name: 'AbortError' })
    await f.started
    // The RPC response may still be entering the driver's durable identity; its
    // signal check after the response must interrupt it in either ordering.
    controller.abort()
    await failed
    assert.equal(executions(f).length, 1)
    assert.deepEqual(f.calls.find(c => c.method === 'turn/interrupt').params, { threadId: 'thread', turnId: 'turn-1' })
    assert.equal(nativeThreadState(f.agent.session).phase, 'ready')
  } finally { await f.driver.dispose() }
})

test('submission acknowledges queue admission, not completion', async () => {
  const f = fixture()
  try { const result = f.driver.submitCommand(f.agent, 'goal', ' clear', new AbortController().signal); assert.match(result.text, /已提交/); assert.equal(result.kind, 'success'); assert.equal(f.queued[0].content[0].text, '/goal clear'); assert.equal(f.calls.length, 0) }
  finally { await f.driver.dispose() }
})
test('Claude preset registers both input commands and disposes them', () => {
  const rows = new Map(), disposers = []
  preset({ effect(fn) { disposers.push(fn()) }, commands: { register(row) { rows.set(row.name, row); return () => rows.delete(row.name) } } })
  assert.deepEqual([...rows.keys()], ['compact', 'goal']); assert.ok([...rows.values()].every(row => row.input && !row.input.attachments))
  for (const dispose of disposers) dispose(); assert.equal(rows.size, 0)
})
test('Claude and Antigravity presets mount human commands while Codex does not', async () => {
  const text = await readFile(new URL('../native-session-driver.mjs', import.meta.url), 'utf8')
  assert.match(text, /NATIVE_COMMAND_ENGINES\.includes\(harness\) \? \[\{ name: new URL\('\.\/native-command-preset\.mjs'/)
  const agy = fixture({ harness: 'antigravity' })
  try {
    await agy.driver.run(agy.payload('/compact'))
    await agy.driver.run(agy.payload('/goal 验证指标', 2))
    assert.equal(executions(agy).length, 2)
    assert.equal(agy.calls.some(c => c.method === 'turn/start'), false)
    const sub = agy.driver.submitCommand(agy.agent, 'compact', '', new AbortController().signal)
    assert.equal(sub.kind, 'success')
    assert.match(sub.text, /Antigravity/)
  } finally { await agy.driver.dispose() }
})
test('production Claude catalog exposes only a live Goal and retains other exclusions', async () => {
  const url = new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url)
  const source = (await readFile(url, 'utf8')).replaceAll('import.meta.url', JSON.stringify(url.href))
  const { claudeLiveCommandCatalog: catalog, claudeCommandCatalog: base } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {claudeLiveCommandCatalog,claudeCommandCatalog};').toString('base64'))
  assert.equal(catalog(base, null).commands.some(row => row.invocation === '/goal'), false)
  const live = catalog(base, { commands: [{ name: 'goal', description: 'Native Goal' }, { name: 'loop' }, { name: 'background' }, { name: 'schedule' }], skillNames: new Set() })
  assert.equal(live.commands.find(row => row.invocation === '/goal').id, 'claude.slash.goal')
  for (const name of ['loop', 'background', 'schedule']) assert.equal(live.commands.some(row => row.invocation === '/' + name), false)
  assert.ok(live.commands.some(row => row.invocation === '/compact'))
})

test('patch rejects input drift rather than silently omitting capabilities', () => {
  assert.throws(() => patchClaudeCommands('', (_s, from) => { throw new Error('drift ' + from) }), /drift/)
})
