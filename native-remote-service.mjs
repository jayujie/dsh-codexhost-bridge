import { nativeRemoteDescriptors, REMOTE_PACKAGE } from './remote-contract.mjs'

/** Adds scoped, validated methods to the existing authenticated DSH Gateway. */
export async function installNativeRemote(ctx, driver) {
  const { TypertRemoteService, Remote } = await ctx.loader.import('@deepseek-ai/dsh-typert-protocol')
  const initializers = []
  class CodexHostRemote extends TypertRemoteService {
    constructor(scope) {
      super(scope, 'codexHost')
      for (const initialize of initializers) initialize.call(this)
    }
    catalog(agent) { return driver.catalog(agent) }
    selectAgent(agent, harnessId) { return driver.selectAgent(agent, harnessId) }
    configure(agent, configuration) { return driver.configure(agent, configuration) }
    delegationTargets(agent) { return driver.delegationTargets(agent) }
    recovery(agent) { return driver.recovery(agent) }
    reconcile(agent, confirmation) { return driver.reconcile(agent, confirmation) }
  }
  // Standard decorators lowered explicitly because this plugin ships as JavaScript.
  for (const method of ['catalog', 'selectAgent', 'configure', 'recovery', 'reconcile', 'delegationTargets']) Remote(method)(CodexHostRemote.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer: initialize => initializers.push(initialize),
  })
  ctx.effect(() => ctx.typert.register({
    package: REMOTE_PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: nativeRemoteDescriptors,
  }), 'codexhost: native Remote contract')
  ctx.plugin(CodexHostRemote)
}
