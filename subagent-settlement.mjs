import { EXTERNAL_PRESET_IDS } from './external-engines.mjs'

export const UNLOAD_REASON = 'DSH Host unloaded'
export const LEGACY_UNLOAD_REASON = 'CodexHost bridge unloaded'
const UNLOAD_REASONS = new Set([UNLOAD_REASON, LEGACY_UNLOAD_REASON])

export function compatibleSettlement(manager) {
  const proto = typeof manager === 'function' ? manager.prototype : Object.getPrototypeOf(manager ?? {})
  const fn = proto?.notifySettlement
  if (typeof fn !== 'function') return false
  const src = Function.prototype.toString.call(fn)
  return src.includes('this.sendWaking(parent, message,')
    && src.includes('closingTeardownFor(parent)')
    && src.includes('createSettlementMessage(')
}

export function isHostUnloadSettlement(activation, terminal, parent) {
  if (activation?.kind !== 'local' || terminal?.stopReason !== 'aborted') return false
  const end = activation.handle?.agent?.session?.snapshotEvents?.(activation.outputStart)?.findLast?.(event => event.type === 'turn/end')
  const reason = end?.data?.reason
  if (reason?.kind !== 'aborted' || reason?.reason?.kind !== 'hook' || !UNLOAD_REASONS.has(reason?.reason?.reason)) return false
  const selected = parent?.session?.snapshotEvents?.()?.findLast?.(event => event.type === 'agent-preset/selected')
  const preset = selected?.data?.agentPreset ?? parent?.session?.header?.agentPreset
  return EXTERNAL_PRESET_IDS.includes(preset)
}

export function installSettlementPatch(ctx) {
  const manager = ctx?.subagents
  if (!manager || !compatibleSettlement(manager)) return () => {}
  const proto = Object.getPrototypeOf(manager)
  const original = proto.notifySettlement
  if (original?.__dshHostSettlementPatched) return () => {}
  const patched = function notifySettlement(activation, terminal) {
    const parentId = activation?.ancestors?.at?.(-1) ?? activation?.parentSessionId
    const parent = this.ctx?.agents?.get?.(parentId)
    if (parent !== undefined && isHostUnloadSettlement(activation, terminal, parent)) {
      const origSendWaking = this.sendWaking
      let intercepted = false
      this.sendWaking = function sendWaking(target, message, mode) {
        if (target === parent && !intercepted) {
          intercepted = true
          parent.send(message, 'next-step', false)
          return
        }
        return origSendWaking.call(this, target, message, mode)
      }
      try { return original.call(this, activation, terminal) }
      finally { this.sendWaking = origSendWaking }
    }
    return original.call(this, activation, terminal)
  }
  patched.__dshHostSettlementPatched = true
  proto.notifySettlement = patched
  const dispose = () => {
    if (proto.notifySettlement === patched) proto.notifySettlement = original
  }
  ctx.effect?.(() => dispose, 'dsh-host: subagent unload settlement guard')
  return dispose
}
