import { hostRecord } from './host-identity.mjs'
export const HOST_TURN_FAILURE = hostRecord('turn-failure')

/** Keep only bounded diagnostics, never raw transport error objects or credentials. */
export function observedTurnFailure(error) {
  const info = error?.codexErrorInfo ?? error?.codex_error_info
  let category
  let httpStatusCode = Number.isInteger(error?.httpStatusCode) && error.httpStatusCode >= 100 && error.httpStatusCode <= 599 ? error.httpStatusCode : undefined
  if (typeof info === 'string') category = info
  else if (info && typeof info === 'object' && !Array.isArray(info)) {
    const keys = Object.keys(info)
    if (keys.length === 1) {
      category = keys[0]
      const status = info[category]?.httpStatusCode
      if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatusCode = status
    }
  }
  const rawCode = category ?? error?.code
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(rawCode) ? rawCode : 'HOST_TURN_FAILED'
  const rawMessage = typeof error?.message === 'string' && error.message.trim() ? error.message : 'The native task failed without a reported error.'
  const message = rawMessage.replace(/https?:\/\/[^\s]+/giu, '[URL redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/giu, '$1 [redacted]')
    .replace(/(["']?(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|(?:client[_-]?)?secret|password|authorization)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/giu, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[redacted]').slice(0, 2000)
  const requestId = error?.requestId ?? error?.request_id
  return { code, message, ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
    ...(typeof requestId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(requestId) ? { requestId } : {}) }
}
