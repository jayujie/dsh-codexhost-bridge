// UI-only projection of durable, ignorable plugin compaction events. No execution or model surface writes.
// Literal copy of host-identity.mjs (build-client.mjs strips imports): write dsh-host, read both.
// The plugin:codexhost/* names are read-only compatibility with sessions recorded before 2026-11-27.
const NATIVE_COMPACTION_EVENTS = ['plugin:dsh-host/compaction', 'plugin:codexhost/compaction']
const NATIVE_COMPACTION_ITEM_EVENTS = ['plugin:dsh-host/item', 'plugin:codexhost/item']
const NATIVE_COMPACTION_HARNESSES = new Set(['codex', 'claude-code', 'antigravity'])
const NATIVE_COMPACTION_PHASES = new Set(['started', 'completed', 'failed'])
const NATIVE_COMPACTION_NODE_KIND = 'dsh-host-compaction'
const NATIVE_COMPACTION_TRANSLATION_CACHE = new Map()
const NATIVE_COMPACTION_TRANSLATION_CACHE_MAX = 500

const NATIVE_COMPACTION_MD_LABELS = Object.freeze({
  code: {
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码块', wrapLabel: '自动换行', unwrapLabel: '不换行' },
  },
  footnotes: '脚注',
})

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
  if (NATIVE_COMPACTION_EVENTS.includes(event?.type)) {
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
  if (NATIVE_COMPACTION_ITEM_EVENTS.includes(event?.type)) {
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

export function nativeCompactionFormat(state) {
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
  const nativeSummary = typeof state.summary === 'string' && state.summary.trim() ? state.summary.trim() : ''
  let changeSummary = ''
  if (hasBefore && hasAfter) {
    const freed = state.beforeTokens - state.afterTokens
    const freedPart = freed > 0 ? `，释放约 ${nativeCompactionFormatTokens(freed)} tokens` : ''
    changeSummary = `${nativeCompactionFormatTokens(state.beforeTokens)} → ${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens${freedPart}`
  } else if (hasAfter) {
    changeSummary = `压缩后 ${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens`
  } else if (hasBefore) {
    changeSummary = `压缩前 ${nativeCompactionFormatTokens(state.beforeTokens)}${windowSuffix} tokens`
  }
  const headerLine = changeSummary ? `${prefix} · ${changeSummary}` : `${prefix}完成`
  if (nativeSummary) {
    const header = changeSummary ? `> **${prefix}** · ${changeSummary}` : `> **${prefix}**`
    return { headline, headerLine, summaryBody: nativeSummary, detail: `${header}\n\n---\n\n${nativeSummary}` }
  }
  const lines = [`- **方式**：${prefix}`]
  if (hasBefore && hasAfter) {
    lines.push(`- **上下文变化**：${changeSummary}`)
  } else if (hasAfter) {
    lines.push(`- **压缩后上下文**：${nativeCompactionFormatTokens(state.afterTokens)}${windowSuffix} tokens`)
  } else if (hasBefore) {
    lines.push(`- **压缩前上下文**：${nativeCompactionFormatTokens(state.beforeTokens)}${windowSuffix} tokens`)
  }
  return { headline, headerLine, summaryBody: '', detail: lines.join('\n') }
}

/**
 * Split compaction summary Markdown into paragraph-preserving chunks that stay
 * within the translator's per-request UTF-16 character limit.
 */
export function splitCompactionTranslationFragments(text, maxTextChars) {
  if (typeof text !== 'string' || !text) return []
  const limit = Number.isFinite(maxTextChars) && maxTextChars >= 64 ? Math.floor(maxTextChars) : 2000
  const result = []
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  let start = 0
  while (true) {
    const match = separator.exec(text)
    let remaining = text.slice(start, match?.index ?? text.length)
    while (remaining.length > limit) {
      let cut = limit
      if (/[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1
      const newline = remaining.lastIndexOf('\n', cut)
      if (newline > Math.floor(limit * 0.35)) {
        cut = newline
      } else {
        const whitespace = remaining.slice(0, cut).search(/\s+\S*$/)
        if (whitespace > 0) cut = whitespace
      }
      const source = remaining.slice(0, cut)
      remaining = remaining.slice(cut)
      const suffix = remaining.match(/^\s+/)?.[0] ?? ''
      remaining = remaining.slice(suffix.length)
      result.push({ text: source, suffix })
    }
    result.push({ text: remaining, suffix: match?.[0] ?? '' })
    if (match === null) return result
    start = match.index + match[0].length
  }
}

function compactionProviderDisplayName(provider) {
  if (provider === 'bing') return 'Bing'
  if (provider === 'google') return 'Google'
  if (provider === 'deepseek-account' || provider === 'deepseek-official') return 'DeepSeek'
  return provider || '翻译'
}

function compactionCacheGet(key) {
  return NATIVE_COMPACTION_TRANSLATION_CACHE.get(key)
}

function compactionCacheSet(key, value) {
  if (NATIVE_COMPACTION_TRANSLATION_CACHE.size >= NATIVE_COMPACTION_TRANSLATION_CACHE_MAX) {
    const firstKey = NATIVE_COMPACTION_TRANSLATION_CACHE.keys().next().value
    if (firstKey !== undefined) NATIVE_COMPACTION_TRANSLATION_CACHE.delete(firstKey)
  }
  NATIVE_COMPACTION_TRANSLATION_CACHE.set(key, value)
}

/**
 * Translate a compaction summary progressively using DSH's mounted cotTranslation Remote
 * (e.g. Bing), invoking `onProgress` as each paragraph completes.
 */
export async function translateCompactionSummary({ text, sessionId, cotRemote, targetLocale, signal, onProgress }) {
  if (!text || !cotRemote || typeof cotRemote.limits !== 'function' || typeof cotRemote.translate !== 'function') {
    return { available: false, text }
  }
  const limRes = await cotRemote.limits(signal)
  if (signal?.aborted) return { available: true, aborted: true, text }
  if (!limRes?.ok || !limRes.value) throw new Error('translation limits unavailable')
  const { maxTextChars, preferences } = limRes.value
  const provider = preferences?.provider
  if (typeof provider !== 'string' || !provider) throw new Error('translation provider unavailable')
  const rawLang = preferences?.targetLanguage || 'auto'
  const targetLanguage = rawLang === 'auto' ? (targetLocale || 'zh-Hans') : rawLang
  const fragments = splitCompactionTranslationFragments(text, maxTextChars)
  const translatedParts = fragments.map(fragment => {
    if (!fragment.text.trim()) return fragment.text
    const cached = compactionCacheGet(`${provider}\0${targetLanguage}\0${fragment.text}`)
    return cached ?? fragment.text
  })
  const compose = () => fragments.map((fragment, idx) => translatedParts[idx] + fragment.suffix).join('')
  const pendingIndices = []
  for (let i = 0; i < fragments.length; i++) {
    const chunk = fragments[i].text
    if (!chunk.trim()) continue
    if (compactionCacheGet(`${provider}\0${targetLanguage}\0${chunk}`) === undefined) pendingIndices.push(i)
  }
  if (pendingIndices.length === 0) {
    const done = compose()
    onProgress?.({ text: done, pending: false, failed: false, provider, translatedCount: fragments.length, totalCount: fragments.length })
    return { available: true, text: done, provider }
  }
  onProgress?.({ text: compose(), pending: true, failed: false, provider, translatedCount: fragments.length - pendingIndices.length, totalCount: fragments.length })
  let doneCount = fragments.length - pendingIndices.length
  for (const idx of pendingIndices) {
    if (signal?.aborted) return { available: true, aborted: true, text: compose(), provider }
    const chunk = fragments[idx].text
    const res = await cotRemote.translate({ provider, targetLanguage, text: chunk, sessionId }, signal)
    if (signal?.aborted) return { available: true, aborted: true, text: compose(), provider }
    if (!res?.ok || typeof res.value !== 'string') throw new Error(res?.error?.message || 'translation failed')
    compactionCacheSet(`${provider}\0${targetLanguage}\0${chunk}`, res.value)
    translatedParts[idx] = res.value
    doneCount += 1
    onProgress?.({
      text: compose(),
      pending: doneCount < fragments.length,
      failed: false,
      provider,
      translatedCount: doneCount,
      totalCount: fragments.length,
    })
  }
  const finalText = compose()
  return { available: true, text: finalText, provider }
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
    kind: 'dsh-host-native-compaction-chat',
    target: 'chat',
    match: {
      ...Object.fromEntries([...NATIVE_COMPACTION_EVENTS, ...NATIVE_COMPACTION_ITEM_EVENTS].map(type => [type, nativeCompactionMatch])),
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
      const { headline, headerLine, summaryBody, detail } = nativeCompactionFormat(state)
      return {
        ...envelope,
        kind: NATIVE_COMPACTION_NODE_KIND,
        data: {
          kind: NATIVE_COMPACTION_NODE_KIND,
          seq: latest.seq,
          time,
          mode: state.mode,
          harnessId: state.harnessId ?? null,
          headerLine,
          headline,
          summaryBody: summaryBody || null,
          detail,
          beforeTokens: state.beforeTokens ?? null,
          afterTokens: state.afterTokens ?? null,
          contextWindowTokens: state.contextWindowTokens ?? null,
        },
      }
    },
  }
}

function nativeCompactionSvg(pathD, size = 14) {
  return h('svg', {
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }, h('path', { d: pathD }))
}

function NativeCompactionNodeView({ node, sessionId, getCotTranslation, locale }) {
  const data = node?.data ?? {}
  const summaryBody = typeof data.summaryBody === 'string' && data.summaryBody.trim() ? data.summaryBody : ''
  const [open, setOpen] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [translation, setTranslation] = useState({ available: false, text: summaryBody, pending: false, failed: false, provider: null })
  const lastSummaryRef = useRef(summaryBody)

  useEffect(() => {
    if (lastSummaryRef.current !== summaryBody) {
      lastSummaryRef.current = summaryBody
      setTranslation({ available: false, text: summaryBody, pending: false, failed: false, provider: null })
    }
  }, [summaryBody])

  useEffect(() => {
    if (!open || !summaryBody) return undefined
    const cotRemote = typeof getCotTranslation === 'function' ? getCotTranslation() : null
    if (!cotRemote || typeof cotRemote.limits !== 'function' || typeof cotRemote.translate !== 'function') {
      setTranslation({ available: false, text: summaryBody, pending: false, failed: false, provider: null })
      return undefined
    }
    const controller = new AbortController()
    const targetLocale = locale?.getSnapshot?.()?.active || 'zh-Hans'
    let active = true
    setTranslation(prev => ({ ...prev, available: true, pending: true, failed: false }))
    translateCompactionSummary({
      text: summaryBody,
      sessionId,
      cotRemote,
      targetLocale,
      signal: controller.signal,
      onProgress: update => {
        if (!active) return
        setTranslation({
          available: true,
          text: update.text,
          pending: update.pending,
          failed: false,
          provider: update.provider,
        })
      },
    }).then(result => {
      if (!active || result?.aborted) return
      if (!result?.available) {
        setTranslation({ available: false, text: summaryBody, pending: false, failed: false, provider: null })
      } else {
        setTranslation({
          available: true,
          text: result.text,
          pending: false,
          failed: false,
          provider: result.provider ?? null,
        })
      }
    }).catch(() => {
      if (!active || controller.signal.aborted) return
      setTranslation(prev => ({ ...prev, available: true, pending: false, failed: true }))
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [open, summaryBody, sessionId, getCotTranslation, locale, retryTick])

  const primitives = typeof UiPrimitives !== 'undefined' ? UiPrimitives : null
  const ApiIcon = primitives?.IconApiOutlineRegular
  const ChevronDown = primitives?.IconChevronDownOutlineRegular
  const ChevronRight = primitives?.IconChevronRightOutlineRegular
  const SpinnerIcon = primitives?.IconLoadingOutlineRegular
  const MarkdownText = primitives?.MarkdownText

  const leadingIcon = ApiIcon ? h(ApiIcon, { size: 14 }) : nativeCompactionSvg('M3 4.5 6.5 8 3 11.5M8.5 11.5h4.5', 14)
  const chevronIcon = open
    ? (ChevronDown ? h(ChevronDown, { size: 14 }) : nativeCompactionSvg('M4 6l4 4 4-4', 14))
    : (ChevronRight ? h(ChevronRight, { size: 14 }) : nativeCompactionSvg('M6 4l4 4-4 4', 14))
  const cotAvailableNow = Boolean(typeof getCotTranslation === 'function' && getCotTranslation())
  const effectiveShowOriginal = showOriginal || translation.failed || !translation.available
  const displayBody = effectiveShowOriginal ? summaryBody : (translation.text || summaryBody)
  const providerName = compactionProviderDisplayName(translation.provider)

  return h('div', { className: 'ch-compaction', 'data-dsh-host-compaction': '' },
    h('div', { className: 'ch-compaction-header' },
      h('span', { className: 'ch-compaction-icon', 'aria-hidden': true }, leadingIcon),
      h('span', { className: 'ch-compaction-headline' }, data.headerLine || data.headline || '上下文已压缩'),
    ),
    summaryBody ? h('div', { className: 'ch-compaction-disclosure', 'data-open': open ? 'true' : 'false' },
      h('button', {
        type: 'button',
        className: 'ch-compaction-toggle',
        'aria-expanded': open,
        onClick: () => setOpen(value => !value),
      },
        h('span', { className: 'ch-compaction-chevron', 'aria-hidden': true }, chevronIcon),
        h('span', { className: 'ch-compaction-toggle-label' }, open ? '收起压缩摘要' : '查看压缩摘要'),
        !open ? h('span', { className: 'ch-compaction-toggle-hint' }, cotAvailableNow ? '点击展开 · 自动翻译' : '点击展开') : null,
      ),
      open ? h('div', { className: 'ch-compaction-body', 'data-compaction-summary-body': '' },
        translation.available ? h('div', { className: 'ch-compaction-toolbar' },
          h('button', {
            type: 'button',
            className: 'ch-compaction-action',
            disabled: translation.failed,
            onClick: () => setShowOriginal(value => !value),
          }, effectiveShowOriginal ? '查看译文' : '查看原文'),
          translation.pending ? h('span', { className: 'ch-compaction-status', role: 'status' },
            SpinnerIcon ? h(SpinnerIcon, { size: 13, className: 'ch-compaction-spinner' }) : null,
            `正在使用 ${providerName} 翻译…`,
          ) : null,
          !translation.pending && !translation.failed && !effectiveShowOriginal ? h('span', { className: 'ch-compaction-status' }, `已由 ${providerName} 翻译`) : null,
          translation.failed ? h('span', { className: 'ch-compaction-status ch-compaction-status-error', role: 'status' }, '翻译暂不可用，已显示原文') : null,
          translation.failed ? h('button', {
            type: 'button',
            className: 'ch-compaction-action',
            onClick: () => setRetryTick(value => value + 1),
          }, '重试') : null,
        ) : null,
        MarkdownText
          ? h(MarkdownText, { text: displayBody, labels: NATIVE_COMPACTION_MD_LABELS, variant: 'compact' })
          : h('pre', { className: 'ch-compaction-fallback' }, displayBody),
      ) : null,
    ) : null,
  )
}

export const nativeCompactionCss = `
.ch-compaction {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 2px 0;
}
.ch-compaction-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.ch-compaction-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.ch-compaction-headline {
  min-width: 0;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.ch-compaction-disclosure {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-left: 22px;
}
.ch-compaction-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 100%;
  padding: 2px 8px 2px 4px;
  margin-left: -4px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 0.5px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
@media (hover: hover) {
  .ch-compaction-toggle:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.ch-compaction-disclosure[data-open='true'] > .ch-compaction-toggle {
  position: sticky;
  top: 0;
  z-index: 7;
  width: 100%;
  border-radius: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
}
.ch-compaction-chevron {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.ch-compaction-toggle-label {
  font-weight: 500;
}
.ch-compaction-toggle-hint {
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));
  font-size: 11px;
  opacity: 0.85;
}
.ch-compaction-body {
  margin-top: 4px;
  padding: 8px 12px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  border-radius: 0 var(--dsw-radius-md, 8px) var(--dsw-radius-md, 8px) 0;
  background: var(--dsw-alias-fill-l1, transparent);
  min-width: 0;
}
.ch-compaction-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
  min-height: 24px;
}
.ch-compaction-action {
  padding: 2px 8px;
  margin-left: -8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
@media (hover: hover) {
  .ch-compaction-action:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.ch-compaction-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.ch-compaction-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.ch-compaction-status-error {
  color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary));
}
.ch-compaction-spinner {
  animation: ch-compaction-spin 1s linear infinite;
}
@keyframes ch-compaction-spin {
  to { transform: rotate(360deg); }
}
.ch-compaction-fallback {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
`

/** Register native compaction projection and collapsible translated chat node into DSH Chat UI. */
export function installNativeCompactionClient(ctx) {
  let disposed = false
  const disposeEvents = ctx.uiConversation.events.register(nativeCompactionDefinition())
  const getCotTranslation = () => ctx.get?.('remote.cotTranslation') ?? ctx.remote?.cotTranslation ?? null
  const disposeSlot = typeof ctx.slots?.inject === 'function' && typeof ctx.slots?.register === 'function'
    ? ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
      name: 'conversation.chat.node',
      key: NATIVE_COMPACTION_NODE_KIND,
      locale: 'chat',
      inject: sessionId => ({ sessionId, getCotTranslation, locale: ctx.locale }),
    }, NativeCompactionNodeView))
    : null
  return () => {
    if (disposed) return
    disposed = true
    disposeSlot?.()
    disposeEvents()
  }
}
