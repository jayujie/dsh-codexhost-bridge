const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Keep the requested effort range, using only entries supplied by the model catalog. */
export function thinkingEfforts(options) {
  return EFFORT_IDS.flatMap(id => {
    const option = options.find(option => option.id === id)
    return option ? [option] : []
  })
}

/** Resolve saved/default selections against the model's remaining official effort entries. */
export function selectedThinkingEffort(options, requested, defaultId) {
  return [requested, defaultId, options[0]?.id].find(id => options.some(option => option.id === id))
}
