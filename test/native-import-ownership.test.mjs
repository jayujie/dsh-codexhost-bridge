import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionImporter, readThreadOwnership } from '../native-session-import.mjs'

// Pure in-memory peers: no Host process, credentials, model turn, filesystem or persisted session.
const ownershipMethod = 'codexhost/thread/ownership/list'
const codex = threadId => ({ threadId, owner: 'codex' })
const external = (threadId, harnessId = 'claude-code') => ({ threadId, owner: 'external', harnessId })
const ids = count => Array.from({ length: count }, (_, i) => `thread-${i}`)
const peerFor = response => {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params })
      assert.equal(method, ownershipMethod)
      return typeof response === 'function' ? response(params, calls.length) : response
    },
  }
}

test('ownership lookup reproduces 53 listed rows / 37 unique IDs without an invalid duplicate request', async () => {
  const unique = ids(37)
  const requested = [...unique, ...unique.slice(0, 16)]
  assert.equal(requested.length, 53)
  const peer = peerFor(({ threadIds }) => {
    assert.equal(new Set(threadIds).size, threadIds.length, 'Host rejects duplicate IDs with -32602')
    return { threads: threadIds.map(codex) }
  })
  const result = await readThreadOwnership(peer, requested)
  assert.deepEqual(peer.calls, [{ method: ownershipMethod, params: { threadIds: unique } }])
  assert.deepEqual(result, unique.map(codex))
})

test('ownership lookup deduplicates stably before batching 201 unique IDs into 100/100/1', async () => {
  const unique = ids(201)
  const peer = peerFor(({ threadIds }) => {
    assert.ok(threadIds.length >= 1 && threadIds.length <= 100)
    return { threads: threadIds.map(codex) }
  })
  const result = await readThreadOwnership(peer, [...unique, ...unique.slice(0, 25)])
  assert.deepEqual(peer.calls.map(call => call.params.threadIds), [unique.slice(0, 100), unique.slice(100, 200), unique.slice(200)])
  assert.deepEqual(result, unique.map(codex))
})

test('ownership lookup makes no RPC for an empty array', async () => {
  const peer = peerFor(() => { throw new Error('empty lookup must not reach Host') })
  assert.deepEqual(await readThreadOwnership(peer, []), [])
  assert.equal(peer.calls.length, 0)
})

for (const [label, value] of [
  ['missing input', undefined], ['null input', null], ['string input', 'thread-a'],
  ['object input', {}], ['missing ID', [undefined]], ['null ID', [null]],
  ['numeric ID', [42]], ['object ID', [{}]], ['empty ID', ['']],
  ['whitespace ID', [' \t\r\n']], ['overlong ID', ['a'.repeat(257)]],
  ['invalid ID after a full valid batch', [...ids(100), '']],
]) {
  test(`ownership lookup refuses ${label} before any RPC`, async () => {
    const peer = peerFor(({ threadIds }) => ({ threads: threadIds.map(codex) }))
    await assert.rejects(async () => readThreadOwnership(peer, value))
    assert.equal(peer.calls.length, 0)
  })
}

test('ownership lookup accepts the 256-character ID boundary without rewriting identity', async () => {
  const id = 'a'.repeat(256)
  const peer = peerFor(({ threadIds }) => ({ threads: threadIds.map(codex) }))
  assert.deepEqual(await readThreadOwnership(peer, [id]), [codex(id)])
  assert.deepEqual(peer.calls[0].params, { threadIds: [id] })
})

for (const [label, response] of [
  ['null result', null], ['missing threads', {}], ['non-array threads', { threads: {} }],
  ['missing requested row', { threads: [codex('a')] }],
  ['empty result', { threads: [] }],
  ['duplicate result', { threads: [codex('a'), codex('a')] }],
  ['unrequested result', { threads: [codex('a'), codex('other')] }],
  ['extra result', { threads: [codex('a'), codex('b'), codex('other')] }],
  ['unknown owner', { threads: [codex('a'), { threadId: 'b', owner: 'mystery' }] }],
  ['null row', { threads: [codex('a'), null] }],
  ['missing external harness', { threads: [codex('a'), { threadId: 'b', owner: 'external' }] }],
  ['blank external harness', { threads: [codex('a'), external('b', ' ')] }],
  ['non-string external harness', { threads: [codex('a'), external('b', 12)] }],
]) {
  test(`ownership lookup refuses ${label}`, async () => {
    await assert.rejects(async () => readThreadOwnership(peerFor(response), ['a', 'b']))
  })
}

test('ownership lookup matches results by exact thread identity, not array position', async () => {
  const peer = peerFor({ threads: [external('b'), codex('a')] })
  const result = await readThreadOwnership(peer, ['a', 'b'])
  assert.deepEqual(new Map(result.map(row => [row.threadId, row])), new Map([['a', codex('a')], ['b', external('b')]]))
})

test('ownership lookup propagates RPC errors instead of defaulting to codex', async () => {
  const error = Object.assign(new Error('Thread ownership metadata could not be read'), { code: -32081 })
  const peer = peerFor(() => { throw error })
  await assert.rejects(readThreadOwnership(peer, ['a']), caught => caught === error)
})

test('ownership lookup rejects a later batch that returns an ID from an earlier batch', async () => {
  const peer = peerFor(({ threadIds }, call) => ({ threads: call === 1 ? threadIds.map(codex) : [codex('thread-0')] }))
  await assert.rejects(readThreadOwnership(peer, ids(101)))
  assert.equal(peer.calls.length, 2)
})

function listPeer(page, owners, native = { candidates: [], total: 0 }) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params })
      if (method === 'thread/list') return page
      if (method === 'codexhost/harness/session-import/list') return native
      if (method === ownershipMethod) return { threads: params.threadIds.map(id => owners.get(id)) }
      throw new Error(`Unexpected RPC: ${method}`)
    },
  }
}
const row = (id, title = id) => ({ id, name: title, cwd: 'D:\\work', updatedAt: 1, status: { type: 'idle' } })

test('import list deduplicates 53 rows to 37, preserves the first row and filters engines by ownership', async () => {
  const unique = ids(37)
  const rows = [...unique.map(id => row(id, `first-${id}`)), ...unique.slice(0, 16).map(id => row(id, `duplicate-${id}`))]
  const owners = new Map(unique.map((id, index) => [id, index % 2 === 0 ? codex(id) : external(id)]))
  const peer = listPeer({ data: rows, nextCursor: 'page-2' }, owners)
  const result = await new NativeSessionImporter({}, null, {}).list(peer, { harnessId: 'codex' })
  assert.deepEqual(peer.calls.find(call => call.method === ownershipMethod).params.threadIds, unique)
  assert.deepEqual(result.rows.map(value => value.id), unique.filter((_, index) => index % 2 === 0))
  assert.ok(result.rows.every(value => value.title === `first-${value.id}`))
  assert.equal(result.nextCursor, 'page-2')
  assert.equal(result.nextOffset, null)
  assert.equal(result.nativeTotal, 0)
})

test('empty thread page preserves its next cursor without issuing an ownership lookup', async () => {
  const peer = listPeer({ data: [], nextCursor: 'page-after-empty' }, new Map())
  const result = await new NativeSessionImporter({}, null, {}).list(peer, { harnessId: 'codex', cursor: 'page-before-empty' })
  assert.deepEqual(result.rows, [])
  assert.equal(result.nextCursor, 'page-after-empty')
  assert.deepEqual(peer.calls.map(call => call.method), ['thread/list'])
  assert.equal(peer.calls[0].params.cursor, 'page-before-empty')
})

test('Claude list filters codex and other harnesses while preserving native pagination', async () => {
  const owners = new Map([['c', codex('c')], ['cl', external('cl')], ['pi', external('pi', 'pi')]])
  const peer = listPeer({ data: [row('c'), row('cl'), row('pi')], nextCursor: 'threads-next' }, owners, {
    candidates: [{ nativeSessionId: 'native-a', title: 'Native A', cwd: 'D:\\work', updatedAt: 1700000000000 }], total: 61,
  })
  const result = await new NativeSessionImporter({}, null, {}).list(peer, { harnessId: 'claude-code', query: ' needle ', cursor: 'threads-current', offset: 20 })
  assert.deepEqual(result.rows.map(value => [value.kind, value.id]), [['thread', 'cl'], ['native', 'native-a']])
  assert.equal(result.rows[1].updatedAt, 1700000000)
  assert.equal(result.nextCursor, 'threads-next')
  assert.equal(result.nextOffset, 40)
  assert.equal(result.nativeTotal, 61)
  assert.equal(peer.calls.find(call => call.method === 'thread/list').params.searchTerm, 'needle')
  assert.equal(peer.calls.find(call => call.method === 'codexhost/harness/session-import/list').params.offset, 20)
})

test('end sentinel skips thread/list and ownership while native pages continue', async () => {
  const peer = listPeer(null, new Map(), { candidates: [], total: 61 })
  const result = await new NativeSessionImporter({}, null, {}).list(peer, { harnessId: 'claude-code', cursor: 'end', offset: 40 })
  assert.deepEqual(peer.calls.map(call => call.method), ['codexhost/harness/session-import/list'])
  assert.equal(result.nextCursor, null)
  assert.equal(result.nextOffset, 60)
})

test('import list does not turn an ownership RPC error into an empty page', async () => {
  const error = new Error('ownership unavailable')
  const peer = { async request(method) {
    if (method === 'thread/list') return { data: [row('a')], nextCursor: null }
    throw error
  } }
  await assert.rejects(new NativeSessionImporter({}, null, {}).list(peer, { harnessId: 'codex' }), caught => caught === error)
})

for (const [label, response] of [
  ['wrong thread ID', { threads: [codex('other-thread')] }],
  ['missing ownership', { threads: [] }],
  ['duplicate ownership', { threads: [codex('target'), codex('target')] }],
  ['unknown owner', { threads: [{ threadId: 'target', owner: 'unknown' }] }],
]) {
  test(`singleton import refuses ${label} before history or persistence access`, async () => {
    const calls = []
    const peer = { async request(method, params) { calls.push({ method, params }); assert.equal(method, ownershipMethod); return response } }
    await assert.rejects(new NativeSessionImporter({}, null, {}).import(peer, {
      harnessId: 'codex', kind: 'thread', id: 'target', acknowledgeIdle: true,
    }))
    assert.deepEqual(calls, [{ method: ownershipMethod, params: { threadIds: ['target'] } }])
  })
}

test('singleton import refuses the wrong engine even when thread identity is correct', async () => {
  const peer = peerFor({ threads: [external('target')] })
  await assert.rejects(new NativeSessionImporter({}, null, {}).import(peer, {
    harnessId: 'codex', kind: 'thread', id: 'target', acknowledgeIdle: true,
  }), /不属于/)
  assert.equal(peer.calls.length, 1)
})

test('singleton import accepts a matching Claude owner and only then reads the exact target history', async () => {
  const reachedHistory = new Error('history boundary reached; no real history is read')
  const calls = []
  const peer = { async request(method, params) {
    calls.push({ method, params })
    if (method === ownershipMethod) return { threads: [external('target')] }
    assert.equal(method, 'thread/read')
    assert.equal(params.threadId, 'target')
    throw reachedHistory
  } }
  await assert.rejects(new NativeSessionImporter({}, null, {}).import(peer, {
    harnessId: 'claude-code', kind: 'thread', id: 'target', acknowledgeIdle: true,
  }), caught => caught === reachedHistory)
  assert.deepEqual(calls.map(call => call.method), [ownershipMethod, 'thread/read'])
})

test('import list resolves real DSH titles for unnamed Codex threads and trims oversized raw previews', async () => {
  const longPrompt = '你是 TMC 项目团队新建的执行者 **executor-sol**\n' + '很长的系统提示词说明内容'.repeat(40)
  const owners = new Map([['t-dsh', codex('t-dsh')], ['t-raw', codex('t-raw')]])
  const peer = listPeer({
    data: [
      { id: 't-dsh', name: null, preview: longPrompt, cwd: '\\\\?\\D:\\Desktop\\TMC', updatedAt: 2, status: { type: 'idle' } },
      { id: 't-raw', name: null, preview: longPrompt, cwd: 'D:\\Desktop\\TMC', updatedAt: 1, status: { type: 'idle' } },
    ],
    nextCursor: null,
  }, owners)
  const ctx = {
    agents: { list: () => [] },
    sessionPersistence: {
      async list() { return [{ header: { id: 'session-hosttask-1', cwd: 'D:\\Desktop\\TMC' }, revision: 'rev-1' }] },
      async open() {
        return {
          async read() {
            return {
              events: [
                { type: 'plugin:dsh-host/thread', ignorable: true, data: { version: 1, phase: 'ready', harnessId: 'codex', threadId: 't-dsh', sessionId: 'session-hosttask-1' } },
                { type: 'session/title', data: { title: 'TMC·长期实验实现与仿真（executor-sol）', source: { kind: 'user' } } },
              ],
            }
          },
          async close() {},
        }
      },
    },
  }
  const result = await new NativeSessionImporter(ctx, null, {}).list(peer, { harnessId: 'codex' })
  assert.equal(result.rows[0].title, 'TMC·长期实验实现与仿真（executor-sol）')
  assert.ok(result.rows[1].title.length <= 121 && result.rows[1].title.endsWith('…'))
  assert.doesNotMatch(result.rows[1].title, /\r|\n/)
})
