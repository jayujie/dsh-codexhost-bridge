import { EXTERNAL_PRESET_IDS } from './external-engines.mjs'

/** Retained with its preset generation, including after the declaring bundle unloads. */
export function apply(ctx) {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const driver = ctx.get('dshHostNative')
    if (driver === undefined || !driver.available()) throw new Error('DSH Host session driver is unavailable; refusing to run this external conversation with the DSH model')
    // The outer driver consumes the complete admitted input after all context middleware.
    return next()
  })
  // Native DSH commands that call its model directly are not external Harness
  // commands. Keep them from silently using a different engine.
  ctx.on('llm/stream', (options, next) => {
    if (options.purpose === 'session-title') return next()
    const agents = ctx.get('agents')
    const agent = options.sessionId ? agents?.get(options.sessionId) : agents?.currentInitiator()
    const preset = agent === undefined ? undefined : ctx.get('agentPresets')?.presetForSession(agent.session)
    if (EXTERNAL_PRESET_IDS.includes(preset)) throw new Error('This external Agent operation is not connected to DSH Host; refusing a DSH model call')
    return next()
  })
}
