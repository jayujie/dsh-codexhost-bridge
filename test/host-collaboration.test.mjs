import test from 'node:test'
import assert from 'node:assert/strict'
import { HostCollaboration } from '../host-collaboration.mjs'

const schema = name => ({ name, description: `Fixture ${name}`, parameters: { type: 'object', properties: {}, additionalProperties: false } })
const textResult = text => ({ isError: false, value: { text }, content: [{ type: 'text', text }] })

function fixture({ names = ['list_agents', 'send_message', 'team_task_list', 'pwsh'], maxOutputBytes = 32000, outcome = () => textResult('fixture-result') } = {}) {
  const controller = new AbortController(), selection = { provider: 'fixture', model: 'fixture-model' }
  const events = []
  const agent = { id: 'session-fixture', model: { current: () => selection }, session: { append(type, data) { events.push({ type, data }) }, snapshotEvents: () => events } }
  const visible = new Map(names.map(name => [name, schema(name)]))
  const resolves = [], executions = [], scopes = []
  let disposed = 0
  const toolSet = { view: scope => { scopes.push(scope); return scope === agent && !disposed ? new Map(visible) : new Map() }, dispose: () => { disposed++ } }
  const member = { self: 'lead' }
  const ctx = { subagents: { namesOf: () => ({ ...member }) }, sessionPersistence: { async flush() {} }, tools: {
    resolve: async input => { resolves.push(input); input.signal.throwIfAborted(); return toolSet },
    schemas: (scope, admitted) => [...admitted.view(scope).values()],
    definitions: (scope, admitted) => [...admitted.view(scope).values()],
    get: (name, scope, admitted) => admitted ? admitted.view(scope).get(name) : visible.get(name),
    executable: (name, scope, admitted) => admitted?.view(scope).get(name),
    execute: async input => {
      executions.push(input)
      const result = await outcome(input)
      return { results: input.calls.map(call => ({ callId: call.id, result })), additionalContexts: [], concluded: false }
    },
  } }
  const helpers = { ToolCallId: value => value, createUserMessage: value => value, createAssistantMessage: value => value, createToolResultMessage: value => value, appendPluginRecord: (session, type, data) => session.append(type, data) }
  const manager = new HostCollaboration(ctx, helpers, { maxOutputBytes })
  const open = () => manager.open({ agent, turn: 3, step: 2, signal: controller.signal })
  return { manager, open, agent, member, selection, controller, toolSet, resolves, executions, scopes, visible, events, disposed: () => disposed }
}

async function denied(operation) {
  try {
    const result = await operation()
    assert.equal(result?.isError, true, 'a denied request must reject or return an MCP error')
  } catch (error) {
    // Assertion failures are not an accepted rejection from the implementation.
    if (error?.code === 'ERR_ASSERTION') throw error
    assert.ok(error instanceof Error)
  }
}

test('collaboration resolves and executes with the exact Agent, toolSet, cancellation and step log', async () => {
  const f = fixture(), lease = await f.open()
  try {
    assert.equal(f.resolves.length, 1)
    assert.equal(f.resolves[0].agent, f.agent)
    assert.equal(f.resolves[0].modelSelection, f.selection)
    assert.equal(f.resolves[0].signal, f.controller.signal)
    assert.deepEqual(lease.schemas.map(tool => tool.name).sort(), ['list_agents', 'send_message', 'team_task_list'])
    for (const tool of lease.schemas) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'name', 'parameters'])
      assert.equal(tool.parameters.type, 'object')
    }
    const result = await lease.call({ id: 'native-call-1', name: 'list_agents', arguments: {} })
    assert.deepEqual(result.content, [{ type: 'text', text: 'fixture-result' }])
    assert.notEqual(result.isError, true)
    assert.equal(f.executions.length, 1)
    const execution = f.executions[0]
    assert.equal(execution.agent, f.agent)
    assert.equal(execution.toolSet, f.toolSet)
    assert.deepEqual(execution.log, { turn: 3, step: 2 })
    assert.equal(execution.signal.aborted, false)
    assert.equal(execution.calls.length, 1)
    assert.equal(execution.calls[0].name, 'list_agents')
    assert.ok(f.scopes.every(scope => scope === f.agent))
  } finally { await lease.close() }
  assert.equal(f.disposed(), 1)
})

test('collaboration rejects non-allowlisted tools and unadmitted Team tools before execution', async () => {
  const f = fixture({ names: ['list_agents', 'pwsh'] }), lease = await f.open()
  try {
    assert.deepEqual(lease.schemas.map(tool => tool.name), ['list_agents'])
    await denied(() => lease.call({ id: 'forbidden', name: 'pwsh', arguments: {} }))
    await denied(() => lease.call({ id: 'unadmitted', name: 'team_task_create', arguments: { subject: 'x', description: 'x' } }))
    assert.equal(f.executions.length, 0)
  } finally { await lease.close() }
})

test('collaboration rechecks scoped admission when a tool is removed during the Turn', async () => {
  const f = fixture(), lease = await f.open()
  try {
    f.visible.delete('team_task_list')
    await denied(() => lease.call({ id: 'removed-team', name: 'team_task_list', arguments: {} }))
    assert.equal(f.executions.length, 0)
  } finally { await lease.close() }
})

test('concurrent and completed duplicate ids execute once; conflicting reuse is denied', async () => {
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const f = fixture({ outcome: async () => { await waiting; return textResult('one execution') } }), lease = await f.open()
  try {
    const request = { id: 'duplicate', name: 'send_message', arguments: { agent: 'worker', message: 'hello' } }
    const first = lease.call(request), second = lease.call({ ...request, arguments: { ...request.arguments } })
    await denied(() => lease.call({ ...request, arguments: { agent: 'worker', message: 'different' } }))
    finish()
    assert.deepEqual(await first, await second)
    assert.deepEqual(await lease.call(request), await first)
    assert.equal(f.executions.length, 1)
  } finally { finish(); await lease.close() }
})

test('an aborted Turn refuses calls without dispatching and releases its admitted set', async () => {
  const f = fixture(), lease = await f.open()
  f.controller.abort(new Error('fixture cancelled'))
  await denied(() => lease.call({ id: 'cancelled', name: 'list_agents', arguments: {} }))
  assert.equal(f.executions.length, 0)
  await lease.close()
  assert.equal(f.disposed(), 1)
})

test('Turn cancellation reaches an already running executor', async () => {
  let entered, observed
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture({ outcome: input => new Promise(resolve => {
    const finish = () => { observed = input.signal.aborted; resolve({ isError: true, error: { code: 'ABORTED', message: 'cancelled' }, content: [{ type: 'text', text: 'cancelled' }] }) }
    input.signal.addEventListener('abort', finish, { once: true })
    entered()
    if (input.signal.aborted) finish()
  }) }), lease = await f.open()
  try {
    const pending = lease.call({ id: 'in-flight', name: 'list_agents', arguments: {} })
    await started
    f.controller.abort(new Error('during execution'))
    await pending.catch(() => undefined)
    assert.equal(observed, true)
    assert.equal(f.executions.length, 1)
  } finally { await lease.close() }
})

test('an already aborted open never executes tools', async () => {
  const f = fixture()
  f.controller.abort(new Error('before open'))
  await assert.rejects(f.open())
  assert.equal(f.executions.length, 0)
})

test('close is idempotent and closed leases reject even a previously completed request', async () => {
  const f = fixture(), lease = await f.open()
  const request = { id: 'finished', name: 'list_agents', arguments: {} }
  await lease.call(request)
  await lease.close()
  await lease.close()
  await denied(() => lease.call(request))
  await denied(() => lease.call({ ...request, id: 'after-close' }))
  assert.equal(f.executions.length, 1)
  assert.equal(f.disposed(), 1)
})

test('MCP result bounds apply to the complete UTF-8 JSON including wrappers and all content blocks', async () => {
  const budget = 512
  const f = fixture({ maxOutputBytes: budget, outcome: () => ({ isError: false, value: {}, content: Array.from({ length: 8 }, () => ({ type: 'text', text: '中文😀\\"\n'.repeat(200) })) }) }), lease = await f.open()
  try {
    const result = await lease.call({ id: 'oversized', name: 'list_agents', arguments: {} })
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= budget)
    assert.ok(Array.isArray(result.content))
    assert.ok(result.content.length > 0)
    for (const block of result.content) if (block.type === 'text') assert.equal(block.text.includes('\ufffd'), false)
  } finally { await lease.close() }
})

test('schema discovery and denied requests keep durable request/result records', async () => {
  const f = fixture(), lease = await f.open()
  try {
    await lease.call({ id: 'schemas', name: '__list__', arguments: {} })
    await denied(() => lease.call({ id: 'denied', name: 'pwsh', arguments: {} }))
    const records = f.events.filter(event => event.type === 'plugin:dsh-host/collaboration')
    assert.deepEqual(records.map(event => [event.data.id, event.data.phase]), [['schemas', 'request'], ['schemas', 'result'], ['denied', 'request'], ['denied', 'result']])
    assert.equal(records.at(-1).data.result.isError, true)
    assert.equal(f.executions.length, 0)
  } finally { await lease.close() }
})

test('discovery returns live identity and rules only on demand, without starting work', async () => {
  const f = fixture(), lease = await f.open()
  try {
    assert.equal(f.events.length, 0, 'opening admission must not inject guidance or execute anything')
    const first = await lease.call({ id: 'discover-root', name: '__list__', arguments: {} })
    const discovered = JSON.parse(first.content[0].text)
    assert.deepEqual(discovered.agent, { self: 'lead' })
    assert.deepEqual(discovered.tools.map(tool => tool.name), ['list_agents', 'send_message', 'team_task_list'])
    assert.match(discovered.instructions, /Team mode does not require creating teammates or tasks/)
    assert.match(discovered.instructions, /Wait for required results/)
    f.member.self = 'review'; f.member.parent = 'lead'
    f.visible.delete('team_task_list')
    const next = await lease.call({ id: 'discover-child', name: '__list__', arguments: {} })
    const current = JSON.parse(next.content[0].text)
    assert.deepEqual(current.agent, { self: 'review', parent: 'lead' })
    assert.equal(current.tools.some(tool => tool.name === 'team_task_list'), false)
    assert.equal(f.executions.length, 0)
    const audit = f.events.find(event => event.data.id === 'discover-root' && event.data.phase === 'result')
    assert.equal(audit.data.result.content[0].text, first.content[0].text, 'model-visible discovery stays durable')
  } finally { await lease.close() }
})

test('executor failure repairs the advertised call before closing the Turn lease', async () => {
  const f = fixture({ outcome: () => { throw new Error('Executor unavailable') } }), lease = await f.open()
  await assert.rejects(lease.call({ id: 'broken', name: 'list_agents', arguments: {} }), /Executor unavailable/)
  await lease.close()
  const result = f.events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.callId, 'hostcollab:3:broken')
  assert.equal(result.data.message.isError, true)
  assert.equal(f.events.find(event => event.type === 'assistant/message').data.message.source.model, 'tool-dispatch')
})

test('a small complete MCP result preserves its content and execution failure state', async () => {
  const f = fixture({ maxOutputBytes: 512, outcome: () => ({ isError: true, error: { code: 'FIXTURE', message: 'expected failure' }, content: [{ type: 'text', text: 'expected failure' }] }) }), lease = await f.open()
  try {
    const result = await lease.call({ id: 'error-result', name: 'list_agents', arguments: {} })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: 'expected failure' }])
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512)
  } finally { await lease.close() }
})

test('wait_agent drains next-step inbox messages, records user/message, notifies wait state, and returns messages to prevent spin', async () => {
  const pending = [
    { id: 'msg-1', source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent worker finished.', senderSessionId: 'child-1' }, content: [{ type: 'text', text: 'Background subagent worker finished.\nResult: 42' }] },
  ]
  const claimedCalls = []
  const waitStates = []
  const f = fixture({
    names: ['wait_agent', 'list_agents'],
    outcome: () => ({ isError: false, value: { timedOut: false }, content: [{ type: 'text', text: '{"timedOut":false}' }] }),
  })
  f.agent.inbox = {
    get nextStep() { return pending },
    claim(target, turn) {
      claimedCalls.push({ target, turn })
      return pending.splice(0, pending.length)
    },
  }
  const lease = await f.manager.open({ agent: f.agent, turn: 3, step: 2, signal: f.controller.signal, onWaitingChange: waiting => waitStates.push(waiting) })
  try {
    const result = await lease.call({ id: 'wait-1', name: 'wait_agent', arguments: { timeout_ms: 10000 } })
    assert.notEqual(result.isError, true)
    assert.deepEqual(waitStates, [true, false])
    assert.deepEqual(claimedCalls, [{ target: 'next-step', turn: 3 }])
    assert.equal(pending.length, 0)
    const parsed = JSON.parse(result.content[0].text)
    assert.equal(parsed.timedOut, false)
    assert.equal(parsed.messages.length, 1)
    assert.equal(parsed.messages[0].id, 'msg-1')
    assert.match(parsed.messages[0].text, /Result: 42/)
    const recorded = f.events.filter(event => event.type === 'user/message')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].data.id, 'msg-1')
  } finally { await lease.close() }
})

test('wait_agent timeout leaves inbox untouched and returns timedOut: true', async () => {
  const pending = [{ id: 'msg-untouched', source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'later' }] }]
  const waitStates = []
  const f = fixture({
    names: ['wait_agent'],
    outcome: () => ({ isError: false, value: { timedOut: true }, content: [{ type: 'text', text: '{"timedOut":true}' }] }),
  })
  f.agent.inbox = {
    get nextStep() { return pending },
    claim() { throw new Error('should not claim on timeout') },
  }
  const lease = await f.manager.open({ agent: f.agent, turn: 3, step: 2, signal: f.controller.signal, onWaitingChange: waiting => waitStates.push(waiting) })
  try {
    const result = await lease.call({ id: 'wait-timeout', name: 'wait_agent', arguments: { timeout_ms: 10000 } })
    assert.deepEqual(waitStates, [true, false])
    assert.deepEqual(JSON.parse(result.content[0].text), { timedOut: true })
    assert.equal(pending.length, 1)
  } finally { await lease.close() }
})
