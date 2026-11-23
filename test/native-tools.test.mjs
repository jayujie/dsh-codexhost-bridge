import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeToolProjector } from '../native-tool-projector.mjs'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

test('Native tool calls, skill arguments and results use DSH lifecycle and deduplicate compatibility items', () => {
  const events = []
  const projector = new NativeToolProjector({ append(type, data, options) { events.push({ type, data, options }) } }, { createToolResultMessage: value => value, createAssistantMessage: value => value }, { turn: 1, step: 1 }, 'claude-code', { provider: 'codexhost/claude-code', model: 'fixture-claude' })
  const item = { type: 'toolExecution', itemId: 'skill-call', toolName: 'Skill', arguments: { skill: 'test-skill' } }
  projector.accept({ method: 'codexhost/item/started', params: { item } })
  projector.accept({ method: 'item/started', params: { item: { id: 'skill-call', type: 'dynamicToolCall', tool: 'Skill' } } })
  projector.accept({ method: 'codexhost/item/completed', params: { item: { ...item, output: { content: [{ type: 'text', text: 'Skill loaded' }] } }, outcome: { status: 'succeeded' } } })
  projector.accept({ method: 'codexhost/item/completed', params: { item } })
  projector.settle()
  assert.deepEqual(events.map(event => event.type), ['assistant/message', 'tool/call', 'tool/result'])
  assert.equal(events[0].data.message.content[0].type, 'tool-call')
  assert.equal(events[1].data.name, 'Skill')
  assert.deepEqual(JSON.parse(events[1].data.arguments), { skill: 'test-skill' })
  assert.equal(events[2].data.message.content[0].text, 'Skill loaded')
  assert.equal(events[2].data.message.isError, false)
})

test('Native command failures and interrupted calls are retained and are never marked successful', () => {
  const events = []
  const projector = new NativeToolProjector({ append(type, data) { events.push({ type, data }) } }, { createToolResultMessage: value => value, createAssistantMessage: value => value }, { turn: 2, step: 1 }, 'codex', { provider: 'codexhost/codex', model: 'fixture-codex' })
  projector.accept({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'failed', command: 'false', exitCode: 1, aggregatedOutput: 'failure', status: 'completed' } } })
  projector.accept({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'open', command: 'wait' } } })
  projector.settle()
  assert.equal(events.filter(event => event.type === 'tool/result').length, 2)
  assert.ok(events.filter(event => event.type === 'tool/result').every(event => event.data.message.isError))
})

test('Streamed command output survives a completion that omits aggregatedOutput', () => {
  const events = []
  const projector = new NativeToolProjector({ append(type, data) { events.push({ type, data }) } }, { createToolResultMessage: value => value, createAssistantMessage: value => value }, { turn: 1, step: 1 }, 'codex', { provider: 'codexhost/codex', model: 'fixture-codex' })
  const item = { id: 'streamed', type: 'commandExecution', command: '17*19' }
  projector.accept({ method: 'item/started', params: { item } })
  projector.accept({ method: 'item/commandExecution/outputDelta', params: { itemId: item.id, delta: '323\n' } })
  projector.accept({ method: 'item/completed', params: { item: { ...item, status: 'completed', aggregatedOutput: null } } })
  assert.equal(events.at(-1).data.message.content[0].text, '323\n')
})

test('Recorded real Codex shell and file-change items retain their names, diffs, outputs and failures', async t => {
  const fixturePath = process.env.DSH_TOOL_SMOKE_FIXTURE ?? ''
  if (!fixturePath || !existsSync(fixturePath)) return t.skip('Optional local tool-smoke fixture not present in standalone repository')
  const proof = JSON.parse(await readFile(fixturePath, 'utf8'))
  const items = proof.results.find(result => result.harnessId === 'codex').tools
  const events = []
  const projector = new NativeToolProjector({ append(type, data) { events.push({ type, data }) } }, { createToolResultMessage: value => value, createAssistantMessage: value => value }, { turn: 1, step: 1 }, 'codex', { provider: 'codexhost/codex', model: 'fixture-codex' })
  for (const item of items) projector.accept({ method: 'item/completed', params: { item } })
  projector.settle()
  assert.equal(events.filter(event => event.type === 'tool/call').length, items.length)
  assert.equal(events.filter(event => event.type === 'tool/result').length, items.length)
  assert.ok(events.some(event => event.type === 'tool/call' && event.data.name === 'exec_command'))
  assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.content[0].text.includes('323')))
  assert.ok(events.some(event => event.type === 'tool/result' && event.data.meta.codexHost.item.type === 'fileChange' && event.data.message.content[0].text.includes('+edited-ok')))
  assert.equal(events.filter(event => event.type === 'tool/result' && event.data.message.isError).length, items.filter(item => item.status === 'failed' || (Number.isInteger(item.exitCode) && item.exitCode !== 0)).length)
})
