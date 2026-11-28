export const REMOTE_PACKAGE = 'dsh-host/native'

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object')
  return value
}

function string(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || value.includes('\0')) throw new TypeError('Expected a bounded non-empty string')
  return value
}

function configuration(value) {
  const input = object(value)
  if (Object.keys(input).some(key => !['modelId', 'thinkingOptionId', 'permissionModeId'].includes(key))) throw new TypeError('Unknown Agent configuration field')
  for (const field of Object.values(input)) string(field)
  return input
}

function catalog(value) {
  const result = object(value)
  if (!['codex', 'claude-code', 'antigravity', 'deepseek-harness'].includes(result.agentId)) throw new TypeError('Invalid Agent catalog owner')
  if (!['ready', 'error'].includes(result.status)) throw new TypeError('Invalid Agent catalog status')
  if (result.status === 'ready' && (!Array.isArray(result.models) || !Array.isArray(result.permissionModes))) throw new TypeError('Invalid Agent catalog')
  return result
}

function delegationTargets(value) {
  const result = object(value), ids = new Set()
  if (!Array.isArray(result.targets) || result.targets.length > 4) throw new TypeError('Invalid delegation targets')
  for (const target of result.targets) {
    if (!['codex', 'claude-code', 'antigravity', 'deepseek-harness'].includes(target?.id) || ids.has(target.id) || typeof target.label !== 'string' || target.label.length > 64 || !['ready', 'unavailable'].includes(target.status)) throw new TypeError('Invalid delegation target')
    ids.add(target.id)
  }
  return result
}

function recovery(value) {
  const result = object(value)
  if (!['clear', 'blocked', 'running', 'recoverable', 'recovered'].includes(result.status) || typeof result.reason !== 'string' || result.reason.length > 128) throw new TypeError('Invalid recovery result')
  if (result.outcome !== undefined && !['completed', 'failed', 'interrupted'].includes(result.outcome)) throw new TypeError('Invalid native outcome')
  if (result.status === 'recoverable' && !/^[a-f0-9]{64}$/.test(result.expected ?? '')) throw new TypeError('Invalid recovery revision')
  return result
}
function recoveryConfirmation(value) {
  const input = object(value)
  if (Object.keys(input).some(key => !['expected', 'acknowledgeStopped'].includes(key)) || input.acknowledgeStopped !== true || !/^[a-f0-9]{64}$/.test(input.expected ?? '')) throw new TypeError('Explicit recovery acknowledgement is required')
  return input
}

function liveStatus(value) {
  const result = object(value)
  if (typeof result.active !== 'boolean') throw new TypeError('Invalid live status active flag')
  if (!result.active) return result
  if (!['codex', 'claude-code', 'antigravity'].includes(result.harnessId)) throw new TypeError('Invalid live status harness')
  if (typeof result.phase !== 'string' || result.phase.length === 0 || result.phase.length > 64) throw new TypeError('Invalid live status phase')
  if (typeof result.label !== 'string' || result.label.length > 256) throw new TypeError('Invalid live status label')
  return result
}

const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
const agentParameter = { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: codec('@deepseek-ai/dsh-session/types#SessionId', string) }
const descriptor = (method, parameters, result) => ({
  id: `${REMOTE_PACKAGE}#dshHost/${method}`, service: 'dshHost', namespace: 'dshHost', method,
  invocation: { kind: 'direct' }, parameters: [agentParameter, ...parameters], result,
})

export const nativeRemoteDescriptors = [
  descriptor('catalog', [], codec('DshHostCatalog', catalog)),
  descriptor('delegationTargets', [], codec('DshHostDelegationTargets', delegationTargets)),
  descriptor('recovery', [], codec('DshHostRecovery', recovery)),
  descriptor('liveStatus', [], codec('DshHostLiveStatus', liveStatus)),
  descriptor('reconcile', [{ name: 'confirmation', wire: 'confirmation', source: 'json', codec: codec('DshHostRecoveryConfirmation', recoveryConfirmation) }], codec('DshHostRecovery', recovery)),
  descriptor('selectAgent', [{ name: 'harnessId', wire: 'harnessId', source: 'json', codec: codec('HarnessId', value => {
    if (!['codex', 'claude-code', 'antigravity', 'deepseek-harness'].includes(value)) throw new TypeError('Unsupported Agent')
    return value
  }) }], codec('AgentPreset', string)),
  descriptor('configure', [{ name: 'configuration', wire: 'configuration', source: 'json', codec: codec('HarnessConfiguration', configuration) }], codec('DshHostCatalog', catalog)),
]

export const nativeRemoteContribution = { package: REMOTE_PACKAGE, descriptors: nativeRemoteDescriptors }
