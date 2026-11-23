import test from 'node:test'
import assert from 'node:assert/strict'
import { completeExternalTitle } from '../native-title.mjs'

test('Missing native titles use the existing DSH auxiliary caller and keep manual/native changes', async () => {
  const calls = [], events = []
  let current = { title: 'raw first prompt', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { append(type, data) { events.push({ type, data }) } }
  const service = { get: () => current }
  let duringCall = () => {}
  const ctx = { get: key => key === 'sessionTitle' ? service : {}, loader: { async import(name) {
    if (name === '@deepseek-ai/dsh-session-title-llm') return { async executeSessionTitleLlm(...args) {
      calls.push(args); duringCall(); return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '文件预览验证' }], model: { provider: 'configured', model: 'title-model' } }
    } }
    if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
    throw new Error(name)
  } } }
  const agent = { session, model: { current: () => ({ provider: 'configured', model: 'title-model' }) } }
  const policy = { enabled: true, maxInputBytes: 16000, maxOutputTokens: 128, timeoutMs: 15000 }
  await completeExternalTitle(ctx, agent, { seq: 2, text: '原始问题' }, new AbortController().signal, policy)
  assert.equal(events.length, 1)
  assert.equal(events[0].data.title, '文件预览验证')
  assert.equal(calls[0][1].provider, 'configured')
  assert.deepEqual(calls[0][4].messageSeqs, [2])
  current = { ...current, source: { kind: 'provider', provider: 'codexhost-native-title' } }
  await completeExternalTitle(ctx, agent, { seq: 2, text: 'x' }, new AbortController().signal, policy)
  assert.equal(calls.length, 1)
  current = { ...current, source: { kind: 'fallback' } }
  duringCall = () => { current = { ...current, eventSeq: 8, source: { kind: 'user' } } }
  await completeExternalTitle(ctx, agent, { seq: 2, text: 'x' }, new AbortController().signal, policy)
  assert.equal(events.length, 1)
})
