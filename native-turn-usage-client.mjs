// Display per-turn token usage for external Agent turns when DSH's strict
// single-attempt-per-step deriveTurnTokenUsage returns undefined (e.g. turns
// containing tool calls in step 1). Never duplicates native TurnUsagePanel.
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

const CH_TURN_USAGE_DEFAULT_PERFORMANCE = Object.freeze({
  subscribe: () => () => {},
  getSnapshot: () => 'detailed',
})

let chTurnUsageAnchorSeq = 0

function chTurnUsageIsCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function chTurnUsageSafeSum(values) {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

// Literal copy of external-engines.mjs (build-client.mjs strips imports). codexhost-* ids are read-only:
// Sessions created before 2026-11-27 recorded them; new Sessions use dsh-host-*.
const CH_TURN_USAGE_PRESETS = { 'dsh-host-codex': 'codex', 'dsh-host-claude-code': 'claude-code', 'dsh-host-antigravity': 'antigravity', 'codexhost-codex': 'codex', 'codexhost-claude-code': 'claude-code', 'codexhost-antigravity': 'antigravity' }
function chTurnUsageExternalOwner(preset) {
  return typeof preset === 'string' && Object.hasOwn(CH_TURN_USAGE_PRESETS, preset) ? CH_TURN_USAGE_PRESETS[preset] : null
}

export function normalizeExternalTurnUsage(usage, route) {
  if (!usage || typeof usage !== 'object') return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!chTurnUsageIsCount(inputTokens) || !chTurnUsageIsCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !chTurnUsageIsCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !chTurnUsageIsCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!chTurnUsageIsCount(reasoningTokens) || reasoningTokens > outputTokens)) return undefined
  const knownPrompt = chTurnUsageSafeSum([
    inputTokens,
    ...(cacheReadTokens === undefined ? [] : [cacheReadTokens]),
    ...(cacheWriteTokens === undefined ? [] : [cacheWriteTokens]),
  ])
  if (knownPrompt === undefined) return undefined
  let exactTotal
  if (totalTokens !== undefined) {
    if (!chTurnUsageIsCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!chTurnUsageIsCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) return undefined
    exactTotal = totalTokens
  } else {
    if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
    exactTotal = chTurnUsageSafeSum([knownPrompt, outputTokens])
    if (exactTotal === undefined) return undefined
  }
  if (exactTotal === 0) return undefined
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(route === undefined ? {} : { routes: [route] }),
  }
}

export function findExternalTurnRawUsage(snapshot, messageId) {
  if (!snapshot || !snapshot.nodes || typeof messageId !== 'string' || !messageId) return null
  const values = typeof snapshot.nodes.values === 'function' ? snapshot.nodes.values() : []
  let tailNode
  for (const node of values) {
    if (node?.kind === 'turn-tail' && node.data?.closing?.finalNode?.messageId === messageId) {
      tailNode = node
      break
    }
  }
  if (!tailNode || tailNode.data.tokenUsage !== undefined) return null
  const primary = tailNode.data.closing?.finalNode?.usage ?? tailNode.data.closing?.usage
  if (primary && typeof primary === 'object') return primary
  const turn = tailNode.data.turn
  const keys = typeof snapshot.locations?.getTurn === 'function' ? snapshot.locations.getTurn(turn) : undefined
  if (Array.isArray(keys) && typeof snapshot.nodes.get === 'function') {
    for (let index = keys.length - 1; index >= 0; index--) {
      const candidateNode = snapshot.nodes.get(keys[index])
      if (candidateNode?.kind !== 'assistant-step') continue
      const candidate = candidateNode.data?.finalNode?.usage ?? candidateNode.data?.usage
      if (candidate && typeof candidate === 'object') return candidate
    }
  }
  return null
}

export function resolveExternalTurnRoute(owner, identity, observation) {
  if (!owner) return undefined
  const rawModel = identity?.harnessId === owner
    ? (identity.model || identity.selectedModel)
    : observation?.harnessId === owner
      ? observation.model
      : undefined
  if (typeof rawModel !== 'string') return undefined
  const model = rawModel.trim()
  return model ? { provider: `dsh-host/${owner}`, model } : undefined
}

function chTurnUsageFormatTokens(value, t) {
  const scaled = candidate => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

function chTurnUsageFormatExactTokens(value, t) {
  const digits = String(value)
  const groups = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return groups.join(t('number.groupSeparator'))
}

function chTurnUsageRoundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
  const unitsPerPercent = decimalPlaces === 0 ? 1 : 10
  const scale = unitsPerPercent * 100
  const doubledScale = scale * 2
  const denominatorQuotient = Math.floor(denominator / doubledScale)
  const denominatorRemainder = denominator % doubledScale
  let lower = 0
  let upper = scale
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)
    if (cacheReadTokens >= threshold) lower = candidate
    else upper = candidate - 1
  }
  return lower
}

function chTurnUsageDisplayPercentUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) return String(units)
  const whole = Math.floor(units / 10)
  const tenths = units % 10
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`
}

function chTurnUsageFormatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 1) {
  if (promptTokens <= 0) return null
  const missedInputTokens = promptTokens - cacheReadTokens
  if (missedInputTokens <= 0) return '100'
  const roundedUnits = chTurnUsageRoundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces)
  const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000
  if (roundedUnits < fullHitUnits) return chTurnUsageDisplayPercentUnits(roundedUnits, decimalPlaces)
  let distinguishingPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(promptTokens / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    distinguishingPlaces += 1
  }
  const denominatorOnes = promptTokens % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`
}

function chTurnUsageCompactCount(value, t) {
  return t('message.turnUsage.count', { count: chTurnUsageFormatTokens(value, t) })
}

function chTurnUsageExactCount(value, t) {
  return t('message.turnUsage.count', { count: chTurnUsageFormatExactTokens(value, t) })
}

function ExternalTurnUsageAction({ messageId, useChat, useProjection, performanceUsage, t }) {
  const preset = useProjection('agentPreset')
  const identity = useProjection('dshHostModelIdentity')
  const observation = useProjection('dshHostObservation')
  const store = performanceUsage ?? CH_TURN_USAGE_DEFAULT_PERFORMANCE
  const mode = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const rawUsage = useChat(snapshot => findExternalTurnRawUsage(snapshot, messageId))
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const anchorRef = useRef(null)
  if (!anchorRef.current) anchorRef.current = `--ch-turn-usage-${++chTurnUsageAnchorSeq}`
  const anchorName = anchorRef.current

  const owner = chTurnUsageExternalOwner(preset)
  const usage = owner && mode === 'detailed' && rawUsage
    ? normalizeExternalTurnUsage(rawUsage, resolveExternalTurnRoute(owner, identity, observation))
    : undefined

  useEffect(() => {
    if (!usage && open) setOpen(false)
  }, [usage, open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const isInside = target => Boolean(
      target && (rootRef.current?.contains?.(target) || panelRef.current?.contains?.(target)),
    )
    const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
    const onPointerDown = event => { if (!isInside(event.target)) setOpen(false) }
    const onClick = event => { if (!isInside(event.target)) setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [open])

  if (!usage) return null

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : chTurnUsageFormatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = chTurnUsageCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''
  const dataIcon = IconDatabaseOutlineRegular ? h(IconDatabaseOutlineRegular) : null

  const dialog = open ? h('div', {
    ref: panelRef,
    className: 'ch-turn-usage-panel',
    role: 'dialog',
    'aria-label': t('message.turnUsage.title'),
    style: { positionAnchor: anchorName },
  },
  h('div', { className: 'ch-turn-usage-title' },
    h('span', { className: 'ch-turn-usage-title-label' }, dataIcon, t('message.turnUsage.title')),
    h('span', { className: 'ch-turn-usage-title-value' }, chTurnUsageExactCount(usage.totalTokens, t)),
  ),
  h('div', { className: 'ch-turn-usage-rule', 'aria-hidden': true }),
  h('dl', { className: 'ch-turn-usage-details', 'data-turn-usage-details': '' },
    routes !== '' ? h('dt', { key: 'model-k' }, t('message.turnUsage.model')) : null,
    routes !== '' ? h('dd', { key: 'model-v', className: 'ch-turn-usage-route' }, routes) : null,
    cacheHit !== null ? h('dt', { key: 'cache-k' }, t('message.turnUsage.cacheHit')) : null,
    cacheHit !== null ? h('dd', { key: 'cache-v' }, `${cacheHit}%`) : null,
    h('dt', { key: 'input-k' }, t('message.turnUsage.input')),
    h('dd', { key: 'input-v' }, chTurnUsageExactCount(usage.uncachedInputTokens, t)),
    usage.cacheReadTokens !== undefined ? h('dt', { key: 'cread-k' }, t('message.turnUsage.cacheRead')) : null,
    usage.cacheReadTokens !== undefined ? h('dd', { key: 'cread-v' }, chTurnUsageExactCount(usage.cacheReadTokens, t)) : null,
    usage.cacheWriteTokens !== undefined ? h('dt', { key: 'cwrite-k' }, t('message.turnUsage.cacheWrite')) : null,
    usage.cacheWriteTokens !== undefined ? h('dd', { key: 'cwrite-v' }, chTurnUsageExactCount(usage.cacheWriteTokens, t)) : null,
    h('dt', { key: 'output-k' }, t('message.turnUsage.output')),
    h('dd', { key: 'output-v' },
      chTurnUsageExactCount(usage.outputTokens, t),
      usage.reasoningTokens !== undefined
        ? h('span', { className: 'ch-turn-usage-reasoning' }, t('message.turnUsage.reasoning', { tokens: chTurnUsageExactCount(usage.reasoningTokens, t) }))
        : null,
    ),
  )) : null

  return h('span', {
    ref: rootRef,
    className: 'ch-turn-usage',
    'data-dsh-host-turn-usage': '',
    style: { anchorName },
  },
  h('button', {
    type: 'button',
    className: 'ch-turn-usage-trigger',
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    onClick: () => setOpen(value => !value),
  },
  dataIcon,
  h('span', { className: 'ch-turn-usage-label' }, t('message.turnUsage.consumed', { total })),
  ),
  dialog && typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog,
  )
}

export function installNativeTurnUsageClient(scope) {
  return scope.slots.inject('conversation.chat.assistant-actions', () => scope.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'dsh-host-turn-usage',
    order: 900,
    locale: 'chat',
    inject: sessionId => {
      let performanceUsage = CH_TURN_USAGE_DEFAULT_PERFORMANCE
      try {
        const turnTail = scope.slots.entriesOfSlot?.('conversation.chat.node')?.find(entry => entry.options?.key === 'turn-tail')
        const live = turnTail?.inject?.(sessionId)?.hooks?.performanceUsage
        if (live && typeof live.subscribe === 'function' && typeof live.getSnapshot === 'function') performanceUsage = live
      } catch {}
      return { performanceUsage }
    },
  }, ExternalTurnUsageAction))
}

export const nativeTurnUsageCss = `
[data-clock="end"]:has([data-dsh-host-turn-usage]) > :last-child { order: 2; margin-left: 0; }
.ch-turn-usage { display: inline-flex; min-width: 0; order: 1; margin-left: 8px; }
.ch-turn-usage-trigger {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0;
  height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-sm); background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  font-variant-numeric: tabular-nums;
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  white-space: nowrap; cursor: pointer;
}
.ch-turn-usage-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ch-turn-usage-trigger svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
  flex: none;
}
.ch-turn-usage-trigger[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}
@media (hover: hover) {
  .ch-turn-usage-trigger:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-tertiary);
  }
}
@media (max-width: 480px) {
  .ch-turn-usage-trigger { justify-content: center; width: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px; }
  .ch-turn-usage-trigger .ch-turn-usage-label { display: none; }
}
.ch-turn-usage-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  width: max-content; min-width: min(300px, calc(100vw - 24px)); max-width: min(440px, calc(100vw - 24px));
  padding: 16px; border: 0; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: default;
  max-height: calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));
  overflow-x: hidden; overflow-y: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
  position-area: none;
  top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px));
  left: max(12px, anchor(left)); right: 12px;
  position-try-fallbacks: --ch-turn-usage-window, --ch-turn-usage-opposite, --ch-turn-usage-wide-opposite, --ch-turn-usage-tall, --ch-turn-usage-viewport;
  align-self: end; justify-self: start; height: fit-content; min-height: 0; margin: 0;
}
.ch-turn-usage-title {
  display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px;
  color: var(--dsw-alias-label-primary); font-weight: 500;
}
.ch-turn-usage-rule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.ch-turn-usage-title-value { font-variant-numeric: tabular-nums; }
.ch-turn-usage-title-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ch-turn-usage-title-label svg { width: 14px; height: 14px; flex: none; }
.ch-turn-usage-details {
  display: grid; grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px; margin: 0; color: var(--dsw-alias-label-tertiary);
}
.ch-turn-usage-details dt, .ch-turn-usage-details dd { min-width: 0; margin: 0; }
.ch-turn-usage-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.ch-turn-usage-details .ch-turn-usage-route { overflow-wrap: anywhere; }
.ch-turn-usage-reasoning { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
@position-try --ch-turn-usage-window {
  position-area: none; top: max(12px, var(--dsh-frame-overlay-top, 12px));
  bottom: max(12px, calc(anchor(top) + 8px)); left: 12px; right: 12px; margin: 0;
  align-self: safe end; justify-self: safe end;
}
@position-try --ch-turn-usage-opposite { top: max(12px, calc(anchor(bottom) + 8px)); bottom: 12px; align-self: start; }
@position-try --ch-turn-usage-wide-opposite {
  top: max(12px, calc(anchor(bottom) + 8px)); bottom: 12px; left: 12px; right: 12px;
  align-self: start; justify-self: safe end;
}
@position-try --ch-turn-usage-tall {
  position-area: none; top: max(12px, var(--dsh-frame-overlay-top, 12px)); bottom: 12px;
  left: max(12px, anchor(left)); right: 12px; margin: 0; align-self: safe start; justify-self: start;
}
@position-try --ch-turn-usage-viewport {
  position-area: none; inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px; margin: 0;
  align-self: safe start; justify-self: safe end;
}
`
