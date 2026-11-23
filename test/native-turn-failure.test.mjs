import test from 'node:test'
import assert from 'node:assert/strict'
import {observedTurnFailure} from '../native-turn-failure.mjs'

test('native error categories survive camelCase and recorded snake_case forms', () => {
  assert.equal(observedTurnFailure({codexErrorInfo: 'modelNotFound', message: 'actual wire category'}).code, 'modelNotFound')
  for (const key of ['codexErrorInfo', 'codex_error_info']) assert.deepEqual(observedTurnFailure({[key]: 'model_not_found', message: 'model unavailable'}), {code: 'model_not_found', message: 'model unavailable'})
  const failure = observedTurnFailure({codexErrorInfo: {httpConnectionFailed: {httpStatusCode: 404, body: 'never include'}}, message: 'connection failed', requestId: 'req-123'})
  assert.deepEqual(failure, {code: 'httpConnectionFailed', message: 'connection failed', httpStatusCode: 404, requestId: 'req-123'})
  assert.deepEqual(observedTurnFailure(failure), failure)
})
test('failure records exclude raw errors, bound text, and redact known credential forms', () => {
  const failure = observedTurnFailure({message: 'Bearer very-secret token=another-secret https://user:pass@example.com/key?token=x sk-abcdefgh1234 ' + 'x'.repeat(5000), codexErrorInfo: 'model_not_found', stack: 'secret-stack', headers: {authorization: 'secret-header'}, additionalDetails: 'secret-details', body: 'secret-body'})
  assert.ok(failure.message.length <= 2000)
  const encoded = JSON.stringify(failure)
  for (const secret of ['very-secret', 'another-secret', 'user:pass', 'sk-abcdefgh1234', 'secret-stack', 'secret-header', 'secret-details', 'secret-body']) assert.ok(!encoded.includes(secret))
  assert.deepEqual(Object.keys(failure).sort(), ['code', 'message'])
})
test('JSON and quoted credential fields including Basic authentication are redacted', () => {
  const message = JSON.stringify({api_key: 'example-secret-value', authorization: 'Basic dXNlcjpwYXNz', token: 'example-token-value', refresh_token: 'example-refresh-value', password: 'example-password-value'})
  const result = JSON.stringify(observedTurnFailure({message}))
  for (const secret of ['example-secret-value', 'dXNlcjpwYXNz', 'example-token-value', 'example-refresh-value', 'example-password-value']) assert.ok(!result.includes(secret))
  assert.ok(!observedTurnFailure({message: "'token': 'quoted secret with spaces'"}).message.includes('quoted secret'))
  assert.ok(!observedTurnFailure({message: 'Authorization: Basic dXNlcjpwYXNz'}).message.includes('dXNlcjpwYXNz'))
})
test('missing or malformed error fields never invent a native category or HTTP status', () => {
  assert.equal(observedTurnFailure(null).code, 'HOST_TURN_FAILED')
  assert.equal(observedTurnFailure({codexErrorInfo: {one: {}, two: {}}, httpStatusCode: 1000}).httpStatusCode, undefined)
  assert.equal(observedTurnFailure({code: 'bad code with whitespace'}).code, 'HOST_TURN_FAILED')
})
