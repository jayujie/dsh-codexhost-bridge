import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as tick } from 'node:timers/promises'

// Load the actual built bundle in memory, exposing private test subjects without
// changing production exports or writing a temporary bundle. Preserve file-based
// import.meta resolution. queryFactory below is a fake: no CLI or network runs.
const bundleUrl = new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url)
const source = await readFile(bundleUrl, 'utf8')
const instrumented = source.replaceAll('import.meta.url', JSON.stringify(bundleUrl.href)) +
  '\nexport { DshClaudeInputGate, dshClaudeRootLifecycle, ClaudeSdkTransport };\n'
let subjects
try { subjects = await import('data:text/javascript;base64,' + Buffer.from(instrumented).toString('base64')) }
catch (error) { throw new Error(`Built bundle test import failed: ${error.message}`) }
const { DshClaudeInputGate: Gate, dshClaudeRootLifecycle: supports, ClaudeSdkTransport: Transport } = subjects
const id = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const lifecycle = (state, command_uuid = id) => ({ type: 'command_lifecycle', state, command_uuid })
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', ...extra })
const assistant = () => ({ type: 'assistant', uuid: '33333333-3333-4333-8333-333333333333', parent_tool_use_id: null,
  message: { id: 'msg_test', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'reply' }], stop_reason: 'end_turn' } })

for (const [initialization, expected] of [
  [{}, false], [{ claude_code_version: '2.1.324' }, false],
  [{ claude_code_version: '2.1.325' }, true], [{ claude_code_version: '2.1.325-beta' }, true],
  [{ claude_code_version: '2.2.0' }, true], [{ claude_code_version: '3.0.0' }, true],
  [{ claude_code_version: '1.99.999' }, false], [{ claude_code_version: 'nonsense' }, false],
  [{ capabilities: ['msg_lifecycle_v1'] }, true],
]) test(`root lifecycle capability ${JSON.stringify(initialization)}`, () => assert.equal(supports(initialization), expected))

test('gate requires matching started, not queued or another UUID', () => {
  const gate = new Gate(id, true, 'human question')
  for (const frame of [result(), lifecycle('queued'), result(), lifecycle('started', other), assistant()]) assert.equal(gate.inspect(frame), 'wait')
  assert.equal(gate.inspect(lifecycle('started')), 'accept')
  assert.equal(gate.inspect(assistant()), 'accept')
  assert.equal(gate.empty({ status: 'succeeded' }), false)
})
test('gate learns matching lifecycle on older CLI and rejects unstarted early terminal', () => {
  const gate = new Gate(id, false, 'question')
  assert.equal(gate.inspect(lifecycle('queued')), 'wait')
  assert.equal(gate.inspect(lifecycle('refused')), 'rejected')
})
test('gate counts root assistant or stream message_start, never nested output', () => {
  const gate = new Gate(id, false, 'question')
  gate.inspect({ ...assistant(), parent_tool_use_id: 'nested' })
  assert.equal(gate.empty({ status: 'succeeded' }), true)
  gate.inspect({ type: 'stream_event', event: { type: 'message_start' } })
  assert.equal(gate.empty({ status: 'succeeded' }), false)
})
test('gate distinguishes queued cancellation and aborted terminal from success', () => {
  const gate = new Gate(id, true, 'question')
  gate.cancelRequested = true
  assert.equal(gate.inspect(lifecycle('cancelled')), 'cancelled')
  assert.equal(gate.inspect(result({ terminal_reason: 'aborted_streaming' })), 'accept')
  assert.equal(gate.inspect(result({ terminal_reason: 'aborted_tools' })), 'accept')
  assert.equal(gate.inspect(result()), 'wait')
})
test('gate exempts explicit local commands from empty-result failure', () => {
  const gate = new Gate(id, true, ' /compact')
  assert.equal(gate.inspect(result()), 'accept')
  assert.equal(gate.empty({ status: 'succeeded' }), false)
})

class Frames {
  queue = []; waiter = null; done = false
  push(frame) { if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value: frame, done: false }) } else this.queue.push(frame) }
  next() {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false })
    if (this.done) return Promise.resolve({ done: true })
    return new Promise(resolve => { this.waiter = resolve })
  }
  finish() { this.done = true; if (this.waiter) { this.waiter({ done: true }); this.waiter = null } }
  [Symbol.asyncIterator]() { return this }
}
async function fixture(initialization = { claude_code_version: '2.1.325' }) {
  const frames = new Frames(), events = [], faults = [], interrupts = []
  let input, queryCalls = 0
  const query = { initializationResult: async () => initialization, accountInfo: async () => ({}),
    interrupt: async (...args) => { interrupts.push(args) }, close: () => frames.finish(),
    [Symbol.asyncIterator]: () => frames }
  const transport = new Transport({ sessionId: other, cwd: process.cwd(), command: process.execPath,
    environment: {}, closeTimeoutMs: 100, thinkingOptionId: 'off', permissionMode: 'default',
    onFault: error => faults.push(error), onPermissionModeChanged() {}, onPlanLimit() {},
    queryFactory: options => { queryCalls++; input = options.prompt; return query } })
  await transport.start()
  return { transport, frames, events, faults, interrupts,
    async run(text = 'question') {
      let settled = false
      const promise = transport.runTurn(text, id, event => events.push(event))
      promise.finally(() => { settled = true }).catch(() => {})
      const sent = await input[Symbol.asyncIterator]().next()
      assert.equal(sent.value.uuid, id)
      return { promise, settled: () => settled }
    },
    async flush() { await tick(); await tick() },
    async close() { await transport.close(); assert.equal(queryCalls, 1); assert.deepEqual(faults, []) }
  }
}

test('built transport ignores old result/output between queued and matching started', async () => {
  const f = await fixture()
  try {
    const run = await f.run()
    for (const frame of [lifecycle('queued'), assistant(), result(), lifecycle('started', other), result()]) f.frames.push(frame)
    await f.flush()
    assert.equal(run.settled(), false)
    assert.equal(f.events.some(event => event.type === 'text.delta'), false)
    f.frames.push(lifecycle('started')); f.frames.push(assistant()); f.frames.push(result())
    assert.deepEqual(await run.promise, { status: 'succeeded' })
    assert.equal(f.events.filter(event => event.type === 'text.delta').map(event => event.delta).join(''), 'reply')
  } finally { await f.close() }
})

for (const withOutput of [true, false]) test(`built older CLI fallback: output=${withOutput}`, async () => {
  const f = await fixture({ claude_code_version: '2.1.324' })
  try {
    const run = await f.run()
    if (withOutput) f.frames.push(assistant())
    f.frames.push(result())
    assert.deepEqual(await run.promise, withOutput ? { status: 'succeeded' } : { status: 'failed', kind: 'emptyResponse' })
  } finally { await f.close() }
})

test('built transport nested result cannot terminate root', async () => {
  const f = await fixture()
  try {
    const run = await f.run()
    f.frames.push(lifecycle('started')); f.frames.push(result({ parent_tool_use_id: 'nested' }))
    await f.flush(); assert.equal(run.settled(), false)
    f.frames.push(assistant()); f.frames.push(result())
    assert.deepEqual(await run.promise, { status: 'succeeded' })
  } finally { await f.close() }
})

test('built transport accepts explicit /compact with no model output', async () => {
  const f = await fixture()
  try { const run = await f.run('/compact'); f.frames.push(result()); assert.deepEqual(await run.promise, { status: 'succeeded' }) }
  finally { await f.close() }
})

test('built transport reports matching unstarted refusal without replay', async () => {
  const f = await fixture()
  try { const run = await f.run(); f.frames.push(lifecycle('queued')); f.frames.push(lifecycle('refused')); assert.deepEqual(await run.promise, { status: 'failed', kind: 'inputNotStarted' }) }
  finally { await f.close() }
})

test('built transport abort before started consumes queued cancelled receipt', async () => {
  const f = await fixture()
  try {
    const run = await f.run(); f.frames.push(lifecycle('queued')); await f.flush()
    await f.transport.abort(); assert.equal(f.interrupts.length, 1)
    f.frames.push(lifecycle('cancelled'))
    assert.deepEqual(await run.promise, { status: 'cancelled', reason: 'cancelled' })
  } finally { await f.close() }
})
