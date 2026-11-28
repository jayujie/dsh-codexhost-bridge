import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshParseAntigravityStartupMilestone } from '../antigravity-visibility.mjs'
import { NativeLiveStatusTracker, createAntigravityStartupLogWatcher, shouldAcceptAntigravityMilestone } from '../native-live-status.mjs'
import { nativeRemoteDescriptors } from '../remote-contract.mjs'

test('dshParseAntigravityStartupMilestone extracts OAuth, MCP, model SSE, and retry stages', () => {
  assert.equal(dshParseAntigravityStartupMilestone('I1128 01:40:00 loadCodeAssist eligibility check').phase, 'auth')
  assert.equal(dshParseAntigravityStartupMilestone('W1128 01:40:00 Cache(loadCodeAssistResponse): Singleflight refresh failed'), null)
  assert.equal(dshParseAntigravityStartupMilestone('I1128 01:40:01 Starting MCP server dsh_collaboration').phase, 'mcp')
  assert.equal(dshParseAntigravityStartupMilestone('I1128 01:40:02 Sending user message to conversation abc').phase, 'sending')
  assert.equal(dshParseAntigravityStartupMilestone('I1128 01:40:03 POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse').phase, 'requesting')
  assert.equal(dshParseAntigravityStartupMilestone('W1128 01:40:10 Run: attempt 1 failed (EOF), retrying in 2s').phase, 'retrying')
  assert.equal(dshParseAntigravityStartupMilestone('W1128 01:40:01 token refresh failed due to network error: EOF').phase, 'retrying')
  assert.equal(dshParseAntigravityStartupMilestone('I1128 01:40:00 random noise line'), null)
})

test('shouldAcceptAntigravityMilestone prevents background loadCodeAssist from regressing post-send status', () => {
  assert.equal(shouldAcceptAntigravityMilestone('starting', 'auth'), true)
  assert.equal(shouldAcceptAntigravityMilestone('auth', 'sending'), true)
  assert.equal(shouldAcceptAntigravityMilestone('sending', 'auth'), false)
  assert.equal(shouldAcceptAntigravityMilestone('requesting', 'auth'), false)
  assert.equal(shouldAcceptAntigravityMilestone('requesting', 'mcp'), false)
  assert.equal(shouldAcceptAntigravityMilestone('sending', 'requesting'), true)
  assert.equal(shouldAcceptAntigravityMilestone('thinking', 'requesting'), false)
  assert.equal(shouldAcceptAntigravityMilestone('thinking', 'retrying'), true)
  assert.equal(shouldAcceptAntigravityMilestone('sending', 'retrying'), true)
})

test('NativeLiveStatusTracker tracks full turn lifecycle across tools, thinking, responding, and clear', () => {
  let now = 1_700_000_000_000
  const tracker = new NativeLiveStatusTracker({ now: () => now })
  assert.deepEqual(tracker.snapshot('s1'), { active: false })

  tracker.start('s1', { harnessId: 'antigravity', phase: 'preparing', label: '正在准备会话…' })
  assert.equal(tracker.snapshot('s1').phase, 'preparing')

  now += 500
  tracker.observeNotification('s1', { method: 'turn/started', params: {} })
  assert.equal(tracker.snapshot('s1').phase, 'starting')

  tracker.start('s-codex', { harnessId: 'codex', phase: 'dispatching', label: '正在启动 Codex 并派发指令…' })
  tracker.observeNotification('s-codex', { method: 'turn/started', params: {} })
  assert.equal(tracker.snapshot('s-codex').phase, 'requesting')
  tracker.clear('s-codex')

  now += 1200
  tracker.observeNotification('s1', { method: 'item/reasoning/textDelta', params: { delta: '分析中' } })
  assert.equal(tracker.snapshot('s1').phase, 'thinking')

  now += 800
  tracker.observeNotification('s1', { method: 'item/started', params: { item: { id: 't1', type: 'toolExecution', toolName: 'read_file' } } })
  assert.equal(tracker.snapshot('s1').phase, 'tool')
  assert.match(tracker.snapshot('s1').label, /read_file/)

  now += 500
  tracker.observeNotification('s1', { method: 'item/started', params: { item: { id: 't2', type: 'commandExecution', command: 'dir' } } })
  assert.match(tracker.snapshot('s1').label, /2 个工具/)

  now += 500
  tracker.observeNotification('s1', { method: 'item/completed', params: { item: { id: 't1', type: 'toolExecution' } } })
  assert.equal(tracker.snapshot('s1').phase, 'tool')

  now += 500
  tracker.observeNotification('s1', { method: 'item/completed', params: { item: { id: 't2', type: 'commandExecution' } } })
  assert.equal(tracker.snapshot('s1').phase, 'thinking')

  now += 500
  tracker.observeNotification('s1', { method: 'item/agentMessage/delta', params: { delta: '好的' } })
  assert.equal(tracker.snapshot('s1').phase, 'responding')

  tracker.observeNotification('s1', { method: 'turn/completed', params: {} })
  assert.deepEqual(tracker.snapshot('s1'), { active: false })
})

test('createAntigravityStartupLogWatcher ignores pre-existing logs and tails newly created agy log file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-watch-'))
  fs.writeFileSync(path.join(dir, 'codexhost-antigravity-old.log'), 'I1128 streamGenerateContent?alt=sse\n')

  const milestones = []
  let activityCount = 0
  const watcher = createAntigravityStartupLogWatcher({
    tmpDir: dir,
    onMilestone: m => milestones.push(m),
    onActivity: () => { activityCount++ },
  })
  watcher.poll()
  assert.equal(milestones.length, 0)

  const fresh = path.join(dir, 'codexhost-antigravity-new.log')
  fs.writeFileSync(fresh, 'I1128 silent auth succeeded\nI1128 Starting MCP server dsh_collaboration\n')
  watcher.poll()
  assert.deepEqual(milestones.map(m => m.phase), ['auth', 'mcp'])
  assert.equal(activityCount, 1)

  fs.appendFileSync(fresh, 'I1128 POST streamGenerateContent?alt=sse\n')
  watcher.poll()
  assert.deepEqual(milestones.map(m => m.phase), ['auth', 'mcp', 'requesting'])
  assert.equal(activityCount, 2)
  watcher.stop()
})

test('remote contract liveStatus codec validates inactive and active payloads strictly', () => {
  const desc = nativeRemoteDescriptors.find(d => d.method === 'liveStatus')
  assert.ok(desc)
  const parse = desc.result.create().parse
  assert.deepEqual(parse({ active: false }), { active: false })
  assert.equal(parse({ active: true, harnessId: 'antigravity', phase: 'requesting', label: '已连接模型，等待首响应…' }).phase, 'requesting')
  assert.throws(() => parse({ active: 'yes' }))
  assert.throws(() => parse({ active: true, harnessId: 'unknown', phase: 'x', label: 'y' }))
})

test('client.js artifact exports NativeLiveStatusBar portal styling and registers liveStatus remote', () => {
  const built = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(built, /ch-live-status/)
  assert.match(built, /data-chat-running/)
  assert.match(built, /getLiveStatus/)
  assert.match(built, /liveStatus/)
})
