import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeRemoteDescriptors } from '../remote-contract.mjs'

test('native endpoints require the authorized Agent lookup and cannot target arbitrary Host Threads', () => {
  for (const descriptor of nativeRemoteDescriptors) {
    assert.deepEqual(descriptor.parameters[0], {
      name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
      codec: descriptor.parameters[0].codec,
    })
    assert.equal(descriptor.parameters[0].codec.typeSymbol, '@deepseek-ai/dsh-session/types#SessionId')
    assert.equal(new Set(descriptor.parameters.map(parameter => parameter.wire)).size, descriptor.parameters.length)
    assert.equal(descriptor.parameters.some(parameter => /threadId|token|url/i.test(parameter.wire)), false)
  }
})

test('Agent configuration rejects unknown fields and oversized or empty model references', () => {
  const parse = nativeRemoteDescriptors.find(descriptor => descriptor.method === 'configure').parameters[1].codec.create().parse
  assert.deepEqual(parse({ modelId: 'opaque-model-ref', permissionModeId: 'default' }), { modelId: 'opaque-model-ref', permissionModeId: 'default' })
  for (const input of [{ url: 'http://example.com' }, { modelId: '' }, { modelId: 'x'.repeat(4097) }, { modelId: null }]) assert.throws(() => parse(input))
})
