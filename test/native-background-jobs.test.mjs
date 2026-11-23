import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { NativeBackgroundJobs, HOST_COMMAND_JOB, HOST_AGENT_JOB, commandOutcome, agentOutcome } from '../native-background-jobs.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** Minimal ctx.jobs: records whether a live wait collected each settlement (the tool-jobs notice guard). */
function fakeJobs() {
  const jobs = new Map()
  let number = 0
  return {
    jobs,
    start(spec) {
      const id = `${spec.kind}-${++number}`
      const record = { spec, id, chunks: [], progress: undefined, status: 'running', waiters: 0 }
      record.hooks = spec.run({ id, append: text => record.chunks.push(text), updateProgress: line => { record.progress = line } })
      record.hooks.done.then(outcome => { record.status = outcome.status; record.outcome = outcome; record.awaited = record.waiters > 0 })
      jobs.set(id, record)
      return id
    },
    wait(id, timeoutMs, owner) {
      const record = jobs.get(id)
      assert.equal(owner, record.spec.owner)
      record.waiters++
      return record.hooks.done.then(() => record)
    },
    kill(id, reason) { const record = jobs.get(id); record.hooks.cancel(reason); if (record.status === 'running') record.status = 'stopping' },
  }
}

function fakePeer(handler = () => ({})) {
  const listeners = new Set(), requests = []
  let close
  const peer = {
    requests, closed: new Promise(resolve => { close = resolve }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    send(method, params) { for (const fn of [...listeners]) fn({ method, params }) },
    async request(method, params) { requests.push({ method, params }); return handler(method, params) },
    close() { close() },
    listenerCount: () => listeners.size,
  }
  return peer
}

function setup() {
  const registry = fakeJobs()
  const ctx = { get: name => name === 'jobs' ? registry : undefined, logger: { warn() {} } }
  const background = new NativeBackgroundJobs(ctx)
  const peer = fakePeer()
  background.attach(peer)
  const agent = { id: 'session-1' }
  return { registry, background, peer, agent }
}

test('outcome mapping never reports an unconfirmed success', () => {
  assert.deepEqual(commandOutcome({ exitCode: 0 }, { status: 'succeeded' }), { status: 'completed', detail: 'exit code: 0' })
  assert.equal(commandOutcome({ exitCode: 2 }, { status: 'succeeded' }).status, 'failed')
  assert.equal(commandOutcome({}, { status: 'cancelled', reason: 'Background command stopped' }).status, 'killed')
  assert.equal(commandOutcome({ status: 'weird' }).status, 'failed')
  assert.equal(agentOutcome({ status: 'running' }), undefined)
  assert.deepEqual(agentOutcome({ status: 'completed', message: 'done' }), { status: 'completed', result: 'done' })
  assert.equal(agentOutcome({ status: 'errored' }).status, 'failed')
})

test('a Claude background command streams after its Turn and settles without a duplicate notice', async () => {
  const { registry, background, peer, agent } = setup()
  const { jobId } = background.registerCommand({ peer, agent, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'npm run dev\n# second line', callId: 'codexhost:1:i' })
  const record = registry.jobs.get(jobId)
  assert.equal(record.spec.kind, HOST_COMMAND_JOB)
  assert.equal(record.spec.label, 'npm run dev')
  assert.equal(record.spec.owner, 'session-1')
  assert.deepEqual(record.spec.toolCall, { callId: 'codexhost:1:i', rootCallId: 'codexhost:1:i' })
  peer.send('item/commandExecution/outputDelta', { threadId: 't', itemId: 'i', delta: 'ready\n' })
  peer.send('item/commandExecution/outputDelta', { threadId: 'other', itemId: 'i', delta: 'foreign\n' })
  peer.send('codexhost/item/completed', { threadId: 't', item: { type: 'commandExecution', itemId: 'i', output: 'ready\n', exitCode: 0 }, outcome: { status: 'succeeded' } })
  // The codex-shaped duplicate completion is first-wins.
  peer.send('item/completed', { threadId: 't', item: { type: 'commandExecution', id: 'i', status: 'failed' } })
  await tick()
  assert.deepEqual(record.chunks, ['ready\n'])
  assert.equal(record.status, 'completed')
  assert.equal(record.awaited, true, 'settlement must be collected by a live wait so tool-jobs does not wake the Host agent')
  assert.equal(background.size, 0)
})

test('stopping a Claude command uses the engine stop RPC and waits for the native notification', async () => {
  const { registry, background, peer, agent } = setup()
  const { jobId } = background.registerCommand({ peer, agent, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'sleep 100' })
  registry.kill(jobId, 'user stop')
  registry.kill(jobId, 'again') // idempotent
  await tick()
  assert.deepEqual(peer.requests, [{ method: 'dsh/host/task/stop', params: { threadId: 't', itemId: 'i' } }])
  assert.equal(registry.jobs.get(jobId).status, 'stopping')
  peer.send('item/completed', { threadId: 't', item: { type: 'commandExecution', id: 'i' }, outcome: { status: 'cancelled', reason: 'Background command stopped' } })
  await tick()
  assert.equal(registry.jobs.get(jobId).status, 'killed')
})

test('a failed stop request is reported, never claimed as stopped', async () => {
  const registry = fakeJobs()
  const background = new NativeBackgroundJobs({ get: () => registry })
  const peer = fakePeer(() => { throw new Error('Background task is no longer active') })
  background.attach(peer)
  const { jobId } = background.registerCommand({ peer, agent: { id: 's' }, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'x' })
  registry.kill(jobId)
  await tick(); await tick()
  const record = registry.jobs.get(jobId)
  assert.equal(record.status, 'failed')
  assert.match(record.outcome.detail, /停止请求失败/)
})

test('Codex stops only a sole background terminal and refuses agent stops', async () => {
  const { registry, background, peer, agent } = setup()
  const one = background.registerCommand({ peer, agent, harnessId: 'codex', threadId: 't', itemId: 'a', command: 'a' }).jobId
  const two = background.registerCommand({ peer, agent, harnessId: 'codex', threadId: 't', itemId: 'b', command: 'b' }).jobId
  assert.throws(() => registry.kill(one), /全部后台终端/)
  assert.equal(peer.requests.length, 0)
  peer.send('item/completed', { threadId: 't', item: { type: 'commandExecution', id: 'b', status: 'completed', exitCode: 0 } })
  await tick()
  registry.kill(one)
  await tick()
  assert.deepEqual(peer.requests.at(-1), { method: 'thread/backgroundTerminals/clean', params: { threadId: 't' } })
  background.observeAgents({ peer, agent, harnessId: 'codex', threadId: 't', item: { id: 'c1', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } }, prompt: 'review' } })
  const agentJob = [...registry.jobs.values()].find(record => record.spec.kind === HOST_AGENT_JOB)
  assert.throws(() => registry.kill(agentJob.id), /Codex 子代理/)
  assert.equal(registry.jobs.get(two).status, 'completed')
})

test('a Claude subagent keeps one job while its id moves to the materialized Host Thread', async () => {
  const { registry, background, peer, agent } = setup()
  const item = { type: 'collabAgentToolCall', id: 'item-1', prompt: 'Audit the parser', receiverThreadIds: ['toolu_1'], agentsStates: { toolu_1: { status: 'pendingInit' } } }
  background.observeAgents({ peer, agent, harnessId: 'claude-code', threadId: 't', item })
  assert.equal(registry.jobs.size, 1)
  const [record] = registry.jobs.values()
  assert.equal(record.spec.label, 'Claude 子代理：Audit the parser')
  // Updates arrive as repeated item/started frames with the materialized id.
  const moved = { ...item, receiverThreadIds: ['host-child'], agentsStates: { 'host-child': { status: 'running', message: 'reading files' } } }
  peer.send('item/started', { threadId: 't', item: moved })
  background.observeAgents({ peer, agent, harnessId: 'claude-code', threadId: 't', item: moved })
  assert.equal(registry.jobs.size, 1, 'no second job for the same delegation')
  assert.deepEqual(record.chunks, ['reading files\n'])
  registry.kill(record.id)
  await tick()
  assert.deepEqual(peer.requests.at(-1), { method: 'dsh/host/task/stop', params: { threadId: 't', agentId: 'host-child' } })
  peer.send('item/completed', { threadId: 't', item: { ...moved, agentsStates: { 'host-child': { status: 'interrupted' } } } })
  await tick()
  assert.equal(record.status, 'killed')
})

test('background Claude subagents settle when their Thread goes idle; foreground ones from their result', async () => {
  const { registry, background, peer, agent } = setup()
  background.observeAgents({ peer, agent, harnessId: 'claude-code', threadId: 't', item: { id: 'bg', receiverThreadIds: ['child-bg'], agentsStates: { 'child-bg': { status: 'running' } } } })
  background.observeAgents({ peer, agent, harnessId: 'claude-code', threadId: 't', item: { id: 'fg', receiverThreadIds: ['child-fg'], agentsStates: { 'child-fg': { status: 'running' } } } })
  peer.send('item/completed', { threadId: 't', item: { type: 'collabAgentToolCall', id: 'bg', receiverThreadIds: ['child-bg'], agentsStates: { 'child-bg': { status: 'running' } } } })
  peer.send('item/completed', { threadId: 't', item: { type: 'collabAgentToolCall', id: 'fg', receiverThreadIds: ['child-fg'], agentsStates: { 'child-fg': { status: 'completed', message: 'All parsers audited' } } } })
  await tick()
  const [bg, fg] = registry.jobs.values()
  assert.equal(bg.status, 'running')
  assert.equal(fg.status, 'completed')
  assert.equal(fg.outcome.result, 'All parsers audited')
  peer.send('thread/status/changed', { threadId: 'child-bg', status: { type: 'idle' } })
  await tick()
  assert.equal(bg.status, 'completed')
  assert.equal(bg.awaited, true)
})

test('connection loss and plugin unload release tracking honestly without stopping engine work', async () => {
  const { registry, background, peer, agent } = setup()
  const lost = background.registerCommand({ peer, agent, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'x' }).jobId
  peer.close()
  await tick()
  assert.equal(registry.jobs.get(lost).status, 'failed')
  assert.match(registry.jobs.get(lost).outcome.detail, /连接已断开/)
  const other = fakePeer()
  background.attach(other)
  const kept = background.registerCommand({ peer: other, agent, harnessId: 'claude-code', threadId: 't', itemId: 'j', command: 'y' }).jobId
  background.dispose()
  await tick()
  assert.equal(registry.jobs.get(kept).status, 'failed')
  assert.equal(other.requests.length, 0, 'unloading DSH tracking never stops the engine task')
  assert.ok(background.registerCommand({ peer: other, agent, harnessId: 'claude-code', threadId: 't', itemId: 'k', command: 'z' }).error)
})

test('a missing or refusing registry leaves the command running and explains why', () => {
  const peer = fakePeer()
  const none = new NativeBackgroundJobs({ get: () => undefined })
  assert.deepEqual(none.registerCommand({ peer, agent: { id: 's' }, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'x' }), { error: 'DSH 后台任务服务不可用' })
  const full = new NativeBackgroundJobs({ get: () => ({ start() { throw new Error('background job limit reached') } }), logger: { warn() {} } })
  assert.match(full.registerCommand({ peer, agent: { id: 's' }, harnessId: 'claude-code', threadId: 't', itemId: 'i', command: 'x' }).error, /limit/)
})

// Real driver Turn: the external engine detaches a command; DSH records a
// non-error hand-off and keeps following it after the Turn subscription ends.
for (const harness of ['claude-code', 'codex']) test(`${harness} Turn hands an open command to DSH background jobs`, { timeout: 5000 }, async () => {
  const events = [], listeners = new Set()
  const registry = fakeJobs()
  const session = { id: 'local', header: { cwd: 'D:/fixture' }, snapshotEvents: () => events, append(type, data) {
    const event = { type, data, seq: events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
    events.push(event); return event
  } }
  session.append('plugin:codexhost/configuration', {harnessId: harness, modelId: 'test'})
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data), createAssistantMessage: x => x, createToolResultMessage: x => x,
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { rows = []; push(value) { this.rows.push(value); return value } snapshot() { return this.rows } },
    BlockAssembler: class { push() {} blocks() { return [{ type: 'text', text: 'started it' }] } },
  }
  const ctx = { get: name => name === 'jobs' ? registry : undefined, agentPresets: { presetForSession: () => 'codexhost-' + harness }, sessionPersistence: { async flush() {} } }
  const send = (method, params) => { for (const fn of [...listeners]) fn({ method, params }) }
  const peer = { closed: new Promise(() => {}), close() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, async request(method) {
    if (method === 'model/list') return { data: [{ model: 'test', isDefault: true }] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }] } }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread' } }
    if (method === 'thread/read') return { thread: {} }
    if (method === 'codexhost/thread/usage/inspect') return { usage: {} }
    if (method === 'turn/start') {
      setImmediate(() => {
        const command = { type: 'commandExecution', itemId: 'cmd', id: 'cmd', command: 'npm run dev', processId: harness === 'codex' ? 'proc-1' : null, status: 'inProgress' }
        if (harness === 'claude-code') {
          send('codexhost/item/started', { threadId: 'thread', turnId: 'turn-1', item: command })
          send('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn-1', itemId: 'cmd', delta: 'booting\n' })
          send('codexhost/item/detached', { threadId: 'thread', turnId: 'turn-1', itemId: 'cmd' })
        } else {
          send('item/started', { threadId: 'thread', turnId: 'turn-1', item: command })
          send('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn-1', itemId: 'cmd', delta: 'booting\n' })
        }
        send('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } })
      })
      return { turn: { id: 'turn-1' } }
    }
    throw new Error(method)
  } }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000 })
  await driver.run({ agent: { id: 'local', session }, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'start the dev server' }] }], turn: 1, step: 1, signal: new AbortController().signal })
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.isError, false)
  assert.match(result.data.message.content[0].text, /已转为 DSH 后台任务 host-command-1/)
  assert.deepEqual(result.data.meta.codexHost.item.dshBackground, { jobId: 'host-command-1' })
  const record = registry.jobs.get('host-command-1')
  assert.equal(record.spec.toolCall.callId, 'codexhost:1:cmd')
  // Codex keeps streaming into the same item; its foreground output seeds the job.
  assert.deepEqual(record.chunks, harness === 'codex' ? ['booting\n'] : [])
  assert.equal(listeners.size, 2, 'the Turn listener is gone; only per-connection title/usage and background listeners remain')
  send('item/commandExecution/outputDelta', { threadId: 'thread', turnId: 'turn-1', itemId: 'cmd', delta: 'listening on 3000\n' })
  send('item/completed', { threadId: 'thread', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', status: 'completed', exitCode: 0 } })
  await tick()
  assert.equal(record.chunks.at(-1), 'listening on 3000\n')
  assert.equal(record.status, 'completed')
  assert.equal(record.awaited, true)
  await driver.dispose()
})

test('shipped backend announces detached commands and routes one-task stops', async () => {
  const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')
  const claude = await readFile(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  assert.match(runtime, /method: "codexhost\/item\/detached"/)
  assert.match(runtime, /request\.method === "dsh\/host\/task\/stop"/)
  assert.match(runtime, /"dsh\/host\/task\/stop"\]\.includes\(request\.method\) \? void 0 : threadId2/, 'stop must not queue behind an active Turn')
  assert.match(runtime, /#dshNativeSubagents\.set\(parent\.id \+ "\\0" \+ record6\.hostThreadId, subagent\.nativeSubagentId\)/)
  assert.match(claude, /async dshStopNativeTask\(\{ itemId, taskId \}\)/)
  assert.match(claude, /dshTaskIdForItem\(itemId\)/)
})
