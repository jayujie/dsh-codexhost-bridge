import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { parseConsoleRequest, consoleRemoteDescriptors } from '../console-contract.mjs'
import { assertConsoleOwner } from '../console-host.mjs'
import { consoleDocument } from '../console-frame.mjs'

test('native console accepts dedicated actions and refuses the removed RPC passthrough', () => {
  const request = { action: 'sessions', harnessId: 'codex', query: 'title' }
  assert.deepEqual(parseConsoleRequest(request), request)
  for (const invalid of [
    { method: 'POST', path: '/api/host/request', body: '{}' },
    { action: 'update' }, { action: 'launch' },
    { action: 'usage', range: 'all', method: 'thread/start' },
    { action: 'sessions', harnessId: 'deepseek-harness' },
    { action: 'sessions', harnessId: 'codex', query: '汉'.repeat(4097) },
    { action: 'import', harnessId: 'codex', kind: 'native', id: 'x' },
    { action: 'priceSave', key: 'x', price: { input: -1, output: 1 } },
    { action: 'priceSave', key: 'x', price: { input: 1, output: Infinity } },
    { action: 'priceSave', key: 'x', price: {} },
    { action: 'claudePath', path: 'x\ny' },
  ]) assert.throws(() => parseConsoleRequest(invalid))
  assert.ok(consoleRemoteDescriptors.every(entry => entry.parameters.every(parameter => parameter.source !== 'lookup')))
})

test('console enforces the actual owner principal, including direct service calls', () => {
  assert.doesNotThrow(() => assertConsoleOwner({ peer: { principal: { kind: 'owner' } } }))
  for (const principal of [undefined, { kind: 'mobile' }, { kind: 'guest' }, { kind: 'liveshare' }]) {
    assert.throws(() => assertConsoleOwner({ peer: { principal } }), /Only the DSH owner/)
  }
  assert.throws(() => assertConsoleOwner(), /Only the DSH owner/)
})

test('original console frame cannot issue direct network requests or spoof parent replies', async () => {
  const doc = consoleDocument({ script: 'const x="</script>";', style: 'body{}' }, 'test-channel')
  assert.match(doc, /connect-src 'none'/)
  assert.match(doc, /<\\\/script>/)
  const bridge = doc.match(/<script>([\s\S]*?)<\/script>/)[1]
  const listeners = new Map()
  const sent = []
  const parent = { postMessage(message) { sent.push(message) } }
  const window = { addEventListener(name, callback) { listeners.set(name, callback) } }
  let click
  window.alert = () => {}
  vm.runInNewContext(bridge, { window, parent, Response, fetch: async () => { throw new Error('test export') }, document: { addEventListener(_name, callback) { click = callback } }, setTimeout, clearTimeout, Map, Error })
  const pending = window.fetch('/api/overview')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].request.path, '/api/overview')
  let resolved = false
  void pending.then(() => { resolved = true })
  listeners.get('message')({ source: {}, data: { kind: 'console-response', channel: 'test-channel', id: 1, response: { status: 200, body: 'bad', headers: {} } } })
  await Promise.resolve()
  assert.equal(resolved, false)
  listeners.get('message')({ source: parent, data: { kind: 'console-response', channel: 'test-channel', id: 1, response: { status: 200, body: 'original', headers: {} } } })
  assert.equal(await (await pending).text(), 'original')
  await assert.rejects(window.fetch('http://127.0.0.1:4399/api/overview'), /Unsupported/)
  let prevented = false
  click({ target: { tagName: 'DIV' }, composedPath: () => [{ matches: () => false }, { matches: selector => selector === 'a[href="/api/diagnostics/export"]' }], preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'diagnostic export inside the original shadow root must not navigate to a DSH URL')
})
