import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS,
  dshAntigravityAutoCompactThreshold,
  dshShouldAutoCompactAntigravity,
  dshIsTransientAntigravityError,
  dshNormalizeAntigravityModelForPrice,
  dshAntigravityTranscriptUsageRequests,
  dshCompactAntigravityTurns,
  dshAntigravityCatalogCachePath,
  dshReadAntigravityCatalogCache,
  dshWriteAntigravityCatalogCache,
  dshRequestAntigravityTrajectorySteps,
  dshListAntigravityImportCandidates,
  dshResolveAntigravityImportCandidate,
  dshReadAntigravityTranscriptTurns,
} from '../antigravity-perf.mjs'
import { NativeSessionImporter } from '../native-session-import.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { NativeTurnProjector } from '../native-turn-projector.mjs'
import { locallyCovered } from '../native-replies.mjs'
import { completeExternalTitle, readNativeAntigravityTitle } from '../native-title.mjs'
import { requestCost, costRequest, sessionCostView } from '../session-api-cost.mjs'
import { ModelPriceLookup } from '../local-model-prices.mjs'

function makeTurn(index, { outputBytes = 0, diffBytes = 0, argBytes = 0, msgBytes = 40, withSubagent = false } = {}) {
  const items = [
    {
      item: {
        type: 'commandExecution',
        itemId: `cmd-${index}`,
        command: 'echo hi',
        output: 'x'.repeat(outputBytes),
        exitCode: 0,
      },
      outcome: { status: 'succeeded' },
    },
    {
      item: {
        type: 'toolExecution',
        itemId: `tool-${index}`,
        toolName: 'read_file',
        arguments: argBytes > 0 ? { path: 'a.txt', blob: 'a'.repeat(argBytes) } : { path: 'a.txt' },
        output: { content: [{ type: 'text', text: 'y'.repeat(outputBytes) }] },
      },
      outcome: { status: 'succeeded' },
    },
    {
      item: {
        type: 'fileChange',
        itemId: `fc-${index}`,
        changes: [{ path: 'src/a.js', kind: 'update', unifiedDiff: '+'.repeat(diffBytes) }],
      },
      outcome: { status: 'succeeded' },
    },
    {
      item: { type: 'agentMessage', itemId: `msg-${index}`, text: 'm'.repeat(msgBytes) },
      outcome: { status: 'succeeded' },
    },
  ]
  if (withSubagent) {
    items.push({
      item: {
        type: 'subagentDelegation',
        itemId: `sub-${index}`,
        operation: 'spawn',
        prompt: 'p'.repeat(outputBytes),
        subagents: [{
          subagentId: '11111111-1111-4111-8111-111111111111',
          nativeSubagentId: '11111111-1111-4111-8111-111111111111',
          description: 'Researcher',
          background: true,
          status: 'completed',
          resultSummary: 'done',
        }],
      },
      outcome: { status: 'succeeded' },
    })
  }
  return {
    nativeTurnRef: { harnessId: 'antigravity', nativeSessionId: 'conv-1', nativeTurnKey: `turn:${index}`, formatVersion: 1 },
    checkpoint: { harnessId: 'antigravity', nativeSessionId: 'conv-1', checkpointId: `turn:${index}`, formatVersion: 1 },
    input: [{ type: 'text', text: `prompt ${index}` }],
    items,
    outcome: { status: 'succeeded' },
  }
}

test('dshCompactAntigravityTurns keeps small history untouched', () => {
  const turns = [makeTurn(1, { outputBytes: 100 }), makeTurn(2, { outputBytes: 100 })]
  const out = dshCompactAntigravityTurns(turns, 1024 * 1024)
  assert.equal(out, turns)
})

test('dshCompactAntigravityTurns preserves turns.length, checkpoints, newest turn, and subagent ids while trimming older heavy payloads', () => {
  const turns = [
    makeTurn(1, { outputBytes: 4000, diffBytes: 4000, argBytes: 2000, withSubagent: true }),
    makeTurn(2, { outputBytes: 4000, diffBytes: 4000, argBytes: 2000 }),
    makeTurn(3, { outputBytes: 4000, diffBytes: 4000, argBytes: 2000 }),
  ]
  const out = dshCompactAntigravityTurns(turns, 18_000)
  assert.equal(out.length, 3, 'turns.length must never change so fork/rollback SQLite indices stay aligned')
  assert.deepEqual(out.map(t => t.checkpoint.checkpointId), ['turn:1', 'turn:2', 'turn:3'])

  // Oldest turn has heavy payloads trimmed, but subagent identity and agentMessage preserved.
  const oldCmd = out[0].items.find(e => e.item.type === 'commandExecution').item
  assert.equal(oldCmd.output, '[older command output trimmed]')
  assert.equal(oldCmd.outputTruncated, true)
  const oldTool = out[0].items.find(e => e.item.type === 'toolExecution').item
  assert.deepEqual(oldTool.arguments, { _trimmed: true })
  assert.equal(oldTool.output.truncated, true)
  const oldDiff = out[0].items.find(e => e.item.type === 'fileChange').item.changes[0]
  assert.equal(oldDiff.unifiedDiff, '[older diff trimmed]')
  const oldSub = out[0].items.find(e => e.item.type === 'subagentDelegation').item
  assert.equal(oldSub.subagents[0].nativeSubagentId, '11111111-1111-4111-8111-111111111111')
  assert.equal(oldSub.prompt, '[older subagent prompt trimmed]')

  // Newest turn is kept completely intact even if large.
  const newestCmd = out[2].items.find(e => e.item.type === 'commandExecution').item
  assert.equal(newestCmd.output.length, 4000)
})

test('dshCompactAntigravityTurns falls back to trimming oversized older messages when still over budget', () => {
  const turns = [
    makeTurn(1, { msgBytes: 10_000 }),
    makeTurn(2, { msgBytes: 10_000 }),
  ]
  const out = dshCompactAntigravityTurns(turns, 12_000)
  assert.equal(out.length, 2)
  const oldMsg = out[0].items.find(e => e.item.type === 'agentMessage').item.text
  assert.ok(oldMsg.length < 2200 && oldMsg.endsWith('[older message trimmed]'))
  const newMsg = out[1].items.find(e => e.item.type === 'agentMessage').item.text
  assert.equal(newMsg.length, 10_000)
})

test('catalog disk cache round-trips, validates executable stat, and expires cleanly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-cache-'))
  try {
    const fakeBin = path.join(dir, 'agy.cmd')
    await writeFile(fakeBin, '@echo off\n', 'utf8')
    const env = { CODEXHOST_DATA_DIR: dir }
    const schema = {
      safeParse(v) {
        return v && Array.isArray(v.models) ? { success: true, data: v } : { success: false }
      },
    }
    const catalog = { models: [{ ref: { id: 'gemini-4-neon' }, label: 'Gemini 4 Neon' }], thinkingOptions: [] }
    assert.equal(dshReadAntigravityCatalogCache(env, fakeBin, schema), null)

    const wrote = await dshWriteAntigravityCatalogCache(env, fakeBin, catalog, { now: 1000 })
    assert.equal(wrote, true)
    assert.equal(dshAntigravityCatalogCachePath(env), path.join(dir, 'antigravity-catalog-cache.json'))

    const hit = dshReadAntigravityCatalogCache(env, fakeBin, schema, { now: 5000 })
    assert.deepEqual(hit?.catalog, catalog)

    // Expired TTL invalidates cache
    assert.equal(dshReadAntigravityCatalogCache(env, fakeBin, schema, { now: 1000 + 8 * 24 * 60 * 60 * 1000 }), null)

    // Modified binary invalidates cache
    await writeFile(fakeBin, '@echo off\nrem updated\n', 'utf8')
    assert.equal(dshReadAntigravityCatalogCache(env, fakeBin, schema, { now: 5000 }), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dshRequestAntigravityTrajectorySteps handles success, oversize degradation, and timeout', async () => {
  function mockHttps(mode) {
    return {
      request(_opts, onResponse) {
        const req = new EventEmitter()
        req.destroyed = false
        req.destroy = () => { req.destroyed = true }
        req.end = () => {
          queueMicrotask(() => {
            if (mode === 'timeout') {
              req.emit('timeout')
              req.emit('error', new Error('socket hang up'))
              return
            }
            const res = new EventEmitter()
            res.statusCode = mode === 'http500' ? 500 : 200
            onResponse(res)
            if (mode === 'ok') {
              res.emit('data', Buffer.from(JSON.stringify({ steps: [{ id: 1 }] })))
              res.emit('end')
            } else if (mode === 'oversize') {
              res.emit('data', Buffer.alloc(1024, 65))
              res.emit('data', Buffer.alloc(1024, 66))
              res.emit('end')
            } else if (mode === 'http500') {
              res.emit('end')
            }
          })
        }
        return req
      },
    }
  }

  const ok = await dshRequestAntigravityTrajectorySteps(1234, 'c1', 500, v => v.steps, { httpsModule: mockHttps('ok'), maxBytes: 4096 })
  assert.deepEqual(ok, { ok: true, actions: [{ id: 1 }] })

  const oversize = await dshRequestAntigravityTrajectorySteps(1234, 'c1', 500, v => v.steps, { httpsModule: mockHttps('oversize'), maxBytes: 1500 })
  assert.deepEqual(oversize, { ok: false, reason: 'oversize', actions: [] })

  const timedOut = await dshRequestAntigravityTrajectorySteps(1234, 'c1', 500, v => v.steps, { httpsModule: mockHttps('timeout'), maxBytes: 4096 })
  assert.deepEqual(timedOut, { ok: false, reason: 'timeout', actions: [] })

  const httpErr = await dshRequestAntigravityTrajectorySteps(1234, 'c1', 500, v => v.steps, { httpsModule: mockHttps('http500'), maxBytes: 4096 })
  assert.deepEqual(httpErr, { ok: false, reason: 'http', actions: [] })
})

test('rebuilt Antigravity adapter uses global disk cache across cwds and respects missing binary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-adapter-'))
  try {
    const cwdA = path.join(dir, 'ws-a')
    const cwdB = path.join(dir, 'ws-b')
    const countFile = path.join(dir, 'invocations.txt')
    const fakeBin = path.join(dir, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy')
    const fakeScript = path.join(dir, 'fake-agy.mjs')
    await writeFile(fakeScript, `
      import { appendFileSync } from 'node:fs';
      if (process.argv[2] === 'models') {
        appendFileSync(${JSON.stringify(countFile)}, 'models\\n');
        process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-4-neon-medium\\tGemini 4 Neon (Medium)\\n');
      }
    `, 'utf8')
    if (process.platform === 'win32') {
      await writeFile(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8')
    } else {
      await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 })
    }
    const { mkdir } = await import('node:fs/promises')
    await mkdir(cwdA, { recursive: true })
    await mkdir(cwdB, { recursive: true })

    const { createHarnessAdapter } = await import('../backend/plugins/antigravity/plugin.mjs')
    const env = { ...process.env, CODEXHOST_DATA_DIR: dir, CODEXHOST_ANTIGRAVITY_COMMAND: fakeBin }

    // First adapter instance: cold start runs `agy models` once and shares across cwds.
    const adapter1 = createHarnessAdapter({ environment: env, platform: process.platform })
    const r1 = await adapter1.inspect({ cwd: cwdA })
    assert.equal(r1.status, 'ready')
    assert.equal(r1.catalog.models[0].ref.id, 'gemini-4-neon')
    assert.equal(r1.catalog.models[0].label, 'Gemini 4 Neon')
    assert.equal(r1.catalog.models[0].resolvedModelLabel, 'gemini-4-neon', 'resolvedModelLabel must be the canonical model ID for pricing')
    const r2 = await adapter1.inspect({ cwd: cwdB })
    assert.equal(r2.status, 'ready')
    assert.equal(r2.catalog.models[0].ref.id, 'gemini-4-neon')
    const callsAfterFirst = (await readFile(countFile, 'utf8')).trim().split(/\r?\n/).length
    assert.equal(callsAfterFirst, 1, 'different cwds must share the global in-memory catalog cache')
    await adapter1.close()

    // Wait briefly for disk cache write to complete
    await stat(dshAntigravityCatalogCachePath(env))

    // Second adapter instance (simulating DSH restart): returns immediately from disk cache!
    const adapter2 = createHarnessAdapter({ environment: env, platform: process.platform })
    const t0 = Date.now()
    const r3 = await adapter2.inspect({ cwd: cwdB })
    const elapsed = Date.now() - t0
    assert.equal(r3.status, 'ready')
    assert.equal(r3.catalog.models[0].ref.id, 'gemini-4-neon')
    assert.ok(elapsed < 500, `disk cache hit should be instant, took ${elapsed}ms`)
    await adapter2.close()

    // Missing executable must NOT return stale disk cache as ready.
    const missingEnv = { ...process.env, CODEXHOST_DATA_DIR: dir, CODEXHOST_ANTIGRAVITY_COMMAND: path.join(dir, 'does-not-exist.exe') }
    const adapter3 = createHarnessAdapter({ environment: missingEnv, platform: process.platform })
    const r4 = await adapter3.inspect({ cwd: cwdA })
    assert.equal(r4.status, 'notInstalled')
    await adapter3.close()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('NativeSessionDriver shares Antigravity catalog cache across workspaces', async () => {
  let inspectCalls = 0
  const peer = {
    closed: new Promise(() => {}),
    subscribe: () => () => {},
    close() {},
    async request(method, params) {
      if (method === 'codexhost/harness/inspect') {
        inspectCalls++
        return {
          status: 'ready',
          catalog: { models: [{ ref: { id: 'gemini-4-neon' }, label: 'Gemini 4 Neon' }], defaultModel: { id: 'gemini-4-neon' }, thinkingOptions: [] },
          permissionModes: { modes: [{ id: 'dangerously-skip-permissions', label: 'Skip permissions', dangerous: true }], defaultModeId: 'dangerously-skip-permissions' },
        }
      }
      throw new Error('Unexpected RPC ' + method)
    },
  }
  const ctx = { agentPresets: { presetForSession: () => 'codexhost-antigravity' } }
  const driver = new NativeSessionDriver(ctx, {}, { connect: async () => peer })
  const makeAgent = cwd => ({ id: cwd, session: { header: { cwd }, snapshotEvents: () => [] } })
  const a = await driver.catalog(makeAgent('D:/repo-1'))
  const b = await driver.catalog(makeAgent('D:/repo-2'))
  assert.equal(a.status, 'ready', a.error)
  assert.equal(b.status, 'ready', b.error)
  assert.equal(inspectCalls, 1, 'antigravity catalog reads should not be partitioned by cwd')
  await driver.dispose()
})

test('516K context window and 80% auto-compaction trigger logic behave cleanly without looping', () => {
  assert.equal(DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS, 516_000)
  assert.equal(dshAntigravityAutoCompactThreshold(516_000), 412_800)
  assert.equal(dshShouldAutoCompactAntigravity(412_799, 516_000, 0), false)
  assert.equal(dshShouldAutoCompactAntigravity(412_800, 516_000, 0), true)
  // Already compacted at 412_800 -> do not re-trigger unless usage climbs higher
  assert.equal(dshShouldAutoCompactAntigravity(412_800, 516_000, 412_800), false)
  assert.equal(dshShouldAutoCompactAntigravity(450_000, 516_000, 412_800), true)

  assert.equal(dshIsTransientAntigravityError('HTTP 503 Service Unavailable'), true)
  assert.equal(dshIsTransientAntigravityError('socket hang up / ECONNRESET'), true)
  assert.equal(dshIsTransientAntigravityError('429 rate limited'), true)
  assert.equal(dshIsTransientAntigravityError('Individual quota reached (429)'), false)
  assert.equal(dshIsTransientAntigravityError('User location is not supported for the API use'), false)
  assert.equal(dshIsTransientAntigravityError('HTTP 403 permission denied'), false)
})

test('transcript parser emits deduplicated cache-inclusive requests and prices both canonical and legacy Antigravity model labels', () => {
  const transcript = [
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 500 }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', input_tokens: 1200, cache_read_tokens: 18800, output_tokens: 600 }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', model: 'claude-sonnet-4-6', input_tokens: 500, cache_read_tokens: 4500, cache_write_tokens: 200, output_tokens: 300 }),
  ].join('\n')
  const entries = dshAntigravityTranscriptUsageRequests(transcript, 'conv-9', 'gemini-4-neon')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0].request, {
    requestId: 'agy:conv-9:2',
    model: 'gemini-4-neon-high',
    provider: 'google',
    inputTokens: 20_000,
    cachedInputTokens: 18_800,
    cacheWriteInputTokens: 0,
    outputTokens: 600,
  })
  assert.equal(entries[1].request.provider, 'anthropic')
  assert.equal(entries[1].request.inputTokens, 5200)
  assert.equal(entries[1].request.cacheWriteInputTokens, 200)

  // Price lookup with official Google Gemini 4 Neon pricing ($3 in, $15 out, $0.15 cacheRead)
  assert.equal(dshNormalizeAntigravityModelForPrice('Gemini 4 Neon'), 'gemini-4-neon')
  assert.equal(dshNormalizeAntigravityModelForPrice('Gemini 4 Neon (High)'), 'gemini-4-neon')
  assert.equal(dshNormalizeAntigravityModelForPrice('gemini-4-neon'), null)

  const lookup = new ModelPriceLookup({ providers: { google: { 'gemini-4-neon': [3, 15, 0.15, null, true] } } })
  const legacyEvent = {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      message: { id: 'm1', source: { kind: 'model', provider: 'codexhost/antigravity', model: 'Gemini 4 Neon' } },
      usage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    },
  }
  const canonicalEvent = {
    ...legacyEvent,
    data: { ...legacyEvent.data, message: { id: 'm2', source: { kind: 'model', provider: 'codexhost/antigravity', model: 'gemini-4-neon' } } },
  }
  // 0.1M * $3 + 0.01M * $15 + 1.0M * $0.15 = $0.30 + $0.15 + $0.15 = $0.60
  assert.ok(Math.abs(requestCost(costRequest(legacyEvent), lookup) - 0.6) < 1e-12)
  assert.ok(Math.abs(requestCost(costRequest(canonicalEvent), lookup) - 0.6) < 1e-12)
  const view = sessionCostView({ m1: costRequest(legacyEvent) }, lookup)
  assert.equal(view.cost.unpricedRequests, 0)
  assert.ok(Math.abs(view.usage.totalCostUsd - 0.6) < 1e-12)
})

test('rebuilt Antigravity session meters cached tokens from transcript.jsonl and auto-compacts at 80% of 516K', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-meter-'))
  try {
    const convId = '11111111-2222-4333-8444-555555555555'
    const { mkdir } = await import('node:fs/promises')
    const logDir = path.join(dir, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    const transcriptFile = path.join(logDir, 'transcript.jsonl')
    const compactLog = path.join(dir, 'compact-called.txt')
    const fakeScript = path.join(dir, 'fake-agy-turn.mjs')
    const fakeBin = path.join(dir, process.platform === 'win32' ? 'fake-agy-turn.cmd' : 'fake-agy-turn')
    await writeFile(fakeScript, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      if (args[0] === 'models') {
        process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');
        process.exit(0);
      }
      if (args.includes('--print=/compact')) {
        appendFileSync(${JSON.stringify(compactLog)}, 'compacted\\n');
        process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(convId)}, status: 'SUCCESS', num_turns: 1 } }) + '\\n');
        process.exit(0);
      }
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => {
        writeFileSync(${JSON.stringify(transcriptFile)}, JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          model: 'gemini-4-neon-high',
          input_tokens: 20000,
          cache_read_tokens: 410000,
          output_tokens: 1500
        }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(convId)}, init: { permission_mode: 'dangerously-skip-permissions' } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 3, state: 'DONE', step_type: 'agent_response', text: 'hello', usage: { input_tokens: 20000, cache_read_tokens: 410000, output_tokens: 1500 } } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(convId)}, status: 'SUCCESS', num_turns: 1, response: 'hello', usage: { input_tokens: 20000, output_tokens: 1500 } } }) + '\\n');
        process.exit(0);
      });
    `, 'utf8')
    if (process.platform === 'win32') {
      await writeFile(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8')
    } else {
      await writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 })
    }

    const { createHarnessAdapter } = await import('../backend/plugins/antigravity/plugin.mjs')
    const env = { ...process.env, USERPROFILE: dir, HOME: dir, CODEXHOST_DATA_DIR: path.join(dir, 'host-data'), CODEXHOST_ANTIGRAVITY_COMMAND: fakeBin }
    const adapter = createHarnessAdapter({ environment: env, platform: process.platform })
    const opened = await adapter.open({ kind: 'create', cwd: dir, model: { id: 'gemini-4-neon' }, permissionModeId: 'dangerously-skip-permissions' })
    assert.equal(opened.ok, true)
    const session = opened.value

    const events = []
    const reader = (async () => {
      for await (const out of session.outputs) {
        if (out.kind === 'event') events.push(out.event)
      }
    })()

    // Turn 1: emits 430,000 context tokens (> 80% of 516,000 = 412,800) and transcript usage with 410,000 cache read tokens
    const t1 = await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: 'hi' }] })
    assert.equal(t1.ok, true)
    while (!events.some(e => e.type === 'turn.completed' && e.turnId === 'turn-1')) {
      await new Promise(r => setTimeout(r, 20))
    }

    const usageReqIdx = events.findIndex(e => e.type === 'usage.request')
    const usageHistIdx = events.findIndex(e => e.type === 'usage.history')
    const turnDoneIdx = events.findIndex(e => e.type === 'turn.completed' && e.turnId === 'turn-1')
    assert.ok(usageReqIdx >= 0 && usageReqIdx < turnDoneIdx, 'usage.request must be emitted before turn.completed')
    assert.ok(usageHistIdx >= 0 && usageHistIdx < turnDoneIdx, 'usage.history must be emitted before turn.completed')
    assert.equal(events[usageReqIdx].request.cachedInputTokens, 410_000)
    assert.equal(events[usageReqIdx].request.inputTokens, 430_000)
    assert.equal(events[usageReqIdx].request.cacheWriteInputTokens, 0)
    assert.equal(events[usageReqIdx].request.model, 'gemini-4-neon-high')
    assert.equal(events[usageReqIdx].request.provider, 'google')

    const usageChanged = events.find(e => e.type === 'session.usage.changed' && e.usage.contextWindowTokens)
    assert.equal(usageChanged.usage.contextWindowTokens, 516_000, 'Gemini context window must be 516K')

    // Turn 2: contextUsedTokens (430,000) >= 80% of 516,000 (412,800) -> auto-compacts before running turn 2!
    const t2 = await session.execute({ type: 'turn.start', turnId: 'turn-2', input: [{ type: 'text', text: 'next' }] })
    assert.equal(t2.ok, true)
    while (!events.some(e => e.type === 'turn.completed' && e.turnId === 'turn-2')) {
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal((await readFile(compactLog, 'utf8')).trim(), 'compacted', 'auto-compaction must invoke --print=/compact at 80% of 516K')
    assert.ok(events.some(e => e.type === 'item.completed' && e.turnId === 'turn-2' && e.snapshot.item.type === 'contextCompaction'))

    await adapter.close()
    await reader
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('NativeTurnProjector captures initial agentMessage text from item/started so locallyCovered prevents duplicate native replies', () => {
  const events = [{ type: 'plugin:codexhost/thread', ignorable: true, data: { hostTurnId: 'h-turn-1', localTurn: 1 } }]
  const session = {
    append(type, data, options) {
      const event = { type, seq: events.length, data, ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}) }
      events.push(event)
      return event
    },
    snapshotEvents: () => events,
  }
  const helpers = {
    AssistantStreamAccumulator: class { #s = []; push(v) { this.#s.push(v); return v } snapshot() { return this.#s } },
    BlockAssembler: class {
      #b = []
      push(c) { if (c.type === 'block-end') this.#b.push(c.block) }
      blocks() { return this.#b }
    },
    createAssistantMessage: ({ content, source }) => ({ content, source }),
  }
  let rev = 0
  const projector = new NativeTurnProjector({
    agent: { id: 'a1', session },
    turn: 1,
    step: 1,
    helpers,
    dispatch: { emit() {} },
    nextRevision: () => ++rev,
    provider: 'codexhost/antigravity',
    model: 'gemini-4-neon',
  })
  // Mirrors Antigravity's wire stream: first chunk in item/started, rest in item/agentMessage/delta.
  projector.accept({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'item-1', text: '四项问题都已查明' } } })
  projector.accept({ method: 'item/agentMessage/delta', params: { itemId: 'item-1', delta: '根因并修复完毕。' } })
  projector.accept({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'item-1', text: '四项问题都已查明根因并修复完毕。' } } })
  projector.settle()

  const assistant = events.find(e => e.type === 'assistant/message')
  assert.equal(assistant.data.message.content[0].text, '四项问题都已查明根因并修复完毕。')
  assert.equal(locallyCovered(session, 'h-turn-1', '四项问题都已查明根因并修复完毕。'), true)
})

test('readNativeAntigravityTitle reads native AGY titles from conversation_summaries.db and ignores blank titles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-title-db-'))
  try {
    const dbPath = path.join(dir, 'conversation_summaries.db')
    assert.equal(await readNativeAntigravityTitle({ threadId: 'missing', dbPath }), null)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT)`)
    db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)`).run(
      'conv-titled',
      '  AGY 自动标题\n测试  ',
      JSON.stringify(['file:///C:/Users/demo/.dsh/dsh-host/antigravity-history/hooks/thread-111', 'file:///D:/work']),
      '2026-11-23 01:00:00+00:00',
    )
    db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)`).run(
      'conv-blank',
      '',
      JSON.stringify(['file:///C:/Users/demo/.dsh/dsh-host/antigravity-history/hooks/thread-222', 'file:///D:/work']),
      '2026-11-23 01:01:00+00:00',
    )
    db.close()

    assert.equal(await readNativeAntigravityTitle({ threadId: 'thread-111', dbPath }), 'AGY 自动标题 测试')
    assert.equal(await readNativeAntigravityTitle({ conversationId: 'conv-titled', dbPath }), 'AGY 自动标题 测试')
    assert.equal(await readNativeAntigravityTitle({ threadId: 'thread-222', dbPath }), null)
    assert.equal(await readNativeAntigravityTitle({ threadId: 'thread-none', dbPath }), null)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('completeExternalTitle truncates oversized prompts within maxInputBytes, unwraps emphasis, flushes, and syncs Host thread name', async () => {
  const events = [], renamed = []
  let flushes = 0, receivedInput = ''
  let current = { title: '首句兜底标题', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { append(type, data) { events.push({ type, data }); if (type === 'session/title') current = { ...data, eventSeq: 5 } } }
  const ctx = {
    sessionPersistence: { async flush() { flushes++ } },
    get: key => key === 'sessionTitle' ? { get: () => current } : {},
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_services, options, _req, _id, prepared) {
            receivedInput = prepared.input
            assert.ok(Buffer.byteLength(prepared.input, 'utf8') <= options.maxInputBytes)
            assert.doesNotThrow(() => JSON.parse(prepared.input))
            return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '**AGY 标题修复与同步**' }], model: { provider: 'botcf', model: 'gpt-6.1-sol' } }
          },
        }
        throw new Error(name)
      },
    },
  }
  const peer = {
    async request(method, params) {
      if (method === 'thread/name/set') { renamed.push(params); return {} }
      throw new Error(method)
    },
  }
  const agent = { session, model: { current: () => ({ provider: 'botcf', model: 'gpt-6.1-sol' }) } }
  const bigPrompt = '长日志😀测试内容\n'.repeat(500)
  const ok = await completeExternalTitle(
    ctx,
    agent,
    { seq: 2, text: bigPrompt },
    new AbortController().signal,
    { enabled: true, maxInputBytes: 256, maxOutputTokens: 512, timeoutMs: 30_000 },
    { peer, threadId: 'thread-agy-1' },
  )
  assert.equal(ok, true)
  assert.ok(receivedInput.length > 0 && !receivedInput.includes('\uFFFD'))
  assert.equal(events.length, 1)
  assert.equal(events[0].data.title, 'AGY 标题修复与同步')
  assert.equal(flushes, 1)
  assert.deepEqual(renamed, [{ threadId: 'thread-agy-1', name: 'AGY 标题修复与同步' }])
})

test('NativeSessionDriver retries fallback title generation on later completed Antigravity turns', async () => {
  const events = [
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '之前 AGY 标题没生成成功' }] } },
    { type: 'plugin:codexhost/thread', seq: 3, ignorable: true, data: { version: 1, phase: 'ready', harnessId: 'antigravity', threadId: 'thread-agy-retry', sessionId: 'local-agy', appliedConfiguration: { modelId: 'gemini-4-neon', permissionModeId: 'dangerously-skip-permissions' } } },
  ]
  let current = { title: '之前 AGY 标题没生成成功', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = {
    id: 'local-agy',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => events,
    append(type, data) {
      const ev = { type, seq: events.length + 1, data }
      events.push(ev)
      if (type === 'session/title') current = { ...data, eventSeq: ev.seq }
      return ev
    },
  }
  const listeners = new Set(), renamed = []
  let llmCalls = 0
  const peer = {
    closed: new Promise(() => {}),
    close() {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async request(method, params) {
      if (method === 'codexhost/harness/inspect') return {
        status: 'ready',
        catalog: { models: [{ ref: { id: 'gemini-4-neon' }, label: 'Gemini 4 Neon', resolvedModelLabel: 'gemini-4-neon' }], defaultModel: { id: 'gemini-4-neon' }, thinkingOptions: [] },
        permissionModes: { modes: [{ id: 'dangerously-skip-permissions', label: 'Skip permissions', dangerous: true }], defaultModeId: 'dangerously-skip-permissions' },
      }
      if (method === 'thread/read') return { thread: { id: 'thread-agy-retry', status: { type: 'idle' } } }
      if (method === 'thread/resume') return {}
      if (method === 'codexhost/thread/usage/inspect') return {}
      if (method === 'turn/start') {
        queueMicrotask(() => {
          for (const fn of listeners) fn({ method: 'turn/completed', params: { threadId: 'thread-agy-retry', turnId: 'h-turn-2', turn: { id: 'h-turn-2', status: 'completed' } } })
        })
        return { turn: { id: 'h-turn-2' } }
      }
      if (method === 'thread/name/set') { renamed.push(params); return {} }
      throw new Error('Unexpected RPC ' + method)
    },
  }
  const helpers = {
    appendPluginRecord(target, type, data) { target.append(type, data) },
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { push(v) { return v } snapshot() { return [] } },
    BlockAssembler: class { push() {} blocks() { return [] } },
    createAssistantMessage: ({ content, source }) => ({ content, source }),
  }
  const ctx = {
    agentPresets: { presetForSession: () => 'codexhost-antigravity' },
    sessionPersistence: { async flush() {} },
    logger: { warn() {} },
    get: key => key === 'sessionTitle' ? { get: () => current } : key === 'llm' ? {} : undefined,
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_services, _opts, _req, _id, prepared) {
            llmCalls++
            assert.deepEqual(prepared.messageSeqs, [2])
            return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: 'AGY 自动标题重试成功' }], model: { provider: 'botcf', model: 'gpt-6.1-sol' } }
          },
        }
        throw new Error(name)
      },
    },
  }
  const driver = new NativeSessionDriver(ctx, helpers, {
    connect: async () => peer,
    titlePolicy: { enabled: true, maxInputBytes: 16_000, maxOutputTokens: 512, timeoutMs: 30_000 },
  })
  const agent = { id: 'local-agy', session, model: { current: () => ({ provider: 'botcf', model: 'gpt-6.1-sol' }) } }
  await driver.run({
    agent,
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮继续聊' }] }],
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
  })
  // Wait for post-turn metadata/title promise to settle before disposing the driver.
  for (let i = 0; i < 50 && renamed.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  await driver.dispose()
  assert.equal(llmCalls, 1)
  assert.equal(current.title, 'AGY 自动标题重试成功')
  assert.deepEqual(renamed, [{ threadId: 'thread-agy-retry', name: 'AGY 自动标题重试成功' }])
})

test('Antigravity native sessionImport lists, resolves, and reconstructs transcript turns end-to-end', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-import-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    const { pathToFileURL } = await import('node:url')
    const { DatabaseSync } = await import('node:sqlite')
    const agyRoot = path.join(dir, '.gemini', 'antigravity-cli')
    const workDir = path.join(dir, 'workspace-a')
    await mkdir(workDir, { recursive: true })
    await mkdir(path.join(agyRoot, 'conversations'), { recursive: true })
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const logDir = path.join(agyRoot, 'brain', convId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })

    // Create a realistic native AGY transcript.jsonl with USER_INPUT, PLANNER_RESPONSE (thinking + tool_calls + content), and GENERIC tool output
    await writeFile(path.join(logDir, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n分析病历表格\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-hydrogen-medium', thinking: '先读取文件', tool_calls: [{ name: 'read_file', args: { Path: '"D:\\\\data.xlsx"' } }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'row1,row2' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-hydrogen-medium', content: '已完成病历分析。' }),
    ].join('\n') + '\n')

    const dbPath = path.join(agyRoot, 'conversation_summaries.db')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT, killed INTEGER)`)
    const insert = db.prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const hookUri = 'file:///C:/Users/demo/.dsh/dsh-host/antigravity-history/hooks/thread-1'
    const workUri = pathToFileURL(workDir).href
    insert.run(convId, '外阴白斑病历用药分析', '分析病历表格', 4, '2026-11-22 16:43:39+00:00', JSON.stringify([hookUri, workUri]), 'CASCADE_RUN_STATUS_IDLE', '', 0)
    // Subagent and killed rows must be excluded
    insert.run('sub-1', '子任务', 'sub', 2, '2026-11-22 16:44:00+00:00', JSON.stringify([workUri]), 'CASCADE_RUN_STATUS_IDLE', convId, 0)
    insert.run('killed-1', '已删', 'k', 2, '2026-11-22 16:45:00+00:00', JSON.stringify([workUri]), 'CASCADE_RUN_STATUS_IDLE', '', 1)
    db.close()

    const listed = await dshListAntigravityImportCandidates({}, { rootDir: agyRoot })
    assert.equal(listed.ok, true)
    assert.equal(listed.value.length, 1)
    assert.equal(listed.value[0].nativeSessionId, convId)
    assert.equal(listed.value[0].title, '外阴白斑病历用药分析')
    assert.equal(path.resolve(listed.value[0].cwd), path.resolve(workDir))
    assert.equal(listed.value[0].running, null)

    const resolved = await dshResolveAntigravityImportCandidate({}, convId, { rootDir: agyRoot })
    assert.equal(resolved.ok, true)
    assert.deepEqual(resolved.value.nativeRef, { harnessId: 'antigravity', nativeSessionId: convId, formatVersion: 1 })

    const missing = await dshResolveAntigravityImportCandidate({}, 'no-such-id', { rootDir: agyRoot })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'sessionNotFound')

    const parsed = await dshReadAntigravityTranscriptTurns({}, convId, { rootDir: agyRoot })
    assert.equal(parsed.turns.length, 1)
    assert.equal(parsed.model.id, 'gemini-4-hydrogen')
    assert.equal(parsed.thinkingOptionId, 'medium')
    assert.deepEqual(parsed.turns[0].input, [{ type: 'text', text: '分析病历表格' }])
    assert.equal(parsed.turns[0].items.map(x => x.item.type).join(','), 'reasoning,toolExecution,agentMessage')
    assert.equal(parsed.turns[0].items[1].item.arguments.Path, 'D:\\data.xlsx')
    assert.equal(parsed.turns[0].items[1].item.output.content[0].text, 'row1,row2')
    assert.equal(parsed.turns[0].items[2].item.text, '已完成病历分析。')

    // End-to-end against the rebuilt shipped Antigravity adapter
    const fakeBin = path.join(dir, process.platform === 'win32' ? 'fake-agy-imp.cmd' : 'fake-agy-imp')
    await writeFile(fakeBin, process.platform === 'win32' ? '@echo off\r\necho gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\r\n' : '#!/bin/sh\necho "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)"\n', { mode: 0o755 })
    const { createHarnessAdapter } = await import('../backend/plugins/antigravity/plugin.mjs')
    const adapter = createHarnessAdapter({
      platform: process.platform,
      environment: {
        ...process.env,
        USERPROFILE: dir,
        HOME: dir,
        CODEXHOST_DATA_DIR: path.join(dir, 'host-data'),
        CODEXHOST_ANTIGRAVITY_COMMAND: fakeBin,
      },
    })
    assert.ok(adapter.sessionImport?.listCandidates && adapter.sessionImport?.resolveCandidate)
    const adapterList = await adapter.sessionImport.listCandidates()
    assert.equal(adapterList.ok, true)
    assert.equal(adapterList.value[0].nativeSessionId, convId)

    const opened = await adapter.open({ kind: 'resume', cwd: workDir, nativeRef: resolved.value.nativeRef })
    assert.equal(opened.ok, true)
    const snap = await opened.value.readSnapshot()
    assert.equal(snap.ok, true)
    assert.equal(snap.value.turns.length, 1)
    assert.equal(snap.value.turns[0].items.at(-1).item.text, '已完成病历分析。')
    await adapter.close()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('NativeSessionImporter.list degrades gracefully when adapter reports Harness Session import is unsupported', async () => {
  const peer = {
    async request(method, params) {
      if (method === 'thread/list') return { data: [{ id: 't-agy-1', name: 'Host AGY Thread', cwd: 'D:/work', updatedAt: 1700000000 }], nextCursor: null }
      if (method === 'codexhost/thread/ownership/list') return { threads: [{ threadId: 't-agy-1', owner: 'external', harnessId: 'antigravity' }] }
      if (method === 'codexhost/harness/session-import/list') throw new Error('Harness Session import is unsupported')
      throw new Error('Unexpected ' + method)
    },
  }
  const importer = new NativeSessionImporter({}, {}, {})
  const result = await importer.list(peer, { harnessId: 'antigravity' })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].id, 't-agy-1')
  assert.equal(result.rows[0].title, 'Host AGY Thread')
})

test('Claude catalog disk cache round-trips, validates executable stat, and rejects non-ready entries', async () => {
  const { dshClaudeCatalogCachePath, dshReadClaudeCatalogCache, dshWriteClaudeCatalogCache } = await import('../claude-catalog-cache.mjs')
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-claude-cache-'))
  try {
    const fakeCli = path.join(dir, 'claude.exe')
    await writeFile(fakeCli, 'fake-claude-v1')
    const env = { CODEXHOST_DATA_DIR: path.join(dir, 'host-data') }
    const sample = {
      status: 'ready',
      catalog: { models: [{ ref: { id: 'claude-model-v1.b3B1cw' }, label: 'Opus' }], defaultModel: { id: 'claude-model-v1.b3B1cw' }, thinkingOptions: [] },
    }
    assert.equal(dshClaudeCatalogCachePath(env), path.join(dir, 'host-data', 'claude-catalog-cache.json'))
    assert.equal(await dshWriteClaudeCatalogCache(env, fakeCli, { status: 'error' }), false)
    assert.equal(await dshWriteClaudeCatalogCache(env, fakeCli, sample, { now: 1_000_000 }), true)
    const hit = dshReadClaudeCatalogCache(env, fakeCli, null, { now: 1_000_500 })
    assert.ok(hit)
    assert.equal(hit.result.status, 'ready')
    assert.equal(hit.result.catalog.models[0].label, 'Opus')
    // Expired cache must miss
    assert.equal(dshReadClaudeCatalogCache(env, fakeCli, null, { now: 1_000_000 + 8 * 86400 * 1000 }), null)
    // Changed binary size invalidates cache
    await writeFile(fakeCli, 'fake-claude-v2-longer')
    assert.equal(dshReadClaudeCatalogCache(env, fakeCli, null, { now: 1_000_500 }), null)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('NativeSessionDriver migrates legacy Antigravity xhigh model IDs and clamps xhigh to high on high-max models', async () => {
  const inspected = {
    status: 'ready',
    catalog: {
      models: [
        { ref: { id: 'gemini-4-neon' }, label: 'Gemini 4 Neon', resolvedModelLabel: 'gemini-4-neon', supportedThinkingOptionIds: ['low', 'medium', 'high', 'xhigh'] },
        { ref: { id: 'gemini-4-carbon' }, label: 'Gemini 4 Carbon', resolvedModelLabel: 'gemini-4-carbon', supportedThinkingOptionIds: ['low', 'medium', 'high'] },
      ],
      defaultModel: { id: 'gemini-4-neon' },
      thinkingOptions: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'XHigh' },
      ],
      defaultThinkingOptionId: 'high',
    },
    permissionModes: { modes: [{ id: 'dangerously-skip-permissions', label: 'Skip permissions', dangerous: true }], defaultModeId: 'dangerously-skip-permissions' },
  }
  const sessionEvents = [{ type: 'plugin:codexhost/configuration', ignorable: true, data: { harnessId: 'antigravity', modelId: 'gemini-4-neon-xhigh', permissionModeId: 'dangerously-skip-permissions' } }]
  const peer = {
    closed: new Promise(() => {}),
    subscribe: () => () => {},
    close() {},
    async request(method) {
      if (method === 'codexhost/harness/inspect') return inspected
      throw new Error('Unexpected RPC ' + method)
    },
  }
  const driver = new NativeSessionDriver(
    { agentPresets: { presetForSession: () => 'codexhost-antigravity' }, sessionPersistence: { async flush() {} } },
    { appendPluginRecord(_session, type, data) { sessionEvents.push({ type, ignorable: true, data }) } },
    { connect: async () => peer },
  )
  const agent = { id: 'agy-migrate', runMaintenance: fn => fn(), session: { header: { cwd: 'D:/work' }, snapshotEvents: () => sessionEvents } }
  const migrated = await driver.catalog(agent)
  assert.equal(migrated.status, 'ready', migrated.error)
  assert.equal(migrated.selection.modelId, 'gemini-4-neon')
  assert.equal(migrated.selection.thinkingOptionId, 'xhigh')

  const switched = await driver.configure(agent, { modelId: 'gemini-4-carbon' })
  assert.equal(switched.selection.modelId, 'gemini-4-carbon')
  assert.equal(switched.selection.thinkingOptionId, 'high')
  await driver.dispose()
})
