import { nativeRemoteDescriptors, REMOTE_PACKAGE } from './remote-contract.mjs'

/** Adds scoped, validated methods to the existing authenticated DSH Gateway. */
export async function installNativeRemote(ctx, driver) {
  const { TypertRemoteService, Remote } = await ctx.loader.import('@deepseek-ai/dsh-typert-protocol')
  const initializers = []
  class DshHostRemote extends TypertRemoteService {
    constructor(scope) {
      super(scope, 'dshHost')
      for (const initialize of initializers) initialize.call(this)
    }
    catalog(agent) { return driver.catalog(agent) }
    selectAgent(agent, harnessId) { return driver.selectAgent(agent, harnessId) }
    configure(agent, configuration) { return driver.configure(agent, configuration) }
    delegationTargets(agent) { return driver.delegationTargets(agent) }
    recovery(agent) { return driver.recovery(agent) }
    liveStatus(agent) { return driver.liveStatus(agent) }
    reconcile(agent, confirmation) { return driver.reconcile(agent, confirmation) }
  }
  // Standard decorators lowered explicitly because this plugin ships as JavaScript.
  for (const method of ['catalog', 'selectAgent', 'configure', 'recovery', 'liveStatus', 'reconcile', 'delegationTargets']) Remote(method)(DshHostRemote.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer: initialize => initializers.push(initialize),
  })
  ctx.effect(() => ctx.typert.register({
    package: REMOTE_PACKAGE, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: nativeRemoteDescriptors,
  }), 'dsh-host: native Remote contract')
  ctx.plugin(DshHostRemote)
}
