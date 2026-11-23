import { randomUUID } from 'node:crypto'

/** Generate from a detached native child and commit only while the original fallback is current. */
export async function completeNativeClaudeTitle(ctx, agent, peer, mapping, firstMessage, signal, policy) {
  const service = ctx.get('sessionTitle'), current = service?.get(agent.session)
  if (!policy?.enabled || current?.source.kind !== 'fallback' || typeof firstMessage?.text !== 'string' || !firstMessage.text.trim()) return false
  signal.throwIfAborted()
  const expectedSeq = current.eventSeq, expectedTitle = current.title
  const description = Buffer.from(firstMessage.text).subarray(0, policy.maxInputBytes).toString('utf8').replace(/\uFFFD$/, '').trim()
  if (!description) return false
  const { appendPluginRecord } = await ctx.loader.import('@deepseek-ai/dsh-session')
  const unchanged = () => {
    const value = service.get(agent.session)
    return value?.eventSeq === expectedSeq && value.title === expectedTitle && value.source.kind === 'fallback'
  }
  if (!unchanged()) return false
  const operationId = randomUUID(), threadId = mapping.threadId
  const audit = data => appendPluginRecord(agent.session, 'plugin:codexhost/native-title', { version: 1, threadId, operationId, ...data })
  const flush = () => ctx.sessionPersistence.flush()
  audit({ phase: 'request', messageSeqs: [firstMessage.seq], description, model: policy.model, maxOutputTokens: policy.maxOutputTokens, timeoutMs: policy.timeoutMs, maxCostUsd: policy.maxCostUsd, extraBeta: 'claude-code-20250219', cachePolicy: 'disabled-client' })
  await flush()
  let dispatched = false
  const cancel = () => {
    if (dispatched) void peer.request('dsh/claude/title/cancel', { threadId, operationId }, { timeoutMs: 10000 }).catch(error => ctx.logger?.warn(`Claude title cancellation unavailable: ${error.code ?? error.name}`))
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    dispatched = true
    const result = await peer.request('dsh/claude/title/generate', { threadId, operationId, description, model: policy.model, maxOutputTokens: policy.maxOutputTokens, timeoutMs: policy.timeoutMs, maxCostUsd: policy.maxCostUsd }, { timeoutMs: policy.timeoutMs + 5000 })
    signal.throwIfAborted()
    if (!unchanged()) { audit({ phase: 'result', status: 'superseded' }); await flush(); return false }
    if (typeof result?.title !== 'string' || result.detached !== true || result.cachePolicy !== 'disabled-client') throw new Error('Invalid isolated native title result')
    const title = result.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (!title || Buffer.byteLength(title) > 512) throw new Error('Invalid native title text')
    agent.session.append('session/title', { title, messageSeqs: [firstMessage.seq], source: { kind: 'provider', provider: 'codexhost-native-title' } })
    audit({ phase: 'result', status: 'committed', title }); await flush()
    const committed = service.get(agent.session)
    if (!signal.aborted && committed?.title === title && committed.source.kind === 'provider' && committed.source.provider === 'codexhost-native-title') {
      try { await peer.request('thread/name/set', { threadId, name: title }, { timeoutMs: 10000 }) }
      catch (error) { ctx.logger?.warn(`Claude title saved in DSH; Host name sync unavailable: ${error.code ?? error.name}`) }
    }
    return true
  } catch (error) {
    audit({ phase: 'result', status: signal.aborted ? 'cancelled' : 'failed', error: error.code ?? error.name }); await flush()
    throw error
  } finally { signal.removeEventListener('abort', cancel) }
}
