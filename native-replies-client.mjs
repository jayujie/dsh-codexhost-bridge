// UI-only projection of durable, ignorable plugin events. No execution or model surface writes.
const NATIVE_REPLIES_EVENT = 'plugin:codexhost/native-message'

function nativeRepliesData(event) {
  const data = event?.data
  if (event?.type !== NATIVE_REPLIES_EVENT || !data || data.version !== 1
    || !['claude-code', 'codex', 'antigravity'].includes(data.harnessId)
    || !['threadId', 'hostTurnId', 'itemId'].every(key => typeof data[key] === 'string' && data[key].length > 0)
    || typeof data.text !== 'string'
    || !Number.isSafeInteger(data.revision) || data.revision < 1
    || (data.append !== undefined && typeof data.append !== 'boolean')
    || !['streaming', 'completed', 'failed', 'interrupted'].includes(data.status)
    || (data.suppressed !== undefined && typeof data.suppressed !== 'boolean')
    || (data.model !== undefined && typeof data.model !== 'string')
    || (data.nativeTime !== undefined && (typeof data.nativeTime !== 'number' || !Number.isFinite(data.nativeTime)))) return null
  return data
}

function nativeRepliesIdentity(data) {
  return JSON.stringify([data.harnessId, data.threadId, data.hostTurnId, data.itemId])
}

function nativeRepliesMatch(event) {
  const data = nativeRepliesData(event)
  // Update-only contexts also work when history is paginated.
  return data === null ? null : { id: nativeRepliesIdentity(data), role: 'update' }
}

function nativeRepliesProjection(context) {
  let latest
  let first
  let text = ''
  let revision = 0
  for (const match of context.matches) {
    const data = nativeRepliesData(match.event)
    if (data === null || nativeRepliesIdentity(data) !== context.id) continue
    if (first === undefined || match.event.seq < first.seq) first = match.event
    if (data.revision <= revision) continue
    text = data.append === true ? text + data.text : data.text
    revision = data.revision
    latest = match.event
  }
  if (latest === undefined) return null
  const data = latest.data
  const time = data.nativeTime ?? latest.time
  const visible = data.suppressed !== true && text.trim() !== ''
  const blocks = visible ? [{ kind: 'text', text }] : []
  const streaming = data.status === 'streaming'
  // A provider/API failure is not a user cancellation. Preserve the native error text without a 已停止 label.
  const interrupted = data.status === 'interrupted'
  const node = streaming || !visible ? undefined : {
    kind: 'assistant', seq: latest.seq, time, turn: 0, step: 0, blocks,
    // No messageId: this is not an editable assistant/message on the model surface.
    ...(interrupted ? { interrupted: true } : {}),
  }
  return { latest, anchorSeq: first.seq, time, blocks, visible, streaming, interrupted, node }
}

function nativeRepliesDefinition(target) {
  return {
    kind: `codexhost-native-reply-${target}`,
    target,
    match: { [NATIVE_REPLIES_EVENT]: nativeRepliesMatch },
    start: (_context, match) => match.event,
    update: (_context, match) => match.event,
    publication: () => 'immediate',
    buildViewNode(context) {
      const projected = nativeRepliesProjection(context)
      if (projected === null) return null
      const { anchorSeq, time, blocks, visible, streaming, interrupted, node } = projected
      const envelope = {
        key: context.key, id: context.id, target, anchorSeq,
        // Never borrow the surrounding DSH Turn/Step or create a fake execution lifecycle.
        location: { kind: 'session' },
      }
      if (target === 'chat') return {
        ...envelope,
        kind: 'assistant-step',
        visibility: visible ? 'visible' : 'hidden',
        data: {
          status: streaming ? 'running' : interrupted ? 'interrupted' : 'settled',
          turn: 0, step: 0, blocks, time,
          ...(node === undefined ? {} : { finalNode: node }),
        },
      }
      return {
        ...envelope,
        kind: context.kind,
        data: {
          kind: 'assistant',
          ...(node === undefined ? {} : { node }),
          partial: streaming && visible ? { turn: 0, step: 0, blocks } : null,
        },
      }
    },
  }
}

/** Register native renderer contracts only; the caller must inject uiConversation. */
export function installNativeRepliesClient(ctx) {
  const disposers = []
  try {
    for (const target of ['chat', 'trajectory']) {
      disposers.push(ctx.uiConversation.events.register(nativeRepliesDefinition(target)))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}
