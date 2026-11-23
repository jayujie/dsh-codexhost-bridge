import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { hostUsageTotals } from '../host-usage-totals.mjs'
import { patchedHostUsage } from '../patch-host-usage.mjs'

test('Complete native request records publish exact optional cache buckets without estimating missing buckets', () => {
  assert.deepEqual(hostUsageTotals([{ inputTokens: 100, outputTokens: 5, cachedInputTokens: 60, cacheWriteInputTokens: 10 }]), { inputTokens: 100, outputTokens: 5, cachedInputTokens: 60, cacheWriteInputTokens: 10, totalTokens: 105 })
  assert.deepEqual(hostUsageTotals([{ inputTokens: 100, outputTokens: 5 }]), { inputTokens: 100, outputTokens: 5, totalTokens: 105 })
  assert.equal(hostUsageTotals([{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }]), undefined)
})

test('Patched installed Host meter derives totals from deduplicated complete history and omits incomplete history', async t => {
  const candidates = [
    process.env.CODEXHOST_APP_DIR && path.join(process.env.CODEXHOST_APP_DIR, 'host-runtime.mjs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@codexhost', 'cli-win32-x64', 'app', 'host-runtime.mjs'),
  ].filter(Boolean)
  const target = candidates.find(p => existsSync(p))
  if (!target) return t.skip('Upstream CodexHost app directory is not installed in this environment')
  const source = await readFile(target, 'utf8')
  const patched = source.includes('function hostUsageTotals(') ? source : await patchedHostUsage(source)
  const start = patched.indexOf('// packages/host-runtime/src/usage-metering.ts')
  const end = patched.indexOf('\n// packages/', start + 10)
  const context = vm.createContext({ hostDerivedUsageFields: ['costSource', 'sessionCacheHitRatePercent'], parseHostUsage: x => x, parseHostUsageRequest: x => x,
    cacheWrite1hPrice: () => 1 })
  vm.runInContext(patched.slice(start, end) + '\nglobalThis.Meter = UsageMeter', context)
  const meter = new context.Meter()
  const request = { requestId: 'one', model: 'sonnet', inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 10 }
  const prices = { find: () => ({ input: 1, output: 2, cacheRead: .1, cacheWrite: 1 }) }
  meter.recordRequest(request, null)
  meter.recordRequest(request, null)
  meter.recordHistory(false)
  assert.equal(meter.derive(null, prices), null)
  meter.recordHistory(true)
  const result = meter.derive(null, prices)
  assert.equal(result.totalTokens, 1050)
  assert.equal(result.cachedInputTokens, 600)
  assert.equal(result.cacheWriteInputTokens, 100)
  assert.equal(result.sessionCacheHitRatePercent, 60)
})
