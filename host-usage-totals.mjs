/** Aggregate a complete, de-duplicated Host request ledger using its unified input convention. */
export function hostUsageTotals(requests) {
  const rows = [...requests]
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens']) {
    if (!rows.every(row => Number.isSafeInteger(row[key]) && row[key] >= 0)) continue
    const value = rows.reduce((total, row) => total + row[key], 0)
    if (!Number.isSafeInteger(value)) return undefined
    result[key] = value
  }
  if (result.inputTokens === undefined || result.outputTokens === undefined) return undefined
  const total = result.inputTokens + result.outputTokens
  if (!Number.isSafeInteger(total)) return undefined
  result.totalTokens = total
  return result
}
