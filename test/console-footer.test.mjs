import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = (await readFile(new URL('../console-client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
const h = (type, props, ...children) => ({ type, props, children })
const api = vm.runInNewContext(`${source}\n;({installConsoleClient, ConsoleFooterAction, dshConsoleCss})`, { h, consoleRemoteContribution: {} })

test('console moves to footer with icon only and retains access guard, navigation and disposal', () => {
  const registrations = [], selected = [], removed = []
  const scope = {
    remote: { codexHostConsole: {} }, uiWorkspace: {}, layout: { selectPanel: id => selected.push(id) },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => { registrations.push({ options, component }); return () => removed.push(options.name) },
    },
    remoteAccess: { whenAccess: (key, fn) => { assert.equal(key, 'codexHostConsole/bootstrap'); scope.disposers = [...fn()] } },
  }
  api.installConsoleClient({ effect() {}, inject: (_deps, fn) => fn(scope) }, key => key)
  assert.deepEqual(registrations.map(r => r.options.name), ['main', 'sidebar.footer.action'])
  const seat = registrations[1]
  assert.equal(seat.options.order, 100)
  for (const wide of [true, false]) {
    const button = seat.component({ ...seat.options.inject(), wide })
    assert.equal(button.type, 'button')
    assert.equal(button.props['aria-label'], 'console')
    assert.equal(button.children.length, 1)
    assert.equal(typeof button.children[0].type, 'function')
    button.props.onClick()
  }
  assert.deepEqual(selected, ['codexhost-console', 'codexhost-console'])
  scope.disposers.reverse().forEach(dispose => dispose())
  assert.deepEqual(removed, ['sidebar.footer.action', 'main'])
  assert.match(api.dshConsoleCss, /grid-template-columns:minmax\(0,1fr\) 44px 36px/)
  assert.match(api.dshConsoleCss, /display:contents!important/)
  assert.match(api.dshConsoleCss, /\.usg_layer\{grid-row:1;grid-column:1\/-1/)
  assert.match(api.dshConsoleCss, /padding-right:0!important/)
  assert.match(api.dshConsoleCss, /position:static!important;inset:auto!important;flex-shrink:0/)
  assert.doesNotMatch(api.dshConsoleCss, /position:absolute|right:36px|padding-right:84px/)
})
