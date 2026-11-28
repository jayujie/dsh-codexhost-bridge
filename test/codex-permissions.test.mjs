import test from 'node:test'
import assert from 'node:assert/strict'
import { codexPermissionMode, codexPermissionParameters } from '../codex-permissions.mjs'
import { dshPresetView } from '../preset-view.mjs'

test('Codex permission selections carry both approval and sandbox, preserving old default records', () => {
  assert.equal(codexPermissionMode('on-request'), 'workspace-write')
  assert.deepEqual(codexPermissionParameters('full-access', 'D:/work'), { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } })
  assert.equal(codexPermissionParameters('read-only', 'D:/work').sandboxPolicy.type, 'readOnly')
  assert.deepEqual(codexPermissionParameters('on-request', 'D:/work').sandboxPolicy.writableRoots, ['D:/work'])
  assert.throws(() => codexPermissionParameters('bypassPermissions', 'D:/work'), /Unsupported/)
})

test('DSH preset view retains native data, notifications, and snapshot identity while excluding external Agents', () => {
  let state = { current: 'coding', busy: false, options: [{ id: 'coding' }, { id: 'dsh-host-codex' }, { id: 'custom-preset' }, { id: 'dsh-host-claude-code' }] }
  const listeners = new Set()
  const source = { getSnapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
  const view = dshPresetView(source)
  const first = view.getSnapshot()
  assert.deepEqual(first.options.map(option => option.id), ['coding', 'custom-preset'])
  assert.equal(first.current, 'coding')
  assert.equal(view.getSnapshot(), first)
  let notified = 0
  const stop = view.subscribe(() => notified++)
  state = { ...state, current: 'custom-preset' }
  for (const listener of listeners) listener()
  assert.equal(view.getSnapshot().current, 'custom-preset')
  assert.equal(notified, 1)
  stop()
  assert.equal(listeners.size, 0)
  assert.equal(state.options.length, 4)
})
