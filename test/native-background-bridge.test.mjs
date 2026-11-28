import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { NATIVE_BACKGROUND_SCHEMA, nativeBackgroundOperation, validateNativeBackgroundCall } from '../native-background-bridge.mjs'
import { HostCollaboration, installCollaborationBridge } from '../host-collaboration.mjs'

function fixture() {
  const events = [], calls = [], cleanup = []
  const session = { snapshotEvents: () => events, append(type, data, options) { const e = { type, data, seq: events.length, ...options }; events.push(e); return e } }
  const agent = { id: 'owner', session, model: { current: () => ({ provider: 'fixture', model: 'fixture' }) }, inject() {} }
  const tools = ['pwsh', 'job_list', 'job_output', 'job_kill']
  const ctx = { tools: { async resolve(input) { assert.equal(input.agent, agent); return { dispose() {} } }, schemas: () => tools.map(name => ({ name })), get: name => tools.includes(name) ? {} : undefined,
    async execute(input) { assert.equal(input.agent, agent); assert.deepEqual(input.log, { turn: 1, step: 1 }); calls.push(input.calls[0]); return { additionalContexts: [], results: [{ result: { content: [{ type: 'text', text: 'job result' }] } }] } } }, sessionPersistence: { async flush() {} }, effect: fn => cleanup.push(fn()) }
  const helpers = { appendPluginRecord: (s, t, d) => s.append(t, d), ToolCallId: x => x, createAssistantMessage: x => x, createToolResultMessage: x => x }
  return { ctx, helpers, agent, calls, events, cleanup, manager: new HostCollaboration(ctx, helpers) }
}

test('SDK affordance normalizes only the four scoped DSH background operations', () => {
  assert.equal(NATIVE_BACKGROUND_SCHEMA.inputSchema.additionalProperties, false)
  assert.deepEqual(nativeBackgroundOperation({ action: 'start', command: 'Write-Output ok', workdir: 'D:/work' }), { name: 'pwsh', arguments: { command: 'Write-Output ok', workdir: 'D:/work', run_in_background: true } })
  assert.deepEqual(nativeBackgroundOperation({ action: 'list' }), { name: 'job_list', arguments: {} })
  assert.deepEqual(nativeBackgroundOperation({ action: 'output', job_id: 'job', wait: true, timeout_ms: 25 }), { name: 'job_output', arguments: { job_id: 'job', wait: true, timeout_ms: 25 } })
  assert.deepEqual(nativeBackgroundOperation({ action: 'stop', job_id: 'job', reason: 'done' }), { name: 'job_kill', arguments: { job_id: 'job', reason: 'done' } })
})

test('no owner substitution, foreground shell, deadline kill, escalation or unknown fields cross this channel', () => {
  for (const input of [{ action: 'start', command: '' }, { action: 'start', command: 'ok', timeoutMs: 1 }, { action: 'start', command: 'ok', owner: 'victim' }, { action: 'start', command: 'ok', sandbox_permissions: 'danger-full-access' }, { action: 'output', job_id: 'job', sessionId: 'victim' }, { action: 'output', job_id: 'job', timeout_ms: -1 }, { action: '__proto__' }, { action: 'constructor' }]) assert.throws(() => nativeBackgroundOperation(input))
  assert.throws(() => validateNativeBackgroundCall('pwsh', { command: 'ok', run_in_background: false }))
  assert.throws(() => validateNativeBackgroundCall('subagent', {}))
  assert.throws(() => validateNativeBackgroundCall('__proto__', {}))
})

test('background start uses normal admitted executor/logging once and closes with the actual DSH Turn', async () => {
  const f = fixture(), controller = new AbortController(), lease = await f.manager.open({ agent: f.agent, turn: 1, step: 1, signal: controller.signal })
  const request = { id: 'start', channel: 'background', ...nativeBackgroundOperation({ action: 'start', command: 'Write-Output ok' }) }
  try {
    const first = await lease.call(request), second = await lease.call(request)
    assert.deepEqual(first, second); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'pwsh')
    assert.equal(JSON.parse(f.calls[0].arguments).run_in_background, true)
    assert.ok(f.events.some(e => e.type === 'plugin:dsh-host/collaboration' && e.data.channel === 'background'))
    await assert.rejects(lease.call({ ...request, arguments: { command: 'different', run_in_background: true } }), /conflict/)
    await lease.close(); await assert.rejects(lease.call({ ...request, id: 'after-close' }), /no longer active/)
  } finally { await f.manager.close() }
})

test('existing collaboration cannot silently turn into a shell or use an invalid channel', async () => {
  const f = fixture(), lease = await f.manager.open({ agent: f.agent, turn: 1, step: 1, signal: new AbortController().signal })
  try {
    await assert.rejects(lease.call({ id: 'denied', name: 'pwsh', arguments: { command: 'ok', run_in_background: true } }), /not admitted/)
    await assert.rejects(lease.call({ id: 'denied2', channel: 'other', name: 'pwsh', arguments: {} }), /channel/)
    assert.equal(f.calls.length, 0)
  } finally { await f.manager.close() }
})

test('real authenticated SDK MCP routes start/output/stop; expired/foreign/autonomous requests cannot start jobs', async () => {
  const f = fixture(); let active = true, autonomousCalls = 0
  const lease = await f.manager.open({ agent: f.agent, turn: 1, step: 1, signal: new AbortController().signal })
  const driver = { collaborationFor: id => active && id === 'thread' ? lease : undefined, callAutonomousCollaboration: async () => { autonomousCalls++; return { content: [] } } }
  const bridge = await installCollaborationBridge(f.ctx, driver, f.helpers)
  try {
    const files = ['claude-wake-policy.txt', 'native-background-bridge.mjs', 'claude-collaboration-sdk.txt']
    const code = (await Promise.all(files.map(name => readFile(new URL('../' + name, import.meta.url), 'utf8')))).map(s => s.replace(/^export /gm, '')).join('\n')
    const sdk = vm.runInNewContext(code + '\n({dshCollaborationMcp})', { fetch, URL, Object })
    const env = { ...bridge.environment, CODEXHOST_THREAD_ID: 'thread' }, frames = []
    const mcp = sdk.dshCollaborationMcp(env)['dsh-collaboration'], transport = { async start() {}, async send(value) { frames.push(value) } }
    await mcp.instance.connect(transport)
    await transport.onmessage({ id: 1, method: 'tools/list' })
    assert.deepEqual(JSON.parse(JSON.stringify(frames[0].result.tools.map(x => x.name))), ['dsh_collaboration', 'dsh_background'])
    const invoke = async (id, args) => { await transport.onmessage({ id, method: 'tools/call', params: { name: 'dsh_background', arguments: args } }); return frames.at(-1).result }
    assert.equal((await invoke(2, { action: 'start', command: 'Write-Output ok' })).isError, undefined)
    assert.equal((await invoke(3, { action: 'output', job_id: 'job' })).isError, undefined)
    assert.equal((await invoke(4, { action: 'stop', job_id: 'job' })).isError, undefined)
    assert.deepEqual(f.calls.map(x => x.name), ['pwsh', 'job_output', 'job_kill'])
    active = false
    assert.equal((await invoke(5, { action: 'start', command: 'should-not-start' })).isError, true)
    const body = { threadId: 'foreign', id: 'bad', channel: 'background', name: 'pwsh', arguments: { command: 'bad', run_in_background: true } }
    const response = await fetch(env.DSH_COLLABORATION_URL, { method: 'POST', headers: { authorization: 'Bearer ' + env.DSH_COLLABORATION_TOKEN }, body: JSON.stringify(body) })
    assert.equal(response.status, 403); assert.equal(autonomousCalls, 0); assert.equal(f.calls.length, 3)
  } finally { await lease.close(); for (const dispose of f.cleanup.reverse()) await dispose(); await f.manager.close() }
})
