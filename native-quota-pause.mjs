// Recognize the gateway's five-hour quota rejection that the Claude CLI records as a
// synthetic "API Error: 503 ..." assistant message, and expose its announced reset
// time. Read-only fold: it never sends anything; the client decides whether to resume.
export const QUOTA_PAUSE_KEY = 'codexHostQuotaPause'

const QUOTA_MARK = /五小时(?:用量|额度)/u
const RESET_AT = /预计最早重置[：:]\s*北京时间\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/u

/** Parse the gateway text; returns the reset instant (epoch ms) or undefined. */
export function parseQuotaReset(text) {
  if (typeof text !== 'string' || !/^API Error:\s*503\b/u.test(text.trimStart()) || !QUOTA_MARK.test(text)) return undefined
  const match = RESET_AT.exec(text)
  if (!match) return { resetAt: undefined }
  const [, y, mo, d, hh, mm, ss = '00'] = match
  const resetAt = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`)
  return { resetAt: Number.isFinite(resetAt) ? resetAt : undefined }
}

const textOf = message => Array.isArray(message?.content)
  ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''

/**
 * State: { streak, candidate?, paused? }.
 * - candidate: a quota text seen inside the running turn.
 * - paused: that turn then ended with an error. Cleared when any new turn starts.
 * - streak: consecutive quota-ended turns; reset by a turn that ends without error.
 */
export function foldQuotaPause(state, event) {
  const current = state ?? { streak: 0 }
  const data = event?.data
  if (event?.type === 'turn/start') {
    if (!current.paused && !current.candidate) return state
    return { streak: current.streak }
  }
  if (event?.type === 'assistant/message' && data?.message?.source?.provider === 'codexhost/claude-code') {
    const parsed = parseQuotaReset(textOf(data.message))
    if (!parsed) return state
    return { streak: current.streak, candidate: { turn: data.turn, ...(parsed.resetAt === undefined ? {} : { resetAt: parsed.resetAt }), failedAt: event.time, seq: event.seq } }
  }
  if (event?.type === 'turn/end') {
    const failed = data?.reason?.kind === 'error'
    if (failed && current.candidate && current.candidate.turn === data.turn) return { streak: current.streak + 1, paused: current.candidate }
    if (!failed && (current.streak || current.candidate)) return { streak: 0 }
    if (current.candidate) return { streak: current.streak }
  }
  return state
}

export async function installQuotaPauseProjection(ctx) {
  const { z } = await ctx.loader.import('zod')
  const pause = z.object({ turn: z.number().int().nonnegative(), resetAt: z.number().int().optional(), failedAt: z.number().int().nonnegative(), seq: z.number().int().nonnegative() }).strict()
  const schema = z.object({ streak: z.number().int().nonnegative(), candidate: pause.optional(), paused: pause.optional() }).strict().nullable()
  return await ctx.sessionProjections.register({ key: QUOTA_PAUSE_KEY, stateVersion: 1, stateSchema: schema, init: () => null,
    apply: foldQuotaPause,
    wire: { viewSchema: schema, view: state => state?.paused ? { streak: state.streak, paused: state.paused } : null, summary: false } })
}
