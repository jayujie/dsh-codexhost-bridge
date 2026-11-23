import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEXHOST_BRIDGE_PROTOCOL,
  BridgeProtocolError,
  bridgeResponse,
  harnessId,
  parseJsonBody,
  requestId,
} from '../protocol.mjs'

test('parses bounded object requests and preserves request ids', () => {
  assert.deepEqual(parseJsonBody('{"requestId":"abc"}'), { requestId: 'abc' })
  assert.equal(requestId('abc'), 'abc')
  assert.equal(harnessId('claude-code'), 'claude-code')
  assert.deepEqual(bridgeResponse('abc', { ok: 1 }), {
    protocol: CODEXHOST_BRIDGE_PROTOCOL,
    requestId: 'abc',
    ok: true,
    result: { ok: 1 },
  })
})

test('rejects malformed, array, oversized, and invalid-id input', () => {
  assert.throws(() => parseJsonBody('{'), error => error instanceof BridgeProtocolError && error.code === 'invalid_json')
  assert.throws(() => parseJsonBody('[]'), error => error instanceof BridgeProtocolError && error.code === 'invalid_request')
  assert.throws(() => parseJsonBody('x'.repeat(65 * 1024)), error => error instanceof BridgeProtocolError && error.code === 'request_too_large')
  assert.throws(() => requestId('x'.repeat(129)), error => error instanceof BridgeProtocolError && error.code === 'invalid_request_id')
  assert.throws(() => harnessId(''), error => error instanceof BridgeProtocolError && error.code === 'invalid_harness_id')
})
