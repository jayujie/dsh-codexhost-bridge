import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

// Isolated component checks: no real Host, accounts, imports or pricing writes.
const source = (await readFile(new URL('../console-client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(v => v !== null && v !== undefined && v !== false) })
function harness(name, props) {
  const values = [], dependencies = [], effects = []
  let cursor = 0, tree
  const api = vm.runInNewContext(`${source}\n;({DhImports,DhAccounts,DhPrices,DhOverview,dshConsoleCss})`, {
    h, DshConsoleButton: 'button', AGENT_ICONS: {}, consoleRemoteContribution: {},
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }] },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial } },
    useEffect(fn, deps) { const i = cursor++; if (!dependencies[i] || deps.some((v, j) => v !== dependencies[i][j])) { effects.push(fn); dependencies[i] = deps } },
  })
  const render = () => { cursor = 0; tree = api[name](props); while (effects.length) effects.shift()(); return tree }
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); return render() }
  const nodes = (node = tree) => typeof node === 'object' && node ? [node, ...node.children.flatMap(child => nodes(child))] : []
  const text = node => typeof node === 'object' && node ? node.children.map(text).join('') : String(node ?? '')
  render()
  return { render, settle, nodes, text, get tree() { return tree }, button: label => nodes().find(n => n.type === 'button' && text(n) === label), input: id => nodes().find(n => n.type === 'input' && n.props.id === id) }
}

test('import awaits opening, catches rejection and retries only opening; double click sends once', async () => {
  const requests = [], opens = []
  let finishImport
  const remote = { request(input) {
    requests.push(input)
    if (input.action === 'sessions') return Promise.resolve({ rows: [{ id: 'thread-a', kind: 'thread', title: '原生历史', cwd: 'D:/work', updatedAt: 1 }] })
    return new Promise(resolve => { finishImport = resolve })
  } }
  const ui = harness('DhImports', { remote, openSession: async id => { opens.push(id); if (opens.length === 1) throw new Error('offline') } })
  await ui.settle()
  assert.equal(ui.button('下一页'), undefined, 'missing pagination values do not create a phantom page')
  ui.button('导入').props.onClick(); ui.render()
  ui.nodes().find(n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: true } }); ui.render()
  const submit = ui.button('导入到 DSH 并打开').props.onClick
  const pending = submit(); await submit()
  assert.equal(requests.filter(r => r.action === 'import').length, 1)
  finishImport({ sessionId: 'dsh-a' }); await pending; ui.render()
  assert.match(ui.text(ui.tree), /已导入.*打开失败/)
  assert.equal(ui.button('导入到 DSH 并打开'), undefined)
  await ui.button('打开已导入会话').props.onClick(); ui.render()
  assert.deepEqual(opens, ['dsh-a', 'dsh-a'])
  assert.equal(requests.filter(r => r.action === 'import').length, 1)
})

test('account identity follows currentAccountId and quota failures remain visible', async () => {
  const ui = harness('DhAccounts', { remote: { request: async () => ({ codex: { value: { currentAccountId: 'b', phase: 'ready', accounts: [{ accountId: 'a', email: 'wrong@example.com' }, { accountId: 'b', email: 'current@example.com' }] } }, claude: {}, quota: { error: 'quota unavailable' } }) } })
  await ui.settle()
  // Pair lists are child components; inspect their actual input instead of flattening them.
  const serialized = JSON.stringify(ui.tree)
  assert.match(serialized, /current@example.com/)
  assert.doesNotMatch(serialized, /wrong@example.com/)
  assert.match(ui.text(ui.tree), /额度读取失败：quota unavailable/)
})

test('price lookup locks model identity; incomplete and negative prices cannot be saved', async () => {
  let complete
  const ui = harness('DhPrices', { onSaved() {}, remote: { request(input) { return input.action === 'prices' ? Promise.resolve({ entries: [] }) : new Promise(resolve => { complete = resolve }) } } })
  await ui.settle()
  ui.input('dh-price-model').props.onChange({ target: { value: 'model-a' } }); ui.render()
  assert.equal(ui.button('保存单价').props.disabled, true)
  const pending = ui.button('读取默认价').props.onClick(); ui.render()
  assert.equal(ui.input('dh-price-model').props.disabled, true)
  complete({ price: { input: 1, output: 2 } }); await pending; ui.render()
  assert.equal(ui.input('dh-price-model').props.disabled, false)
  assert.equal(ui.button('保存单价').props.disabled, false)
  ui.nodes().find(n => n.type === 'input' && n.props.type === 'number').props.onChange({ target: { value: '-1' } }); ui.render()
  assert.equal(ui.button('保存单价').props.disabled, true)
})

test('refresh failure explicitly marks retained data as stale', async () => {
  let calls = 0
  const ui = harness('DhOverview', { navigate() {}, remote: { request: async () => { if (++calls > 1) throw new Error('offline'); return { workspaces: 2, externalSessions: 1 } } } })
  await ui.settle()
  assert.match(ui.text(ui.tree), /上次读取/)
  ui.button('刷新').props.onClick(); ui.render(); await ui.settle()
  assert.match(ui.text(ui.tree), /刷新失败，以下保留上次读取的结果/)
  assert.match(ui.text(ui.tree), /offline/)
})
