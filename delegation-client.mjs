import { createElement as h, useEffect, useRef, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { AGENT_ICONS } from './icons.mjs'
import { DELEGATION_SOURCE, delegationCarrier, delegationReference, findDelegationTrigger, filterDelegationTargets } from './delegation-mentions.mjs'

/** Native @ completion and reference serialization; registration belongs to the plugin fiber. */
export function installDelegationSource(scope, { canDelegate, directoryFor, t }) {
  scope.effect(() => scope.inputTriggers.registerSource({
    trigger: '@', name: DELEGATION_SOURCE, order: -100, showGroupTitle: false,
    async candidates(session, request) {
      if (!canDelegate(session.sessionId)) return []
      const result = await directoryFor(session.sessionId).delegationTargets()
      if (request.signal.aborted) return []
      return filterDelegationTargets(result.targets, request.query).filter(target => target.status === 'ready').map(target => ({ name: target.id, label: target.label, value: target.id, section: t('delegateTitle'), description: t('delegateTargetHint') }))
    },
    onPick(pick) {
      if (!canDelegate(pick.session.sessionId)) throw new Error(t('delegateSessionUnavailable'))
      return { insert: delegationReference(pick.candidate.value ?? pick.candidate.name) }
    },
    codec: { clipboardText: delegationCarrier, async serialize(ref, signal) { signal.throwIfAborted(); return delegationCarrier(ref) } },
  }))
}

/** Read # only from the current editable text node; native chips/quotes remain opaque. */
export function readDelegationHit(card, inputActions, selection = document.getSelection()) {
  const node = selection?.anchorNode
  if (!card || !selection?.isCollapsed || node?.nodeType !== 3 || !card.contains(node)) return null
  const editable = node.parentElement?.closest('[contenteditable]')
  if (editable?.getAttribute('contenteditable') !== 'true' || !card.contains(editable)) return null
  return findDelegationTrigger(node.textContent.slice(0, selection.anchorOffset), inputActions.captureInsertion())
}
const delegationHitKey = hit => hit ? `${hit.manual ? 'button' : 'typed'}:${hit.span.draftRev}:${hit.span.start}:${hit.span.end}:${hit.query}` : ''

/** A # menu beside the original Composer controls; selection never submits or switches Agent. */
export function DelegationPicker({ external, hostDirectory, input, inputActions, insertDelegation, focusInput, t }) {
  const anchor = useRef(null), ignored = useRef(''), composing = useRef(false), interaction = useRef(null)
  const [hit, setHit] = useState(null), [targets, setTargets] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [index, setIndex] = useState(0), [revision, setRevision] = useState(0)
  const editable = input?.phase === 'plain' && !!inputActions
  const open = hit !== null && editable
  const matches = filterDelegationTargets(targets, hit?.query ?? '')
  const enabled = matches.filter(target => target.status === 'ready')
  const chosen = enabled.length ? enabled[Math.min(index, enabled.length - 1)] : null
  const dismiss = () => { ignored.current = delegationHitKey(hit); setHit(null) }
  const pick = id => {
    if (!editable || !hit || !matches.some(target => target.id === id && target.status === 'ready')) return
    // The last input event may precede its React effect. Re-capture this same # token
    // at the explicit pick, never apply a previously captured revision to new text.
    const fresh = hit.manual ? hit : readDelegationHit(anchor.current?.closest('[data-composer-card]'), inputActions)
    if (!fresh || fresh.span.start !== hit.span.start || !filterDelegationTargets(matches, fresh.query).some(target => target.id === id) || !insertDelegation(id, fresh.span)) { setError(t('delegateDraftChanged')); return }
    setHit(null); ignored.current = ''; setError(''); focusInput()
  }
  // Capture listeners use the latest rendered choice while effects are settling.
  interaction.current = { open, hit, input, enabled, chosen, loading, pick, dismiss }
  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true); setError(''); setTargets([])
    hostDirectory.delegationTargets(revision > 0).then(result => { if (current) { setTargets(result.targets); setIndex(0) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [open, hostDirectory, revision])
  useEffect(() => { setHit(null); ignored.current = ''; setError('') }, [hostDirectory, external])
  useEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    if (!editable || !card) { setHit(null); return }
    const track = () => {
      if (composing.current) return
      const live = interaction.current
      if (live.hit?.manual && live.hit.span.draftRev !== live.input.draftRev) { setHit(null); return }
      // Pointer focus inside the popup must not discard the captured insertion.
      if (document.activeElement?.closest?.('.ch-delegation-menu')) return
      const next = readDelegationHit(card, inputActions)
      if (next && delegationHitKey(next) !== ignored.current) setHit(old => delegationHitKey(old) === delegationHitKey(next) ? old : next)
      else if (!live.hit?.manual) setHit(null)
    }
    const keydown = event => {
      const live = interaction.current
      if (composing.current || event.isComposing || event.keyCode === 229 || !event.target?.closest?.('[contenteditable="true"]') || !card.contains(event.target)) return
      if (!live.open) {
        const pending = readDelegationHit(card, inputActions)
        if (pending && delegationHitKey(pending) !== ignored.current && ['Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(event.key) && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation(); setHit(pending)
        }
        return
      }
      if (event.key === 'Tab' && event.shiftKey) { live.dismiss(); return }
      if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Escape') { live.dismiss(); return }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { setIndex(value => live.enabled.length ? (value + (event.key === 'ArrowUp' ? -1 : 1) + live.enabled.length) % live.enabled.length : 0); return }
      if (!live.loading && live.chosen) live.pick(live.chosen.id)
    }
    const start = () => { composing.current = true; setHit(null) }
    const end = () => { composing.current = false; track() }
    track()
    document.addEventListener('selectionchange', track)
    card.addEventListener('keydown', keydown, true)
    card.addEventListener('compositionstart', start)
    card.addEventListener('compositionend', end)
    return () => { document.removeEventListener('selectionchange', track); card.removeEventListener('keydown', keydown, true); card.removeEventListener('compositionstart', start); card.removeEventListener('compositionend', end) }
  }, [editable, input?.draftRev, hostDirectory, open, hit, index, targets, loading])
  return h('span', { ref: anchor, className: 'ch-delegation-anchor' }, h(Menu, {
    open, onClose: dismiss, side: 'top', align: 'end', portal: true, autoFocus: false, selection: 'fill', selectedId: chosen?.id,
    isExternalTrigger: node => {
      const element = node.nodeType === 1 ? node : node.parentElement
      return !!anchor.current?.closest('[data-composer-card]')?.contains(node) && !!element?.closest('[contenteditable="true"]')
    },
    listClassName: 'ch-delegation-menu',
    items: [{ type: 'label', id: 'delegation-title', text: t('delegateTitle') }, ...matches.map(target => ({ id: target.id, label: target.status === 'ready' ? target.label : `${target.label} · ${t('delegateUnavailable')}`, disabled: target.status !== 'ready', icon: h('img', { src: AGENT_ICONS[target.id], width: 18, height: 18, alt: '' }) }))],
    onSelect: pick,
    // Keep a measurable menu anchor without a visible or focusable Composer button.
    anchor: h('span', { className: 'ch-delegation-position', 'aria-hidden': true }),
  }, loading ? h('p', { className: 'ch-delegation-note', role: 'status' }, t('loading')) : null,
    error ? h('div', { className: 'ch-delegation-note', role: 'alert' }, error, h('button', { type: 'button', onClick: () => setRevision(value => value + 1) }, t('retry'))) : null,
    !loading && !error && matches.length === 0 ? h('p', { className: 'ch-delegation-note' }, t('delegateNoMatch')) : null,
    h('p', { className: 'ch-delegation-note' }, t(external ? 'delegateIndependent' : 'delegateNativeIndependent')),
    !loading && !error ? h('div', { className: 'ch-delegation-note' }, h('button', { type: 'button', onClick: () => setRevision(value => value + 1) }, t('refresh'))) : null))
}

export const delegationCss = `
.ch-delegation-anchor{display:inline-flex;width:0;min-width:0;height:1px;align-self:center;pointer-events:none}.ch-delegation-position{display:inline-block;width:0;height:1px}.ch-delegation-menu{width:min(280px,calc(100vw - 24px))}.ch-delegation-note{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:6px 12px;margin:0;overflow-wrap:anywhere}.ch-delegation-note button{margin-left:8px;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-standard,#8884);background:transparent;border-radius:var(--dsw-radius-sm,8px);padding:3px 8px;cursor:pointer}.ch-delegation-menu img{object-fit:contain}.ch-delegation-note button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
`
