import test from 'node:test'
import assert from 'node:assert/strict'
import { installUnifiedSubagentEntry, NativeDelegation } from '../native-delegation.mjs'

const signal = () => new AbortController().signal

test('unified entry preserves native policy and routes external model/effort through managed teams', async () => {
  const registered = new Map(), hooks = {}, effects = [], calls = [], natives = []
  const original = { name: 'subagent', description: 'native', parameters: { prompt: { type: 'string', required: true } }, output: {}, execute: async args => { natives.push(args); return { kind: 'activation', name: 'native-child' } } }
  const agent = { ctx: { tools: { register: definition => {
    registered.set(definition.name, definition)
    hooks['tools/change']?.()
    return () => registered.delete(definition.name)
  } } } }
  const ctx = { agents: { list: () => [agent] }, tools: { get: () => original, register: d => { registered.set(d.name, d); return () => registered.delete(d.name) } }, on: (name, fn) => { hooks[name] = fn }, effect: fn => { const cleanup = fn(); effects.push(cleanup) } }
  const manager = { start: async (...args) => { calls.push(args); return { name: 'codex-child' } } }
  const driver = { catalog: async () => ({ status: 'ready', models: [{ id: 'real-id', thinkingOptions: [{ id: 'high' }] }], selection: { modelId: 'real-id', thinkingOptionId: 'high' } }) }
  await installUnifiedSubagentEntry(ctx, manager, driver, { defineTool: d => d })
  const tool = registered.get('subagent'), exec = { agent, signal: signal() }
  assert.deepEqual(await tool.execute({ prompt: 'native', provider: 'approved', model: 'native-model' }, exec), { kind: 'activation', name: 'native-child' })
  assert.equal(natives[0].provider, 'approved')
  assert.deepEqual(await tool.execute({ engine: 'codex', prompt: 'review', model: 'real-id', reasoning_effort: 'high' }, exec), { kind: 'activation', name: 'codex-child' })
  assert.equal(calls[0][1].task, 'review'); assert.equal(calls[0][1].model, 'real-id'); assert.equal(calls[0][1].reasoning_effort, 'high')
  await assert.rejects(tool.execute({ engine: 'claude-code', provider: 'maxai' }, exec), /omit provider/)
  const discovery = await registered.get('list_host_subagent_models').execute({ engine: 'codex' }, exec)
  assert.equal(JSON.parse(discovery.result).models[0].id, 'real-id')
  for (const effect of effects.reverse()) if (typeof effect === 'function') effect()
  assert.equal(registered.size, 0)
})

test('explicit selection is validated and available before the first child work; invalid effort starts nothing', async () => {
  const events = [], parent = { id: 'parent', session: { id: 'parent', snapshotEvents: () => events } }, specs = []
  let manager
  const ctx = { agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 1 }), get: () => undefined }, sessionPersistence: { flush: async () => {} }, subagents: { resolveMaxDepth: () => 1, startActivation: async spec => {
    specs.push(spec)
    assert.deepEqual(manager.initialConfigurations.get(spec.childId), { harnessId: 'codex', modelId: 'model-id', permissionModeId: 'workspace-write', thinkingOptionId: 'high' })
    return { childId: spec.childId, name: 'review', result: Promise.resolve() }
  } } }
  const driver = { available: () => true, catalog: async () => ({ status: 'ready', models: [{ id: 'model-id', thinkingOptions: [{ id: 'high' }] }], selection: { modelId: 'model-id' } }) }
  manager = new NativeDelegation(ctx, driver, { appendPluginRecord: (_s, type, data) => events.push({ type, data, ignorable: true }) })
  manager.read = async () => ({ name: 'review' })
  const args = { engine: 'codex', task: 'review', name: 'review', model: 'model-id', reasoning_effort: 'high' }
  await manager.start(parent, args, signal(), { requireSelection: false })
  assert.equal(specs.length, 1); assert.equal(manager.initialConfigurations.size, 0)
  await assert.rejects(manager.start(parent, { ...args, reasoning_effort: 'low' }, signal(), { requireSelection: false }), /different task|already has/)
  await assert.rejects(manager.start(parent, { ...args, name: 'invalid', reasoning_effort: 'max' }, signal(), { requireSelection: false }), /not advertised/)
  await assert.rejects(manager.start(parent, { ...args, name: 'invalid-model', model: 'unknown' }, signal(), { requireSelection: false }), /not advertised/)
  assert.equal(specs.length, 1)
  await manager.dispose()
})
