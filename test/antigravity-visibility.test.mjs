import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  dshAntigravityTranscriptPath,
  dshParseAntigravityAuthRefreshNetworkError,
  dshIsAntigravityInteractiveOAuthTrigger,
  dshParseAntigravityLogLine,
  dshExtractAntigravitySystemMessage,
  dshParseAntigravityTranscriptLiveRecord,
  DshAntigravityLiveObserver,
} from '../antigravity-visibility.mjs'
import { NativeTurnProjector } from '../native-turn-projector.mjs'
import { locallyCovered } from '../native-replies.mjs'

test('dshParseAntigravityLogLine ignores startup pre-auth noise and surfaces retries and post-startup errors', () => {
  // Pre-startup benign lines must be ignored
  assert.equal(dshParseAntigravityLogLine('E1124 10:30:32.000 33 errorreport.go:282] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.', { postStartup: false }), null)
  assert.equal(dshParseAntigravityLogLine('E1124 10:30:32.055 1 launchsteps.go:108] Failed to resolve GeminiDir ".gemini": path is not absolute', { postStartup: true }), null)

  // Sending user message marks post-startup
  const started = dshParseAntigravityLogLine('I1124 10:30:37.366 1 server.go:1883] Sending user message to conversation abc (items=1, media=0)')
  assert.equal(started?.kind, 'started')
  assert.equal(started?.markPostStartup, true)

  // Normal first SSE request should not emit noisy retry status
  const firstReq = dshParseAntigravityLogLine('I1124 10:30:56.923 761 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1', { postStartup: true, hadRetry: false })
  assert.equal(firstReq?.kind, 'started')

  // Retry line surfaces exact attempt, reason, delay, and dedupe key
  const retry = dshParseAntigravityLogLine('I1124 11:30:00.178 31 run.go:308] Run: attempt 2 failed (stream reading error: unexpected EOF), retrying in 6.4s', { postStartup: true })
  assert.equal(retry?.kind, 'retry')
  assert.equal(retry?.attempt, 2)
  assert.equal(retry?.dedupeKey, 'attempt:2:stream reading error: unexpected eof')
  assert.match(retry?.text ?? '', /第 2 次请求失败.*unexpected EOF.*6\.4s/)

  // Subsequent SSE dispatch after retry emits re-dispatch status
  const reReq = dshParseAntigravityLogLine('I1124 11:30:15.844 31 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2', { postStartup: true, hadRetry: true })
  assert.equal(reReq?.kind, 'request-retry')
  assert.match(reReq?.text ?? '', /重新发起模型请求/)

  // Post-startup fatal/error line surfaces cleanly
  const err = dshParseAntigravityLogLine('E1124 11:31:00.000 31 client.go:99] quota exhausted for model gemini-4-carbon', { postStartup: true })
  assert.equal(err?.kind, 'error')
  assert.match(err?.text ?? '', /quota exhausted/)
})

test('dshExtractAntigravitySystemMessage filters repetitive boilerplate and keeps actionable task/system notices', () => {
  const preamble = 'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.'
  assert.equal(dshExtractAntigravitySystemMessage('<SYSTEM_MESSAGE>\nReminder: work efficiently. In this turn, issue in parallel every independent search...\n</SYSTEM_MESSAGE>'), null)
  assert.equal(dshExtractAntigravitySystemMessage(`${preamble}\n\n<SYSTEM_MESSAGE>\nReminder: work efficiently. In this turn, issue in parallel every independent search...\n</SYSTEM_MESSAGE>`), null)
  assert.equal(dshExtractAntigravitySystemMessage(preamble), null)
  assert.equal(dshExtractAntigravitySystemMessage('not actually sent by the user. It is provided by the system as important information to pay attention to.'), null)
  assert.equal(dshExtractAntigravitySystemMessage(`${preamble}\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T04:10:53Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>`), null)
  assert.equal(dshExtractAntigravitySystemMessage('[System Instruction: When creating new files...]'), null)

  const taskDone = dshExtractAntigravitySystemMessage(`${preamble}\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T02:32:43Z sender=30029cf9/task-5 priority=MESSAGE_PRIORITY_HIGH content=Task id "30029cf9/task-5" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`)
  assert.equal(taskDone, '[AGY 系统] task-5: Task id "30029cf9/task-5" finished with result:')

  const custom = dshExtractAntigravitySystemMessage(`${preamble}\n\n<SYSTEM_MESSAGE>\nContext compacted from 420K to 28K tokens.\n</SYSTEM_MESSAGE>`)
  assert.equal(custom, '[AGY 系统] Context compacted from 420K to 28K tokens.')
})

test('DshAntigravityLiveObserver seeks past old transcript on resume, deduplicates log/transcript retries, and handles partial writes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-vis-obs-'))
  try {
    const convId = 'conv-resume-1'
    const logPath = path.join(dir, 'agy.log')
    const transcriptFile = dshAntigravityTranscriptPath({ USERPROFILE: dir, HOME: dir }, convId)
    await mkdir(path.dirname(transcriptFile), { recursive: true })

    // Existing historical turn in transcript.jsonl (must NOT be replayed on resume!)
    await writeFile(transcriptFile, JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: '旧轮次的思考内容，不应重复播放',
    }) + '\n', 'utf8')
    await writeFile(logPath, '', 'utf8')

    const seen = []
    const obs = new DshAntigravityLiveObserver({
      environment: { USERPROFILE: dir, HOME: dir },
      logPath,
      initialConversationId: convId,
      pollMs: 50,
      onEvent: (ev) => seen.push(ev),
    })

    // Initial flush must emit nothing from historical transcript
    await obs.flush()
    assert.equal(seen.length, 0)

    // Append retry to logPath AND matching ERROR_MESSAGE + new thinking (split across partial write) to transcript
    await appendFile(logPath, 'I1124 11:28:01.000 1 server.go:1883] Sending user message to conversation conv-resume-1\n', 'utf8')
    await appendFile(logPath, 'I1124 11:30:00.178 31 run.go:308] Run: attempt 1 failed (stream reading error: unexpected EOF), retrying in 4s\n', 'utf8')
    const errLine = JSON.stringify({ step_index: 2, type: 'ERROR_MESSAGE', error: 'API error (attempt 1): stream reading error: unexpected EOF' }) + '\n'
    const thinkLine = JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', thinking: '本轮新思考：定位到根因' }) + '\n'
    // Write error line + first half of think line (partial)
    await appendFile(transcriptFile, errLine + thinkLine.slice(0, 35), 'utf8')
    await obs.flush()
    // Should have ONLY 1 event (retry from log; duplicate attempt 1 ERROR_MESSAGE deduped; partial line buffered)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].kind, 'retry')

    // Finish writing second half of think line + a real system message
    const sysLine = JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T04:00:00Z sender=conv-resume-1/task-9 priority=HIGH content=Task finished OK\n</SYSTEM_MESSAGE>' }) + '\n'
    await appendFile(transcriptFile, thinkLine.slice(35) + sysLine, 'utf8')
    await obs.flush()
    assert.equal(seen.length, 3)
    assert.equal(seen[1].kind, 'thinking')
    assert.equal(seen[1].text, '本轮新思考：定位到根因')
    assert.equal(seen[2].kind, 'system')
    assert.match(seen[2].text, /task-9: Task finished OK/)
    obs.stop()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('DshAntigravityLiveObserver detects transient OAuth token refresh network EOF before interactive OAuth stalls', async () => {
  assert.equal(
    dshParseAntigravityAuthRefreshNetworkError('W1125 22:42:21.408 249 browser.go:256] token refresh failed due to network error: Post "https://oauth2.googleapis.com/token": EOF'),
    'Post "https://oauth2.googleapis.com/token": EOF',
  )
  assert.equal(
    dshParseAntigravityAuthRefreshNetworkError('W1125 22:42:21.408 249 keyring.go:74] keyringAuth: token validation failed due to network error (token may still be valid): Post "https://oauth2.googleapis.com/token": EOF'),
    'Post "https://oauth2.googleapis.com/token": EOF',
  )
  assert.equal(
    dshParseAntigravityAuthRefreshNetworkError('W1125 22:42:21.408 249 browser.go:256] token refresh failed due to network error: invalid_grant'),
    null,
  )
  assert.equal(dshIsAntigravityInteractiveOAuthTrigger('I1125 22:42:21.408 1 printmode.go:433] Print mode: triggering interactive OAuth'), true)

  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-vis-auth-'))
  try {
    // 1. Network EOF during token refresh + interactive OAuth -> emits auth-refresh-network-stalled once
    const logNet = path.join(dir, 'net.log')
    await writeFile(logNet, [
      'I1125 22:42:16.405 249 keyring.go:64] keyringAuth: loaded token, expiry=2026-11-25 22:41:28 +0800 CST expired=true',
      'W1125 22:42:21.408 249 browser.go:256] token refresh failed due to network error: Post "https://oauth2.googleapis.com/token": EOF',
      'I1125 22:42:21.408 1 printmode.go:416] Print mode: silent auth failed',
      'I1125 22:42:21.408 1 printmode.go:433] Print mode: triggering interactive OAuth',
      'I1125 22:42:21.408 1 auth_manager.go:207] Starting OAuth authentication flow',
    ].join('\n') + '\n', 'utf8')
    const eventsNet = []
    const obsNet = new DshAntigravityLiveObserver({ environment: {}, logPath: logNet, onEvent: ev => eventsNet.push(ev) })
    await obsNet.flush()
    assert.equal(eventsNet.length, 1)
    assert.equal(eventsNet[0].kind, 'auth-refresh-network-stalled')
    assert.match(eventsNet[0].reason, /oauth2\.googleapis\.com\/token": EOF/)
    assert.match(obsNet.authRefreshNetworkReason ?? '', /oauth2\.googleapis\.com\/token": EOF/)
    obsNet.stop()

    // 2. Genuine unauthenticated interactive OAuth (no network error line) -> must NOT emit stall retry
    const logReal = path.join(dir, 'real.log')
    await writeFile(logReal, [
      'I1125 22:42:16.405 1 printmode.go:410] Print mode: not authenticated, trying silent auth',
      'I1125 22:42:16.406 1 printmode.go:416] Print mode: silent auth failed',
      'I1125 22:42:16.406 1 printmode.go:433] Print mode: triggering interactive OAuth',
    ].join('\n') + '\n', 'utf8')
    const eventsReal = []
    const obsReal = new DshAntigravityLiveObserver({ environment: {}, logPath: logReal, onEvent: ev => eventsReal.push(ev) })
    await obsReal.flush()
    assert.equal(eventsReal.length, 0)
    assert.equal(obsReal.authRefreshNetworkReason, null)
    obsReal.stop()
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('rebuilt Antigravity adapter emits live retry status, step thinking, and system messages as reasoning items without breaking assistant text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-vis-e2e-'))
  try {
    const convId = '22222222-3333-4444-8555-666666666666'
    const logDir = path.join(dir, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    const transcriptFile = path.join(logDir, 'transcript.jsonl')
    const fakeScript = path.join(dir, 'fake-agy-vis.mjs')
    const fakeBin = path.join(dir, process.platform === 'win32' ? 'fake-agy-vis.cmd' : 'fake-agy-vis')

    await writeFile(fakeScript, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      if (args[0] === 'models') {
        process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');
        process.exit(0);
      }
      const logIdx = args.indexOf('--log-file');
      const logFile = logIdx >= 0 ? args[logIdx + 1] : null;
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', async () => {
        if (logFile) {
          writeFileSync(logFile, [
            'E1124 12:00:00.000 33 errorreport.go:282] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.',
            'I1124 12:00:01.000 1 server.go:1883] Sending user message to conversation ${convId}',
          ].join('\\n') + '\\n');
        }
        process.stdout.write(JSON.stringify({ event: 'init', conversation_id: ${JSON.stringify(convId)}, init: { permission_mode: 'dangerously-skip-permissions' } }) + '\\n');
        // Simulate an API retry logged before any tool/text arrives
        if (logFile) {
          appendFileSync(logFile, 'I1124 12:00:02.000 31 run.go:308] Run: attempt 1 failed (stream reading error: unexpected EOF), retrying in 4s\\n');
        }
        await new Promise(r => setTimeout(r, 500));
        // Simulate step 1 thinking + system notification written right before tool execution
        appendFileSync(${JSON.stringify(transcriptFile)}, [
          JSON.stringify({ step_index: 1, type: 'ERROR_MESSAGE', error: 'API error (attempt 1): stream reading error: unexpected EOF' }),
          JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-high', input_tokens: 1000, cache_read_tokens: 0, output_tokens: 200, thinking: '先读取配置文件确认参数' }),
          JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\\nReminder: work efficiently. In this turn...\\n</SYSTEM_MESSAGE>' }),
          JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', content: '<SYSTEM_MESSAGE>\\n[Message] timestamp=2026-11-24T04:00:01Z sender=${convId}/task-7 priority=HIGH content=Background check completed\\n</SYSTEM_MESSAGE>' }),
        ].join('\\n') + '\\n');
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'a.txt' }, output: 'ok' } } }) + '\\n');
        // Direct stream-json thinking + system step_update passthrough
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 6, state: 'ACTIVE', step_type: 'thinking', text_delta: '整理最终结论' } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 7, state: 'ACTIVE', step_type: 'agent_response', text_delta: '已完成' } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: ${JSON.stringify(convId)}, step_index: 7, state: 'DONE', step_type: 'agent_response', text_delta: '修复。' } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: ${JSON.stringify(convId)}, status: 'SUCCESS', num_turns: 1, response: '已完成修复。', usage: { input_tokens: 1000, output_tokens: 200 } } }) + '\\n');
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

    const t1 = await session.execute({ type: 'turn.start', turnId: 'turn-vis-1', input: [{ type: 'text', text: 'check' }] })
    assert.equal(t1.ok, true)
    while (!events.some(e => e.type === 'turn.completed' && e.turnId === 'turn-vis-1')) {
      await new Promise(r => setTimeout(r, 20))
    }

    const completedItems = events.filter(e => e.type === 'item.completed').map(e => e.snapshot.item)
    const reasoningItems = completedItems.filter(i => i.type === 'reasoning')
    const agentItems = completedItems.filter(i => i.type === 'agentMessage')
    const toolItems = completedItems.filter(i => i.type === 'toolExecution')

    assert.equal(agentItems.length, 1, 'assistant message must remain a single unsplit bubble')
    assert.equal(agentItems[0].text, '已完成修复。')
    assert.equal(toolItems.length, 1)

    const allReasoningText = reasoningItems.map(i => i.text).join('\n---\n')
    assert.match(allReasoningText, /第 1 次请求失败.*unexpected EOF.*4s/, 'retry status from --log-file must be surfaced')
    assert.equal((allReasoningText.match(/unexpected EOF/g) ?? []).length, 1, 'duplicate transcript ERROR_MESSAGE for attempt 1 must be deduped')
    assert.match(allReasoningText, /先读取配置文件确认参数/, 'transcript PLANNER_RESPONSE thinking must be surfaced')
    assert.match(allReasoningText, /task-7: Background check completed/, 'actionable SYSTEM_MESSAGE must be surfaced')
    assert.doesNotMatch(allReasoningText, /Reminder: work efficiently/, 'boilerplate reminder must be filtered')
    assert.doesNotMatch(allReasoningText, /You are not logged into Antigravity/, 'startup pre-auth warning must be filtered')
    assert.match(allReasoningText, /整理最终结论/, 'direct stream-json thinking step must be forwarded')

    // Verify Host textual item invariant: for every reasoning item, started.text + appended deltas === completed.text
    for (const rItem of reasoningItems) {
      const started = events.find(e => e.type === 'item.started' && e.item.itemId === rItem.itemId)
      assert.ok(started, 'reasoning item must have matching item.started')
      const updates = events.filter(e => e.type === 'item.updated' && e.itemId === rItem.itemId && e.update.type === 'text.append')
      const reconstructed = started.item.text + updates.map(u => u.update.text).join('')
      assert.equal(reconstructed, rItem.text, 'item.completed text must exactly match started + text.append deltas')
    }

    // Verify reasoning appears before toolExecution and before final agentMessage
    const firstReasoningIdx = completedItems.findIndex(i => i.type === 'reasoning')
    const toolIdx = completedItems.findIndex(i => i.type === 'toolExecution')
    const agentIdx = completedItems.findIndex(i => i.type === 'agentMessage')
    assert.ok(firstReasoningIdx < toolIdx && toolIdx < agentIdx, `expected reasoning(${firstReasoningIdx}) < tool(${toolIdx}) < agent(${agentIdx})`)

    // Verify NativeTurnProjector projects both reasoning and agentMessage cleanly
    const sessionEvents = [{ type: 'plugin:dsh-host/thread', ignorable: true, data: { hostTurnId: 'h-vis-1', localTurn: 1 } }]
    const mockSession = {
      append(type, data, options) {
        const ev = { type, seq: sessionEvents.length, data, ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}) }
        sessionEvents.push(ev)
        return ev
      },
      snapshotEvents: () => sessionEvents,
    }
    const helpers = {
      AssistantStreamAccumulator: class { #s = []; push(v) { this.#s.push(v); return v } snapshot() { return this.#s } },
      BlockAssembler: class { #b = []; push(c) { if (c.type === 'block-end') this.#b.push(c.block) } blocks() { return this.#b } },
      createAssistantMessage: ({ content, source }) => ({ content, source }),
    }
    let rev = 0
    const projector = new NativeTurnProjector({
      agent: { id: 'a1', session: mockSession }, turn: 1, step: 1, helpers, dispatch: { emit() {} }, nextRevision: () => ++rev, provider: 'codexhost/antigravity', model: 'gemini-4-neon',
    })
    for (const rItem of reasoningItems) {
      const pid = `${rItem.itemId}-summary`
      projector.accept({ method: 'item/reasoning/summaryTextDelta', params: { itemId: pid, delta: rItem.text } })
      projector.accept({ method: 'item/completed', params: { item: { type: 'reasoning', id: pid, summary: [rItem.text] } } })
    }
    projector.accept({ method: 'item/started', params: { item: { type: 'agentMessage', id: agentItems[0].itemId, text: '已完成' } } })
    projector.accept({ method: 'item/agentMessage/delta', params: { itemId: agentItems[0].itemId, delta: '修复。' } })
    projector.accept({ method: 'item/completed', params: { item: { type: 'agentMessage', id: agentItems[0].itemId, text: '已完成修复。' } } })
    projector.settle()

    const msg = sessionEvents.find(e => e.type === 'assistant/message')
    assert.ok(msg.data.message.content.some(b => b.type === 'reasoning' && b.text.includes('先读取配置文件确认参数')))
    assert.equal(msg.data.message.content.at(-1).text, '已完成修复。')
    assert.equal(locallyCovered(mockSession, 'h-vis-1', '已完成修复。'), true)

    await adapter.close()
    await reader
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
