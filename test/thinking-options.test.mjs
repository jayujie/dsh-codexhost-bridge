import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'

const efforts = ['low', 'medium', 'high', 'xhigh', 'max']

function fixture(harnessId, defaultId, supported, saved) {
  const events = [{ type: 'plugin:codexhost/configuration', ignorable: true, data: { harnessId, modelId: 'model', ...(saved ? { thinkingOptionId: saved } : {}) } }]
  const model = { ref: { id: 'model' }, model: 'model', displayName: 'Model', label: 'Model', isDefault: true, defaultReasoningEffort: defaultId, supportedReasoningEfforts: supported.map(reasoningEffort => ({ reasoningEffort })) }
  const peer = { closed: new Promise(() => {}), subscribe: () => () => {}, async request(method) {
    if (method === 'model/list') return { data: [model] }
    if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: {
      models: [{ ...model, supportedThinkingOptionIds: supported }], defaultModel: model.ref,
      thinkingOptions: supported.map(id => ({ id, label: `Official ${id}` })), defaultThinkingOptionId: defaultId,
    }, permissionModes: { modes: [{ id: 'default', label: 'Default' }], defaultModeId: 'default' } }
    throw new Error(`Unexpected method: ${method}`)
  } }
  const driver = new NativeSessionDriver({ agentPresets: { presetForSession: () => harnessId === 'codex' ? 'codexhost-codex' : 'codexhost-claude-code' }, sessionPersistence: { async flush() {} } },
    { appendPluginRecord(_session, type, data) { events.push({ type, ignorable: true, data }) } }, { connect: async () => peer })
  const agent = { runMaintenance: callback => callback(), session: { header: { cwd: 'D:/workspace' }, snapshotEvents: () => events } }
  return { driver, agent }
}

test('Codex effort catalog retains native defaults and removes options outside low through max', async () => {
  const { driver, agent } = fixture('codex', 'medium', ['auto', 'minimal', ...efforts, 'ultra'], 'ultra')
  const catalog = await driver.catalog(agent)
  assert.deepEqual(catalog.models[0].thinkingOptions.map(option => option.id), efforts)
  assert.equal(catalog.selection.thinkingOptionId, 'medium')
  const configured = await driver.configure(agent, { thinkingOptionId: 'max' })
  assert.equal(configured.selection.thinkingOptionId, 'max')
  assert.equal((await driver.catalog(agent)).selection.thinkingOptionId, 'max')
})

test('Claude auto and off selections resolve to a supplied effort and cannot be configured directly', async () => {
  for (const saved of ['auto', 'off', 'ultracode']) {
    const { driver, agent } = fixture('claude-code', 'auto', ['off', 'auto', ...efforts, 'ultracode'], saved)
    const catalog = await driver.catalog(agent)
    assert.deepEqual(catalog.models[0].thinkingOptions.map(option => option.id), efforts)
    assert.equal(catalog.models[0].thinkingOptions[0].label, 'Official low')
    assert.equal(catalog.selection.thinkingOptionId, 'low')
    await assert.rejects(driver.configure(agent, { thinkingOptionId: saved }), { code: 'HOST_THINKING_INVALID' })
  }
})

test('model-specific effort limitations never acquire invented levels', async () => {
  const { driver, agent } = fixture('claude-code', 'auto', ['off', 'auto', 'high', 'max'])
  assert.deepEqual((await driver.catalog(agent)).models[0].thinkingOptions.map(option => option.id), ['high', 'max'])
  assert.equal((await driver.catalog(agent)).selection.thinkingOptionId, 'high')
  const fixed = fixture('codex', 'none', [])
  assert.deepEqual((await fixed.driver.catalog(fixed.agent)).models[0].thinkingOptions, [])
  assert.equal((await fixed.driver.catalog(fixed.agent)).selection.thinkingOptionId, undefined)
})
