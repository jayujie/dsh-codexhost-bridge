/** A scoped view of the original DSH preset store, excluding the external execution presets (literal copy: keep in sync with external-engines.mjs). */
export function dshPresetView(source) {
  let previous, filtered
  return {
    subscribe: listener => source.subscribe(listener),
    getSnapshot() {
      const value = source.getSnapshot()
      if (value !== previous) {
        previous = value
        filtered = { ...value, options: value.options.filter(option => !['codexhost-codex', 'codexhost-claude-code', 'codexhost-antigravity'].includes(option.id)) }
      }
      return filtered
    },
  }
}
