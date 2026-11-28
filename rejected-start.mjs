import { isHostRecord } from './host-identity.mjs'
// A busy RPC rejection is a definite non-start, not an unknown network outcome.
export const BUSY_START_MESSAGE = 'External Thread already has an active Turn'
export const isBusyStartRejection = error => error?.code === -32072 && error?.message === BUSY_START_MESSAGE

/** Legacy evidence is limited to the exact persisted pending mapping and its ended local Turn. */
export function rejectedStartEvidence(session, state) {
  if (state?.phase !== 'submitted' || state.hostTurnId !== undefined || state.harnessId !== 'claude-code'
    || state.sessionId !== session.id || !Number.isSafeInteger(state.localTurn)
    || typeof state.lastHostTurnId !== 'string' || !state.lastHostTurnId) return undefined
  const events = session.snapshotEvents()
  const mapping = events.findLast(event => isHostRecord(event.type, 'thread') && event.ignorable === true)
  if (!mapping || JSON.stringify(mapping.data) !== JSON.stringify(state)) return undefined
  const end = events.find(event => event.seq > mapping.seq && event.type === 'turn/end' && event.data.turn === state.localTurn)
  const error = end?.data.reason?.kind === 'error' && end.data.reason.error
  if (error?.message !== BUSY_START_MESSAGE || ![-32072, 'UNKNOWN'].includes(error.code)) return undefined
  return { mappingSeq: mapping.seq, errorSeq: end.seq, localTurn: state.localTurn }
}

/** No resume, mutation, interruption or model request. A changed/live history is never cleared. */
export async function inspectRejectedStart(peer, state) {
  const read = includeTurns => peer.request('thread/read', { threadId: state.threadId, includeTurns }, { timeoutMs: 15000 })
  const before = (await read(true)).thread
  if (before?.id !== state.threadId || before.status?.type !== 'idle' || before.historyMode === 'paginated'
    || !Number.isFinite(before.updatedAt) || !Array.isArray(before.turns)) return undefined
  const terminal = turn => ['completed', 'failed', 'interrupted'].includes(turn?.status)
  const anchor = before.turns.find(turn => turn.id === state.lastHostTurnId)
  const latest = before.turns.at(-1)
  if (!terminal(anchor) || !terminal(latest) || before.turns.some(turn => !terminal(turn))) return undefined
  const after = (await read(false)).thread
  if (after?.id !== state.threadId || after.status?.type !== 'idle' || after.updatedAt !== before.updatedAt) return undefined
  return { latestHostTurnId: latest.id, latestOutcome: latest.status, updatedAt: after.updatedAt }
}
