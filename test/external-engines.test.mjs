import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EXTERNAL_ENGINES, EXTERNAL_ENGINE_IDS, EXTERNAL_PRESETS, EXTERNAL_PRESET_IDS, presetForEngine, engineLabel, isExternalEngine } from '../external-engines.mjs'
import { nativeThreadState, EXTERNAL_PRESETS as DRIVER_PRESETS } from '../native-session-driver.mjs'
import { foldHostModelIdentity } from '../native-observations.mjs'
import { hostPermissionOptions } from '../permission-presentation.mjs'
import { NativeSessionImporter } from '../native-session-import.mjs'

const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8')

test('the engine table is internally consistent and keeps the original two engines first', () => {
  assert.deepEqual(EXTERNAL_ENGINE_IDS, ['codex', 'claude-code', 'antigravity'])
  assert.deepEqual(EXTERNAL_PRESET_IDS, ['codexhost-codex', 'codexhost-claude-code', 'codexhost-antigravity'])
  assert.deepEqual(EXTERNAL_PRESETS, { 'codexhost-codex': 'codex', 'codexhost-claude-code': 'claude-code', 'codexhost-antigravity': 'antigravity' })
  assert.deepEqual(DRIVER_PRESETS, EXTERNAL_PRESETS, 'the driver re-exports the shared table')
  for (const { id, preset, label } of EXTERNAL_ENGINES) {
    assert.equal(presetForEngine(id), preset); assert.equal(engineLabel(id), label); assert.ok(isExternalEngine(id))
  }
  assert.throws(() => presetForEngine('deepseek-harness'), /Unknown external engine/)
  assert.equal(isExternalEngine('deepseek-harness'), false)
})

// Browser-side modules are concatenated by build-client.mjs with imports stripped, so they carry
// literal copies. These checks fail when a copy is missed after adding or renaming an engine.
test('browser-side literal copies list every engine', async () => {
  const client = await read('client.mjs')
  for (const { id, preset, label } of EXTERNAL_ENGINES) {
    assert.ok(client.includes(`{ id: '${id}', label: '${label}' }`), `client.mjs AGENTS: ${id}`)
    assert.ok(client.includes(`preset === '${preset}' ? '${id}'`), `client.mjs agentId(): ${preset}`)
  }
  const presetView = await read('preset-view.mjs')
  for (const preset of EXTERNAL_PRESET_IDS) assert.ok(presetView.includes(`'${preset}'`), `preset-view.mjs: ${preset}`)
  const contract = await read('remote-contract.mjs')
  assert.equal([...contract.matchAll(/\['codex', 'claude-code', 'antigravity', 'deepseek-harness'\]\.includes/g)].length, 3, 'catalog owner, delegationTargets and selectAgent')
  assert.ok((await read('native-replies-client.mjs')).includes("['claude-code', 'codex', 'antigravity'].includes(data.harnessId)"))
})

test('the generated client bundle and icon table are up to date', async () => {
  const bundle = await read('client.js')
  const { AGENT_ICONS } = await import('../icons.mjs')
  for (const id of [...EXTERNAL_ENGINE_IDS, 'deepseek-harness']) assert.match(AGENT_ICONS[id] ?? '', /^data:image\/(png|svg\+xml);base64,/, 'icon for ' + id)
  assert.ok(bundle.includes(AGENT_ICONS.antigravity), 'client.js embeds the Antigravity icon: run npm run build:client')
  for (const preset of EXTERNAL_PRESET_IDS) assert.ok(bundle.includes(preset), `client.js knows ${preset}`)
  assert.match(bundle, /\{\s*id:\s*['"]antigravity['"],\s*label:\s*['"]Antigravity['"]\s*\}/)
})

test('a saved Antigravity mapping is accepted; an unknown engine is still rejected', () => {
  const session = data => ({ snapshotEvents: () => [{ type: 'plugin:codexhost/thread', ignorable: true, data }] })
  const mapping = { version: 1, harnessId: 'antigravity', phase: 'ready', threadId: 'thread-1' }
  assert.equal(nativeThreadState(session(mapping)).harnessId, 'antigravity')
  assert.throws(() => nativeThreadState(session({ ...mapping, harnessId: 'gemini-cli' })), /mapping is invalid/)
})

test('model identity is recovered for Antigravity from every recorded source', () => {
  const data = { version: 1, harnessId: 'antigravity', threadId: 't', appliedConfiguration: { modelId: 'gemini-x' } }
  assert.deepEqual(foldHostModelIdentity(null, { type: 'plugin:codexhost/thread', ignorable: true, data }), { harnessId: 'antigravity', threadId: 't', selectedModel: 'gemini-x' })
  const message = { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'codexhost/antigravity', model: 'gemini-y' } } } }
  assert.deepEqual(foldHostModelIdentity(null, message), { harnessId: 'antigravity', model: 'gemini-y' })
  // A Claude selection ref is special-cased; an Antigravity model id must never be treated as one.
  const observed = foldHostModelIdentity(null, { type: 'plugin:codexhost/observation', ignorable: true, data: { harnessId: 'antigravity', threadId: 't', model: 'default' } })
  assert.deepEqual(observed, { harnessId: 'antigravity', threadId: 't', model: 'default' })
})

test('Antigravity permission mode is presented as dangerous, never as a restricted choice', () => {
  const modes = [{ id: 'dangerously-skip-permissions', label: 'Skip permissions', dangerous: true }]
  const options = hostPermissionOptions('antigravity', modes)
  assert.equal(options.length, 1)
  assert.equal(options[0].dangerous, true)
  assert.equal(options[0].iconKind, 'full-access')
  assert.deepEqual(hostPermissionOptions('antigravity', [{ id: 'plan', label: 'Plan' }]), [], 'a mode the adapter does not advertise is not invented')
})

test('importing lists native Antigravity sessions and leaves Codex on its own path', async () => {
  const calls = []
  const peer = { async request(method, params) {
    calls.push([method, params.harnessId])
    if (method === 'thread/list') return { data: [], nextCursor: null }
    if (method === 'codexhost/harness/session-import/list') return { candidates: [{ nativeSessionId: 'agy-1', title: 'My chat', cwd: 'D:/w', updatedAt: 1700000000 }], total: 1 }
    throw new Error('Unexpected RPC ' + method)
  } }
  const importer = new NativeSessionImporter({}, {}, {})
  const agy = await importer.list(peer, { harnessId: 'antigravity' })
  assert.deepEqual(agy.rows.map(row => [row.kind, row.id, row.title]), [['native', 'agy-1', 'My chat']])
  assert.ok(calls.some(([method, harness]) => method === 'codexhost/harness/session-import/list' && harness === 'antigravity'))
  calls.length = 0
  const codex = await importer.list(peer, { harnessId: 'codex' })
  assert.deepEqual(codex.rows, [])
  assert.equal(calls.some(([method]) => method === 'codexhost/harness/session-import/list'), false)
})

// ---- backend payload: what the shipped bundle actually contains ----
test('the Antigravity adapter is pinned, enabled and allow-listed in the runtime', async () => {
  const manifest = JSON.parse(await read('backend/build-manifest.json'))
  assert.match(manifest.adapterPins.antigravity, /^[0-9a-f]{64}$/)
  assert.ok(manifest.files['plugins/antigravity/plugin.mjs'], 'the adapter is part of the reviewed payload')
  const plugin = JSON.parse(await read('backend/plugins/antigravity/manifest.json'))
  assert.equal(plugin.id, 'antigravity')
  assert.ok((await read('backend/host-runtime.mjs')).includes('new Set(["claude-code", "antigravity", "codex-usage", "deepseek-harness"])'))
  const source = await read('backend-builder.mjs')
  assert.ok(source.includes(manifest.adapterPins.antigravity), 'build script and manifest agree on the pin')
})

// Not a style check: this records the security posture we accepted when enabling the adapter. If a
// future adapter build adds real permission modes, or drops the flag, this fails so it gets reviewed.
test('the Antigravity adapter runs with skip-permissions as its only mode (accepted posture)', async () => {
  const bundle = await read('backend/plugins/antigravity/plugin.mjs')
  assert.ok(bundle.includes('"--dangerously-skip-permissions"'), 'agy is launched with --dangerously-skip-permissions')
  const start = bundle.indexOf('ANTIGRAVITY_PERMISSION_MODE_CATALOG = '), end = bundle.indexOf('function decodeAntigravityPermissionModeId')
  assert.ok(start > 0 && end > start, 'permission catalog located in the bundle')
  const catalog = bundle.slice(start, end)
  assert.equal([...catalog.matchAll(/^\s+id: "/gm)].length, 1, 'exactly one permission mode')
  // esbuild minifies `true` to `!0`.
  assert.ok(/id: "dangerously-skip-permissions"/.test(catalog) && /dangerous: (true|!0)/.test(catalog))
})
