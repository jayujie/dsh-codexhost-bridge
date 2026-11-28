/**
 * Single source of truth for the external execution engines the bridge can drive.
 *
 * Server-side modules import this. Browser-side modules (client.mjs, remote-contract.mjs,
 * preset-view.mjs, permission-presentation.mjs, native-replies-client.mjs) cannot: build-client.mjs
 * strips imports and concatenates them, so they carry literal copies instead.
 * test/external-engines.test.mjs fails if a literal copy drifts from this list.
 */
export const EXTERNAL_ENGINES = Object.freeze([
  Object.freeze({ id: 'codex', preset: 'dsh-host-codex', legacyPreset: 'codexhost-codex', label: 'Codex' }),
  Object.freeze({ id: 'claude-code', preset: 'dsh-host-claude-code', legacyPreset: 'codexhost-claude-code', label: 'Claude Code' }),
  // Google Antigravity CLI (`agy`). Signs in with the user's Google account through `agy` itself.
  // Its only native permission mode is dangerously-skip-permissions: no tool approval, no sandbox.
  Object.freeze({ id: 'antigravity', preset: 'dsh-host-antigravity', legacyPreset: 'codexhost-antigravity', label: 'Antigravity' }),
])

export const EXTERNAL_ENGINE_IDS = Object.freeze(EXTERNAL_ENGINES.map(engine => engine.id))
/**
 * New Sessions select `preset`. `legacyPreset` stays registered (hidden from pickers) because
 * Sessions created before 2026-11-27 recorded it and DSH remounts a Session by that exact id.
 */
export const LEGACY_PRESET_IDS = Object.freeze(EXTERNAL_ENGINES.map(engine => engine.legacyPreset))
/** Every external preset id, current and legacy: use for "is this an external Session" checks. */
export const EXTERNAL_PRESET_IDS = Object.freeze(EXTERNAL_ENGINES.flatMap(engine => [engine.preset, engine.legacyPreset]))
/** preset id (current or legacy) -> engine id, e.g. 'dsh-host-antigravity' -> 'antigravity'. */
export const EXTERNAL_PRESETS = Object.freeze(Object.fromEntries(EXTERNAL_ENGINES.flatMap(engine => [[engine.preset, engine.id], [engine.legacyPreset, engine.id]])))

export const isExternalEngine = id => EXTERNAL_ENGINE_IDS.includes(id)
export const engineLabel = id => EXTERNAL_ENGINES.find(engine => engine.id === id)?.label ?? String(id)
export const HOST_PROVIDER_PREFIX = 'dsh-host/'
// Read-only: assistant messages recorded before the 2026-11-25 rebrand carry this provider prefix.
export const LEGACY_HOST_PROVIDER_PREFIX = 'codexhost/'
export const hostProvider = id => `${HOST_PROVIDER_PREFIX}${id}`
export const isHostProvider = provider => typeof provider === 'string' && (provider.startsWith(HOST_PROVIDER_PREFIX) || provider.startsWith(LEGACY_HOST_PROVIDER_PREFIX))
export function hostProviderEngine(provider) {
  if (typeof provider !== 'string') return undefined
  const raw = provider.startsWith(HOST_PROVIDER_PREFIX) ? provider.slice(HOST_PROVIDER_PREFIX.length)
    : provider.startsWith(LEGACY_HOST_PROVIDER_PREFIX) ? provider.slice(LEGACY_HOST_PROVIDER_PREFIX.length)
    : undefined
  return raw && EXTERNAL_ENGINE_IDS.includes(raw) ? raw : undefined
}
export function presetForEngine(id) {
  const engine = EXTERNAL_ENGINES.find(candidate => candidate.id === id)
  if (!engine) throw new Error(`Unknown external engine: ${id}`)
  return engine.preset
}
