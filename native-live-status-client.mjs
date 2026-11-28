import { createElement as h, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

const LIVE_STATUS_POLL_MS = 500
const STALL_WARN_MS = 60_000
const ENGINE_BADGE = { codex: 'Codex', 'claude-code': 'Claude', antigravity: 'AGY' }

function formatLiveDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const mins = Math.floor(sec / 60)
  const rem = sec % 60
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`
}

function formatSilentMinutes(ms) {
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`
}

function findRunningAnchor() {
  if (typeof document === 'undefined') return null
  const nodes = document.querySelectorAll('[data-chat-running="true"]')
  let host = null
  for (let i = nodes.length - 1; i >= 0; i--) {
    const el = nodes[i]
    if (!el.hasAttribute('data-holding') && el.offsetParent !== null) {
      host = el
      break
    }
  }
  if (!host && nodes.length > 0) host = nodes[nodes.length - 1]
  if (!host) return null
  return host.querySelector('[class*="runningContent"]') ?? host
}

/**
 * Ephemeral live execution status pill mounted right inside the chat stream's
 * [data-chat-running="true"] row (adjacent to "深度求索中") while a DSH Host turn runs.
 */
export function NativeLiveStatusBar({ sessionId, hostDirectory, running, owner }) {
  const [status, setStatus] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [anchor, setAnchor] = useState(null)

  useEffect(() => {
    if (!running || !hostDirectory || owner === 'deepseek-harness') {
      setStatus(null)
      setAnchor(null)
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const next = await hostDirectory.getLiveStatus()
        if (!cancelled) {
          setStatus(next?.active ? next : null)
          setNow(Date.now())
        }
      } catch {
        // Non-fatal: keep previous status or wait for next poll.
      }
    }
    void read()
    const pollId = setInterval(() => { void read() }, LIVE_STATUS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(pollId)
    }
  }, [running, hostDirectory, owner, sessionId])

  useEffect(() => {
    if (!running || owner === 'deepseek-harness' || typeof document === 'undefined') {
      setAnchor(null)
      return
    }
    const sync = () => {
      const next = findRunningAnchor()
      setAnchor(prev => (prev === next ? prev : next))
    }
    sync()
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
    observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-running', 'data-holding'] })
    const fallbackTimer = setInterval(sync, 400)
    return () => {
      observer?.disconnect()
      clearInterval(fallbackTimer)
    }
  }, [running, owner, sessionId])

  useEffect(() => {
    if (!running || !status?.active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running, status?.active])

  if (!running || owner === 'deepseek-harness' || !status?.active || !anchor) return null

  const silentMs = Math.max(0, now - (status.lastActivityAt ?? status.startedAt ?? now))
  const phaseMs = Math.max(0, now - (status.phaseStartedAt ?? status.startedAt ?? now))
  const stalled = !status.paused && silentMs >= STALL_WARN_MS
  const phaseText = formatLiveDuration(phaseMs)
  const silentText = stalled ? formatSilentMinutes(silentMs) : ''
  const phaseLabel = status.label || '后台运行中…'
  const tone = stalled
    ? 'stalled'
    : status.phase === 'retrying'
      ? 'retry'
      : status.paused
        ? 'paused'
        : 'active'
  const badge = ENGINE_BADGE[status.harnessId ?? owner] ?? 'Host'
  const tipText = stalled
    ? `停留在：${phaseLabel} · 静默 ${silentText}`
    : `当前阶段耗时 ${phaseText}`

  const pill = h('span', {
    className: 'ch-live-status',
    'data-tone': tone,
    role: 'status',
    'aria-live': 'polite',
  },
    h('span', { className: 'ch-live-status-dot', 'aria-hidden': 'true' }),
    h('span', { className: 'ch-live-status-badge' }, badge),
    stalled
      ? h('span', { className: 'ch-live-status-warn' }, `静默 ${silentText}`)
      : h('span', { className: 'ch-live-status-text' }, phaseLabel),
    h('span', { className: 'ch-live-status-tip', role: 'tooltip' }, tipText),
  )

  return createPortal(pill, anchor)
}

export const nativeLiveStatusCss = `
[data-chat-running="true"] > :has(> .ch-live-status),
[data-chat-running="true"]:has(> .ch-live-status) {
  display:inline-flex; align-items:center; flex-wrap:wrap; row-gap:4px;
  height:auto; min-height:calc(28px + var(--dsh-content-font-delta,0px)); max-width:100%;
}
.ch-live-status {
  position:relative; display:inline-flex; align-items:center; gap:6px; max-width:100%;
  margin-left:4px; padding:1px 9px; border-radius:999px; cursor:default; user-select:none;
  font-size:12px; line-height:18px; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#555);
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 9%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 22%,transparent);
  vertical-align:middle;
}
.ch-live-status[data-tone="retry"] {
  color:#9a6700;
  background:color-mix(in srgb,#d29922 12%,transparent);
  border-color:color-mix(in srgb,#d29922 32%,transparent);
}
.ch-live-status[data-tone="stalled"] {
  color:#b54738;
  background:color-mix(in srgb,#d64b58 11%,transparent);
  border-color:color-mix(in srgb,#d64b58 32%,transparent);
}
.ch-live-status[data-tone="paused"] {
  color:var(--dsw-alias-label-tertiary,#777);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#000) 6%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#000) 14%,transparent);
}
.ch-live-status-dot {
  width:6px; height:6px; border-radius:50%; flex:none;
  background:var(--dsw-alias-state-business-primary,#4d6bfe);
  animation:ch-live-pulse 1.6s ease-in-out infinite;
}
.ch-live-status[data-tone="retry"] .ch-live-status-dot { background:#d29922; }
.ch-live-status[data-tone="stalled"] .ch-live-status-dot { background:#d64b58; animation:none; }
.ch-live-status[data-tone="paused"] .ch-live-status-dot { background:var(--dsw-alias-label-tertiary,#888); animation:none; }
.ch-live-status-badge {
  font-size:11px; font-weight:600; opacity:.85; flex:none;
}
.ch-live-status-text {
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:min(360px,58vw);
}
.ch-live-status-meta { opacity:.68; flex:none; }
.ch-live-status-warn { font-weight:500; flex:none; }
.ch-live-status-tip {
  position:absolute; left:0; bottom:calc(100% + 6px); z-index:1200;
  padding:4px 9px; border-radius:8px; white-space:nowrap; pointer-events:none;
  font-size:12px; line-height:18px; font-weight:400; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary,#222);
  background:var(--dsw-alias-bg-elevated,#fff);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));
  box-shadow:0 4px 14px rgba(0,0,0,.10);
  opacity:0; transform:translateY(2px); transition:opacity 120ms ease,transform 120ms ease;
}
.ch-live-status:hover .ch-live-status-tip,
.ch-live-status:focus-visible .ch-live-status-tip { opacity:1; transform:translateY(0); }
@keyframes ch-live-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.82)} }
@media (prefers-reduced-motion:reduce) { .ch-live-status-dot { animation:none; } }
`
