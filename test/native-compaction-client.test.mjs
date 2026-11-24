import test from 'node:test'
import assert from 'node:assert/strict'
import { installNativeCompactionClient } from '../native-compaction-client.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'

const COMPACTION_EVENT = 'plugin:codexhost/compaction'
const ITEM_EVENT = 'plugin:codexhost/item'

function definition() {
  const registered = []
  const dispose = installNativeCompactionClient({
    uiConversation: { events: { register(value) { registered.push(value); return () => {} } } },
  })
  assert.equal(registered.length, 1)
  return { def: registered[0], dispose }
}

function build(def, events) {
  const matches = events.map(event => {
    const fn = def.match[event.type]
    const matched = fn ? fn(event) : null
    assert.ok(matched, `expected event ${event.type} to match`)
    return { event, location: { kind: 'session' }, ...matched }
  })
  const id = matches[0].id
  return def.buildViewNode({ kind: def.kind, id, key: `${def.kind}:${id}`, matches, state: undefined, start: undefined, current: new Map() })
}

test('native compaction client registers chat definition with idempotent dispose and rejects invalid payloads', () => {
  let disposed = 0
  let def
  const dispose = installNativeCompactionClient({
    uiConversation: { events: { register(value) { def = value; return () => { disposed++ } } } },
  })
  assert.equal(def.target, 'chat')
  assert.deepEqual(Object.keys(def.match).sort(), [COMPACTION_EVENT, ITEM_EVENT])
  assert.equal(def.match[COMPACTION_EVENT]({ type: COMPACTION_EVENT, data: { version: 2 } }), null)
  assert.equal(def.match[COMPACTION_EVENT]({ type: COMPACTION_EVENT, data: { version: 1, threadId: 't', turnId: 'u', compactionId: 'c', phase: 'unknown' } }), null)
  assert.equal(def.match[ITEM_EVENT]({ type: ITEM_EVENT, data: { threadId: 't', turnId: 'u', item: { id: 'i', type: 'commandExecution' } } }), null)
  dispose()
  dispose()
  assert.equal(disposed, 1)
})

test('auto compaction projects running card while started and native compaction marker once completed', () => {
  const { def } = definition()
  const started = {
    type: COMPACTION_EVENT, seq: 10, time: 1000,
    data: { version: 1, harnessId: 'antigravity', threadId: 't1', turnId: 'turn1', compactionId: 'c1', mode: 'auto', phase: 'started', beforeTokens: 420500, contextWindowTokens: 516000 },
  }
  const running = build(def, [started])
  assert.equal(running.kind, 'manual-compaction')
  assert.equal(running.data.compaction, null)
  assert.equal(running.data.command.outcome, null)

  const completed = {
    type: COMPACTION_EVENT, seq: 11, time: 2000,
    data: { version: 1, harnessId: 'antigravity', threadId: 't1', turnId: 'turn1', compactionId: 'c1', mode: 'auto', phase: 'completed', beforeTokens: 420500, afterTokens: 52300, contextWindowTokens: 516000 },
  }
  const done = build(def, [started, completed])
  assert.equal(done.kind, 'compaction')
  assert.equal(done.anchorSeq, 10)
  assert.equal(done.data.kind, 'compaction')
  assert.match(done.data.summary, /Antigravity 自动压缩/)
  assert.match(done.data.summary, /420\.5K → 52\.3K \/ 516K tokens/)
  assert.match(done.data.summary, /释放约 368\.2K tokens/)
})

test('manual compaction projects inline headline and expandable detail; failures surface error outcome', () => {
  const { def } = definition()
  const done = build(def, [
    { type: COMPACTION_EVENT, seq: 20, time: 1000, data: { version: 1, harnessId: 'claude-code', threadId: 't2', turnId: 'turn2', compactionId: 'manual:turn2', mode: 'manual', phase: 'started', beforeTokens: 160000, contextWindowTokens: 200000 } },
    { type: COMPACTION_EVENT, seq: 21, time: 2500, data: { version: 1, harnessId: 'claude-code', threadId: 't2', turnId: 'turn2', compactionId: 'manual:turn2', mode: 'manual', phase: 'completed', beforeTokens: 160000, afterTokens: 32000, contextWindowTokens: 200000, summary: '保留最近上下文。' } },
  ])
  assert.equal(done.kind, 'manual-compaction')
  assert.equal(done.data.command.outcome.kind, 'success')
  assert.match(done.data.command.outcome.text, /Claude Code 手动压缩（160K → 32K \/ 200K tokens）/)
  assert.match(done.data.compaction.summary, /保留最近上下文。/)

  const failed = build(def, [
    { type: COMPACTION_EVENT, seq: 30, time: 3000, data: { version: 1, harnessId: 'antigravity', threadId: 't3', turnId: 'turn3', compactionId: 'manual:turn3', mode: 'manual', phase: 'failed', error: '压缩超时' } },
  ])
  assert.equal(failed.kind, 'manual-compaction')
  assert.equal(failed.data.compaction, null)
  assert.deepEqual(failed.data.command.outcome, { kind: 'error', text: '压缩超时' })
})

test('legacy plugin:codexhost/item contextCompaction renders and deduplicates with plugin:codexhost/compaction', () => {
  const { def } = definition()
  const legacyItem = {
    type: ITEM_EVENT, seq: 5, time: 500,
    data: { threadId: 't-legacy', turnId: 'turn-legacy', item: { id: 'item-1', type: 'contextCompaction' } },
  }
  const legacyOnly = build(def, [legacyItem])
  assert.equal(legacyOnly.kind, 'compaction')
  assert.equal(legacyOnly.anchorSeq, 5)
  assert.match(legacyOnly.data.summary, /上下文自动压缩/)

  const rich = {
    type: COMPACTION_EVENT, seq: 6, time: 600,
    data: { version: 1, harnessId: 'codex', threadId: 't-legacy', turnId: 'turn-legacy', compactionId: 'item-1', mode: 'auto', phase: 'completed', beforeTokens: 120000, afterTokens: 24000 },
  }
  assert.equal(def.match[ITEM_EVENT](legacyItem).id, def.match[COMPACTION_EVENT](rich).id)
  const merged = build(def, [legacyItem, rich])
  assert.equal(merged.kind, 'compaction')
  assert.match(merged.data.summary, /Codex 自动压缩/)
  assert.match(merged.data.summary, /120K → 24K/)
})

test('NativeSessionDriver records plugin:codexhost/compaction for contextCompaction items and manual /compact turns', async () => {
  for (const scenario of ['auto-item', 'manual-compact', 'silent-drop']) {
    const events = [], listeners = new Set()
    const session = {
      id: `local-${scenario}`,
      header: { cwd: 'D:/test' },
      snapshotEvents: () => events,
      append(type, data) {
        const event = { type, data, seq: events.length, time: 1000 + events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
        events.push(event)
        return event
      },
    }
    session.append('plugin:codexhost/thread', { version: 1, sessionId: session.id, phase: 'ready', harnessId: 'antigravity', threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: 'dangerously-skip-permissions' } })
    session.append('plugin:codexhost/configuration', { harnessId: 'antigravity', modelId: 'test', permissionModeId: 'dangerously-skip-permissions' })
    const emit = value => { for (const listener of listeners) listener(value) }
    let usageCall = 0
    const peer = {
      closed: new Promise(() => {}),
      close() {},
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      async request(method) {
        if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }], permissionModes: [{ id: 'dangerously-skip-permissions', label: 'Full' }] } }
        if (method === 'codexhost/thread/commands/inspect') return { commands: [{ id: 'antigravity.compact', invocation: '/compact', argumentMode: 'text' }] }
        if (method === 'codexhost/thread/usage/inspect') {
          usageCall += 1
          return usageCall === 1
            ? { usage: { contextUsedTokens: 420000, contextWindowTokens: 516000 } }
            : { usage: { contextUsedTokens: 48000, contextWindowTokens: 516000 } }
        }
        if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
        if (method === 'thread/resume') return { thread: { id: 'thread' } }
        if (method === 'codexhost/thread/command/execute') {
          queueMicrotask(() => emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-compact', status: 'completed' } } }))
          return { turnId: 'turn-compact' }
        }
        if (method === 'turn/start') {
          queueMicrotask(() => {
            if (scenario === 'auto-item') {
              emit({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn-1', item: { id: 'cmp-1', type: 'contextCompaction' } } })
              emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-1', item: { id: 'cmp-1', type: 'contextCompaction' } } })
            }
            emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
          })
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(method)
      },
    }
    const ctx = { get: () => undefined, agentPresets: { presetForSession: () => 'codexhost-antigravity' }, sessionPersistence: { async flush() {} } }
    const helpers = {
      appendPluginRecord: (s, type, data) => s.append(type, data),
      agentEvents: () => ({ emit() {} }),
      AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } },
      BlockAssembler: class { push() {} blocks() { return [] } },
    }
    const driver = new NativeSessionDriver(ctx, helpers, { connect: async () => peer, turnTimeoutMs: 2000, cancelTimeoutMs: 20 })
    const agent = { id: session.id, session }
    try {
      await driver.run({
        agent,
        messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: scenario === 'manual-compact' ? '/compact' : 'continue' }] }],
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      })
      await new Promise(resolve => setTimeout(resolve, 25))
      const records = events.filter(event => event.type === COMPACTION_EVENT)
      assert.ok(records.length >= 1, `${scenario} should emit compaction records`)
      const last = records.at(-1).data
      assert.equal(last.phase, 'completed')
      assert.equal(last.mode, scenario === 'manual-compact' ? 'manual' : 'auto')
      assert.equal(last.beforeTokens, 420000)
      assert.equal(last.afterTokens, 48000)
      assert.equal(last.contextWindowTokens, 516000)
      assert.equal(events.some(event => event.type === ITEM_EVENT && event.data.item?.type === 'contextCompaction'), false)
    } finally {
      await driver.dispose()
    }
  }
})
