import { EXTERNAL_ENGINE_IDS } from './external-engines.mjs'

export const OBSERVATION = 'plugin:codexhost/observation-v2'

const count = value => Number.isSafeInteger(value) && value >= 0
const COUNTERS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']

/** Copy only measured counters and capacities; absent facts remain absent. */
export function observedUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = Object.fromEntries([...COUNTERS, 'contextWindowTokens', 'contextUsedTokens'].filter(key => count(value[key])).map(key => [key, value[key]]))
  for (const key of ['sessionCacheHitRatePercent', 'cacheHitRatePercent', 'outputTokensPerSecond', 'apiOutputTokensPerSecond', 'timeToFirstOutputMs', 'totalCostUsd', 'totalCredits', 'contextUsagePercent', 'turnAverageTokensPerSecond', 'outputTimingReliable']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key]
  }
  return Object.keys(result).length ? result : undefined
}

/** Metadata-only inspections may omit live context. A later zero reading after a
 * failed or interrupted turn is not treated as a real empty context. Keep the
 * last positive sample only for the same thread and model. */
export function mergeObservedUsage(previous, next, sameRoute) {
  if (!sameRoute || !previous) return next
  const sample = Object.fromEntries(['contextUsedTokens', 'contextWindowTokens', 'contextUsagePercent'].filter(key => previous[key] !== undefined).map(key => [key, previous[key]]))
  const merged = { ...sample, ...next }
  if (previous.contextUsedTokens > 0 && next.contextUsedTokens === 0 && next.contextWindowTokens > 0) {
    merged.contextUsedTokens = previous.contextUsedTokens
    if (previous.contextUsagePercent !== undefined) merged.contextUsagePercent = previous.contextUsagePercent
  }
  const sameCounters = ['inputTokens', 'outputTokens', 'totalTokens'].every(key => previous[key] !== undefined && previous[key] === next[key])
  if (sameCounters) {
    for (const key of ['turnAverageTokensPerSecond', 'outputTimingReliable']) if (merged[key] === undefined && previous[key] !== undefined) merged[key] = previous[key]
    if (merged.outputTimingReliable === 0) delete merged.outputTokensPerSecond
  }
  return merged
}

export function turnTimingUsage(before, after, elapsedMs, streamMeasured) {
  const timing = { outputTimingReliable: streamMeasured ? 1 : 0 }
  if (count(before?.outputTokens) && count(after?.outputTokens) && after.outputTokens >= before.outputTokens && Number.isFinite(elapsedMs) && elapsedMs > 0) timing.turnAverageTokensPerSecond = (after.outputTokens - before.outputTokens) / (elapsedMs / 1000)
  return timing
}

export function observedCost(value) {
  if (!Number.isFinite(value?.totalCostUsd) || value.totalCostUsd < 0 || !['publicPrice', 'native'].includes(value.costSource)) return undefined
  return { source: value.costSource, ...(Array.isArray(value.unpricedModels) && value.unpricedModels.every(model => typeof model === 'string') && value.unpricedModels.length ? { unpricedModels: value.unpricedModels } : {}) }
}

/** Convert cumulative Host counters into disjoint DSH buckets for exactly this Turn. */
export function turnUsage(before, after) {
  if (!before || !after) return undefined
  if (!['inputTokens', 'outputTokens'].every(key => count(before[key]) && count(after[key]) && after[key] >= before[key])) return undefined
  const delta = Object.fromEntries(COUNTERS.filter(key => count(before[key]) && count(after[key]) && after[key] >= before[key]).map(key => [key, after[key] - before[key]]))
  // Host input includes cache reads/writes; DSH input excludes both.
  if (!count(delta.cachedInputTokens) || !count(delta.cacheWriteInputTokens)) return undefined
  const inputTokens = delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens
  if (!count(inputTokens) || (delta.reasoningOutputTokens !== undefined && delta.reasoningOutputTokens > delta.outputTokens)) return undefined
  const totalTokens = delta.inputTokens + delta.outputTokens
  if (!count(totalTokens) || (delta.totalTokens !== undefined && delta.totalTokens !== totalTokens)) return undefined
  return { inputTokens, outputTokens: delta.outputTokens, totalTokens, cacheReadTokens: delta.cachedInputTokens,
    cacheWriteTokens: delta.cacheWriteInputTokens, ...(delta.reasoningOutputTokens === undefined ? {} : { reasoningTokens: delta.reasoningOutputTokens }) }
}

/** Synchronize a real native title, preserving user-pinned names and recording its origin. */
export function acceptNativeTitle(session, value, current) {
  if (typeof value !== 'string') return false
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!title || Buffer.byteLength(title) > 512) return false
  if (current?.source.kind === 'user' || current?.title === title) return false
  session.append('session/title', { title, messageSeqs: current?.messageSeqs ?? [],
    source: { kind: 'provider', provider: 'codexhost-native-title' } })
  return true
}

/** Recover recorded model identity independently of optional usage inspection. */
export function foldHostModelIdentity(state, event) {
  const data = event.data
  if (event.ignorable === true && event.type === 'plugin:codexhost/thread' && data?.version === 1 && EXTERNAL_ENGINE_IDS.includes(data.harnessId) && typeof data.threadId === 'string' && data.threadId && typeof data.appliedConfiguration?.modelId === 'string') {
    const selectedModel = data.appliedConfiguration.modelId
    if (state?.harnessId === data.harnessId && state.threadId === data.threadId && state.selectedModel === selectedModel) return state
    return { harnessId: data.harnessId, threadId: data.threadId, selectedModel }
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const source = data?.message?.source
    const harnessId = EXTERNAL_ENGINE_IDS.find(id => source?.provider === 'codexhost/' + id)
    if (source?.kind !== 'model' || !harnessId || typeof source.model !== 'string' || !source.model.trim()) return state
    if (state?.harnessId === harnessId && state.model === source.model) return state
    return { ...(state?.harnessId === harnessId ? state : {}), harnessId, model: source.model }
  }
  if (event.ignorable === true && [OBSERVATION, 'plugin:codexhost/observation'].includes(event.type) && EXTERNAL_ENGINE_IDS.includes(data?.harnessId) && typeof data.model === 'string' && data.model.trim()) {
    const unresolved = data.harnessId === 'claude-code' && (data.model.startsWith('claude-model-v1.') || ['default', 'opus', 'sonnet', 'haiku'].includes(data.model))
    const sameThread = state?.harnessId === data.harnessId && state.threadId === data.threadId
    if (unresolved && sameThread && state.model) return state
    return { ...(sameThread ? state : {}), harnessId: data.harnessId, threadId: data.threadId, ...(unresolved ? { selectedModel: data.model } : { model: data.model }) }
  }
  return state
}

/** Register a client-visible, log-backed snapshot of native context and cumulative usage. */
export async function installObservationProjection(ctx) {
  const { z } = await ctx.loader.import('zod')
  const identitySchema = z.object({ harnessId: z.enum([...EXTERNAL_ENGINE_IDS]), threadId: z.string().optional(), selectedModel: z.string().optional(), model: z.string().optional() }).strict().nullable()
  await ctx.sessionProjections.register({ key: 'codexHostModelIdentity', stateVersion: 1, stateSchema: identitySchema, init: () => null,
    apply: foldHostModelIdentity, wire: { viewSchema: identitySchema, view: state => state, summary: false } })
  const schema = z.object({ threadId: z.string(), harnessId: z.string(), model: z.string(), observedAt: z.number().int().nonnegative(), recordedSeq: z.number().int().nonnegative().optional(),
    usage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    cost: z.object({ source: z.enum(['publicPrice', 'native']), unpricedModels: z.array(z.string()).optional(), unpricedRequests: z.number().int().nonnegative().optional(), readingComplete: z.boolean().optional() }).strict().optional() }).strict().nullable()
  return await ctx.sessionProjections.register({ key: 'codexHostObservation', stateVersion: 3, stateSchema: schema, init: () => null,
    apply: (state, event) => [OBSERVATION, 'plugin:codexhost/observation'].includes(event.type) && event.ignorable === true ? { ...event.data, recordedSeq: event.seq } : state,
    wire: { viewSchema: schema, view: state => state, summary: false } })
}

export const ZERO_USAGE = Object.freeze(Object.fromEntries(COUNTERS.map(key => [key, 0])))
