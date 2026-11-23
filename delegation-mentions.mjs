/** The four supported Host targets; ids and Markdown carrier follow CodexHost v0.17.4. */
export const DELEGATION_AGENTS = Object.freeze([
  { id: 'codex', label: 'Codex' }, { id: 'claude-code', label: 'Claude Code' }, { id: 'antigravity', label: 'Antigravity' }, { id: 'deepseek-harness', label: 'DSH' },
])
export const DELEGATION_SOURCE = 'codexhost-agent'
export function delegationCarrier(id) {
  const target = DELEGATION_AGENTS.find(agent => agent.id === id)
  if (!target) throw new TypeError('Unsupported delegation target')
  return `[@${target.label}](subagent://codexhost.${target.id})`
}
export function delegationReference(id) {
  const target = DELEGATION_AGENTS.find(agent => agent.id === id)
  if (!target) throw new TypeError('Unsupported delegation target')
  return { source: DELEGATION_SOURCE, ref: id, label: `@${target.label}`, appearance: 'session', clipboardText: delegationCarrier(id) }
}
/** Match only a word-start #query at the caret; issue numbers and Markdown headings stay text. */
export function findDelegationTrigger(before, span) {
  if (!span || span.start !== span.end || !Number.isSafeInteger(span.end) || !Number.isSafeInteger(span.draftRev)) return null
  const match = /(?:^|\s)#([^\s#]{0,32})$/u.exec(before)
  if (!match || /^\d/u.test(match[1])) return null
  const length = match[1].length + 1
  if (length > span.end) return null
  return { query: match[1], span: { start: span.end - length, end: span.end, draftRev: span.draftRev } }
}
/** Only direct user messages can authorize new native DSH child tasks. */
export function selectedDelegationTargets(messages) {
  const ids = new Set()
  for (const message of messages) {
    if (message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(/\[@[^\]\n]+\]\(<?subagent:\/\/codexhost\.([a-z0-9][a-z0-9-]*)>?\)/gu)) {
        if (!DELEGATION_AGENTS.some(agent => agent.id === match[1])) throw new TypeError('Unsupported delegation target')
        ids.add(match[1])
      }
    }
  }
  return [...ids]
}
export function filterDelegationTargets(targets, query) {
  const needle = query.trim().replace(/^@/u, '').toLowerCase()
  return targets.filter(target => `${target.id} ${target.label}${target.id === 'antigravity' ? ' agy' : ''}`.toLowerCase().includes(needle))
}
