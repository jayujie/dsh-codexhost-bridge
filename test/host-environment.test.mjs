import test from 'node:test'
import assert from 'node:assert/strict'
import { standaloneHostEnvironment } from '../host-installation.mjs'

test('standalone Host removes the Electron crash reporter pipe without dropping Harness credentials or mutating its parent', () => {
  const parent = { CHROME_CRASHPAD_PIPE_NAME: 'private-electron-pipe', PATH: 'existing-cli-path', ANTHROPIC_API_KEY: 'test-only-secret', ELECTRON_RUN_AS_NODE: '1' }
  const child = standaloneHostEnvironment(parent)
  assert.equal(Object.hasOwn(child, 'CHROME_CRASHPAD_PIPE_NAME'), false)
  assert.equal(child.PATH, parent.PATH)
  assert.equal(child.ANTHROPIC_API_KEY, parent.ANTHROPIC_API_KEY)
  assert.equal(parent.CHROME_CRASHPAD_PIPE_NAME, 'private-electron-pipe')
})
