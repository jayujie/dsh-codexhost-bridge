import { resolveHostInstallation } from './host-installation.mjs'
import { NativeSessionImporter } from './native-session-import.mjs'
import { parseConsoleRequest, CONSOLE_REMOTE_PACKAGE, consoleRemoteDescriptors } from './console-contract.mjs'
import { PluginUpdater, readPluginVersion } from './plugin-updater.mjs'

export function assertConsoleOwner(invocation) {
  if (invocation?.peer?.principal?.kind !== 'owner') throw new Error('Only the DSH owner can open or operate the DSH Host console')
}
const settled = promise => promise.then(value => ({ status: 'ready', value }), error => ({ status: 'error', error: error.message }))
/** Dedicated DSH console. It shares the session driver's connection and never exposes RPC passthrough. */
export class DshHostConsole {
  constructor(ctx, config, driver, helpers) {
    this.ctx = ctx; this.config = config; this.driver = driver
    this.importer = new NativeSessionImporter(ctx, driver, helpers)
    this.updater = new PluginUpdater(ctx, config)
  }
  async bootstrap() { return { name: 'DSH Host', version: await readPluginVersion(), agents: ['codex', 'claude-code', 'antigravity'], carrier: 'DSH' } }
  async request(raw) {
    const input = parseConsoleRequest(raw)
    if (input.action === 'updateCheck') return this.updater.check({ refresh: input.refresh === true })
    if (input.action === 'updateApply') return this.updater.apply({ version: input.version })
    const peer = await this.driver.consoleConnection()
    const call = (method, params = {}) => peer.request(method, params, { timeoutMs: 45000 })
    switch (input.action) {
      case 'overview': return { connected: true, workspaces: this.ctx.workspaceRegistry.list().length,
        externalSessions: this.ctx.agents.list().filter(agent => this.driver.owner(agent)).length, agents: ['codex', 'claude-code', 'antigravity'] }
      case 'connections': {
        const [installation, models, claude, settings, antigravity, agySettings] = await Promise.all([
          settled(resolveHostInstallation(this.config)), settled(call('model/list', { limit: 100 })),
          settled(call('codexhost/harness/inspect', { harnessId: 'claude-code', refresh: input.refresh === true })),
          settled(call('codexhost/harness/launch-settings/get', { harnessId: 'claude-code' })),
          settled(call('codexhost/harness/inspect', { harnessId: 'antigravity', refresh: input.refresh === true })),
          settled(call('codexhost/harness/launch-settings/get', { harnessId: 'antigravity' })),
        ])
        return { codex: { status: models.status, error: models.error,
          path: installation.value?.stockCodexPath, models: (models.value?.data ?? []).map(m => ({ id: m.model, label: m.displayName ?? m.model })) },
          claude: { status: claude.value?.status ?? claude.status, error: claude.value?.error?.message ?? claude.error,
            models: (claude.value?.catalog?.models ?? []).map(m => ({ id: m.ref.id, label: m.label })),
            path: settings.value?.path ?? '', restartRequired: settings.value?.restartRequired ?? false },
          antigravity: { status: antigravity.value?.status ?? antigravity.status, error: antigravity.value?.error?.message ?? antigravity.error,
            models: (antigravity.value?.catalog?.models ?? []).map(m => ({ id: m.ref.id, label: m.label })),
            path: agySettings.value?.path ?? '', restartRequired: agySettings.value?.restartRequired ?? false } }
      }
      case 'claudePath': return call('codexhost/harness/launch-settings/set', { harnessId: 'claude-code', path: input.path })
      case 'accounts': {
        const [codex, claude, antigravity] = await Promise.all([
          settled(call(input.refresh ? 'codexhost/account/refresh' : 'codexhost/account/list')),
          settled(call('codexhost/harness/accounts/inspect', { harnessId: 'claude-code', refresh: input.refresh === true })),
          settled(call('codexhost/harness/accounts/inspect', { harnessId: 'antigravity', refresh: input.refresh === true })),
        ])
        let quota
        if (codex.value?.currentAccountId) quota = await settled(call('codexhost/account/usage/inspect', { accountId: codex.value.currentAccountId, refresh: input.refresh === true }))
        return { codex, claude, antigravity, ...(quota ? { quota } : {}) }
      }
      case 'sessions': return this.importer.list(peer, input)
      case 'import': return this.importer.import(peer, input)
      case 'usage': {
        const r = await call('codexhost/usage/statistics/get', { range: input.range ?? '7d', ...(input.harness ? { harness: input.harness } : {}) })
        return { filters: r.filters, reading: r.reading, totals: r.totals, byHarness: r.byHarness, byModel: r.byModel, recentSessions: r.recentSessions ?? r.sessions }
      }
      case 'prices': return call('codexhost/usage/model-prices/get')
      case 'priceDefault': return call('codexhost/usage/model-prices/default', { model: input.model })
      case 'priceSave': return call('codexhost/usage/model-prices/set', { key: input.key, price: input.price, ...(input.previousKey ? { previousKey: input.previousKey } : {}) })
    }
    throw new Error('Unsupported DSH Host action')
  }
}
export async function installConsoleRemote(ctx, config, driver) {
  const [{ TypertRemoteService, Remote }, ...modules] = await Promise.all([
    ctx.loader.import('@deepseek-ai/dsh-typert-protocol'), ...['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session'].map(name => ctx.loader.import(name)),
  ])
  const console = new DshHostConsole(ctx, config, driver, Object.assign({}, ...modules))
  const initializers = []
  class ConsoleRemote extends TypertRemoteService {
    constructor(scope) { super(scope, 'codexHostConsole'); for (const initialize of initializers) initialize.call(this) }
    bootstrap() { assertConsoleOwner(this.ctx.invocation); return console.bootstrap() }
    request(request) { assertConsoleOwner(this.ctx.invocation); return console.request(request) }
  }
  for (const method of ['bootstrap', 'request']) Remote(method)(ConsoleRemote.prototype[method], {
    kind: 'method', name: method, static: false, private: false, addInitializer: initialize => initializers.push(initialize),
  })
  ctx.effect(() => ctx.typert.register({ package: CONSOLE_REMOTE_PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: consoleRemoteDescriptors }))
  ctx.plugin(ConsoleRemote)
}
