/** Exact ledger counters only: no prices, context RPCs, estimates, or missing-bucket defaults. */
export function dshHostTokenUsageNotification(threadId, turnId, usage) {
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId || !usage) return null
  const fields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'totalTokens']
  if (!fields.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null
  if (usage.inputTokens < usage.cachedInputTokens + usage.cacheWriteInputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens || usage.totalTokens === 0) return null
  const total = Object.fromEntries(fields.map(key => [key, usage[key]]))
  if (usage.reasoningOutputTokens !== undefined) {
    if (!Number.isSafeInteger(usage.reasoningOutputTokens) || usage.reasoningOutputTokens < 0 || usage.reasoningOutputTokens > usage.outputTokens) return null
    total.reasoningOutputTokens = usage.reasoningOutputTokens
  }
  // Private notification: standard Codex events may require last/context fields
  // that the ledger cannot supply. Do not invent those fields or change that schema.
  return { method: 'codexhost/thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total } } }
}
