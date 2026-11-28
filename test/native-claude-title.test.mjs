import test from 'node:test'
import assert from 'node:assert/strict'
import { completeNativeClaudeTitle } from '../native-claude-title.mjs'

const GENERATE = 'dsh/claude/title/generate'
const CANCEL = 'dsh/claude/title/cancel'
const TITLE = 'session/title'
const AUDIT = 'plugin:dsh-host/native-title'
const policy = { enabled: true, maxInputBytes: 16000, timeoutMs: 15000, maxOutputTokens: 512, model: 'claude-haiku-5-5', maxCostUsd: 0.05 }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(overrides = {}) {
  const events = [], calls = [], flushes = [], warnings = []
  let current = { title: '原始首句', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { id: 'local-title-test', header: { cwd: 'D:/fixture' }, append(type, data, options) {
    events.push({ type, data, options })
    if (type === TITLE) current = { ...data, eventSeq: events.length + 4 }
    return events.length + 4
  } }
  const persistence = { async flush(...args) { flushes.push(args) } }
  const service = { get: () => current }
  const ctx = { sessionPersistence: persistence, logger: { warn: (...args) => warnings.push(args) },
    get(key) {
      if (key === 'sessionTitle') return service
      if (key === 'sessionPersistence') return persistence
      throw new Error(`Unexpected service access: ${key}; native titles must not use the DSH LLM`)
    }, loader: { async import(name) {
      assert.equal(name, '@deepseek-ai/dsh-session', 'native titles may import only the formal session audit helper, never a DSH LLM')
      return { appendPluginRecord(targetSession, type, data) {
        assert.equal(targetSession, session)
        assert.equal(type, AUDIT)
        events.push({ type, data, ignorable: true })
        return events.length + 4
      } }
    } } }
  const peer = { async request(method, params) {
    calls.push({ method, params })
    assert.ok([GENERATE, CANCEL, 'thread/name/set'].includes(method), `Unexpected RPC: ${method}`)
    if (overrides.request) return overrides.request(method, params)
    if (method === GENERATE) return { title: '依赖与导入修复', detached: true, cachePolicy: 'disabled-client' }
    return {}
  } }
  const agent = { id: session.id, session, model: { current() { throw new Error('Must not select a DSH model') } } }
  const mapping = { threadId: 'claude-thread-title-test', harnessId: 'claude-code', phase: 'ready', sessionId: session.id }
  const firstMessage = { seq: 2, text: '检查项目依赖与修复会话导入' }
  const controller = new AbortController()
  return { events, calls, flushes, warnings, ctx, peer, agent, mapping, firstMessage, controller,
    setCurrent(value) { current = value }, getCurrent: () => current,
    run(extraPolicy = {}, message = firstMessage) { return completeNativeClaudeTitle(ctx, agent, peer, mapping, message, controller.signal, { ...policy, ...extraPolicy }) } }
}
const formalTitles = f => f.events.filter(event => event.type === TITLE)

test('native Claude title uses one detached RPC, persists DSH title and synchronizes Host without a DSH model call', async () => {
  const f = fixture()
  assert.equal(await f.run(), true)
  const generated = f.calls.filter(call => call.method === GENERATE)
  assert.equal(generated.length, 1)
  assert.deepEqual(Object.keys(generated[0].params).sort(), ['threadId', 'operationId', 'description', 'model', 'maxOutputTokens', 'timeoutMs', 'maxCostUsd'].sort())
  assert.equal(generated[0].params.threadId, f.mapping.threadId)
  assert.equal(generated[0].params.model, policy.model)
  assert.equal(generated[0].params.maxOutputTokens, 512)
  assert.equal(generated[0].params.timeoutMs, policy.timeoutMs)
  assert.equal(generated[0].params.maxCostUsd, policy.maxCostUsd)
  assert.equal(typeof generated[0].params.operationId, 'string')
  assert.ok(generated[0].params.operationId.length > 0)
  assert.ok(generated[0].params.description.includes(f.firstMessage.text))
  assert.equal(formalTitles(f).length, 1)
  assert.equal(formalTitles(f)[0].data.title, '依赖与导入修复')
  assert.equal(formalTitles(f)[0].data.source.kind, 'provider')
  assert.equal(formalTitles(f)[0].data.source.provider, 'dsh-host-native-title')
  assert.deepEqual(formalTitles(f)[0].data.messageSeqs, [2])
  assert.ok(f.flushes.length >= 1)
  assert.deepEqual(f.calls.find(call => call.method === 'thread/name/set').params, { threadId: f.mapping.threadId, name: '依赖与导入修复' })
  const audit = f.events.filter(event => event.type === AUDIT)
  assert.ok(audit.length >= 2, 'request and result must remain auditable')
  assert.ok(audit.every(event => event.ignorable === true), 'audit must use the formal plugin record helper')
  assert.ok(JSON.stringify(audit).includes(f.firstMessage.text), 'audit retains reproducible source input')
})

for (const kind of ['provider', 'user']) test(`existing ${kind} title is preserved without RPC or audit writes`, async () => {
  const f = fixture()
  f.setCurrent({ ...f.getCurrent(), source: { kind } })
  assert.equal(await f.run(), false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.events.length, 0)
})

test('disabled policy and empty input do not start title generation', async () => {
  const f = fixture()
  assert.equal(await f.run({ enabled: false }), false)
  assert.equal(await f.run({}, { seq: 2, text: '  \n\t ' }), false)
  assert.equal(f.calls.length, 0)
  assert.equal(formalTitles(f).length, 0)
})

test('manual rename while native request is pending wins over generated title', async () => {
  const entered = deferred(), response = deferred()
  const f = fixture({ request(method) { if (method === GENERATE) { entered.resolve(); return response.promise } return {} } })
  const task = f.run()
  await entered.promise
  f.setCurrent({ title: '用户手动标题', eventSeq: 10, source: { kind: 'user' }, messageSeqs: [] })
  response.resolve({ title: '迟到标题', detached: true, cachePolicy: 'disabled-client' })
  assert.equal(await task, false)
  assert.equal(formalTitles(f).length, 0)
  assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 0)
})

test('changed fallback event sequence also rejects stale generation', async () => {
  const entered = deferred(), response = deferred()
  const f = fixture({ request(method) { if (method === GENERATE) { entered.resolve(); return response.promise } return {} } })
  const task = f.run()
  await entered.promise
  f.setCurrent({ ...f.getCurrent(), eventSeq: 12 })
  response.resolve({ title: '过时标题', detached: true, cachePolicy: 'disabled-client' })
  assert.equal(await task, false)
  assert.equal(formalTitles(f).length, 0)
})

test('description respects UTF-8 byte budget without broken multibyte characters', async () => {
  const f = fixture()
  await f.run({ maxInputBytes: 23 }, { seq: 2, text: '检查😀项目依赖与修复会话导入'.repeat(50) })
  const description = f.calls.find(call => call.method === GENERATE).params.description
  assert.ok(Buffer.byteLength(description, 'utf8') <= 23)
  assert.ok(description.length > 0)
  assert.ok(!description.includes('\uFFFD'))
  assert.equal(Buffer.from(description, 'utf8').toString('utf8'), description)
})

test('aborting a pending title cancels the exact operation and never commits late result', async () => {
  const entered = deferred(), response = deferred()
  const f = fixture({ request(method) { if (method === GENERATE) { entered.resolve(); return response.promise } return {} } })
  const task = f.run()
  await entered.promise
  f.controller.abort(new Error('fixture abort'))
  response.resolve({ title: '取消后迟到标题', detached: true, cachePolicy: 'disabled-client' })
  await task.catch(error => { assert.match(String(error), /abort|cancel/i) })
  const generated = f.calls.find(call => call.method === GENERATE)
  const cancelled = f.calls.filter(call => call.method === CANCEL)
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].params.operationId, generated.params.operationId)
  assert.equal(cancelled[0].params.threadId, generated.params.threadId)
  assert.equal(formalTitles(f).length, 0)
  assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 0)
})

test('pre-aborted signal starts no native model request', async () => {
  const f = fixture()
  f.controller.abort()
  await f.run().catch(error => { assert.match(String(error), /abort|cancel/i) })
  assert.equal(f.calls.filter(call => call.method === GENERATE).length, 0)
  assert.equal(formalTitles(f).length, 0)
})

test('native error propagates with fallback intact and without retry or DSH fallback', async () => {
  const failure = new Error('fixture native failure')
  const f = fixture({ request(method) { if (method === GENERATE) throw failure; return {} } })
  await assert.rejects(f.run(), error => error === failure)
  assert.equal(f.getCurrent().source.kind, 'fallback')
  assert.equal(formalTitles(f).length, 0)
  assert.equal(f.calls.filter(call => call.method === GENERATE).length, 1)
  assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 0)
  assert.ok(f.events.some(event => event.type === AUDIT && event.data.phase === 'result' && event.data.status === 'failed'))
})

test('unverified detachment or cache policy and blank native titles never become formal titles', async () => {
  for (const result of [
    { title: '不隔离', detached: false, cachePolicy: 'disabled-client' },
    { title: '缓存策略未知', detached: true, cachePolicy: 'unknown' },
    { title: '   ', detached: true, cachePolicy: 'disabled-client' },
  ]) {
    const f = fixture({ request(method) { if (method === GENERATE) return result; return {} } })
    await assert.rejects(f.run())
    assert.equal(formalTitles(f).length, 0)
    assert.equal(f.calls.filter(call => call.method === GENERATE).length, 1)
    assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 0)
  }
})

test('Host name synchronization failure does not lose committed DSH title or retry generation', async () => {
  const f = fixture({ request(method) {
    if (method === GENERATE) return { title: 'DSH保留的标题', detached: true, cachePolicy: 'disabled-client' }
    if (method === 'thread/name/set') throw new Error('fixture Host name synchronization failure')
    return {}
  } })
  assert.equal(await f.run(), true)
  assert.equal(formalTitles(f).length, 1)
  assert.equal(formalTitles(f)[0].data.title, 'DSH保留的标题')
  assert.ok(f.flushes.length >= 1)
  assert.equal(f.calls.filter(call => call.method === GENERATE).length, 1)
  assert.equal(f.calls.filter(call => call.method === 'thread/name/set').length, 1)
  assert.ok(f.warnings.length >= 1)
})
