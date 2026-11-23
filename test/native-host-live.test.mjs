import test from 'node:test'
import assert from 'node:assert/strict'
import { connectNativeHost } from '../native-host-client.mjs'

// Explicit opt-in: uses the installed Host, reads metadata only, creates no turns.
test('installed Host exposes real Codex models, Harness catalogs and import candidates', {
  skip: process.env.CODEXHOST_NATIVE_SMOKE !== '1', timeout: 60_000,
}, async t => {
  const peer = await connectNativeHost()
  t.after(() => peer.close())
  const codex = await peer.request('model/list', { limit: 20 }, { timeoutMs: 10_000 })
  assert.ok(codex.data.length > 0)
  assert.ok(codex.data.every(model => typeof model.id === 'string' && typeof model.model === 'string'))

  const plugins = await peer.request('codexhost/harness/plugins/list')
  assert.equal(plugins.plugins.find(plugin => plugin.id === 'deepseek-harness')?.kind, 'usage')
  for (const id of ['claude-code']) {
    const plugin = plugins.plugins.find(plugin => plugin.id === id)
    assert.ok(plugin, `${id} must be installed`)
    assert.ok(plugin.icon || plugin.iconStyle?.vector, `${id} must provide its original icon`)
    const inspection = await peer.request('codexhost/harness/inspect', { harnessId: id, cwd: 'D:/work', refresh: false }, { timeoutMs: 20_000 })
    assert.equal(inspection.status, 'ready')
    assert.ok(inspection.catalog.models.length > 0)
    assert.ok(inspection.catalog.models.every(model => typeof model.ref?.id === 'string'))
    assert.ok(inspection.permissionModes.modes.length > 0)
  }

  const sources = await peer.request('codexhost/harness/session-import/sources')
  assert.ok(sources.harnesses.some(source => source.harnessId === 'claude-code'))
  const candidates = await peer.request('codexhost/harness/session-import/list', { harnessId: 'claude-code', limit: 2, offset: 0 })
  assert.ok(Array.isArray(candidates.candidates))
  assert.ok(candidates.candidates.length <= 2)
  assert.ok(Number.isInteger(candidates.total))
  for (const candidate of candidates.candidates) {
    assert.equal(typeof candidate.nativeSessionId, 'string')
    assert.equal(typeof candidate.cwd, 'string')
  }
})
