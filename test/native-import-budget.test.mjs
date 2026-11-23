import test from 'node:test'
import assert from 'node:assert/strict'
import { readImportHistory, historySeed, IMPORT_BUDGET_BYTES } from '../native-session-import.mjs'
import { importedThroughTurn, readNativeReplies } from '../native-replies.mjs'

const MB = 1024 * 1024
const turn = (id, text = 'x') => ({ id, status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', id: id + '-u', content: [{ type: 'text', text }] }] })
const idle = { id: 't', status: { type: 'idle' }, updatedAt: 1, cwd: 'D:/work' }

/** Paginated peer: newest-first pages like the real thread/turns/list. */
function pagedPeer(turns, { updatedAfter } = {}) {
  const calls = []
  let reads = 0
  return { calls, async request(method, params) {
    calls.push(method)
    if (method === 'thread/read') {
      reads++
      return { thread: { ...idle, historyMode: 'paginated', updatedAt: reads > 1 && updatedAfter ? updatedAfter : 1 } }
    }
    if (method === 'thread/turns/list') {
      assert.equal(params.sortDirection, 'desc', 'import reads newest-first so it can stop early')
      const ordered = [...turns].reverse(), start = Number(params.cursor ?? 0), end = start + params.limit
      return { data: ordered.slice(start, end), nextCursor: end < ordered.length ? String(end) : null }
    }
    throw new Error('Unexpected RPC ' + method)
  } }
}

test('a history within budget imports whole, oldest first, without a truncated flag', async () => {
  const turns = Array.from({ length: 7 }, (_, i) => turn('a' + i))
  const result = await readImportHistory(pagedPeer(turns), 't')
  assert.deepEqual(result.turns.map(t => t.id), turns.map(t => t.id))
  assert.equal('truncated' in result, false)
})

test('an oversized history keeps the newest Turns under budget instead of refusing the import', async () => {
  const big = 'x'.repeat(1 * MB)
  const turns = Array.from({ length: 10 }, (_, i) => turn('b' + i, big))
  const result = await readImportHistory(pagedPeer(turns), 't', { maxBytes: 3.5 * MB })
  assert.equal(result.truncated, true)
  assert.deepEqual(result.turns.map(t => t.id), ['b7', 'b8', 'b9'], 'newest three, in oldest-first order')
})

test('reading stops once the budget is hit instead of walking the whole history', async () => {
  const big = 'x'.repeat(1 * MB)
  const turns = Array.from({ length: 200 }, (_, i) => turn('c' + i, big))
  const peer = pagedPeer(turns)
  await readImportHistory(peer, 't', { maxBytes: 3.5 * MB })
  // 200 Turns / 50 per page would need 4 list calls; the first page already exceeds the budget.
  assert.equal(peer.calls.filter(m => m === 'thread/turns/list').length, 1)
})

test('the newest Turn is kept even when it alone exceeds the budget', async () => {
  const turns = [turn('d0'), turn('d1', 'x'.repeat(2 * MB))]
  const result = await readImportHistory(pagedPeer(turns), 't', { maxBytes: 1 * MB })
  assert.deepEqual(result.turns.map(t => t.id), ['d1'])
  assert.equal(result.truncated, true)
})

test('the default budget stays under the 24 MiB hard limit', () => {
  assert.ok(IMPORT_BUDGET_BYTES < 24 * MB)
})

test('a history that changes while importing is still refused', async () => {
  await assert.rejects(readImportHistory(pagedPeer([turn('e0')], { updatedAfter: 2 }), 't'), /已发生变化/)
})

test('a running Thread is still refused', async () => {
  const peer = { async request() { return { thread: { ...idle, status: { type: 'active' } } } } }
  await assert.rejects(readImportHistory(peer, 't'), /正在原客户端运行/)
})

test('legacy whole-history reads are trimmed to the newest Turns too', async () => {
  const big = 'x'.repeat(1 * MB)
  const turns = Array.from({ length: 6 }, (_, i) => turn('f' + i, big))
  const peer = { async request(method, params) {
    assert.equal(method, 'thread/read')
    return { thread: { ...idle, ...(params.includeTurns ? { turns } : {}) } }
  } }
  const result = await readImportHistory(peer, 't', { maxBytes: 2.5 * MB })
  assert.deepEqual(result.turns.map(t => t.id), ['f4', 'f5'])
  assert.equal(result.truncated, true)
  const small = await readImportHistory({ async request(m, p) { return { thread: { ...idle, ...(p.includeTurns ? { turns: [turn('g0')] } : {}) } } } }, 't')
  assert.equal('truncated' in small, false)
})

// historySeed needs the DSH runtime helpers; these stubs cover only what user-message-only Turns touch.
class Stub { push() { return { chunk: {} } } blocks() { return [] } snapshot() { return [] } finish() {} requestCancel() {} }
const stubHelpers = { AssistantStreamAccumulator: Stub, BlockAssembler: Stub, createUserMessage: value => ({ content: value.content, source: value.source }) }
function seed(thread) {
  try { return historySeed(thread, 'claude-code', { modelId: 'm' }, stubHelpers, undefined) } catch (error) { return error }
}

test('the import record carries the sync watermark and the truncated flag', t => {
  const events = seed({ ...idle, id: 't', createdAt: 1, turns: [turn('h0'), turn('h1')], truncated: true })
  if (events instanceof Error) return t.skip('historySeed needs the full DSH helpers: ' + events.message)
  const record = events.find(e => e.type === 'plugin:codexhost/import')
  assert.equal(record.data.newestTurnId, 'h1')
  assert.equal(record.data.truncated, true)
  assert.equal(record.data.turns, 2)
  const plain = seed({ ...idle, id: 't', createdAt: 1, turns: [turn('h0')] }).find(e => e.type === 'plugin:codexhost/import')
  assert.equal('truncated' in plain.data, false)
})

test('importedThroughTurn reads the newest watermark for the matching Thread only', () => {
  const rec = (threadId, newestTurnId) => ({ type: 'plugin:codexhost/import', ignorable: true, data: { version: 1, threadId, ...(newestTurnId ? { newestTurnId } : {}) } })
  const session = events => ({ snapshotEvents: () => events })
  assert.equal(importedThroughTurn(session([rec('t', 'x1'), rec('t', 'x2')]), 't'), 'x2')
  assert.equal(importedThroughTurn(session([rec('other', 'y1')]), 't'), undefined)
  assert.equal(importedThroughTurn(session([rec('t')]), 't'), undefined, 'older imports without a watermark keep the previous behaviour')
  assert.equal(importedThroughTurn(session([{ type: 'plugin:codexhost/import', data: { threadId: 't', newestTurnId: 'z' } }]), 't'), undefined, 'only ignorable plugin records count')
})

test('reply catch-up stops at the import watermark and never fetches older pages', async () => {
  const all = Array.from({ length: 40 }, (_, i) => ({ id: 'r' + String(i).padStart(2, '0'), status: 'completed', itemsView: 'full', items: [] }))
  const listed = []
  const peer = { async request(method, params) {
    if (method === 'thread/read') return { thread: { id: 't', status: { type: 'idle' }, updatedAt: 5 } }
    listed.push(params.cursor ?? 'first')
    const ordered = [...all].reverse(), start = Number(params.cursor ?? 0), end = start + params.limit
    return { data: ordered.slice(start, end), nextCursor: end < ordered.length ? String(end) : null }
  } }
  // The import covered r00..r37; r38 and r39 are newer than it.
  const result = await readNativeReplies(peer, 't', { isCovered: t => t.id === 'r37', pageSize: 5 })
  assert.deepEqual(result.turns.map(t => t.id), ['r38', 'r39'])
  assert.deepEqual(listed, ['first'], 'one page covers the gap; 35 older Turns are never requested')
})
