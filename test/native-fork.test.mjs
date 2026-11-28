import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver, nativeThreadState } from '../native-session-driver.mjs'

function makeFixture({ preset = 'dsh-host-antigravity', harnessId = 'antigravity', parentThreadId = 'thread-parent-1', lastHostTurnId = 'turn-parent-1', parentModelId = 'gemini-4-neon', childModelId, parentConfig, requestHandler, initialTitle = 'Side: 帮我查下这个问题', isSidechat = true } = {}) {
  const events = []
  const calls = []
  const listeners = new Set()
  const session = {
    id: 'session-child-1',
    header: {
      cwd: 'D:/Desktop',
      parentSession: 'session-parent-1',
      isSeeded: true,
      origin: 'subagent',
    },
    snapshotEvents: () => events,
    append(type, data, extra = {}) {
      const event = {
        type,
        data,
        seq: events.length,
        ...(type.startsWith('plugin:') ? { ignorable: true } : {}),
        ...extra,
      }
      events.push(event)
      return event
    },
  }
  if (parentThreadId) {
    session.append('plugin:dsh-host/thread', {
      version: 1,
      sessionId: 'session-parent-1',
      phase: 'ready',
      harnessId,
      threadId: parentThreadId,
      ...(lastHostTurnId ? { lastHostTurnId } : {}),
      appliedConfiguration: parentConfig ?? (harnessId === 'codex'
        ? { modelId: 'gpt-6.2-sol', thinkingOptionId: 'high', permissionModeId: 'workspace-write' }
        : { modelId: parentModelId, thinkingOptionId: 'high', permissionModeId: harnessId === 'claude-code' ? 'bypassPermissions' : 'dangerously-skip-permissions' }),
    })
  }
  if (childModelId) {
    session.append('plugin:dsh-host/configuration', {
      harnessId,
      modelId: childModelId,
      thinkingOptionId: 'medium',
      permissionModeId: harnessId === 'codex' ? 'workspace-write' : harnessId === 'claude-code' ? 'bypassPermissions' : 'dangerously-skip-permissions',
    })
  }
  if (isSidechat) {
    session.append('subagent/descriptor', { mode: 'continuable', provider: 'sidechat', label: initialTitle })
  }

  let currentTitle = { title: initialTitle, source: { kind: 'user' } }
  const peer = {
    closed: new Promise(() => {}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    close() {},
    async request(method, params) {
      calls.push({ method, params })
      if (requestHandler) {
        const res = await requestHandler(method, params, listeners)
        if (res !== undefined) return res
      }
      if (method === 'model/list') {
        return { data: [{ model: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] }
      }
      if (method === 'codexhost/harness/inspect') {
        if (params.harnessId === 'claude-code') {
          return {
            status: 'ready',
            catalog: {
              models: [
                { ref: { id: 'claude-model-v1.b3B1cw' }, label: 'Opus 5.5', resolvedModelLabel: 'claude-opus-5-5', supportedThinkingOptionIds: ['medium', 'high'] },
                { ref: { id: 'claude-model-v1.c29ubmV0' }, label: 'Sonnet 5.5', resolvedModelLabel: 'claude-sonnet-5-5', supportedThinkingOptionIds: ['medium', 'high'] },
              ],
              thinkingOptions: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
              defaultThinkingOptionId: 'high',
            },
            permissionModes: { modes: [{ id: 'bypassPermissions', label: 'Bypass' }], defaultModeId: 'bypassPermissions' },
          }
        }
        return {
          status: 'ready',
          catalog: {
            models: [
              { ref: { id: 'gemini-4-neon' }, label: 'Gemini 4 Neon', resolvedModelLabel: 'gemini-4-neon', supportedThinkingOptionIds: ['medium', 'high'] },
              { ref: { id: 'gemini-4-flash' }, label: 'Gemini 4 Flash', resolvedModelLabel: 'gemini-4-flash', supportedThinkingOptionIds: ['medium', 'high'] },
            ],
            thinkingOptions: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }],
            defaultThinkingOptionId: 'high',
          },
          permissionModes: { modes: [{ id: 'dangerously-skip-permissions', label: 'Skip' }], defaultModeId: 'dangerously-skip-permissions' },
        }
      }
      if (method === 'thread/fork') {
        return { thread: { id: 'thread-forked-1' } }
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thread-fresh-1' } }
      }
      if (method === 'thread/resume') {
        return { thread: { id: params.threadId } }
      }
      if (method === 'thread/read') {
        return { thread: { id: params.threadId, status: { type: 'idle' }, name: 'Remote Renamed Title' } }
      }
      if (method.startsWith('codexhost/thread/') && method.endsWith('/select')) {
        return {}
      }
      if (method === 'codexhost/thread/usage/inspect') {
        return { usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }
      }
      if (method === 'turn/start') {
        const turnId = `host-turn-${calls.filter(c => c.method === 'turn/start').length}`
        setImmediate(() => {
          for (const fn of listeners) {
            fn({ method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, itemId: 'm1', delta: 'ok' } })
            fn({ method: 'item/completed', params: { threadId: params.threadId, turnId, item: { id: 'm1', type: 'agentMessage', text: 'ok' } } })
            fn({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } })
          }
        })
        return { turn: { id: turnId } }
      }
      if (method === 'thread/name/set') return {}
      throw new Error(`unexpected method: ${method}`)
    },
  }

  const helpers = {
    appendPluginRecord: (s, name, data) => s.append(name, data),
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { push(x) { return x } snapshot() { return [] } },
    BlockAssembler: class { push() {} blocks() { return [{ type: 'text', text: 'ok' }] } },
    createUserMessage: msg => ({ id: 'msg-1', ...msg }),
    createAssistantMessage: msg => ({ id: 'asst-1', ...msg }),
  }
  const ctx = {
    agentPresets: { presetForSession: () => preset },
    sessionPersistence: { async flush() {} },
    get(key) {
      if (key === 'sessionTitle') return { get: () => currentTitle }
      return undefined
    },
    logger: { warn() {} },
  }
  const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, cancelTimeoutMs: 50, turnTimeoutMs: 5000, titlePolicy: { enabled: true } })
  const agent = { id: session.id, session, async runMaintenance(fn) { return fn() } }
  return { driver, agent, session, calls, events }
}

const userMsg = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const boundaryMsg = { content: [{ type: 'text', text: 'Side conversation boundary.\n...' }], source: { kind: 'plugin:dsh-better-sidebar' } }

test('Antigravity sidechat performs native thread/fork with lastTurnId, applies child model override, and resumes on turn 2', async () => {
  const f = makeFixture({
    preset: 'dsh-host-antigravity',
    harnessId: 'antigravity',
    parentModelId: 'gemini-4-neon',
    childModelId: 'gemini-4-flash',
  })
  await f.driver.run({ agent: f.agent, messages: [boundaryMsg, userMsg('解释一下刚才的修改')], turn: 6, step: 1, signal: new AbortController().signal })

  const forkCall = f.calls.find(c => c.method === 'thread/fork')
  assert.ok(forkCall, 'expected thread/fork RPC')
  assert.deepEqual(forkCall.params, {
    threadId: 'thread-parent-1',
    cwd: 'D:/Desktop',
    lastTurnId: 'turn-parent-1',
    excludeTurns: true,
  })
  assert.equal('model' in forkCall.params, false, 'external fork must not pass model override')
  assert.ok(f.calls.some(c => c.method === 'codexhost/thread/model/select' && c.params.threadId === 'thread-forked-1' && c.params.model.id === 'gemini-4-flash'))
  const state = nativeThreadState(f.session)
  assert.equal(state.sessionId, 'session-child-1')
  assert.equal(state.threadId, 'thread-forked-1')
  assert.equal(state.forkedFromThreadId, 'thread-parent-1')
  assert.equal(state.forkedFromTurnId, 'turn-parent-1')
  assert.equal(state.phase, 'ready')

  // Second turn must resume the forked thread, never re-fork
  await f.driver.run({ agent: f.agent, messages: [userMsg('继续追问')], turn: 7, step: 1, signal: new AbortController().signal })
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1)
  assert.ok(f.calls.some(c => c.method === 'thread/resume' && c.params.threadId === 'thread-forked-1'))
  // Sidechat title is protected against native title overwrite
  assert.equal(f.events.some(e => e.type === 'session/title'), false)
})

test('Claude Code sidechat forks cleanly with lastTurnId and retains distinct thread identity', async () => {
  const f = makeFixture({
    preset: 'dsh-host-claude-code',
    harnessId: 'claude-code',
    parentModelId: 'claude-model-v1.b3B1cw',
  })
  await f.driver.run({ agent: f.agent, messages: [boundaryMsg, userMsg('总结架构')], turn: 4, step: 1, signal: new AbortController().signal })
  const forkCall = f.calls.find(c => c.method === 'thread/fork')
  assert.ok(forkCall)
  assert.equal(forkCall.params.threadId, 'thread-parent-1')
  assert.equal(forkCall.params.lastTurnId, 'turn-parent-1')
  assert.equal(nativeThreadState(f.session).threadId, 'thread-forked-1')
  assert.equal(nativeThreadState(f.session).sessionId, 'session-child-1')
})

test('Codex sidechat forks via native thread/fork with model and permissions', async () => {
  const f = makeFixture({
    preset: 'dsh-host-codex',
    harnessId: 'codex',
    parentModelId: 'gpt-6.2-sol',
  })
  await f.driver.run({ agent: f.agent, messages: [boundaryMsg, userMsg('检查测试')], turn: 3, step: 1, signal: new AbortController().signal })
  const forkCall = f.calls.find(c => c.method === 'thread/fork')
  assert.ok(forkCall)
  assert.equal(forkCall.params.threadId, 'thread-parent-1')
  assert.equal(forkCall.params.model, 'gpt-6.2-sol')
  assert.equal(forkCall.params.excludeTurns, true)
  assert.equal(nativeThreadState(f.session).threadId, 'thread-forked-1')
  assert.equal(nativeThreadState(f.session).sessionId, 'session-child-1')
})

test('Falls back to thread/start gracefully when parent has no settled checkpoint (-32080)', async () => {
  const f = makeFixture({
    preset: 'dsh-host-antigravity',
    harnessId: 'antigravity',
    requestHandler(method) {
      if (method === 'thread/fork') {
        const err = new Error('External Fork Checkpoint is unavailable')
        err.code = -32080
        throw err
      }
    },
  })
  await f.driver.run({ agent: f.agent, messages: [boundaryMsg, userMsg('首轮运行中提问')], turn: 2, step: 1, signal: new AbortController().signal })
  assert.equal(f.calls.filter(c => c.method === 'thread/fork').length, 1)
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1)
  const state = nativeThreadState(f.session)
  assert.equal(state.threadId, 'thread-fresh-1')
  assert.equal(state.sessionId, 'session-child-1')
  assert.equal(state.forkedFromThreadId, undefined)
})

test('Seeded sidechat without parent thread mapping starts cleanly without HOST_MAPPING_MISSING', async () => {
  const f = makeFixture({
    preset: 'dsh-host-antigravity',
    harnessId: 'antigravity',
    parentThreadId: null,
  })
  await f.driver.run({ agent: f.agent, messages: [boundaryMsg, userMsg('父会话未发过消息')], turn: 2, step: 1, signal: new AbortController().signal })
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(nativeThreadState(f.session).threadId, 'thread-fresh-1')
})
