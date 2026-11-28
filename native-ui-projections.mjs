function isStalePreCompactionObservation(observation, activity) {
  return Boolean(
    activity && typeof activity === 'object'
    && Number.isSafeInteger(activity.lastCompactionSeq) && activity.lastCompactionSeq > 0
    && Number.isSafeInteger(observation?.recordedSeq)
    && activity.lastCompactionSeq > observation.recordedSeq,
  )
}

/** Reconcile active-window tool & message token activity against measured Host contextUsedTokens (Scheme A). */
export function externalContextBreakdown(observation, activity) {
  const usage = observation?.usage
  const total = usage?.contextUsedTokens
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(usage?.contextWindowTokens) || usage.contextWindowTokens <= 0) return undefined
  if (!activity || typeof activity !== 'object') return undefined
  const rawTools = Number.isFinite(activity.toolTokens) && activity.toolTokens >= 0 ? Math.round(activity.toolTokens) : 0
  const rawMessages = Number.isFinite(activity.messageTokens) && activity.messageTokens >= 0 ? Math.round(activity.messageTokens) : 0
  const rawActive = rawTools + rawMessages
  const baseline = Number.isFinite(activity.systemBaselineTokens) && activity.systemBaselineTokens > 0
    ? Math.round(activity.systemBaselineTokens)
    : 0
  if (isStalePreCompactionObservation(observation, activity)) {
    const afterTokens = Number.isSafeInteger(activity.lastCompactionAfterTokens) && activity.lastCompactionAfterTokens > 0
      ? activity.lastCompactionAfterTokens
      : 0
    if (afterTokens > 0) {
      const systemTokens = Math.max(0, afterTokens - rawActive)
      return { systemTokens, toolsTokens: rawTools, messageTokens: rawMessages }
    }
    const systemTokens = baseline > 0 ? Math.min(Math.max(baseline, 16_000), 60_000) : 20_000
    return { systemTokens, toolsTokens: rawTools, messageTokens: rawMessages }
  }
  if (rawActive <= 0) return undefined
  const rawGap = total - rawActive
  if (rawGap <= 0) {
    const toolsTokens = Math.round((total * rawTools) / rawActive)
    const messageTokens = Math.max(0, total - toolsTokens)
    return { systemTokens: 0, toolsTokens, messageTokens }
  }
  const maxSystem = baseline > 0 ? Math.min(Math.max(baseline, 16_000), 60_000) : 45_000
  if (rawGap <= maxSystem) {
    return { systemTokens: rawGap, toolsTokens: rawTools, messageTokens: rawMessages }
  }
  const excess = rawGap - maxSystem
  if (rawTools > 0) {
    return { systemTokens: maxSystem, toolsTokens: rawTools + excess, messageTokens: rawMessages }
  }
  return { systemTokens: maxSystem, toolsTokens: 0, messageTokens: rawMessages + excess }
}

/** Adapt external observations to the unchanged DSH renderer contracts. */
export function externalProjection(key, native, observation, contextActivity) {
  const usage = observation?.usage
  if (key === 'contextBreakdown') return externalContextBreakdown(observation, contextActivity)
  if (key === 'contextPressure') {
    if (!(usage?.contextWindowTokens > 0 && usage.contextUsedTokens !== undefined)) return undefined
    if (isStalePreCompactionObservation(observation, contextActivity)) {
      const reconciled = externalContextBreakdown(observation, contextActivity)
      if (reconciled) {
        return {
          pressureTokens: reconciled.systemTokens + reconciled.toolsTokens + reconciled.messageTokens,
          contextWindow: usage.contextWindowTokens,
        }
      }
    }
    return { pressureTokens: usage.contextUsedTokens, contextWindow: usage.contextWindowTokens }
  }
  if (key === 'tokenUsage') {
    if (!usage || !['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].every(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0)) return undefined
    const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens
    return uncachedInputTokens < 0 ? undefined : { uncachedInputTokens, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens, outputTokens: usage.outputTokens }
  }
  if (key === 'sessionStats' && native) {
    // Bridged chunks can arrive as a completed batch. Their local arrival times
    // are not model decode timings; never fall back to that synthetic rate.
    const tps = Number.isFinite(usage?.outputTokensPerSecond) && usage.outputTokensPerSecond > 0 ? usage.outputTokensPerSecond : undefined
    const avg = Number.isFinite(usage?.turnAverageTokensPerSecond) && usage.turnAverageTokensPerSecond > 0 ? usage.turnAverageTokensPerSecond : undefined
    const rate = tps ?? avg
    return { ...native, decodeTokens: rate ?? 0, decodeMs: rate !== undefined ? 1000 : 0 }
  }
  return native
}

/** Distinguish a recorded model from a Claude selection ref; never infer a concrete default model. */
export function hostModelPresentation(harnessId, value) {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'unknown' }
  if (harnessId !== 'claude-code') return { kind: 'model', value }
  if (value === 'default') return { kind: 'default' }
  if (['opus', 'sonnet', 'haiku'].includes(value)) return { kind: 'selection', value }
  const prefix = 'claude-model-v1.'
  if (!value.startsWith(prefix)) return { kind: 'model', value }
  try {
    const encoded = value.slice(prefix.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || encoded.length > 4096) return { kind: 'unknown' }
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))
    if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '') !== encoded) return { kind: 'unknown' }
    const decoded = decodeURIComponent(Array.from(binary, ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
    if (!decoded || decoded.trim() !== decoded || decoded.length > 512 || /[\u0000-\u001f\u007f]/u.test(decoded)) return { kind: 'unknown' }
    return decoded === 'default' ? { kind: 'default' } : { kind: 'selection', value: decoded }
  } catch { return { kind: 'unknown' } }
}

const COST_BREAKDOWN_KEYS = ['inputCostUsd', 'outputCostUsd', 'cacheReadCostUsd', 'cacheWriteCostUsd', 'cacheSavingsUsd']

/**
 * Align a public-price breakdown with a Host total. Public tables carry the 5-minute
 * cache-write rate (1.25x input); Claude Code's 1h cache writes bill at 2x input, so a
 * total that differs only by that cache-write premium keeps its breakdown, with the
 * residual attributed to cache writes. Any other mismatch returns undefined.
 */
export function reconcileCostBreakdown(targetTotal, breakdown) {
  if (!Number.isFinite(targetTotal) || !breakdown || !Number.isFinite(breakdown.totalCostUsd) || breakdown.totalCostUsd <= 0) return undefined
  if (Math.abs(targetTotal - breakdown.totalCostUsd) <= Math.max(0.01, targetTotal * 0.05)) return breakdown
  const write = breakdown.cacheWriteCostUsd
  if (!Number.isFinite(write) || write <= 0) return undefined
  const fixed = breakdown.totalCostUsd - write
  const ratio = (targetTotal - fixed) / write
  // 1h / 5m write rate = 2 / 1.25 = 1.6; allow a small margin for mixed TTLs and rounding.
  if (!(ratio >= 0.95 && ratio <= 1.65)) return undefined
  return { ...breakdown, cacheWriteCostUsd: targetTotal - fixed, totalCostUsd: targetTotal }
}

function matchingCostBreakdown(targetTotal, localUsage) {
  const reconciled = reconcileCostBreakdown(targetTotal, localUsage)
  if (!reconciled) return {}
  return Object.fromEntries(COST_BREAKDOWN_KEYS.filter(key => Number.isFinite(reconciled[key]) && reconciled[key] >= 0).map(key => [key, reconciled[key]]))
}

/** Prefer current Host pricing; otherwise price recorded Turns without retaining a stale total. */
export function hostApiCostObservation(host, local) {
  const newerUsage = local?.cost?.latestUsageSeq !== undefined && host?.recordedSeq !== undefined && local.cost.latestUsageSeq > host.recordedSeq
  const hostPriced = host?.cost && hostCostLabel(host.usage, host.cost)
  if (!newerUsage && hostPriced) {
    if (Number.isFinite(host.usage?.inputCostUsd) && Number.isFinite(host.usage?.outputCostUsd)) return host
    const breakdown = matchingCostBreakdown(host.usage.totalCostUsd, local?.usage)
    return Object.keys(breakdown).length ? { ...host, usage: { ...host.usage, ...breakdown } } : host
  }
  const { totalCostUsd: staleCost, inputCostUsd: _i, outputCostUsd: _o, cacheReadCostUsd: _cr, cacheWriteCostUsd: _cw, cacheSavingsUsd: _cs, ...usage } = host?.usage ?? {}
  if (newerUsage && hostPriced) {
    // The two ledgers may have different historical coverage; never add overlapping totals.
    // Native billed dollars are not interchangeable with a public-price estimate.
    const totalCostUsd = host.cost.source === 'native' ? staleCost : Math.max(staleCost, local?.usage?.totalCostUsd ?? 0)
    const hostBreakdown = matchingCostBreakdown(totalCostUsd, host.usage)
    const breakdown = Object.keys(hostBreakdown).length ? hostBreakdown : matchingCostBreakdown(totalCostUsd, local?.usage)
    return { ...host, usage: { ...usage, ...breakdown, totalCostUsd }, cost: { ...local?.cost, source: host.cost.source, lowerBound: true } }
  }
  return { ...host, usage: { ...usage, ...local?.usage }, cost: local?.cost }
}

/** CodexHost renderer-usage-control.ts formatRendererCost / formatUsageCost, MIT. */
export function hostCostLabel(usage, cost) {
  if (!Number.isFinite(usage?.totalCostUsd) || usage.totalCostUsd < 0) return undefined
  const value = usage.totalCostUsd
  const formatted = `$${value.toFixed(Math.abs(value) >= 1 ? 2 : 3)}`
  return cost?.lowerBound || cost?.unpricedModels?.length ? `≥${formatted}` : formatted
}
