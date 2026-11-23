import { zodRequire } from './zod-resolver.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZERO_USAGE, observedUsage, turnUsage, acceptNativeTitle, foldHostModelIdentity, installObservationProjection } from '../native-observations.mjs'
import { nativeFilePath, installWorkspaceFilePaths } from '../workspace-file-paths.mjs'
import { createRequire } from 'node:module'

const threadEvent = (harnessId, modelId, threadId = 'thread') => ({ type: 'plugin:codexhost/thread', ignorable: true, data: { version: 1, harnessId, threadId, appliedConfiguration: { modelId } } })
const messageEvent = (harnessId, model) => ({ type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'codexhost/' + harnessId, model } } } })
for (const harness of ['codex', 'claude-code']) test(`${harness} model identity replays without any usage snapshot`, () => {
  const selected = harness === 'codex' ? 'gpt-selected' : 'claude-model-v1.c29ubmV0'
  const events = [threadEvent(harness, selected), messageEvent(harness, 'actual-model'), threadEvent(harness, selected)]
  const state = events.reduce(foldHostModelIdentity, null)
  assert.equal(state.model, 'actual-model')
  assert.equal(state.selectedModel, selected)
  assert.deepEqual(events.slice(1).reduce(foldHostModelIdentity, events.slice(0, 1).reduce(foldHostModelIdentity, null)), state)
  assert.equal(foldHostModelIdentity(state, { type: 'turn/end', data: {} }), state)
  assert.equal(foldHostModelIdentity(state, messageEvent('unrelated', 'wrong')), state)
  assert.equal(foldHostModelIdentity(state, threadEvent(harness, 'changed')).model, undefined)
  assert.equal(foldHostModelIdentity(state, threadEvent(harness, selected, 'different-thread')).model, undefined)
})
test('legacy Claude default observation does not erase an assistant model record', () => {
  const selected = 'claude-model-v1.ZGVmYXVsdA'
  const state = [threadEvent('claude-code', selected), messageEvent('claude-code', 'claude-reported')].reduce(foldHostModelIdentity, null)
  assert.equal(foldHostModelIdentity(state, {type: 'plugin:codexhost/observation-v2', ignorable: true, data: {harnessId: 'claude-code', threadId: 'thread', model: selected}}), state)
})
test('model identity stays separate while usage snapshots retain their recorded sequence', async () => {
  const {z} = zodRequire(import.meta.url)('zod'), definitions = []
  const usage = await installObservationProjection({loader: {import: async () => ({z})}, sessionProjections: {register: async definition => {definitions.push(definition); return definition}}})
  assert.equal(usage.key, 'codexHostObservation')
  assert.equal(usage.stateVersion, 3)
  const observation = { threadId: 'thread', harnessId: 'codex', model: 'gpt-test', observedAt: 100, usage: { totalCostUsd: .1 }, cost: { source: 'publicPrice' } }
  const observed = usage.apply(usage.init(), { type: 'plugin:codexhost/observation-v2', ignorable: true, seq: 17, data: observation })
  assert.equal(observed.recordedSeq, 17)
  assert.deepEqual(usage.stateSchema.parse(observed), { ...observation, recordedSeq: 17 })
  const identity = definitions.find(definition => definition.key === 'codexHostModelIdentity')
  const state = identity.apply(identity.init(), threadEvent('codex', 'gpt-selected'))
  assert.deepEqual(identity.stateSchema.parse(state), state)
  assert.deepEqual(identity.wire.viewSchema.parse(identity.wire.view(state)), state)
})

test('Host usage becomes disjoint DSH billing without counting cached input twice', () => {
  const after = { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 1050 }
  assert.deepEqual(turnUsage(ZERO_USAGE, after), { inputTokens: 300, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 50, reasoningTokens: 10, totalTokens: 1050 })
  assert.deepEqual(turnUsage(after, { ...after, inputTokens: 1400, cachedInputTokens: 900, outputTokens: 70, totalTokens: 1470 }), { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 420 })
  assert.equal(turnUsage(undefined, after), undefined)
  assert.equal(turnUsage(after, ZERO_USAGE), undefined)
  assert.equal(turnUsage(ZERO_USAGE, { ...after, totalTokens: 0 }), undefined)
  assert.equal(turnUsage(ZERO_USAGE, { ...after, cachedInputTokens: undefined }), undefined)
  assert.deepEqual(observedUsage({ inputTokens: -1, totalCostUsd: 2 }), { totalCostUsd: 2 })
})

test('Native title events replace fallback names but never override user names', () => {
  const events = [{ type: 'user/message', seq: 2, data: { source: { kind: 'user' } } }, { type: 'session/title', data: { title: 'first prompt', source: { kind: 'fallback' } } }]
  const session = { append(type, data) { events.push({ type, data }) } }
  assert.equal(acceptNativeTitle(session, null), false)
  assert.equal(acceptNativeTitle(session, '原生摘要标题', { ...events.at(-1).data, messageSeqs: [2] }), true)
  assert.equal(events.at(-1).data.title, '原生摘要标题')
  assert.deepEqual(events.at(-1).data.messageSeqs, [2])
  assert.equal(acceptNativeTitle(session, '原生摘要标题', events.at(-1).data), false)
  events.push({ type: 'session/title', data: { title: 'My name', source: { kind: 'user' } } })
  assert.equal(acceptNativeTitle(session, 'A different native name', events.at(-1).data), false)
})

test('Windows Markdown paths use the existing file service with reversible adaptation', () => {
  assert.equal(nativeFilePath('D:/workspace', '/D:/workspace/a.html'), 'D:/workspace/a.html')
  assert.equal(nativeFilePath('/workspace', '/D:/workspace/a.html'), '/D:/workspace/a.html')
  assert.equal(nativeFilePath('D:/workspace', '//server/share/a'), '//server/share/a')
  const calls = [], releases = []
  class Files { stat(scope, path, signal) { calls.push({ scope, path, signal }); return 'native-result' } }
  for (const name of ['read', 'readBytes', 'list', 'changes']) Files.prototype[name] = Files.prototype.stat
  const files = new Files()
  installWorkspaceFilePaths({ inject(_keys, callback) { callback({ workspaceFiles: files, effect(callback) { releases.push(callback()) } }) } })
  const scope = { workspaceRoot: 'D:/workspace', sessionId: 'session' }, signal = new AbortController().signal
  assert.equal(files.stat(scope, '/D:/workspace/a.html', signal), 'native-result')
  assert.deepEqual(calls[0], { scope, path: 'D:/workspace/a.html', signal })
  releases[0]()
  assert.equal(Object.hasOwn(files, 'stat'), false)
})
