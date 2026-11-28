import { hostRecord, hostRecordTypes, isHostRecord } from './host-identity.mjs'
import { EXTERNAL_ENGINE_IDS, hostProvider, hostProviderEngine } from './external-engines.mjs'
import { requestCostBreakdown } from './session-api-cost.mjs'
import { reconcileCostBreakdown } from './native-ui-projections.mjs'

export const OBSERVATION = hostRecord('observation-v2')
/** Observation records under the current and legacy prefixes, plus the pre-v2 legacy record (read-only). */
export const OBSERVATION_TYPES = Object.freeze([...hostRecordTypes('observation-v2'), 'plugin:codexhost/observation'])

const count = value => Number.isSafeInteger(value) && value >= 0
const COUNTERS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']
const BILLING_COUNTERS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens']

export function hasBillingCounters(value) {
  return Boolean(value && typeof value === 'object' && BILLING_COUNTERS.every(key => count(value[key])))
}

/** Copy only measured counters and capacities; absent facts remain absent. */
export function observedUsage(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = Object.fromEntries([...COUNTERS, 'contextWindowTokens', 'contextUsedTokens'].filter(key => count(value[key])).map(key => [key, value[key]]))
  for (const key of ['sessionCacheHitRatePercent', 'cacheHitRatePercent', 'outputTokensPerSecond', 'apiOutputTokensPerSecond', 'timeToFirstOutputMs', 'totalCostUsd', 'totalCredits', 'contextUsagePercent', 'turnAverageTokensPerSecond', 'outputTimingReliable']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key]
  }
  return Object.keys(result).length ? result : undefined
}

function hasPositiveSpeed(usage) {
  return (Number.isFinite(usage?.outputTokensPerSecond) && usage.outputTokensPerSecond > 0)
    || (Number.isFinite(usage?.turnAverageTokensPerSecond) && usage.turnAverageTokensPerSecond > 0)
}

function preserveObservedSpeed(previous, next) {
  if (!next || typeof next !== 'object') return next
  const merged = { ...next }
  if (merged.outputTimingReliable === 0) delete merged.outputTokensPerSecond
  if (merged.turnAverageTokensPerSecond === 0) delete merged.turnAverageTokensPerSecond
  if (merged.outputTokensPerSecond === 0) delete merged.outputTokensPerSecond
  if (!hasPositiveSpeed(merged) && hasPositiveSpeed(previous)) {
    if (Number.isFinite(previous.turnAverageTokensPerSecond) && previous.turnAverageTokensPerSecond > 0) {
      merged.turnAverageTokensPerSecond = previous.turnAverageTokensPerSecond
    }
    if (merged.outputTimingReliable !== 0 && Number.isFinite(previous.outputTokensPerSecond) && previous.outputTokensPerSecond > 0 && previous.outputTimingReliable !== 0) {
      merged.outputTokensPerSecond = previous.outputTokensPerSecond
    }
    if (merged.outputTimingReliable === undefined && previous.outputTimingReliable !== undefined) {
      merged.outputTimingReliable = previous.outputTimingReliable
    }
  }
  return merged
}

/** Metadata-only inspections may omit live context. A later zero reading after a
 * failed or interrupted turn is not treated as a real empty context. Keep the
 * last positive sample only for the same thread and model, while retaining the
 * last valid speed across pre-turn inspections, reloads, and model switches. */
export function mergeObservedUsage(previous, next, sameRoute, sameThread = sameRoute) {
  if (!previous || !sameThread) return next
  const sample = sameRoute
    ? Object.fromEntries(['contextUsedTokens', 'contextWindowTokens', 'contextUsagePercent'].filter(key => previous[key] !== undefined).map(key => [key, previous[key]]))
    : {}
  const merged = { ...sample, ...next }
  if (merged.turnAverageTokensPerSecond === 0) delete merged.turnAverageTokensPerSecond
  if (merged.outputTokensPerSecond === 0) delete merged.outputTokensPerSecond
  if (sameRoute && previous.contextUsedTokens > 0 && next.contextUsedTokens === 0 && next.contextWindowTokens > 0) {
    merged.contextUsedTokens = previous.contextUsedTokens
    if (previous.contextUsagePercent !== undefined) merged.contextUsagePercent = previous.contextUsagePercent
  }
  const sameCounters = sameRoute && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => previous[key] !== undefined && previous[key] === next[key])
  if (sameCounters) {
    for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'turnAverageTokensPerSecond', 'outputTimingReliable']) {
      if (merged[key] === undefined && previous[key] !== undefined) merged[key] = previous[key]
    }
    if (merged.outputTokensPerSecond === undefined && Number.isFinite(previous.outputTokensPerSecond) && previous.outputTokensPerSecond > 0 && previous.outputTimingReliable !== 0) {
      merged.outputTokensPerSecond = previous.outputTokensPerSecond
    }
    if (previous.reasoningOutputTokens > 0 && (merged.reasoningOutputTokens === undefined || merged.reasoningOutputTokens === 0)) {
      merged.reasoningOutputTokens = previous.reasoningOutputTokens
    }
    if (merged.outputTimingReliable === 0) delete merged.outputTokensPerSecond
  }
  return preserveObservedSpeed(previous, merged)
}

export function turnTimingUsage(before, after, elapsedMs, streamMeasured) {
  if (count(before?.outputTokens) && count(after?.outputTokens) && after.outputTokens === before.outputTokens) return {}
  const timing = { outputTimingReliable: streamMeasured ? 1 : 0 }
  if (count(before?.outputTokens) && count(after?.outputTokens) && after.outputTokens > before.outputTokens && Number.isFinite(elapsedMs) && elapsedMs > 0) timing.turnAverageTokensPerSecond = (after.outputTokens - before.outputTokens) / (elapsedMs / 1000)
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
  if (!count(inputTokens)) return undefined
  const totalTokens = delta.inputTokens + delta.outputTokens
  if (!count(totalTokens) || totalTokens === 0 || (delta.totalTokens !== undefined && delta.totalTokens !== totalTokens)) return undefined
  // Reasoning is an optional sub-breakdown of outputTokens; if a prior partial/error
  // observation reset reasoningOutputTokens, omit it instead of dropping the whole Turn's usage.
  const reasoningTokens = delta.reasoningOutputTokens !== undefined && delta.reasoningOutputTokens <= delta.outputTokens ? delta.reasoningOutputTokens : undefined
  return { inputTokens, outputTokens: delta.outputTokens, totalTokens, cacheReadTokens: delta.cachedInputTokens,
    cacheWriteTokens: delta.cacheWriteInputTokens, ...(reasoningTokens === undefined ? {} : { reasoningTokens }) }
}

/** Synchronize a real native title, preserving user-pinned names and recording its origin. */
export function acceptNativeTitle(session, value, current) {
  if (typeof value !== 'string') return false
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!title || Buffer.byteLength(title) > 512) return false
  if (current?.source.kind === 'user' || current?.title === title) return false
  session.append('session/title', { title, messageSeqs: current?.messageSeqs ?? [],
    source: { kind: 'provider', provider: 'dsh-host-native-title' } })
  return true
}

/** Recover recorded model identity independently of optional usage inspection. */
export function foldHostModelIdentity(state, event) {
  const data = event.data
  if (event.ignorable === true && isHostRecord(event.type, 'thread') && data?.version === 1 && EXTERNAL_ENGINE_IDS.includes(data.harnessId) && typeof data.threadId === 'string' && data.threadId && typeof data.appliedConfiguration?.modelId === 'string') {
    const selectedModel = data.appliedConfiguration.modelId
    if (state?.harnessId === data.harnessId && state.threadId === data.threadId && state.selectedModel === selectedModel) return state
    return { harnessId: data.harnessId, threadId: data.threadId, selectedModel }
  }
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    const source = data?.message?.source
    const harnessId = hostProviderEngine(source?.provider)
    if (source?.kind !== 'model' || !harnessId || typeof source.model !== 'string' || !source.model.trim()) return state
    if (state?.harnessId === harnessId && state.model === source.model) return state
    return { ...(state?.harnessId === harnessId ? state : {}), harnessId, model: source.model }
  }
  if (event.ignorable === true && OBSERVATION_TYPES.includes(event.type) && EXTERNAL_ENGINE_IDS.includes(data?.harnessId) && typeof data.model === 'string' && data.model.trim()) {
    const unresolved = data.harnessId === 'claude-code' && (data.model.startsWith('claude-model-v1.') || ['default', 'opus', 'sonnet', 'haiku'].includes(data.model))
    const sameThread = state?.harnessId === data.harnessId && state.threadId === data.threadId
    if (unresolved && sameThread && state.model) return state
    return { ...(sameThread ? state : {}), harnessId: data.harnessId, threadId: data.threadId, ...(unresolved ? { selectedModel: data.model } : { model: data.model }) }
  }
  return state
}

/** Derive input/output/cache USD buckets directly from Host cumulative counters when single-model pricing matches. */
export function enrichObservationCostBreakdown(state, lookup) {
  const usage = state?.usage
  if (!state || !lookup || !usage || !state.model || !state.harnessId) return state
  if (Number.isFinite(usage.inputCostUsd) && Number.isFinite(usage.outputCostUsd)) return state
  if (!hasBillingCounters(usage)) return state
  const inputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens
  if (!count(inputTokens)) return state
  const breakdown = requestCostBreakdown({
    model: state.pricingModel ?? state.model,
    provider: hostProvider(state.harnessId),
    usage: { inputTokens, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens, outputTokens: usage.outputTokens },
  }, lookup)
  if (!breakdown) return state
  const priced = { ...breakdown, totalCostUsd: breakdown.total }
  const aligned = Number.isFinite(usage.totalCostUsd) ? reconcileCostBreakdown(usage.totalCostUsd, priced) : priced
  if (!aligned) return state
  return {
    ...state,
    usage: {
      ...usage,
      inputCostUsd: aligned.inputCostUsd,
      outputCostUsd: aligned.outputCostUsd,
      cacheReadCostUsd: aligned.cacheReadCostUsd,
      cacheWriteCostUsd: aligned.cacheWriteCostUsd,
      ...(aligned.cacheSavingsUsd > 0 ? { cacheSavingsUsd: aligned.cacheSavingsUsd } : {}),
    },
  }
}

/**
 * Host observations for Claude Code carry the opaque catalog id (claude-model-v1.*);
 * remember the concrete model from the engine's own replies so pricing can resolve it.
 */
export function foldHostObservation(state, event) {
  if (OBSERVATION_TYPES.includes(event.type) && event.ignorable === true) {
    const keep = state?.pricingModel && state.harnessId === event.data?.harnessId ? { pricingModel: state.pricingModel } : {}
    let data = event.data
    if (data?.usage && state?.usage && state.threadId === data.threadId && !hasPositiveSpeed(data.usage) && hasPositiveSpeed(state.usage)) {
      data = { ...data, usage: preserveObservedSpeed(state.usage, data.usage) }
    }
    return { ...data, recordedSeq: event.seq, ...keep }
  }
  if (state && event.type === 'assistant/message') {
    const source = event.data?.message?.source
    if (source?.kind === 'model' && hostProviderEngine(source.provider) === state.harnessId && typeof source.model === 'string' && source.model.trim() && source.model !== state.pricingModel) return { ...state, pricingModel: source.model }
  }
  return state
}

function estimateTextTokens(value) {
  if (!value) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return 0
  let cjk = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x2e80) cjk++
  return Math.ceil((text.length - cjk) / 4 + cjk / 1.5)
}

function estimateBlockTokens(block) {
  if (!block || typeof block !== 'object') return 0
  if (block.type === 'text' || block.type === 'reasoning') return estimateTextTokens(block.text) + 4
  if (block.type === 'tool-call') return estimateTextTokens(block.name) + estimateTextTokens(block.arguments) + 4
  if (block.type === 'image') {
    const { offloaded: _o, ...reference } = block
    return estimateTextTokens(reference) + 4
  }
  return estimateTextTokens(block) + 4
}

function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content) + 4
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) total += estimateBlockTokens(block)
  return total
}

const AGY_FILE_SUMMARY_RE = /^\s*\d+\s+lines?,\s*(\d+)\s+bytes\s*$/iu

function estimateToolResultContentTokens(content) {
  if (typeof content === 'string') {
    const m = AGY_FILE_SUMMARY_RE.exec(content)
    if (m) return Math.ceil(Number(m[1]) / 3.2) + 8
    return estimateTextTokens(content) + 4
  }
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const m = AGY_FILE_SUMMARY_RE.exec(block.text)
      if (m) { total += Math.ceil(Number(m[1]) / 3.2) + 8; continue }
    }
    total += estimateBlockTokens(block)
  }
  return total
}

const INITIAL_CONTEXT_BREAKDOWN = Object.freeze({
  activeToolTokens: 0,
  activeMessageTokens: 0,
  turnToolTokens: 0,
  turnMessageTokens: 0,
  lastCompactionId: '',
  lastCompactionSummaryTokens: 0,
  lastCompactionSeq: 0,
  lastCompactionAfterTokens: 0,
  lastContextUsed: 0,
  systemBaselineTokens: 0,
})

/**
 * Incrementally track active-window tool activity and conversation tokens
 * since the latest compaction boundary for external engines (Scheme A).
 */
export function foldHostContextBreakdown(state, event) {
  const current = state ?? INITIAL_CONTEXT_BREAKDOWN
  if (!event || typeof event !== 'object') return current
  const data = event.data
  const eventSeq = count(event.seq) ? event.seq : 0
  if (event.type === 'turn/start') {
    if (current.turnToolTokens === 0 && current.turnMessageTokens === 0) return current
    return { ...current, turnToolTokens: 0, turnMessageTokens: 0 }
  }
  if (isHostRecord(event.type, 'compaction') && event.ignorable === true) {
    if (data?.phase === 'failed') return current
    const cid = typeof data?.compactionId === 'string' ? data.compactionId : ''
    const summaryTokens = typeof data?.summary === 'string' && data.summary.trim() ? estimateTextTokens(data.summary) + 4 : 0
    const afterTokens = count(data?.afterTokens) && data.afterTokens > 0 ? data.afterTokens : 0
    const nextCompactionSeq = Math.max(current.lastCompactionSeq ?? 0, eventSeq)
    if (cid && cid === current.lastCompactionId) {
      const delta = Math.max(0, summaryTokens - current.lastCompactionSummaryTokens)
      const nextAfter = afterTokens > 0 ? afterTokens : (current.lastCompactionAfterTokens ?? 0)
      if (delta === 0 && nextCompactionSeq === (current.lastCompactionSeq ?? 0) && nextAfter === (current.lastCompactionAfterTokens ?? 0)) return current
      return {
        ...current,
        activeMessageTokens: current.activeMessageTokens + delta,
        lastCompactionSummaryTokens: summaryTokens,
        lastCompactionSeq: nextCompactionSeq,
        lastCompactionAfterTokens: nextAfter,
      }
    }
    return {
      ...current,
      activeToolTokens: 0,
      activeMessageTokens: summaryTokens,
      turnToolTokens: 0,
      turnMessageTokens: 0,
      lastCompactionId: cid,
      lastCompactionSummaryTokens: summaryTokens,
      lastCompactionSeq: nextCompactionSeq,
      lastCompactionAfterTokens: afterTokens,
    }
  }
  if (event.ignorable === true && OBSERVATION_TYPES.includes(event.type)) {
    const used = data?.usage?.contextUsedTokens
    if (!count(used) || used <= 0) return current
    const dropped = current.lastContextUsed >= 80_000 && used <= current.lastContextUsed * 0.55
    let nextTool = current.activeToolTokens
    let nextMsg = current.activeMessageTokens
    if (dropped && nextTool + nextMsg > used) {
      nextTool = current.turnToolTokens
      nextMsg = current.turnMessageTokens
    }
    let nextBaseline = current.systemBaselineTokens ?? 0
    if (eventSeq >= (current.lastCompactionSeq ?? 0)) {
      const impliedOverhead = used - (nextTool + nextMsg)
      if (impliedOverhead >= 8_000 && impliedOverhead <= 60_000) {
        if (nextBaseline === 0 || impliedOverhead < nextBaseline) nextBaseline = impliedOverhead
      }
    }
    if (nextTool === current.activeToolTokens && nextMsg === current.activeMessageTokens && used === current.lastContextUsed && nextBaseline === (current.systemBaselineTokens ?? 0)) return current
    return {
      ...current,
      activeToolTokens: nextTool,
      activeMessageTokens: nextMsg,
      lastContextUsed: used,
      systemBaselineTokens: nextBaseline,
    }
  }
  if (event.type === 'user/message') {
    const tokens = estimateContentTokens(data?.content) + 4
    if (tokens <= 0) return current
    return {
      ...current,
      activeMessageTokens: current.activeMessageTokens + tokens,
      turnMessageTokens: current.turnMessageTokens + tokens,
    }
  }
  if (event.type === 'assistant/message') {
    const blocks = data?.message?.content
    if (!Array.isArray(blocks) || blocks.length === 0) return current
    let toolAdd = 0, msgAdd = 0
    for (const block of blocks) {
      if (block?.type === 'tool-call') toolAdd += estimateBlockTokens(block)
      else msgAdd += estimateBlockTokens(block)
    }
    if (msgAdd > 0) msgAdd += 4
    if (toolAdd === 0 && msgAdd === 0) return current
    return {
      ...current,
      activeToolTokens: current.activeToolTokens + toolAdd,
      activeMessageTokens: current.activeMessageTokens + msgAdd,
      turnToolTokens: current.turnToolTokens + toolAdd,
      turnMessageTokens: current.turnMessageTokens + msgAdd,
    }
  }
  if (event.type === 'tool/result') {
    const tokens = estimateToolResultContentTokens(data?.message?.content) + 8
    if (tokens <= 0) return current
    return {
      ...current,
      activeToolTokens: current.activeToolTokens + tokens,
      turnToolTokens: current.turnToolTokens + tokens,
    }
  }
  return current
}

/** Register a client-visible, log-backed snapshot of native context and cumulative usage. */
export async function installObservationProjection(ctx, { lookup } = {}) {
  const { z } = await ctx.loader.import('zod')
  const identitySchema = z.object({ harnessId: z.enum([...EXTERNAL_ENGINE_IDS]), threadId: z.string().optional(), selectedModel: z.string().optional(), model: z.string().optional() }).strict().nullable()
  await ctx.sessionProjections.register({ key: 'dshHostModelIdentity', stateVersion: 1, stateSchema: identitySchema, init: () => null,
    apply: foldHostModelIdentity, wire: { viewSchema: identitySchema, view: state => state, summary: false } })
  const tokenCount = z.number().int().nonnegative()
  const contextStateSchema = z.object({
    activeToolTokens: tokenCount,
    activeMessageTokens: tokenCount,
    turnToolTokens: tokenCount,
    turnMessageTokens: tokenCount,
    lastCompactionId: z.string(),
    lastCompactionSummaryTokens: tokenCount,
    lastCompactionSeq: tokenCount,
    lastCompactionAfterTokens: tokenCount,
    lastContextUsed: tokenCount,
    systemBaselineTokens: tokenCount,
  }).strict()
  const contextViewSchema = z.object({
    toolTokens: tokenCount,
    messageTokens: tokenCount,
    lastCompactionSeq: tokenCount,
    lastCompactionAfterTokens: tokenCount,
    systemBaselineTokens: tokenCount,
  }).strict()
  await ctx.sessionProjections.register({ key: 'dshHostContextBreakdown', stateVersion: 3, stateSchema: contextStateSchema,
    init: () => ({ ...INITIAL_CONTEXT_BREAKDOWN }),
    apply: foldHostContextBreakdown,
    wire: {
      viewSchema: contextViewSchema,
      view: state => ({
        toolTokens: state.activeToolTokens,
        messageTokens: state.activeMessageTokens,
        lastCompactionSeq: state.lastCompactionSeq ?? 0,
        lastCompactionAfterTokens: state.lastCompactionAfterTokens ?? 0,
        systemBaselineTokens: state.systemBaselineTokens ?? 0,
      }),
      summary: false,
    } })
  const schema = z.object({ threadId: z.string(), harnessId: z.string(), model: z.string(), pricingModel: z.string().optional(), observedAt: z.number().int().nonnegative(), recordedSeq: z.number().int().nonnegative().optional(),
    usage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    cost: z.object({ source: z.enum(['publicPrice', 'native']), unpricedModels: z.array(z.string()).optional(), unpricedRequests: z.number().int().nonnegative().optional(), readingComplete: z.boolean().optional() }).strict().optional() }).strict().nullable()
  return await ctx.sessionProjections.register({ key: 'dshHostObservation', stateVersion: 4, stateSchema: schema, init: () => null,
    apply: foldHostObservation,
    wire: { viewSchema: schema, view: state => enrichObservationCostBreakdown(state, lookup), summary: false } })
}

export const ZERO_USAGE = Object.freeze(Object.fromEntries(COUNTERS.map(key => [key, 0])))
