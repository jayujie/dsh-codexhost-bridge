import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionImporter, importSessionId } from '../native-session-import.mjs'
const threadId = 'native-thread', harnessId = 'claude-code', cwd = 'D:/work'
function fixture(rows, { canonical, io, live = [] } = {}) {
  const attached = [], created = []
  const peers = { async request(method) {
    if (method === 'codexhost/thread/ownership/list') return { threads: [{ threadId, owner: 'external', harnessId }] }
    if (method === 'thread/read') return { thread: { id: threadId, cwd, status: { type: 'idle' }, updatedAt: 1, turns: [] } }
    throw new Error('Unexpected RPC ' + method)
  } }
  const records = new Map(rows.map(row => [row.id, row])), candidateId = importSessionId(harnessId, threadId)
  if (canonical) records.set(candidateId, { id: candidateId, ...canonical })
  const ctx = { agents: { list: () => live, get(id) { return live.find(agent => agent.id === id) },  async create(options) { created.push(options); throw new Error('Must not create another Agent') } }, sessionPersistence: {
    async stat(id) { return id === candidateId && canonical ? { header: { id, cwd } } : undefined },
    async list() { return rows.map(row => ({ header: { id: row.id, cwd } })) },
    async open(id) {
      const row = records.get(id)
      if (row.corrupt) { const error = new Error('bad persisted source'); error.name = 'SessionPersistenceCorruptionError'; throw error }
      if (row.io) throw io
      return { async read() { return { events: [{ type: 'plugin:codexhost/thread', ignorable: true, data: { version: 1, phase: row.phase ?? 'ready', threadId, harnessId, sessionId: row.mappingOwner ?? id } }] } }, async close() {} }
    },
  }, workspaceRegistry: { async create() { return { id: 'workspace', async attachSession(id) { attached.push(id) } } } } }
  const importer = new NativeSessionImporter(ctx, {}, {})
  const run = () => importer.import(peers, { harnessId, id: threadId, kind: 'thread', acknowledgeIdle: true })
  return { run, attached, created, candidateId }
}
test('an existing unique executable mapping can be reused despite an unrelated corrupt record', async () => {
  const f = fixture([{ id: 'corrupt', corrupt: true }, { id: 'reference-copy', mappingOwner: 'old-original' }, { id: 'executable' }])
  assert.equal((await f.run()).sessionId, 'executable')
  assert.deepEqual(f.attached, ['executable']); assert.equal(f.created.length, 0)
})
test('corrupt history without a readable owner never permits a duplicate new Session', async () => {
  const f = fixture([{ id: 'corrupt', corrupt: true }, { id: 'reference-copy', mappingOwner: 'old-original' }])
  await assert.rejects(f.run(), /无法确认唯一归属/); assert.equal(f.created.length, 0); assert.equal(f.attached.length, 0)
})
test('two executable mappings are refused rather than choosing one by list order', async () => {
  const f = fixture([{ id: 'first' }, { id: 'second' }])
  await assert.rejects(f.run(), /多个可续聊映射/); assert.equal(f.created.length, 0)
})
test('an unresolved matching owner blocks import even when another ready record exists', async () => {
  const f = fixture([{ id: 'ready' }, { id: 'submitted', phase: 'submitted' }])
  await assert.rejects(f.run(), /未确认的任务/); assert.equal(f.attached.length, 0)
})
test('ordinary I/O errors are not mistaken for safe historical corruption', async () => {
  const io = new Error('Access denied'), f = fixture([{ id: 'io', io: true }, { id: 'executable' }], { io })
  await assert.rejects(f.run(), error => error === io); assert.equal(f.attached.length, 0)
})
test('a verified canonical recovery reattaches directly without scanning the corrupt original', async () => {
  const f = fixture([{ id: 'original', corrupt: true }], { canonical: {} })
  assert.equal((await f.run()).sessionId, f.candidateId)
  assert.deepEqual(f.attached, [f.candidateId]); assert.equal(f.created.length, 0)
})
test('an opened reference-only copy is ignored when reattaching the actual canonical recovery', async () => {
  const agent = { id: 'reference-copy', session: { snapshotEvents: () => [{ type: 'plugin:codexhost/thread', ignorable: true, data: { version: 1, phase: 'ready', threadId, harnessId, sessionId: 'old-original' } }] } }
  const f = fixture([], { canonical: {}, live: [agent] })
  assert.equal((await f.run()).sessionId, f.candidateId)
  assert.deepEqual(f.attached, [f.candidateId])
})

test('a canonical reference-only copy cannot masquerade as the executable owner', async () => {
  const f = fixture([], { canonical: { mappingOwner: 'another-session' } })
  await assert.rejects(f.run(), /映射不一致/); assert.equal(f.attached.length, 0)
})
