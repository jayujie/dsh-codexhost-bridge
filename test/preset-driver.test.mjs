import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../native-preset-driver.mjs'

test('retained external preset refuses to fall back when the bridge has unloaded', async () => {
  const handlers = {}
  apply({ on(name, handler) { handlers[name] = handler }, get() { return undefined } })
  await assert.rejects(handlers['agent/pre-step']({ agent: {} }), /refusing to run.*DSH model/)
})

test('external commands cannot call the DSH model while ordinary DSH calls still delegate', () => {
  const handlers = {}
  const agent = { session: {} }
  let preset = 'dsh-host-claude-code'
  apply({ on(name, handler) { handlers[name] = handler }, get(name) {
    if (name === 'agents') return { get: () => agent, currentInitiator: () => agent }
    if (name === 'agentPresets') return { presetForSession: () => preset }
  } })
  assert.throws(() => handlers['llm/stream']({ sessionId: 'external' }, () => { throw new Error('must not reach adapter') }), /refusing a DSH model call/)
  assert.equal(handlers['llm/stream']({ sessionId: 'external', purpose: 'session-title' }, () => 'auxiliary-title'), 'auxiliary-title')
  preset = 'coding-tools'
  assert.equal(handlers['llm/stream']({ sessionId: 'native' }, () => 'native-stream'), 'native-stream')
})
