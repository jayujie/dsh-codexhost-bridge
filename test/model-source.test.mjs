import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeModelSource, NativeToolProjector } from '../native-tool-projector.mjs'
import { NativeTurnProjector } from '../native-turn-projector.mjs'
import { HostCollaboration } from '../host-collaboration.mjs'

// Intentionally keyless: no Loader, Host process, adapter, sockets, or real tools.
// Identity helpers do not supply kind:'model', so the producer must supply it.
const provider = 'codexhost/claude-code'
const model = 'observed-model-label:exact'
const invalid = [undefined, null, '', ' ', '\t\r\n', 0, false, {}]
const toolItem = { type: 'toolExecution', itemId: 'observed-call', toolName: 'Read', arguments: { file_path: 'fixture.txt' }, output: 'observed text' }

function fixture() {
  const events = [], frames = [], initializations = []
  const session = { append(type, data, options) { const event = { type, data, options, seq: events.length }; events.push(event); return event } }
  const helpers = {
    createAssistantMessage: value => value,
    createToolResultMessage: value => value,
    AssistantStreamAccumulator: class {
      constructor() { initializations.push('accumulator'); this.records = [] }
      push(value) { this.records.push(value); return value }
      snapshot() { return this.records }
    },
    BlockAssembler: class {
      constructor() { initializations.push('assembler'); this.content = [] }
      push(chunk) { if (chunk.type === 'block-end') this.content.push(chunk.block) }
      blocks() { return this.content }
    },
  }
  const turnOptions = {
    agent: { id: 'session-model-source-fixture', session }, turn: 6, step: 1,
    helpers, dispatch: { emit(name, payload) { frames.push({ name, payload }) } },
    nextRevision: () => frames.length + 1, provider, model,
  }
  return { events, frames, initializations, session, helpers, turnOptions }
}

test('nativeModelSource preserves exact supplied identities and adds the model tag', () => {
  assert.deepEqual(nativeModelSource(provider, model), { kind: 'model', provider, model })
  assert.deepEqual(nativeModelSource(' exact/provider ', ' exact/model '), {
    kind: 'model', provider: ' exact/provider ', model: ' exact/model ',
  }, 'validation must not silently normalize or guess a recorded identity')
})

for (const field of ['provider', 'model']) {
  for (const [index, value] of invalid.entries()) {
    test(`nativeModelSource rejects invalid ${field} case ${index}`, () => {
      assert.throws(() => nativeModelSource(field === 'provider' ? value : provider, field === 'model' ? value : model))
    })
    test(`NativeTurnProjector rejects invalid ${field} case ${index} before publication`, () => {
      const f = fixture()
      assert.throws(() => new NativeTurnProjector({ ...f.turnOptions, [field]: value }))
      assert.deepEqual(f.events, [])
      assert.deepEqual(f.frames, [])
      assert.deepEqual(f.initializations, [], 'reject before creating stream state')
    })
    test(`NativeToolProjector rejects invalid ${field} case ${index} before append`, () => {
      const f = fixture()
      assert.throws(() => new NativeToolProjector(f.session, f.helpers, { turn: 6, step: 1 }, 'claude-code', { provider, model, [field]: value }))
      assert.deepEqual(f.events, [])
      assert.deepEqual(f.frames, [])
    })
  }
}

test('NativeToolProjector rejects the historical omitted-source default', () => {
  const f = fixture()
  assert.throws(() => new NativeToolProjector(f.session, f.helpers, { turn: 6, step: 1 }, 'claude-code'))
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.frames, [])
})

test('NativeToolProjector advertises an exact valid model source with identity helpers', () => {
  const f = fixture()
  const projector = new NativeToolProjector(f.session, f.helpers, { turn: 6, step: 1 }, 'claude-code', { provider, model })
  projector.accept({ method: 'codexhost/item/completed', params: { item: toolItem } })
  assert.deepEqual(f.events.map(e => e.type), ['assistant/message', 'tool/call', 'tool/result'])
  assert.deepEqual(f.events[0].data.message.source, { kind: 'model', provider, model })
  assert.equal(f.events[0].data.message.content[0].name, 'Read')
})

test('NativeTurnProjector shares a valid model source across tool and text observations', () => {
  const f = fixture(), projector = new NativeTurnProjector(f.turnOptions)
  projector.accept({ method: 'codexhost/item/completed', params: { item: toolItem } })
  projector.accept({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', text: 'fixture answer' } } })
  projector.settle()
  const messages = f.events.filter(e => e.type === 'assistant/message')
  assert.equal(messages.length, 2)
  for (const event of messages) assert.deepEqual(event.data.message.source, { kind: 'model', provider, model })
  assert.deepEqual(messages[1].data.message.content, [{ type: 'text', text: 'fixture answer' }])
  assert.equal(f.frames[0].payload.frame.type, 'start')
  assert.equal(f.frames.at(-1).payload.frame.type, 'end')
})

function collaborationFixture() {
  const events = [], executions = []
  const agent = {
    id: 'session-collaboration-model-source-fixture',
    model: { current: () => ({ provider, model }) },
    session: { append(type, data) { events.push({ type, data }) }, snapshotEvents: () => events },
    inject() { throw new Error('fixture has no additional context') },
  }
  const toolSet = { dispose() {} }
  const ctx = {
    sessionPersistence: { async flush() {} },
    tools: {
      async resolve() { return toolSet },
      schemas() { return [{ name: 'list_agents', parameters: { type: 'object', properties: {} } }] },
      get(name) { return name === 'list_agents' ? {} : undefined },
      async execute(input) {
        executions.push(input)
        return { additionalContexts: [], results: [{ result: { content: [{ type: 'text', text: 'fixture result' }] } }] }
      },
    },
  }
  const helpers = {
    ToolCallId: value => value,
    createAssistantMessage: value => value,
    createToolResultMessage: value => value,
    appendPluginRecord: (session, type, data) => session.append(type, data),
  }
  const manager = new HostCollaboration(ctx, helpers)
  return {
    manager, events, executions,
    open: () => manager.open({ agent, turn: 6, step: 1, signal: new AbortController().signal }),
  }
}

for (const field of ['provider', 'model']) {
  test(`HostCollaboration rejects an empty ${field} without advertising or executing a tool`, async () => {
    const f = collaborationFixture(), lease = await f.open()
    try {
      lease.source = { kind: 'model', provider, model, [field]: '' }
      await assert.rejects(lease.call({ id: `invalid-${field}`, name: 'list_agents', arguments: {} }))
      assert.deepEqual(f.executions, [])
      assert.deepEqual(f.events.filter(e => e.type === 'assistant/message' || e.type === 'tool/result'), [],
        'a rejected source must not create an advertised call or orphan result; plugin rejection audit is allowed')
    } finally { await lease.close(); await f.manager.close() }
  })
}

test('HostCollaboration keeps an exact valid source, including kind, with identity helpers', async () => {
  const f = collaborationFixture(), lease = await f.open()
  try {
    lease.source = { provider, model }
    await lease.call({ id: 'valid-source', name: 'list_agents', arguments: {} })
    assert.equal(f.executions.length, 1)
    const assistant = f.events.filter(e => e.type === 'assistant/message')
    assert.equal(assistant.length, 1)
    assert.deepEqual(assistant[0].data.message.source, { kind: 'model', provider, model })
  } finally { await lease.close(); await f.manager.close() }
})
