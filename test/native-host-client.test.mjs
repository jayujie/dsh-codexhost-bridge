import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { NativeHostPeer } from '../native-host-client.mjs'

function fixture(t, options = {}) {
  const sent = []
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk.toString())); done() } })
  child.kills = 0
  child.kill = () => { child.kills++ }
  const peer = new NativeHostPeer(child, options)
  t.after(() => peer.close())
  const receive = value => child.stdout.write(`${JSON.stringify(value)}\n`)
  const ready = () => receive({ method: 'codexhost/remote-control-bridge/ready', params: { protocolVersion: 1 } })
  return { peer, child, sent, receive, ready }
}

test('native peer matches out-of-order replies and preserves model references', async t => {
  const f = fixture(t)
  f.ready()
  const first = f.peer.request('codexhost/harness/inspect', { harnessId: 'claude-code' })
  const second = f.peer.request('codexhost/harness/session-import/sources')
  await Promise.resolve()
  assert.equal(f.sent.length, 2)
  f.receive({ id: f.sent[1].id, result: { harnesses: [] } })
  f.receive({ id: f.sent[0].id, result: { status: 'ready', catalog: { models: [{ ref: { id: 'opaque-model-id' }, label: 'Sonnet' }] } } })
  assert.deepEqual(await second, { harnesses: [] })
  assert.equal((await first).catalog.models[0].ref.id, 'opaque-model-id')
})

test('native peer retains complete streaming notifications and approval request IDs without deciding', async t => {
  const f = fixture(t)
  f.ready()
  const frames = []
  const dispose = f.peer.subscribe(message => frames.push(message))
  f.peer.subscribe(() => { throw new Error('unmounted view') })
  const notification = { method: 'item/agentMessage/delta', params: { threadId: 'external-thread', turnId: 'turn', itemId: 'item', delta: '你好' } }
  const approval = { id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: 'external-thread', command: ['echo', 'test'] } }
  f.receive(notification)
  f.receive(approval)
  assert.deepEqual(frames, [notification, approval])
  assert.equal(f.sent.length, 0)
  await f.peer.respond(41, { decision: 'decline' })
  assert.deepEqual(f.sent, [{ id: 41, result: { decision: 'decline' } }])
  dispose()
  f.receive(notification)
  assert.equal(frames.length, 2)
})

test('native peer decodes split multibyte frames', async t => {
  const f = fixture(t)
  f.ready()
  const frames = []
  f.peer.subscribe(message => frames.push(message))
  const frame = Buffer.from(`${JSON.stringify({ method: 'stream', params: { delta: '中文' } })}\n`)
  const cut = frame.indexOf(Buffer.from('中')) + 1
  f.child.stdout.write(frame.subarray(0, cut))
  f.child.stdout.write(frame.subarray(cut))
  assert.equal(frames[0].params.delta, '中文')
})

test('native peer preserves upstream error codes and details', async t => {
  const f = fixture(t)
  f.ready()
  const result = f.peer.request('codexhost/thread/model/select', {})
  await Promise.resolve()
  f.receive({ id: f.sent[0].id, error: { code: -32602, message: 'Invalid params', data: { field: 'model' } } })
  await assert.rejects(result, error => error.code === -32602 && error.details.field === 'model')
})

test('disconnect rejects in-flight writes and never retries them', async t => {
  const f = fixture(t)
  f.ready()
  const request = f.peer.request('turn/start', { threadId: 'thread' })
  await Promise.resolve()
  f.child.emit('exit', 1)
  await assert.rejects(request, { code: 'HOST_DISCONNECTED' })
  assert.equal(f.sent.length, 1)
  assert.equal(f.child.kills, 1)
  await assert.rejects(f.peer.request('turn/start', {}), { code: 'HOST_DISCONNECTED' })
})

test('cancel stops waiting without pretending the Host turn was cancelled', async t => {
  const f = fixture(t)
  f.ready()
  const controller = new AbortController()
  const result = f.peer.request('turn/start', {}, { signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  await assert.rejects(result, { code: 'HOST_REQUEST_ABORTED' })
  assert.equal(f.sent.length, 1)
  f.receive({ id: f.sent[0].id, result: { turn: { id: 'already-started' } } })
  assert.equal(f.child.kills, 0)
})

test('timeout reports unknown outcome and does not resubmit the request', async t => {
  const f = fixture(t)
  f.ready()
  await assert.rejects(f.peer.request('turn/start', {}, { timeoutMs: 5 }), { code: 'HOST_REQUEST_TIMEOUT' })
  assert.equal(f.sent.length, 1)
})

test('invalid readiness and oversized UTF-8 frames close the connection', async t => {
  const bad = fixture(t)
  bad.receive({ method: 'codexhost/remote-control-bridge/ready', params: { protocolVersion: 2 } })
  await assert.rejects(bad.peer.ready, { code: 'HOST_PROTOCOL_UNSUPPORTED' })
  const large = fixture(t, { maxFrameBytes: 100 })
  large.child.stdout.write(Buffer.from('中'.repeat(34)))
  await assert.rejects(large.peer.ready, { code: 'HOST_FRAME_TOO_LARGE' })
})

test('malformed frame rejects pending calls instead of silently losing them', async t => {
  const f = fixture(t)
  f.ready()
  const request = f.peer.request('thread/read', {})
  await Promise.resolve()
  f.child.stdout.write('{bad}\n')
  await assert.rejects(request, { code: 'HOST_INVALID_FRAME' })
})

test('native peer assembles frames split across chunks without re-copying the partial frame', async t => {
  const f = fixture(t)
  f.ready()
  const seen = []
  f.peer.subscribe(message => seen.push(message))
  const big = { method: 'big', params: { text: 'x'.repeat(5 * 65536 + 17), utf8: '五小时额度' } }
  const bytes = Buffer.from(JSON.stringify(big) + '\n' + JSON.stringify({ method: 'a' }) + '\n' + JSON.stringify({ method: 'b' }))
  const original = Buffer.concat
  let copied = 0
  Buffer.concat = function (list, length) { const out = original.call(this, list, length); copied += out.length; return out }
  try {
    // 7-byte steps split multibyte UTF-8 characters and land the newline on chunk boundaries.
    for (let i = 0; i < bytes.length; i += 65536) f.child.stdout.write(bytes.subarray(i, i + 65536))
    f.child.stdout.write(Buffer.from('\n'))
    const small = Buffer.from(JSON.stringify({ method: 'c', params: { s: '额度' } }) + '\n')
    for (let i = 0; i < small.length; i += 7) f.child.stdout.write(small.subarray(i, i + 7))
    await new Promise(resolve => setImmediate(resolve))
  } finally { Buffer.concat = original }
  assert.deepEqual(seen.map(m => m.method), ['big', 'a', 'b', 'c'])
  assert.equal(seen[0].params.text.length, 5 * 65536 + 17)
  assert.equal(seen[0].params.utf8, '五小时额度')
  assert.equal(seen[3].params.s, '额度')
  assert.ok(copied < 2 * bytes.length, `copied ${copied} bytes for a ${bytes.length}-byte stream`)
})

test('native peer still rejects an oversized partial frame before its newline arrives', async t => {
  const f = fixture(t, { maxFrameBytes: 1024 })
  f.ready()
  const pending = f.peer.request('x').catch(error => error)
  await Promise.resolve()
  f.child.stdout.write(Buffer.alloc(600, 0x61))
  f.child.stdout.write(Buffer.alloc(600, 0x61))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await pending).code, 'HOST_FRAME_TOO_LARGE')
  assert.equal(f.child.kills, 1)
})
