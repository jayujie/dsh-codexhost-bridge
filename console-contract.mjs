export const CONSOLE_REMOTE_PACKAGE = '@local/dsh-codexhost-bridge/console'
const actions = {
  overview: [], connections: ['refresh'], accounts: ['refresh'],
  sessions: ['harnessId', 'query', 'cursor', 'offset'],
  import: ['harnessId', 'kind', 'id', 'acknowledgeIdle'],
  usage: ['range', 'harness'], prices: [], priceDefault: ['model'],
  priceSave: ['key', 'previousKey', 'price'], claudePath: ['path'],
}
const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v)
export function parseConsoleRequest(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(actions, v.action)
    || Object.keys(v).some(k => k !== 'action' && !actions[v.action].includes(k))) throw new TypeError('Unsupported DSH Host console action')
  for (const k of ['refresh', 'acknowledgeIdle']) if (v[k] !== undefined && typeof v[k] !== 'boolean') throw new TypeError(`Invalid ${k}`)
  if (v.harnessId !== undefined && !['codex', 'claude-code', 'antigravity'].includes(v.harnessId)) throw new TypeError('Unsupported import Agent')
  if (['sessions', 'import'].includes(v.action) && !v.harnessId) throw new TypeError('Import Agent is required')
  for (const k of ['id', 'cursor', 'model', 'key', 'previousKey']) if (v[k] !== undefined && !text(v[k], k === 'cursor' ? 16384 : 1024)) throw new TypeError(`Invalid ${k}`)
  if (v.query !== undefined && (typeof v.query !== 'string' || v.query.length > 4096 || /\0/.test(v.query))) throw new TypeError('Invalid search')
  if (v.offset !== undefined && (!Number.isSafeInteger(v.offset) || v.offset < 0)) throw new TypeError('Invalid offset')
  if (v.action === 'import' && (!text(v.id, 1024) || !['thread', 'native'].includes(v.kind) || (v.harnessId === 'codex' && v.kind !== 'thread'))) throw new TypeError('Invalid import reference')
  if (v.action === 'priceDefault' && !text(v.model, 512)) throw new TypeError('Model is required')
  if (v.action === 'priceSave') {
    if (!text(v.key, 512) || v.key.trim() !== v.key) throw new TypeError('Invalid price model')
    if (v.price !== null) {
      const p = v.price
      if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'].includes(k))
        || !['input', 'output'].every(k => Object.hasOwn(p, k)) || !Object.values(p).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new TypeError('Invalid API prices')
    }
  }
  if (v.action === 'claudePath' && v.path !== null && !text(v.path)) throw new TypeError('Invalid Claude installation path')
  if (v.range !== undefined && !['today', '7d', '30d', '90d', 'all'].includes(v.range)) throw new TypeError('Invalid usage range')
  if (v.harness !== undefined && !['codex', 'claude-code', 'antigravity', 'deepseek-harness'].includes(v.harness)) throw new TypeError('Invalid usage Agent')
  return v
}
const codec = (typeSymbol, parse) => ({ mode: 'strict', typeSymbol, create: () => ({ parse }) })
const object = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('Expected console response'); return v }
const descriptor = (method, parameters) => ({ id: `${CONSOLE_REMOTE_PACKAGE}#codexHostConsole/${method}`,
  service: 'codexHostConsole', namespace: 'codexHostConsole', method, invocation: { kind: 'direct' }, parameters,
  result: codec('DshHostConsoleResponse', object),
})
export const consoleRemoteDescriptors = [descriptor('bootstrap', []), descriptor('request', [{ name: 'request', wire: 'request', source: 'json', codec: codec('DshHostConsoleRequest', parseConsoleRequest) }])]
export const consoleRemoteContribution = { package: CONSOLE_REMOTE_PACKAGE, descriptors: consoleRemoteDescriptors }
