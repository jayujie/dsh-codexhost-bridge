import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { hostDataDirectory } from './backend-paths.mjs'
import { dshNormalizeAntigravityModelForPrice } from './antigravity-perf.mjs'

let localPricesModulePromise
const loadLocalPricesModule = () => localPricesModulePromise ??= import('./local-model-prices.mjs')

const count = value => Number.isSafeInteger(value) && value >= 0

// DSH inputTokens excludes cache buckets; never subtract them a second time.
export function costRequest(event) {
  if (event.type !== 'assistant/message' || event.surfaceOp !== 'append') return undefined
  const { message, usage } = event.data ?? {}
  const source = message?.source
  if (source?.kind !== 'model' || typeof source.model !== 'string' || !source.model) return undefined
  // Host intermediate messages are not requests; only the terminal message carries Turn usage.
  if (source.provider?.startsWith('codexhost/') && !usage) return undefined
  if (typeof message.id !== 'string' || !message.id) return undefined
  const buckets = usage && { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0 }
  return { id: message.id, model: source.model, provider: source.provider ?? '', seq: event.seq, ...(buckets && Object.values(buckets).every(count) ? { usage: buckets } : {}) }
}

export function requestCost(request, lookup) {
  const u = request.usage
  let p = lookup.find(request.model, request.provider)
  if (!p && request.provider === 'codexhost/antigravity') {
    const normalized = dshNormalizeAntigravityModelForPrice(request.model)
    if (normalized) p = lookup.find(normalized, 'google')
  }
  if (!u || !p || (u.cacheReadTokens > 0 && p.cacheRead === undefined) || (u.cacheWriteTokens > 0 && p.cacheWrite === undefined)) return undefined
  const total = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * (p.cacheRead ?? 0) + u.cacheWriteTokens * (p.cacheWrite ?? 0)) / 1e6
  return Number.isFinite(total) && total >= 0 ? total : undefined
}

export function sessionCostView(requests, lookup) {
  let totalCostUsd = 0, priced = 0, unpricedRequests = 0, latestUsageSeq
  const unpricedModels = new Set()
  for (const request of Object.values(requests)) {
    if (request.seq !== undefined) latestUsageSeq = Math.max(latestUsageSeq ?? request.seq, request.seq)
    const cost = requestCost(request, lookup)
    if (cost === undefined) { unpricedRequests++; unpricedModels.add(request.model) }
    else { totalCostUsd += cost; priced++ }
  }
  return { usage: priced ? { totalCostUsd } : {}, cost: { source: 'publicPrice', unpricedRequests, unpricedModels: [...unpricedModels], readingComplete: true, ...(latestUsageSeq === undefined ? {} : { latestUsageSeq }) } }
}

export async function loadLocalPriceLookup(config = {}) {
  // Local data only: ordinary DSH sessions never start Host or make network calls.
  const { bundledModelPrices, ModelPriceLookup, parseModelPriceTable, parseModelPriceOverrides } = await loadLocalPricesModule()
  let table = bundledModelPrices, overrides = new Map()
  const directory = hostDataDirectory(config)
  try { const cached = parseModelPriceTable(JSON.parse(await readFile(path.join(directory, 'pricing', 'models-dev.json'), 'utf8'))); if (cached && cached.fetchedAtMs > table.fetchedAtMs) table = cached } catch {}
  try { overrides = parseModelPriceOverrides(JSON.parse(await readFile(path.join(directory, 'pricing.json'), 'utf8'))) } catch {}
  return new ModelPriceLookup(table, overrides)
}

export async function installSessionApiCost(ctx, config) {
  const [{ z }, lookup] = await Promise.all([ctx.loader.import('zod'), loadLocalPriceLookup(config)])
  const counter = z.number().int().nonnegative()
  const request = z.object({ id: z.string(), model: z.string(), provider: z.string(), seq: counter.optional(), usage: z.object({ inputTokens: counter, outputTokens: counter, cacheReadTokens: counter, cacheWriteTokens: counter }).optional() })
  const view = z.object({ usage: z.record(z.string(), z.number().finite().nonnegative()), cost: z.object({ source: z.literal('publicPrice'), unpricedRequests: counter, unpricedModels: z.array(z.string()), readingComplete: z.boolean(), latestUsageSeq: counter.optional() }) })
  return await ctx.sessionProjections.register({ key: 'sessionApiCost', stateVersion: 3, stateSchema: z.record(z.string(), request), init: () => ({}),
    apply(state, event) { const next = costRequest(event); return next && !Object.hasOwn(state, next.id) ? { ...state, [next.id]: next } : state },
    wire: { viewSchema: view, view: state => sessionCostView(state, lookup), summary: false } })
}
