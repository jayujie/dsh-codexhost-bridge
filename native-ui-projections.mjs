/** Adapt external observations to the unchanged DSH renderer contracts. */
export function externalProjection(key, native, observation) {
  const usage = observation?.usage
  if (key === 'contextBreakdown') return undefined // External engines do not report these subdivisions.
  if (key === 'contextPressure') return usage?.contextWindowTokens > 0 && usage.contextUsedTokens !== undefined
    ? { pressureTokens: usage.contextUsedTokens, contextWindow: usage.contextWindowTokens } : undefined
  if (key === 'tokenUsage') {
    if (!usage || !['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'].every(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0)) return undefined
    const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens
    return uncachedInputTokens < 0 ? undefined : { uncachedInputTokens, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens, outputTokens: usage.outputTokens }
  }
  if (key === 'sessionStats' && native) {
    // Bridged chunks can arrive as a completed batch. Their local arrival times
    // are not model decode timings; never fall back to that synthetic rate.
    const rate = usage?.outputTokensPerSecond ?? usage?.turnAverageTokensPerSecond
    return { ...native, decodeTokens: Number.isFinite(rate) && rate > 0 ? rate : 0, decodeMs: Number.isFinite(rate) && rate > 0 ? 1000 : 0 }
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

/** Prefer current Host pricing; otherwise price recorded Turns without retaining a stale total. */
export function hostApiCostObservation(host, local) {
  const newerUsage = local?.cost?.latestUsageSeq !== undefined && host?.recordedSeq !== undefined && local.cost.latestUsageSeq > host.recordedSeq
  const hostPriced = host?.cost && hostCostLabel(host.usage, host.cost)
  if (!newerUsage && hostPriced) return host
  const { totalCostUsd: staleCost, ...usage } = host?.usage ?? {}
  if (newerUsage && hostPriced) {
    // The two ledgers may have different historical coverage; never add overlapping totals.
    // Native billed dollars are not interchangeable with a public-price estimate.
    const totalCostUsd = host.cost.source === 'native' ? staleCost : Math.max(staleCost, local?.usage?.totalCostUsd ?? 0)
    return { ...host, usage: { ...usage, totalCostUsd }, cost: { ...local?.cost, source: host.cost.source, lowerBound: true } }
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
