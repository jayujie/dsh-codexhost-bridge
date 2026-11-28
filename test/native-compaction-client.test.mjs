import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { installNativeCompactionClient, splitCompactionTranslationFragments, translateCompactionSummary } from '../native-compaction-client.mjs'
import { cleanAntigravityCompactionSummary, cleanClaudeCompactionSummary, readNativeCompactionSummary } from '../native-compaction-summary.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'

const COMPACTION_EVENT = 'plugin:dsh-host/compaction'
const ITEM_EVENT = 'plugin:dsh-host/item'

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
  // Current names plus the pre-2026-11-27 names, so old Sessions keep rendering.
  assert.deepEqual(Object.keys(def.match).sort(), [COMPACTION_EVENT, ITEM_EVENT, 'plugin:codexhost/compaction', 'plugin:codexhost/item'].sort())
  assert.equal(def.match[COMPACTION_EVENT]({ type: COMPACTION_EVENT, data: { version: 2 } }), null)
  assert.equal(def.match[COMPACTION_EVENT]({ type: COMPACTION_EVENT, data: { version: 1, threadId: 't', turnId: 'u', compactionId: 'c', phase: 'unknown' } }), null)
  assert.equal(def.match[ITEM_EVENT]({ type: ITEM_EVENT, data: { threadId: 't', turnId: 'u', item: { id: 'i', type: 'commandExecution' } } }), null)
  dispose()
  dispose()
  assert.equal(disposed, 1)
})

test('auto compaction projects running card while started and custom collapsible compaction node once completed', () => {
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
    data: { version: 1, harnessId: 'antigravity', threadId: 't1', turnId: 'turn1', compactionId: 'c1', mode: 'auto', phase: 'completed', beforeTokens: 420500, afterTokens: 52300, contextWindowTokens: 516000, summary: '1. Task Overview\n\nAll done.' },
  }
  const done = build(def, [started, completed])
  assert.equal(done.kind, 'dsh-host-compaction')
  assert.equal(done.anchorSeq, 10)
  assert.equal(done.data.kind, 'dsh-host-compaction')
  assert.equal(done.data.headerLine, 'Antigravity 自动压缩 · 420.5K → 52.3K / 516K tokens，释放约 368.2K tokens')
  assert.equal(done.data.summaryBody, '1. Task Overview\n\nAll done.')
})

test('manual compaction projects custom collapsible node with headerLine and summaryBody; failures surface error outcome', () => {
  const { def } = definition()
  const done = build(def, [
    { type: COMPACTION_EVENT, seq: 20, time: 1000, data: { version: 1, harnessId: 'claude-code', threadId: 't2', turnId: 'turn2', compactionId: 'manual:turn2', mode: 'manual', phase: 'started', beforeTokens: 160000, contextWindowTokens: 200000 } },
    { type: COMPACTION_EVENT, seq: 21, time: 2500, data: { version: 1, harnessId: 'claude-code', threadId: 't2', turnId: 'turn2', compactionId: 'manual:turn2', mode: 'manual', phase: 'completed', beforeTokens: 160000, afterTokens: 32000, contextWindowTokens: 200000, summary: '保留最近上下文。' } },
  ])
  assert.equal(done.kind, 'dsh-host-compaction')
  assert.equal(done.data.mode, 'manual')
  assert.equal(done.data.headerLine, 'Claude Code 手动压缩 · 160K → 32K / 200K tokens，释放约 128K tokens')
  assert.equal(done.data.summaryBody, '保留最近上下文。')

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
  assert.equal(legacyOnly.kind, 'dsh-host-compaction')
  assert.equal(legacyOnly.anchorSeq, 5)
  assert.match(legacyOnly.data.headerLine, /上下文自动压缩/)

  const rich = {
    type: COMPACTION_EVENT, seq: 6, time: 600,
    data: { version: 1, harnessId: 'codex', threadId: 't-legacy', turnId: 'turn-legacy', compactionId: 'item-1', mode: 'auto', phase: 'completed', beforeTokens: 120000, afterTokens: 24000 },
  }
  assert.equal(def.match[ITEM_EVENT](legacyItem).id, def.match[COMPACTION_EVENT](rich).id)
  const merged = build(def, [legacyItem, rich])
  assert.equal(merged.kind, 'dsh-host-compaction')
  assert.equal(merged.data.headerLine, 'Codex 自动压缩 · 120K → 24K tokens，释放约 96K tokens')
})

test('compaction summary Bing translation splits chunks, translates progressively, and caches results', async () => {
  const source = 'First paragraph about task.\n\nSecond paragraph with details.'
  const parts = splitCompactionTranslationFragments(source, 80)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].text, 'First paragraph about task.')
  assert.equal(parts[0].suffix, '\n\n')
  assert.equal(parts[1].text, 'Second paragraph with details.')

  const requests = []
  const progress = []
  const cotRemote = {
    async limits() {
      return { ok: true, value: { maxTextChars: 80, preferences: { provider: 'bing', targetLanguage: 'zh-Hans' } } }
    },
    async translate(req) {
      requests.push(req)
      return { ok: true, value: `[ZH:${req.text}]` }
    },
  }
  const first = await translateCompactionSummary({
    text: source, sessionId: 'sess-1', cotRemote, targetLocale: 'zh-Hans',
    signal: new AbortController().signal,
    onProgress: update => progress.push(update),
  })
  assert.equal(first.available, true)
  assert.equal(first.provider, 'bing')
  assert.equal(first.text, '[ZH:First paragraph about task.]\n\n[ZH:Second paragraph with details.]')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].provider, 'bing')
  assert.equal(requests[0].targetLanguage, 'zh-Hans')
  assert.equal(requests[0].sessionId, 'sess-1')
  assert.ok(progress.length >= 2)

  // Second run reuses in-memory cache without re-calling Bing.
  const second = await translateCompactionSummary({
    text: source, sessionId: 'sess-1', cotRemote, targetLocale: 'zh-Hans',
    signal: new AbortController().signal,
  })
  assert.equal(second.text, first.text)
  assert.equal(requests.length, 2)

  // Missing cotRemote degrades gracefully.
  const noRemote = await translateCompactionSummary({ text: source, sessionId: 'sess-1', cotRemote: null })
  assert.equal(noRemote.available, false)
  assert.equal(noRemote.text, source)
})

test('NativeSessionDriver overrides stale pre-compaction contextUsedTokens with post-compaction transcript reading', async () => {
  const events = [], listeners = new Set()
  const session = {
    id: 'local-stale-after-compact',
    header: { cwd: 'D:/test' },
    snapshotEvents: () => events,
    append(type, data) {
      const event = { type, data, seq: events.length, time: 1000 + events.length, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
      events.push(event)
      return event
    },
  }
  session.append('plugin:dsh-host/thread', { version: 1, sessionId: session.id, phase: 'ready', harnessId: 'antigravity', threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: 'dangerously-skip-permissions' } })
  session.append('plugin:dsh-host/configuration', { harnessId: 'antigravity', modelId: 'test', permissionModeId: 'dangerously-skip-permissions' })
  const emit = value => { for (const listener of listeners) listener(value) }
  const peer = {
    closed: new Promise(() => {}),
    close() {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async request(method) {
      if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: 'test' }, label: 'test' }], permissionModes: [{ id: 'dangerously-skip-permissions', label: 'Full' }] } }
      // Host still reports stale pre-compaction 481018 even after compaction completes.
      if (method === 'codexhost/thread/usage/inspect') return { usage: { contextUsedTokens: 481018, contextWindowTokens: 516000 } }
      if (method === 'thread/read') return { thread: { id: 'thread', status: { type: 'idle' } } }
      if (method === 'thread/resume') return { thread: { id: 'thread' } }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          emit({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn-1', item: { id: 'cmp-stale', type: 'contextCompaction' } } })
          emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn-1', item: { id: 'cmp-stale', type: 'contextCompaction' } } })
          emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
        })
        return { turn: { id: 'turn-1' } }
      }
      throw new Error(method)
    },
  }
  const ctx = { get: () => undefined, agentPresets: { presetForSession: () => 'dsh-host-antigravity' }, sessionPersistence: { async flush() {} } }
  const helpers = {
    appendPluginRecord: (s, type, data) => s.append(type, data),
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } },
    BlockAssembler: class { push() {} blocks() { return [] } },
  }
  const latestObservation = () => [...events].reverse().find(e => e.type === 'plugin:dsh-host/observation-v2')?.data
  const driver = new NativeSessionDriver(ctx, helpers, {
    connect: async () => peer,
    observationOf: latestObservation,
    turnTimeoutMs: 2000,
    cancelTimeoutMs: 20,
    readCompactionSummary: async () => ({ beforeTokens: 481018, afterTokens: 20096, latestContextUsed: 20096, summary: 'Compact summary.' }),
  })
  try {
    await driver.run({
      agent: { id: session.id, session },
      messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }],
      turn: 2, step: 1, signal: new AbortController().signal,
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    const finalObs = latestObservation()
    assert.equal(finalObs?.usage?.contextUsedTokens, 20096)
    assert.equal(finalObs?.usage?.contextWindowTokens, 516000)
  } finally {
    await driver.dispose()
  }
})

test('NativeSessionDriver records plugin:dsh-host/compaction for contextCompaction items and manual /compact turns', async () => {
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
    session.append('plugin:dsh-host/thread', { version: 1, sessionId: session.id, phase: 'ready', harnessId: 'antigravity', threadId: 'thread', appliedConfiguration: { modelId: 'test', permissionModeId: 'dangerously-skip-permissions' } })
    session.append('plugin:dsh-host/configuration', { harnessId: 'antigravity', modelId: 'test', permissionModeId: 'dangerously-skip-permissions' })
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
    const ctx = { get: () => undefined, agentPresets: { presetForSession: () => 'dsh-host-antigravity' }, sessionPersistence: { async flush() {} } }
    const helpers = {
      appendPluginRecord: (s, type, data) => s.append(type, data),
      agentEvents: () => ({ emit() {} }),
      AssistantStreamAccumulator: class { push(value) { return value } snapshot() { return [] } },
      BlockAssembler: class { push() {} blocks() { return [] } },
    }
    const driver = new NativeSessionDriver(ctx, helpers, {
      connect: async () => peer,
      turnTimeoutMs: 2000,
      cancelTimeoutMs: 20,
      readCompactionSummary: async () => ({ summary: '## 1. Task Overview\n- Completed work summary.' }),
    })
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
      assert.equal(last.summary, '## 1. Task Overview\n- Completed work summary.')
      assert.equal(events.some(event => event.type === ITEM_EVENT && event.data.item?.type === 'contextCompaction'), false)
    } finally {
      await driver.dispose()
    }
  }
})

test('native compaction summary readers extract clean Markdown from AGY, Claude Code, and Codex transcripts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-compact-summary-'))
  try {
    const legacyDir = path.join(root, 'legacy')
    await mkdir(path.join(legacyDir, 'mapping-store', 'threads'), { recursive: true })
    await writeFile(path.join(legacyDir, 'mapping-store', 'threads', 'agy-thread.json'), JSON.stringify({
      nativeSessionRef: { harnessId: 'antigravity', nativeSessionId: 'agy-native-1' },
    }))
    await writeFile(path.join(legacyDir, 'mapping-store', 'threads', 'claude-thread.json'), JSON.stringify({
      nativeSessionRef: { harnessId: 'claude-code', nativeSessionId: 'claude-native-1' },
    }))

    // AGY CHECKPOINT transcript
    const agyLogs = path.join(root, 'agy', 'brain', 'agy-native-1', '.system_generated', 'logs')
    await mkdir(agyLogs, { recursive: true })
    const rawAgy = '# Resuming from a compaction\n<summary>\nRESUMING MY OWN TASK IN PROGRESS. Boilerplate.\n\n## 1. Task Overview\n- Fixed bug X.\n\n## 2. Next Steps\n- Ship it.\n\nRESUME RULES (I am resuming my own task):\n1. Rule one.\n</summary>'
    await writeFile(path.join(agyLogs, 'transcript_full.jsonl'), [
      JSON.stringify({ step_index: 50, type: 'CHECKPOINT', input_tokens: 300000, cache_read_tokens: 120000, output_tokens: 3000, content: rawAgy }),
      JSON.stringify({ step_index: 52, type: 'PLANNER_RESPONSE', input_tokens: 22040, cache_read_tokens: 0, output_tokens: 800 }),
      JSON.stringify({ step_index: 55, type: 'PLANNER_RESPONSE', input_tokens: 21000, cache_read_tokens: 45000, output_tokens: 500 }),
    ].join('\n') + '\n')

    const agyResult = await readNativeCompactionSummary({
      harnessId: 'antigravity', threadId: 'agy-thread',
      config: { legacyHostDataDir: legacyDir, backendDataDir: path.join(root, 'host') },
      agyRoot: path.join(root, 'agy'),
    })
    assert.equal(agyResult.beforeTokens, 420000)
    assert.equal(agyResult.afterTokens, 22040)
    assert.equal(agyResult.latestContextUsed, 66000)
    assert.match(agyResult.summary, /## 1\. Task Overview/)
    assert.match(agyResult.summary, /Fixed bug X/)
    assert.doesNotMatch(agyResult.summary, /RESUMING MY OWN TASK|RESUME RULES/)

    // Claude Code compact_boundary + isCompactSummary transcript
    const claudeProj = path.join(root, 'claude', 'proj-a')
    await mkdir(claudeProj, { recursive: true })
    const rawClaude = 'This session is being continued from a previous conversation that ran out of context.\n\n<system-reminder>\n<tools-used-before-summary>Read</tools-used-before-summary>\n</system-reminder>\nSummary:\n1. Primary Request:\n   - Refactor API.\n\nPlease continue the conversation from where we left off without asking.'
    await writeFile(path.join(claudeProj, 'claude-native-1.jsonl'), [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 480000, postTokens: 21000 } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: rawClaude } }),
    ].join('\n') + '\n')

    const claudeResult = await readNativeCompactionSummary({
      harnessId: 'claude-code', threadId: 'claude-thread',
      config: { legacyHostDataDir: legacyDir, backendDataDir: path.join(root, 'host') },
      claudeRoot: path.join(root, 'claude'),
    })
    assert.equal(claudeResult.beforeTokens, 480000)
    assert.equal(claudeResult.afterTokens, 21000)
    assert.match(claudeResult.summary, /1\. Primary Request/)
    assert.doesNotMatch(claudeResult.summary, /system-reminder|This session is being continued|Please continue/)

    // Codex plaintext compacted record
    const codexDir = path.join(root, 'codex', '2026', '11')
    await mkdir(codexDir, { recursive: true })
    await writeFile(path.join(codexDir, 'rollout-2026-11-25-codex-thread-1.jsonl'),
      JSON.stringify({ type: 'compacted', payload: { message: 'Codex checkpoint summary.' } }) + '\n')
    const codexResult = await readNativeCompactionSummary({
      harnessId: 'codex', threadId: 'codex-thread-1', codexRoot: path.join(root, 'codex'),
    })
    assert.equal(codexResult.summary, 'Codex checkpoint summary.')

    assert.equal(cleanAntigravityCompactionSummary(''), undefined)
    assert.equal(cleanClaudeCompactionSummary(''), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
