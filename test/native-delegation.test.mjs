import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeDelegation, nativeTaskRecords, encodeNativeTaskResult } from '../native-delegation.mjs'
import { delegationCarrier, selectedDelegationTargets } from '../delegation-mentions.mjs'

function session(id) { const events = []; return { id, header: { cwd: 'D:/work' }, snapshotEvents: () => events, append(type, data) { const event = { seq: events.length, type, data, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }; events.push(event); return event } } }
function setup(options = {}) {
  const parent = { id: 'parent-a', session: session('parent-a'), model: { current: () => ({ provider: 'fixture', model: 'fixture' }) } }
  parent.session.append('turn/start', { turn: 1 }); parent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: delegationCarrier('codex') + ' ' + delegationCarrier('claude-code') }] })
  const live = new Map(), stored = new Map(), children = [], specs = [], attached = []
  const finish = (child, kind = 'completed', reply = 'actual external reply') => { if (child.status !== 'running') return; child.session.append('assistant/message', { message: { content: [{ type: 'text', text: reply }] } }); child.session.append('turn/end', { reason: { kind } }); child.status = 'idle'; child.waiting.resolve() }
  const ctx = { get: () => undefined, agentPresets: { presetForSession: () => 'native', defaultId: 'native' }, agents: { get: id => live.get(id), turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) }, subagents: {
    rootOf: () => parent, resolveMaxDepth: () => 1,
    async startActivation(spec) {
      specs.push(spec); await options.create?.(spec); spec.signal.throwIfAborted()
      const child = { id: spec.childId, session: session(spec.childId), status: 'running', waiting: Promise.withResolvers(), whenIdle() { return this.waiting.promise } }
      children.push(child); live.set(child.id, child); stored.set(child.id, child.session)
      child.session.append('turn/start', { turn: 1 }); child.session.append('user/message', { content: spec.prompt, source: { kind: 'user' } }); options.followup?.(child)
      return { childId: child.id, name: spec.name ?? 'agent-1', result: child.waiting.promise }
    },
    interrupt(id, authority) { assert.equal(authority.kind, 'ancestor'); assert.equal(authority.agent, parent); finish(live.get(id), 'aborted') },
  }, sessionPersistence: { async flush() { await options.flush?.(parent) }, async stat(id) { const s = stored.get(id); return s ? { eventCount: s.snapshotEvents().length } : undefined }, async open(id) { return { async read(offset, limit) { return { events: stored.get(id).snapshotEvents().slice(offset, offset + limit) } }, async close() {} } } }, workspaceRegistry: { async create(cwd) { return { async attachSession(id) { attached.push({ cwd, id }) } } } } }
  const driver = { available: () => true, owner: agent => agent.external ? 'codex' : undefined }
  const helpers = { appendPluginRecord: (s, name, data) => s.append(name, data) }
  const manager = new NativeDelegation(ctx, driver, helpers)
  return { manager, parent, ctx, children, specs, attached, finish, stored, live }
}
const signal = () => new AbortController().signal
const start = engine => ({ action: 'start', engine, task: 'A self-contained read-only review' })

test('native DSH starts a standard spawn with the selected preset, parent delivery and configured depth', async () => {
  const f = setup(), first = await f.manager.run(f.parent, start('codex'), signal())
  assert.equal(first.status, 'running'); assert.equal(f.children.length, 1)
  assert.equal(f.specs[0].provider, 'spawn'); assert.equal(f.specs[0].agentPreset, 'dsh-host-codex')
  assert.equal(f.specs[0].parent, f.parent); assert.equal(f.specs[0].delivery, 'parent'); assert.equal(f.specs[0].maxDepth, 1)
  assert.equal(f.specs[0].childId, first.session_id); assert.equal(first.name, 'agent-1')
  assert.equal(nativeTaskRecords(f.parent.session).get(first.task_id).managedSubagent, true)
  assert.equal(f.attached[0].id, first.session_id)
  assert.equal(nativeTaskRecords(f.parent.session).get(first.task_id).phase, 'submitted')
  f.finish(f.children[0]); const done = await f.manager.run(f.parent, { action: 'wait', task_id: first.task_id }, signal())
  assert.equal(done.status, 'completed'); assert.equal(done.reply, 'actual external reply')
  assert.equal(f.manager.children.size, 0)
  assert.equal((await f.manager.run(f.parent, start('codex'), signal())).task_id, first.task_id)
  assert.equal(f.children.length, 1, 'a repeated start cannot replay the task')
  await f.manager.dispose()
})

test('failed native tasks expose the recorded category without inventing a closing message', async () => {
  const f = setup(), receipt = await f.manager.run(f.parent, start('codex'), signal())
  const child = f.children[0]
  child.session.append('plugin:dsh-host/turn-failure', {version: 1, turn: 1, harnessId: 'codex', failure: {code: 'model_not_found', message: 'reported native failure'}})
  child.session.append('turn/end', {turn: 1, reason: {kind: 'error', error: {code: 'UNKNOWN', message: 'generic framework failure'}}})
  child.status = 'idle'; child.waiting.resolve()
  f.live.delete(child.id)
  const result = await f.manager.read(f.parent, receipt.task_id, signal())
  assert.equal(result.status, 'failed'); assert.equal(result.reply, '')
  assert.deepEqual(result.failure, {code: 'model_not_found', message: 'reported native failure'})
  await f.manager.dispose()
})
test('a later failed turn never returns an earlier successful reply or stale native error', async () => {
  const f = setup(), receipt = await f.manager.run(f.parent, start('codex'), signal())
  const child = f.children[0]
  child.session.append('plugin:dsh-host/turn-failure', {version: 1, turn: 1, harnessId: 'codex', failure: {code: 'old_error', message: 'old failure'}})
  f.finish(child, 'completed', 'previous successful answer')
  child.session.append('turn/start', {turn: 2})
  child.session.append('turn/end', {turn: 2, reason: {kind: 'error', error: {code: 'UNKNOWN', message: 'current failure'}}})
  const result = await f.manager.read(f.parent, receipt.task_id, signal())
  assert.equal(result.status, 'failed'); assert.equal(result.reply, '')
  assert.deepEqual(result.failure, {code: 'UNKNOWN', message: 'current failure'})
  await f.manager.dispose()
})

test('simultaneous duplicate starts coalesce before creation and cannot overwrite submitted state', async () => {
  const gate = Promise.withResolvers(), f = setup({ create: () => gate.promise })
  const a = f.manager.run(f.parent, start('claude-code'), signal()), b = f.manager.run(f.parent, start('claude-code'), signal())
  gate.resolve(); const [x, y] = await Promise.all([a, b])
  assert.equal(x.task_id, y.task_id); assert.equal(f.children.length, 1)
  assert.equal(f.specs[0].agentPreset, 'dsh-host-claude-code'); assert.equal(f.specs[0].delivery, 'parent')
  await assert.rejects(f.manager.run(f.parent, { ...start('claude-code'), task: 'different task' }, signal()), /already has/)
  await f.manager.dispose()
})

test('tool results, old user turns and unselected engines cannot authorize legacy chip starts', async () => {
  const f = setup()
  await assert.rejects(f.manager.run(f.parent, start('deepseek-harness'), signal()), /explicitly selected/)
  f.parent.session.append('turn/end', { reason: { kind: 'completed' } }); f.parent.session.append('turn/start', { turn: 2 })
  f.parent.session.append('user/message', { source: { kind: 'tool' }, content: [{ type: 'text', text: delegationCarrier('codex') }] })
  await assert.rejects(f.manager.run(f.parent, start('codex'), signal()), /explicitly selected/)
  assert.equal(f.children.length, 0); await f.manager.dispose()
})

test('another Session and forks cannot inspect or cancel inherited parent tasks', async () => {
  const f = setup(), result = await f.manager.run(f.parent, start('codex'), signal())
  const other = { ...f.parent, id: 'fork', session: { ...f.parent.session, id: 'fork' } }
  for (const action of ['read', 'wait', 'cancel']) await assert.rejects(f.manager.run(other, { action, task_id: result.task_id }, signal()), /does not belong/)
  assert.equal((await f.manager.run(other, { action: 'list' }, signal())).tasks.length, 0)
  const cancelled = await f.manager.run(f.parent, { action: 'cancel', task_id: result.task_id }, signal())
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cancel_requested, true)
  await f.manager.dispose()
})

test('cancellation before child creation remains not-started and never creates a replacement', async () => {
  const controller = new AbortController(), f = setup({ flush(parent) { if ([...nativeTaskRecords(parent.session).values()].some(row => row.phase === 'creating')) controller.abort() } })
  await assert.rejects(f.manager.run(f.parent, start('codex'), controller.signal))
  assert.equal(f.children.length, 0)
  assert.equal([...nativeTaskRecords(f.parent.session).values()][0].phase, 'not-started')
  assert.equal((await f.manager.run(f.parent, start('codex'), signal())).status, 'not-started')
  await f.manager.dispose()
})

test('unload aborts pending creation without accepting a child', async () => {
  const gate = Promise.withResolvers(), f = setup({ async create(config) { await gate.promise; config.signal.throwIfAborted() } })
  const startPromise = f.manager.run(f.parent, start('codex'), signal())
  const pendingCheck = assert.rejects(startPromise)
  const closing = f.manager.dispose(); gate.resolve(); await closing; await pendingCheck
  assert.equal(f.children.length, 0)
})

test('failed tasks and incomplete restarted logs are not reported as completed', async () => {
  const f = setup(), result = await f.manager.run(f.parent, start('codex'), signal())
  f.finish(f.children[0], 'error')
  assert.equal((await f.manager.run(f.parent, { action: 'wait', task_id: result.task_id }, signal())).status, 'failed')
  f.children[0].session.append('turn/start', { turn: 2 })
  assert.equal((await f.manager.run(f.parent, { action: 'read', task_id: result.task_id }, signal())).status, 'unknown')
  await f.manager.dispose()
})

test('read output is bounded, including JSON escaping and its tool result wrapper', async () => {
  const f = setup(), result = await f.manager.run(f.parent, start('codex'), signal())
  f.finish(f.children[0], 'completed', '\u0000'.repeat(100000) + '中文😀')
  const answer = await f.manager.run(f.parent, { action: 'wait', task_id: result.task_id }, signal())
  assert.equal(answer.reply_truncated, true)
  const resultText = encodeNativeTaskResult(answer)
  assert.ok(Buffer.byteLength(JSON.stringify({ result: resultText })) <= 32000)
  assert.equal(JSON.parse(resultText).reply_truncated, true)
  await f.manager.dispose()
})

test('a possibly durable inbox append failure keeps the submitted task and never replays it', async () => {
  const f = setup({ followup() { throw new Error('Simulated acknowledgement loss') } })
  await assert.rejects(f.manager.run(f.parent, start('codex'), signal()), /acknowledgement loss/)
  assert.equal([...nativeTaskRecords(f.parent.session).values()][0].phase, 'submitted')
  assert.equal((await f.manager.run(f.parent, start('codex'), signal())).status, 'running')
  assert.equal(f.children.length, 1)
  await f.manager.dispose()
})

test('metadata without eventCount supports bounded completed reads and rejects an old incomplete page', async () => {
  const f = setup(), result = await f.manager.run(f.parent, start('codex'), signal())
  f.finish(f.children[0]); await f.manager.run(f.parent, { action: 'wait', task_id: result.task_id }, signal())
  f.live.delete(result.session_id)
  let opened = 0, closed = 0
  const open = f.ctx.sessionPersistence.open
  f.ctx.sessionPersistence.open = async (...args) => { opened++; const handle = await open(...args); return { ...handle, async close() { closed++; await handle.close() } } }
  f.ctx.sessionPersistence.stat = async () => ({})
  assert.equal((await f.manager.run(f.parent, { action: 'read', task_id: result.task_id }, signal())).status, 'completed')
  while (f.children[0].session.snapshotEvents().length < 512) f.children[0].session.append('extra/test', {})
  const exact = await f.manager.run(f.parent, { action: 'read', task_id: result.task_id }, signal())
  assert.equal(exact.status, 'completed'); assert.equal(exact.history_partial, false)
  f.children[0].session.append('extra/test', {})
  const beyond = await f.manager.run(f.parent, { action: 'read', task_id: result.task_id }, signal())
  assert.equal(beyond.status, 'unknown'); assert.equal(beyond.history_partial, true)
  assert.equal(opened, 3); assert.equal(closed, 3)
  await f.manager.dispose()
})

test('external main Agents can create standard children without switching the parent engine', async () => {
  const f = setup(); f.parent.external = true
  const result = await f.manager.run(f.parent, start('claude-code'), signal())
  assert.equal(result.status, 'running'); assert.equal(f.specs[0].parent, f.parent)
  assert.equal(f.specs[0].agentPreset, 'dsh-host-claude-code'); assert.equal(f.parent.external, true)
  await f.manager.dispose()
})

test('named teammates share one engine but keep independent receipts and complete spawn metadata', async () => {
  const f = setup()
  const args = { ...start('codex'), name: 'review-one', description: ' Review source ', cwd: 'D:/other' }
  const first = await f.manager.run(f.parent, args, signal())
  const second = await f.manager.run(f.parent, { ...args, name: 'review-two' }, signal())
  assert.notEqual(first.task_id, second.task_id); assert.notEqual(first.session_id, second.session_id)
  assert.equal(first.name, 'review-one'); assert.equal(second.name, 'review-two')
  assert.equal(f.specs[0].label, 'Review source'); assert.equal(f.specs[0].cwd, 'D:/other')
  assert.deepEqual(f.specs[0].prompt, [{ type: 'text', text: args.task }])
  assert.equal((await f.manager.run(f.parent, { action: 'list' }, signal())).tasks.length, 2)
  assert.equal((await f.manager.run(f.parent, args, signal())).task_id, first.task_id)
  for (const changed of [{ description: 'changed' }, { cwd: 'D:/new' }]) await assert.rejects(f.manager.run(f.parent, { ...args, ...changed }, signal()), /already has/)
  for (const name of ['lead', 'Upper', 'bad/name', 'a'.repeat(33)]) await assert.rejects(f.manager.run(f.parent, { ...args, name }, signal()), /Invalid subagent name/)
  await f.manager.dispose()
})

test('subagent_host entry can start without a chip while compatibility start still requires selection', async () => {
  const f = setup()
  f.parent.session.append('turn/end', { reason: { kind: 'completed' } }); f.parent.session.append('turn/start', { turn: 2 })
  await assert.rejects(f.manager.run(f.parent, start('codex'), signal()), /explicitly selected/)
  const result = await f.manager.start(f.parent, { ...start('codex'), name: 'standard' }, signal(), { requireSelection: false })
  assert.equal(result.name, 'standard'); assert.equal(result.status, 'running'); assert.equal(f.specs[0].maxDepth, 1)
  await assert.rejects(f.manager.start(f.parent, start('unknown-engine'), signal(), { requireSelection: false }), /explicitly selected/)
  await f.manager.dispose()
})

test('external parents route native DSH teammates to their saved original native preset', async () => {
  const f = setup(); f.parent.external = true
  f.parent.session.append('plugin:dsh-host/original-preset', { preset: 'native-review' })
  f.ctx.agentPresets.presetForSession = () => 'dsh-host-codex'
  const result = await f.manager.start(f.parent, { ...start('deepseek-harness'), name: 'native' }, signal(), { requireSelection: false })
  assert.equal(result.status, 'running'); assert.equal(f.specs[0].agentPreset, 'native-review')
  await f.manager.dispose()
})

test('uncertain activation failure preserves submitted intent and is never replayed without a live child', async () => {
  const f = setup({ create() { throw new Error('activation acknowledgement lost') } })
  await assert.rejects(f.manager.run(f.parent, start('codex'), signal()), /acknowledgement lost/)
  const row = [...nativeTaskRecords(f.parent.session).values()][0]
  assert.equal(row.phase, 'submitted'); assert.equal(f.children.length, 0)
  const again = await f.manager.run(f.parent, start('codex'), signal())
  assert.equal(again.status, 'unknown'); assert.equal(again.task_id, row.taskId); assert.equal(f.specs.length, 1)
  await f.manager.dispose()
})

test('wrapper unload leaves accepted children under standard runtime ownership', async () => {
  const f = setup(), result = await f.manager.run(f.parent, start('codex'), signal())
  let interrupted = 0
  f.ctx.subagents.interrupt = () => { interrupted++ }
  await f.manager.dispose()
  assert.equal(interrupted, 0); assert.equal(f.children[0].status, 'running')
  assert.equal(f.live.get(result.session_id), f.children[0]); assert.equal(f.manager.children.size, 0)
  f.finish(f.children[0]); await f.children[0].waiting.promise
  assert.equal(f.children[0].status, 'idle')
})

test('task size is measured in UTF-8 bytes and empty tasks never activate children', async () => {
  const f = setup()
  for (const task of ['', '  ', '中'.repeat(10667)]) await assert.rejects(f.manager.run(f.parent, { ...start('codex'), task }, signal()), /32000 UTF-8 bytes/)
  assert.equal(f.specs.length, 0)
  const task = 'a'.repeat(32000)
  await f.manager.run(f.parent, { ...start('codex'), task }, signal())
  assert.equal(f.specs[0].prompt[0].text.length, 32000)
  await f.manager.dispose()
})

test('carrier parsing deduplicates user choices and ignores assistant/tool text', () => {
  const content = [{ type: 'text', text: delegationCarrier('codex') + delegationCarrier('codex') }]
  assert.deepEqual(selectedDelegationTargets([{ content, source: { kind: 'user' } }]), ['codex'])
  assert.deepEqual(selectedDelegationTargets([{ content, source: { kind: 'tool' } }]), [])
})
