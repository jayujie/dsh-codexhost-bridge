import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')
const start = runtime.indexOf('  async #requestOfficial(method, params) {')
const end = runtime.indexOf('\n  #inspectHarnessAccount', start)
assert.ok(start > 0 && end > start)
const method = runtime.slice(start, end).replace('#requestOfficial', 'requestOfficial')
const Probe = vm.runInNewContext(`(class { #options; #officialRuntime; constructor(options, client) { this.#options = options; this.#officialRuntime = client } ${method} })`)

for (const options of [{ delegationOnly: true }, { externalOnly: true }]) {
  test(`headless official reads initialize their own connection: ${JSON.stringify(options)}`, async () => {
    let initialized = false
    const calls = []
    const client = {
      async initializeProtocol(params) { calls.push('initialize'); assert.equal(params.capabilities.experimentalApi, true); initialized = true },
      async request(method, params) { calls.push(method); return initialized ? { result: { thread: { id: params.threadId } } } : { error: { message: 'Not initialized' } } },
    }
    const probe = new Probe(options, client)
    assert.equal((await probe.requestOfficial('thread/read', { threadId: 'fixture' })).result?.thread.id, 'fixture')
    assert.deepEqual(calls, ['initialize', 'thread/read'])
  })
}

test('desktop connections keep the client-supplied handshake', async () => {
  const probe = new Probe({}, { initializeProtocol() { throw new Error('must not replace desktop identity') }, async request() { return { result: {} } } })
  assert.ok((await probe.requestOfficial('thread/read', {})).result)
})

test('failed initialization prevents dispatch instead of retrying the read', async () => {
  let requests = 0
  const probe = new Probe({ delegationOnly: true }, { async initializeProtocol() { throw new Error('offline') }, async request() { requests++ } })
  await assert.rejects(probe.requestOfficial('thread/read', {}), /offline/)
  assert.equal(requests, 0)
})

test('only the stdin owner is marked as a headless delegation connection', () => {
  assert.match(runtime, /new AppServerHost\(\{ \.\.\.common, delegationOnly: !0,/)
  assert.doesNotMatch(runtime, /arguments: \[\], delegationOnly/)
})
