import test from 'node:test'
import assert from 'node:assert/strict'
import { OwnedHostRuntime } from '../owned-host-runtime.mjs'
import { readHostDescriptor, hostIsAlive } from '../host-installation.mjs'

test('installed background Host starts without Desktop, is reused, and only its owner stops it', { skip: process.env.CODEXHOST_OWNED_SMOKE !== '1', timeout: 60000 }, async () => {
  const initial = await readHostDescriptor()
  const alreadyRunning = hostIsAlive(initial)
  const runtime = new OwnedHostRuntime()
  const borrower = new OwnedHostRuntime()
  let peer, other
  try {
    if (!alreadyRunning) await assert.rejects(new OwnedHostRuntime({ autoStartHost: false }).ensure(), { code: 'HOST_NOT_RUNNING' })
    peer = await runtime.connect()
    const started = await readHostDescriptor()
    assert.ok(hostIsAlive(started))
    assert.ok((await peer.request('model/list', { limit: 100 })).data.length > 0)
    other = await borrower.connect()
    assert.equal((await readHostDescriptor()).ownerPid, started.ownerPid)
    other.close()
    await borrower.close()
    assert.ok(hostIsAlive(started))
    peer.close()
    await runtime.close()
    assert.equal(hostIsAlive(started), alreadyRunning)
  } finally { peer?.close(); other?.close(); await borrower.close(); await runtime.close() }
})
