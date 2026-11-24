// UI-only projection of durable, ignorable plugin compaction events. No execution or model surface writes.
const NATIVE_COMPACTION_EVENT = 'plugin:codexhost/compaction'
const NATIVE_COMPACTION_ITEM_EVENT = 'plugin:codexhost/item'
const NATIVE_COMPACTION_HARNESSES = new Set(['codex', 'claude-code', 'antigravity'])
const NATIVE_COMPACTION_PHASES = new Set(['started', 'completed', 'failed'])

function nativeCompactionEngineLabel(harnessId) {
  if (harnessId === 'codex') return 'Codex'
  if (harnessId === 'claude-code') return 'Claude Code'
  if (harnessId === 'antigravity') return 'Antigravity'
  return undefined
}

function nativeCompactionFormatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(value))
}

function nativeCompactionRecord(event) {
  const data = event?.data
  if (event?.type === NATIVE_COMPACTION_EVENT) {
    if (!data || data.version !== 1
      || typeof data.threadId !== 'string' || !data.threadId
      || typeof data.turnId !== 'string' || !data.turnId
      || typeof data.compactionId !== 'string' || !data.compactionId
      || !NATIVE_COMPACTION_PHASES.has(data.phase)
      || (data.mode !== undefined && data.mode !== 'auto' && data.mode !== 'manual')
      || (data.harnessId !== undefined && !NATIVE_COMPACTION_HARNESSES.has(data.harnessId))
      || (data.beforeTokens !== undefined && (typeof data.beforeTokens !== 'number' || !Number.isFinite(data.beforeTokens) || data.beforeTokens < 0))
      || (data.afterTokens !== undefined && (typeof data.afterTokens !== 'number' || !Number.isFinite(data.afterTokens) || data.afterTokens < 0))
      || (data.contextWindowTokens !== undefined && (typeof data.contextWindowTokens !== 'number' || !Number.isFinite(data.contextWindowTokens) || data.contextWindowTokens <= 0))
      || (data.summary !== undefined && typeof data.summary !== 'string')
      || (data.error !== undefined && typeof data.error !== 'string')) return null
    return {
      source: 'compaction',
      threadId: data.threadId,
      turnId: data.turnId,
      compactionId: data.compactionId,
      harnessId: data.harnessId,
      mode: data.mode ?? 'auto',
      phase: data.phase,
      beforeTokens: data.beforeTokens,
      afterTokens: data.afterTokens,
      contextWindowTokens: data.contextWindowTokens,
      summary: data.summary,
      error: data.error,
    }
  }
  if (event?.type === NATIVE_COMPACTION_ITEM_EVENT) {
    if (!data || typeof data.threadId !== 'string' || !data.threadId
      || typeof data.turnId !== 'string' || !data.turnId
      || !data.item || data.item.type !== 'contextCompaction') return null
    const compactionId = (typeof data.item.id === 'string' && data.item.id)
      ? data.item.id
      : (typeof data.item.itemId === 'string' && data.item.itemId)
        ? data.item.itemId
        : 'contextCompaction'
    const summary = typeof data.item.summary === 'string'
      ? data.item.summary
      : typeof data.item.text === 'string'
        ? data.item.text
        : undefined
    return {
      source: 'item',
      threadId: data.threadId,
      turnId: data.turnId,
      compactionId,
      harnessId: undefined,
      mode: 'auto',
      phase: data.item.status === 'failed' ? 'failed' : 'completed',
      beforeTokens: undefined,
      afterTokens: undefined,
      contextWindowTokens: undefined,
      summary,
      error: typeof data.item.error?.message === 'string' ? data.item.error.message : undefined,
    }
  }
  return null
}

function nativeCompactionIdentity(record) {
  return JSON.stringify([record.threadId, record.turnId, record.compactionId])
}

function nativeCompactionMatch(event) {
  const parsed = nativeCompactionRecord(event)
  return parsed === null ? null : { id: nativeCompactionIdentity(parsed), role: 'update' }
}

function nativeCompactionFormat(state) {
  const engine = nativeCompactionEngineLabel(state.harnessId)
  const modeLabel = state.mode === 'manual' ? '手动压缩' : '自动压缩'
  const prefix = engine ? `${engine} ${modeLabel}` : `上下文${modeLabel}`
  const hasBefore = typeof state.beforeTokens === 'number' && state.beforeTokens > 0
  const hasAfter = typeof state.afterTokens === 'number' && state.afterTokens > 0
  const windowSuffix = typeof state.contextWindowTokens === 'number' && state.contextWindowTokens > 0
    ? ` / ${nativeCompactionFormatTokens(state.contextWindowTokens)}`
    : ''
  let headline
  if (hasBefore && hasAfter) {
    headline = `${prefix}（${nativeCompactionFormatTokens(state.beforeTokens)} → ${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens）`
  } else if (hasAfter) {
    headline = `${prefix}（当前 ${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens）`
  } else if (hasBefore) {
    headline = `${prefix}（压缩前 ${nativeCompactionFormatTokens(state.beforeTokens)}${windowSuffix} tokens）`
  } else {
    headline = `${prefix}完成`
  }
  const lines = [`- **方式**：${prefix}`]
  if (hasBefore && hasAfter) {
    const freed = state.beforeTokens - state.afterTokens
    const freedPart = freed > 0 ? `，释放约 ${nativeCompactionFormatTokens(freed)} tokens` : ''
    lines.push(`- **上下文变化**：${nativeCompactionFormatTokens(state.beforeTokens)} → ${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens${freedPart}`)
  } else if (hasAfter) {
    lines.push(`- **压缩后上下文**：${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens`)
  } else if (hasBefore) {
    lines.push(`- **压缩前上下文**：${nativeCompactionFormatTokens(state.beforeTokens)}${windowSuffix} tokens`)
  }
  const nativeSummary = typeof state.summary === 'string' && state.summary.trim() ? state.summary.trim() : ''
  const detail = nativeSummary ? `${lines.join('\n')}\n\n${nativeSummary}` : lines.join('\n')
  return { headline, detail }
}

function nativeCompactionProjection(context) {
  const ordered = [...context.matches].sort((left, right) => left.event.seq - right.event.seq)
  let first
  let latest
  let state = null
  for (const match of ordered) {
    const parsed = nativeCompactionRecord(match.event)
    if (parsed === null || nativeCompactionIdentity(parsed) !== context.id) continue
    if (first === undefined) first = match.event
    latest = match.event
    if (state === null) {
      state = { ...parsed }
      continue
    }
    const terminal = state.phase === 'completed' || state.phase === 'failed'
    if (parsed.source === 'compaction' || state.source === 'item') {
      state.source = parsed.source === 'compaction' ? 'compaction' : state.source
      if (parsed.harnessId !== undefined) state.harnessId = parsed.harnessId
      if (parsed.source === 'compaction') state.mode = parsed.mode
      if (!terminal || parsed.phase !== 'started') state.phase = parsed.phase
      if (parsed.beforeTokens !== undefined) state.beforeTokens = parsed.beforeTokens
      if (parsed.afterTokens !== undefined) state.afterTokens = parsed.afterTokens
      if (parsed.contextWindowTokens !== undefined) state.contextWindowTokens = parsed.contextWindowTokens
      if (parsed.summary !== undefined && parsed.summary.trim()) state.summary = parsed.summary
      if (parsed.error !== undefined && parsed.error.trim()) state.error = parsed.error
    } else if (parsed.summary !== undefined && parsed.summary.trim() && !state.summary) {
      state.summary = parsed.summary
    }
  }
  if (state === null || first === undefined || latest === undefined) return null
  return { first, latest, state }
}

function nativeCompactionDefinition() {
  return {
    kind: 'codexhost-native-compaction-chat',
    target: 'chat',
    match: {
      [NATIVE_COMPACTION_EVENT]: nativeCompactionMatch,
      [NATIVE_COMPACTION_ITEM_EVENT]: nativeCompactionMatch,
    },
    start: (_context, match) => match.event,
    update: (_context, match) => match.event,
    publication: () => 'immediate',
    buildViewNode(context) {
      const projected = nativeCompactionProjection(context)
      if (projected === null) return null
      const { first, latest, state } = projected
      const time = latest.time ?? first.time
      const envelope = {
        key: context.key,
        id: context.id,
        target: 'chat',
        anchorSeq: first.seq,
        location: { kind: 'session' },
        visibility: 'visible',
      }
      if (state.phase === 'started') {
        return {
          ...envelope,
          kind: 'manual-compaction',
          data: {
            command: { kind: 'command', seq: first.seq, time, commandId: context.id, name: 'compact', args: null, outcome: null },
            compaction: null,
          },
        }
      }
      if (state.phase === 'failed') {
        return {
          ...envelope,
          kind: 'manual-compaction',
          data: {
            command: { kind: 'command', seq: first.seq, time, commandId: context.id, name: 'compact', args: null, outcome: { kind: 'error', text: state.error || '上下文压缩失败' } },
            compaction: null,
          },
        }
      }
      const { headline, detail } = nativeCompactionFormat(state)
      const compaction = {
        kind: 'compaction',
        seq: latest.seq,
        time,
        summary: detail,
        summaryEventSeq: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
      }
      if (state.mode === 'manual') {
        return {
          ...envelope,
          kind: 'manual-compaction',
          data: {
            command: { kind: 'command', seq: first.seq, time, commandId: context.id, name: 'compact', args: null, outcome: { kind: 'success', text: headline } },
            compaction,
          },
        }
      }
      return {
        ...envelope,
        kind: 'compaction',
        data: compaction,
      }
    },
  }
}

/** Register native compaction projection into DSH Chat UI; caller must inject uiConversation. */
export function installNativeCompactionClient(ctx) {
  let disposed = false
  const dispose = ctx.uiConversation.events.register(nativeCompactionDefinition())
  return () => {
    if (disposed) return
    disposed = true
    dispose()
  }
}
