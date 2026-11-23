/** Only explicit per-model Claude CLI metadata authorizes an effort entry. */
export function dshClaudeThinkingOptionIds(model) {
  const levels = model.supportsEffort === false || !Array.isArray(model.supportedEffortLevels) ? [] : model.supportedEffortLevels
  const allowed = ['low', 'medium', 'high', 'xhigh', 'max'].filter(id => levels.includes(id))
  return [...(model.supportsThinkingOff === false ? [] : ['off']), 'auto', ...allowed, ...(allowed.includes('xhigh') ? ['ultracode'] : [])]
}
