import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeNativeHarnessRoute } from '../harness-route.mjs'

test('complete model/thinking/permission configuration follows the Host canonical route order', () => {
  const wire = encodeNativeHarnessRoute('claude-code', { modelId: 'claude-model-v1.aGFpa3U', thinkingOptionId: 'off', permissionModeId: 'default' })
  const expected = '{"harnessId":"claude-code","model":{"id":"claude-model-v1.aGFpa3U"},"thinkingOptionId":"off","permissionModeId":"default"}'
  assert.equal(Buffer.from(wire.slice('codexhost/plugin-v1@'.length), 'hex').toString(), expected)
})
