export const CODEXHOST_BRIDGE_PROTOCOL = 'dsh-host-bridge/v1'

const MAX_JSON_BYTES = 64 * 1024
const MAX_REQUEST_ID_LENGTH = 128

export class BridgeProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeProtocolError'
    this.code = code
  }
}

export function parseJsonBody(raw, maxBytes = MAX_JSON_BYTES) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new BridgeProtocolError('request_too_large', 'DSH Host bridge request exceeds its size limit')
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new BridgeProtocolError('invalid_json', 'DSH Host bridge request is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeProtocolError('invalid_request', 'DSH Host bridge request must be a JSON object')
  }
  return value
}

export function requestId(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) {
    throw new BridgeProtocolError('invalid_request_id', 'DSH Host bridge requestId is invalid')
  }
  return value
}

export function harnessId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REQUEST_ID_LENGTH) {
    throw new BridgeProtocolError('invalid_harness_id', 'DSH Host bridge harnessId is invalid')
  }
  return value
}

export function boundedString(value, name, maximum = MAX_REQUEST_ID_LENGTH) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new BridgeProtocolError(`invalid_${name}`, `DSH Host bridge ${name} is invalid`)
  }
  return value
}

export function positiveInteger(value, name, maximum = 100) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BridgeProtocolError(`invalid_${name}`, `DSH Host bridge ${name} is invalid`)
  }
  return value
}

export function bridgeResponse(request, result) {
  return {
    protocol: CODEXHOST_BRIDGE_PROTOCOL,
    ...requestId(request) ? { requestId: requestId(request) } : {},
    ok: true,
    result,
  }
}

export function bridgeError(request, code, message) {
  return {
    protocol: CODEXHOST_BRIDGE_PROTOCOL,
    ...requestId(request) ? { requestId: requestId(request) } : {},
    ok: false,
    error: { code, message },
  }
}

export function jsonResponse(response, status = 200) {
  const body = JSON.stringify(response)
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
}
