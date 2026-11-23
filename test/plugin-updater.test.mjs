import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver, PluginUpdater } from '../plugin-updater.mjs'

test('compareSemver orders stable and prerelease versions according to SemVer 2.0', () => {
  assert.equal(compareSemver('0.6.1', '0.6.0'), 1)
  assert.equal(compareSemver('0.6.0', '0.6.1'), -1)
  assert.equal(compareSemver('0.6.1', '0.6.1'), 0)
  assert.equal(compareSemver('0.6.1', '0.6.1-rc.1'), 1)
  assert.equal(compareSemver('0.6.1-rc.2', '0.6.1-rc.1'), 1)
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1)
  assert.deepEqual(parseSemver('v0.6.1-beta.2'), { major: 0, minor: 6, patch: 1, prerelease: ['beta', 2] })
})

test('PluginUpdater reads market-index.json, detects updates, and caches for TTL', async () => {
  let fetches = 0
  const indexBody = {
    format: 1,
    plugins: [{
      name: 'dsh-host',
      versions: [
        { version: '0.6.0', publishTimestamp: 1700000000, source: { type: 'git', url: 'https://github.com/jayujie/dsh-host', commit: 'a'.repeat(40) } },
        { version: '0.7.0', publishTimestamp: 1700001000, source: { type: 'git', url: 'https://github.com/jayujie/dsh-host', commit: 'b'.repeat(40) } },
      ],
    }],
  }
  const fetchImpl = async () => { fetches++; return { ok: true, json: async () => indexBody } }
  const ctx = {
    get: name => name === 'pluginManager' ? {
      listBundles: async () => [{ name: 'dsh-host', installed: true, availability: 'profile', removable: true, source: 'https://github.com/jayujie/dsh-host' }],
      removeBundle: async () => ({ application: 'applied' }),
      installBundle: async () => ({ application: 'restart-required' }),
    } : undefined,
  }
  const updater = new PluginUpdater(ctx, {}, { fetchImpl, readVersion: async () => '0.6.0' })
  const first = await updater.check()
  assert.equal(first.updateAvailable, true)
  assert.equal(first.latestVersion, '0.7.0')
  assert.equal(first.installSpec, `git+https://github.com/jayujie/dsh-host.git#${'b'.repeat(40)}`)
  assert.equal(first.canAutoUpdate, true)
  assert.equal(fetches, 1)
  const cached = await updater.check()
  assert.equal(cached, first)
  assert.equal(fetches, 1)
  await updater.check({ refresh: true })
  assert.equal(fetches, 2)
})

test('PluginUpdater falls back to GitHub Releases API when market-index.json is unreachable', async () => {
  const fetchImpl = async url => {
    if (url.includes('market-index.json')) return { ok: false, status: 503 }
    return {
      ok: true,
      json: async () => ({
        tag_name: 'v0.8.0',
        html_url: 'https://github.com/jayujie/dsh-host/releases/tag/v0.8.0',
        published_at: '2026-11-24T00:00:00Z',
        assets: [{ name: 'dsh-host-0.8.0.tgz', browser_download_url: 'https://github.com/jayujie/dsh-host/releases/download/v0.8.0/dsh-host-0.8.0.tgz' }],
      }),
    }
  }
  const updater = new PluginUpdater({}, {}, { fetchImpl, readVersion: async () => '0.6.1' })
  const status = await updater.check({ refresh: true })
  assert.equal(status.updateAvailable, true)
  assert.equal(status.latestVersion, '0.8.0')
  assert.equal(status.channel, 'github-release')
  assert.match(status.installSpec, /dsh-host-0\.8\.0\.tgz$/)
})

test('PluginUpdater refuses to overwrite local link: dev checkouts and rolls back failed git installs', async () => {
  const indexBody = {
    format: 1,
    plugins: [{
      name: 'dsh-host',
      versions: [{ version: '0.7.0', publishTimestamp: 1700001000, source: { type: 'git', url: 'https://github.com/jayujie/dsh-host', commit: 'c'.repeat(40) } }],
    }],
  }
  const fetchImpl = async () => ({ ok: true, json: async () => indexBody })

  // 1. link: checkout refused
  const linkCtx = {
    get: name => name === 'pluginManager' ? {
      listBundles: async () => [{ name: 'dsh-host', installed: true, availability: 'profile', source: 'link:D:/Desktop/dsh-host' }],
    } : undefined,
  }
  const linkUpdater = new PluginUpdater(linkCtx, {}, { fetchImpl, readVersion: async () => '0.6.1' })
  await assert.rejects(() => linkUpdater.apply(), /link:/)

  // 2. git install failure triggers rollback to previous source
  const ops = []
  const rollbackCtx = {
    get: name => name === 'pluginManager' ? {
      listBundles: async () => [{ name: 'dsh-host', installed: true, enabled: true, availability: 'profile', removable: true, source: 'git+https://github.com/jayujie/dsh-host.git#' + 'a'.repeat(40) }],
      removeBundle: async n => { ops.push(['remove', n]); return { application: 'applied' } },
      installBundle: async spec => {
        ops.push(['install', spec])
        if (spec.includes('c'.repeat(40))) return { application: 'failed', error: { diagnostic: 'network down' } }
        return { application: 'applied' }
      },
    } : undefined,
  }
  const rollbackUpdater = new PluginUpdater(rollbackCtx, {}, { fetchImpl, readVersion: async () => '0.6.1' })
  await assert.rejects(() => rollbackUpdater.apply(), /network down/)
  assert.equal(ops.length, 3)
  assert.equal(ops[0][0], 'remove')
  assert.match(ops[1][1], /c{40}/)
  assert.match(ops[2][1], /a{40}/)
})

test('PluginUpdater uses native updateBundle for npm registry installations', async () => {
  const indexBody = {
    format: 1,
    plugins: [{
      name: 'dsh-host',
      versions: [{ version: '0.7.0', publishTimestamp: 1700001000, source: { type: 'npm' } }],
    }],
  }
  const calls = []
  const ctx = {
    get: name => name === 'pluginManager' ? {
      listBundles: async () => [{ name: 'dsh-host', installed: true, updatable: true, availability: 'profile', source: 'dsh-host@0.6.1' }],
      updateBundle: async (pkg, ver) => { calls.push([pkg, ver]); return { result: { application: 'restart-required' } } },
    } : undefined,
  }
  const updater = new PluginUpdater(ctx, {}, { fetchImpl: async () => ({ ok: true, json: async () => indexBody }), readVersion: async () => '0.6.1' })
  const res = await updater.apply({ version: '0.7.0' })
  assert.equal(res.status, 'restart-required')
  assert.deepEqual(calls, [['dsh-host', '0.7.0']])
})
