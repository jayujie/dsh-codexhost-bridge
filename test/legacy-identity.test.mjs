// Sessions created before 2026-11-27 carry plugin:codexhost/* records and codexhost-* preset ids.
// They are never rewritten, so every reader must keep accepting them; new records use dsh-host names.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hostRecord, hostRecordTypes, isHostRecord } from '../host-identity.mjs'
import { EXTERNAL_PRESETS, LEGACY_PRESET_IDS, presetForEngine } from '../external-engines.mjs'
import { nativeThreadState } from '../native-session-driver.mjs'
import { savedReplies, importedThroughTurn } from '../native-replies.mjs'
import { foldHostModelIdentity, OBSERVATION_TYPES } from '../native-observations.mjs'
import { apply } from '../native-preset-driver.mjs'

const session = events => ({ snapshotEvents: () => events })
const mapping = { version: 1, harnessId: 'claude-code', phase: 'ready', threadId: 'thread-old' }

test('record names: write dsh-host, read dsh-host and codexhost', () => {
  assert.equal(hostRecord('thread'), 'plugin:dsh-host/thread')
  assert.deepEqual(hostRecordTypes('thread'), ['plugin:dsh-host/thread', 'plugin:codexhost/thread'])
  assert.ok(isHostRecord('plugin:codexhost/thread', 'thread'))
  assert.ok(isHostRecord('plugin:dsh-host/thread', 'thread'))
  assert.ok(!isHostRecord('plugin:codexhost/thread-x', 'thread'))
  assert.ok(!isHostRecord('plugin:other/thread', 'thread'))
  assert.deepEqual(OBSERVATION_TYPES, ['plugin:dsh-host/observation-v2', 'plugin:codexhost/observation-v2', 'plugin:codexhost/observation'])
})

test('presets: new Sessions get dsh-host-*, old codexhost-* Sessions still resolve to their engine', () => {
  assert.equal(presetForEngine('claude-code'), 'dsh-host-claude-code')
  for (const legacy of LEGACY_PRESET_IDS) assert.equal(EXTERNAL_PRESETS[legacy], legacy.replace('codexhost-', ''))
})

test('an old Session mapping recorded as plugin:codexhost/thread is still the active mapping', () => {
  assert.equal(nativeThreadState(session([{ type: 'plugin:codexhost/thread', ignorable: true, data: mapping }])).threadId, 'thread-old')
  // After the rename the plugin appends a new-name record; the newest record wins regardless of name.
  const mixed = session([
    { type: 'plugin:codexhost/thread', ignorable: true, data: mapping },
    { type: 'plugin:dsh-host/thread', ignorable: true, data: { ...mapping, threadId: 'thread-new' } },
  ])
  assert.equal(nativeThreadState(mixed).threadId, 'thread-new')
})

test('replies and import watermarks recorded under both names fold into one history', () => {
  const reply = (type, revision, text, append) => ({ type, ignorable: true, data: { version: 1, threadId: 't', hostTurnId: 'h1', itemId: 'i1', revision, text, append, status: 'completed' } })
  const items = savedReplies(session([reply('plugin:codexhost/native-message', 1, 'Hello'), reply('plugin:dsh-host/native-message', 2, ' world', true)]), 't')
  assert.equal([...items.values()][0].text, 'Hello world')
  const imported = session([{ type: 'plugin:codexhost/import', ignorable: true, data: { threadId: 't', newestTurnId: 'turn-9' } }])
  assert.equal(importedThroughTurn(imported, 't'), 'turn-9')
})

test('model identity is recovered from an old plugin:codexhost/thread record', () => {
  const data = { ...mapping, appliedConfiguration: { modelId: 'claude-x' } }
  assert.deepEqual(foldHostModelIdentity(null, { type: 'plugin:codexhost/thread', ignorable: true, data }), { harnessId: 'claude-code', threadId: 'thread-old', selectedModel: 'claude-x' })
})

test('an old codexhost-* Session is still treated as external and never falls back to the DSH model', () => {
  const handlers = {}
  const agent = { session: {} }
  apply({ on(name, handler) { handlers[name] = handler }, get(name) {
    if (name === 'agents') return { get: () => agent, currentInitiator: () => agent }
    if (name === 'agentPresets') return { presetForSession: () => 'codexhost-claude-code' }
  } })
  assert.throws(() => handlers['llm/stream']({ sessionId: 'old' }, () => { throw new Error('must not reach adapter') }), /refusing a DSH model call/)
})

test('legacy preset registration uses clean engine names without suffix while preserving description and sort order', async () => {
  const { readFile } = await import('node:fs/promises')
  const driverSource = await readFile(new URL('../native-session-driver.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(driverSource, /（旧会话兼容）/)
  assert.match(driverSource, /agentPresets\.register\(\{\s*id,\s*name:\s*engineLabel\(harness\)/)
})
