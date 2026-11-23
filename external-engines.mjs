/**
 * Single source of truth for the external execution engines the bridge can drive.
 *
 * Server-side modules import this. Browser-side modules (client.mjs, remote-contract.mjs,
 * preset-view.mjs, permission-presentation.mjs, native-replies-client.mjs) cannot: build-client.mjs
 * strips imports and concatenates them, so they carry literal copies instead.
 * test/external-engines.test.mjs fails if a literal copy drifts from this list.
 */
export const EXTERNAL_ENGINES = Object.freeze([
  Object.freeze({ id: 'codex', preset: 'codexhost-codex', label: 'Codex' }),
  Object.freeze({ id: 'claude-code', preset: 'codexhost-claude-code', label: 'Claude Code' }),
  // Google Antigravity CLI (`agy`). Signs in with the user's Google account through `agy` itself.
  // Its only native permission mode is dangerously-skip-permissions: no tool approval, no sandbox.
  Object.freeze({ id: 'antigravity', preset: 'codexhost-antigravity', label: 'Antigravity' }),
])

export const EXTERNAL_ENGINE_IDS = Object.freeze(EXTERNAL_ENGINES.map(engine => engine.id))
export const EXTERNAL_PRESET_IDS = Object.freeze(EXTERNAL_ENGINES.map(engine => engine.preset))
/** preset id -> engine id, e.g. 'codexhost-antigravity' -> 'antigravity'. */
export const EXTERNAL_PRESETS = Object.freeze(Object.fromEntries(EXTERNAL_ENGINES.map(engine => [engine.preset, engine.id])))

export const isExternalEngine = id => EXTERNAL_ENGINE_IDS.includes(id)
export const engineLabel = id => EXTERNAL_ENGINES.find(engine => engine.id === id)?.label ?? String(id)
export function presetForEngine(id) {
  const engine = EXTERNAL_ENGINES.find(candidate => candidate.id === id)
  if (!engine) throw new Error(`Unknown external engine: ${id}`)
  return engine.preset
}
