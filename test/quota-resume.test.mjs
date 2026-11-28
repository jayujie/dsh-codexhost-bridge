import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { foldQuotaPause, parseQuotaReset } from '../native-quota-pause.mjs'

const GATEWAY = 'API Error: 503 账号五小时用量达到95% 保护线，已暂停接收新请求。 预计最早重置：北京时间 2026-11-22 03:00:00（以用量更新为准）。 等待五小时额度窗口重置并更新后再提交。. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (kirisame.haimaintedu.com).'
const RESET = Date.parse('2026-11-21T19:00:00Z')
const claude = text => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'codexhost/claude-code', model: 'claude-opus-5-5' } })
const fold = events => events.reduce((state, event) => foldQuotaPause(state, event), null)

test('parses the gateway reset time as Beijing time', () => {
  assert.equal(parseQuotaReset(GATEWAY).resetAt, RESET)
  assert.deepEqual(parseQuotaReset('API Error: 503 账号五小时用量达到95% 保护线'), { resetAt: undefined })
  assert.equal(parseQuotaReset('API Error: 503 Service Temporarily Unavailable'), undefined)
  assert.equal(parseQuotaReset('普通回复提到五小时用量和预计最早重置：北京时间 2026-11-22 03:00:00'), undefined, 'Only an API Error 503 line counts')
})

test('real session sequence (seq 13429-13445) pauses, then the next turn clears it', () => {
  const failed = [
    { type: 'turn/start', seq: 13429, time: 1, data: { turn: 162 } },
    { type: 'user/message', seq: 13434, time: 2, data: { content: [] } },
    { type: 'plugin:dsh-host/turn-failure', seq: 13437, time: 3, ignorable: true, data: { turn: 162 } },
    { type: 'assistant/message', seq: 13440, time: 1795282247365, data: { turn: 162, step: 1, message: claude(GATEWAY) } },
    { type: 'step/end', seq: 13441, time: 5, data: { turn: 162 } },
    { type: 'turn/end', seq: 13442, time: 6, data: { turn: 162, reason: { kind: 'error', error: { message: 'Claude Code Turn failed' } } } },
  ]
  const state = fold(failed)
  assert.deepEqual(state, { streak: 1, paused: { turn: 162, resetAt: RESET, failedAt: 1795282247365, seq: 13440 } })
  assert.deepEqual(foldQuotaPause(state, { type: 'turn/start', seq: 13445, data: { turn: 163 } }), { streak: 1 })
})

test('streak grows across repeated quota failures and resets on a clean turn', () => {
  const round = (turn, seq) => [
    { type: 'turn/start', seq, data: { turn } },
    { type: 'assistant/message', seq: seq + 1, time: seq, data: { turn, message: claude(GATEWAY) } },
    { type: 'turn/end', seq: seq + 2, data: { turn, reason: { kind: 'error' } } },
  ]
  const twice = fold([...round(1, 10), ...round(2, 20)])
  assert.equal(twice.streak, 2)
  assert.equal(twice.paused.seq, 21)
  const clean = fold([...round(1, 10), { type: 'turn/start', seq: 30, data: { turn: 2 } }, { type: 'turn/end', seq: 31, data: { turn: 2, reason: { kind: 'completed' } } }])
  assert.deepEqual(clean, { streak: 0 })
})

test('quota text from another provider or a non-error turn end does not pause', () => {
  const other = fold([{ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, message: { ...claude(GATEWAY), source: { kind: 'model', provider: 'deepseek' } } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error' } } }])
  assert.equal(other?.paused, undefined)
  const completed = fold([{ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, message: claude(GATEWAY) } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }])
  assert.equal(completed?.paused, undefined)
})

// Minimal hook runtime for the client component.
const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
function mountQuota(props, { now, storage = new Map(), random = 0 } = {}) {
  const state = [], deps = [], cleanups = [], effects = []
  let i = 0, tree, current = props
  const clock = { now }
  const sandbox = {
    Menu: 'menu', h: (type, p, ...children) => ({ type, props: p ?? {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) }),
    useState(value) { const k = i++; if (!(k in state)) state[k] = typeof value === 'function' ? value() : value; return [state[k], value => { state[k] = typeof value === 'function' ? value(state[k]) : value }] },
    useRef(value) { return state[i++] ??= { current: value } },
    useEffect(fn, next) { const k = i++; if (!deps[k] || !next || next.some((v, n) => v !== deps[k][n])) { effects.push(() => { cleanups[k]?.(); cleanups[k] = fn() }); deps[k] = next } },
    setInterval: fn => { clock.tick = fn; return 0 }, clearInterval() {},
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, String(value)) },
    Date: Object.assign(function () {}, { now: () => clock.now, parse: Date.parse }),
    Math: Object.create(Math, { random: { value: () => random } }),
    Intl,
  }
  sandbox.globalThis = sandbox
  const component = vm.runInNewContext(source + '\n;QuotaResumeControl', sandbox)
  const render = () => { i = 0; tree = component(current); while (effects.length) effects.shift()(); return tree }
  render(); render()
  const text = n => typeof n === 'object' ? [n.props?.anchor ? text(n.props.anchor) : '', ...n.children.map(text)].join('') : String(n)
  return { render: () => { render(); render() }, text: () => text(tree), clock, storage, update(next) { clock.tick?.(); current = { ...current, ...next }; render(); render() } }
}

const paused = { streak: 1, paused: { turn: 162, resetAt: RESET, failedAt: RESET - 5.5 * 3600e3, seq: 13440 } }
const t = key => ({ quotaChipCountdown: 'R {time}', quotaSchedule: '{reset}|{due}', quotaResumePrompt: 'CONTINUE' }[key] ?? key)

test('fires once at reset + 2 minutes, only while idle, and never twice for the same failure', async () => {
  const sent = []
  const resume = async text => { sent.push(text) }
  const ui = mountQuota({ sessionId: 's', quota: paused, running: false, pending: 0, resume, t }, { now: RESET + 119000 })
  assert.equal(sent.length, 0)
  assert.match(ui.text(), /R 0:01/)
  ui.clock.now = RESET + 120000; ui.update({ running: true })
  assert.equal(sent.length, 0, 'Waits while the session is busy')
  ui.update({ running: false, pending: 1 })
  assert.equal(sent.length, 0, 'Waits while a submission is still pending')
  ui.update({ pending: 0 })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent, ['CONTINUE'])
  ui.update({}); ui.update({ running: false })
  assert.equal(sent.length, 1)
  // A reload in the same browser sees the claim.
  const again = mountQuota({ sessionId: 's', quota: paused, running: false, pending: 0, resume, t }, { now: RESET + 200000, storage: ui.storage })
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 1)
  assert.match(again.text(), /quotaChip_done/)
})

test('respects the off switch, the stale guard, the streak cap and an unknown reset time', async () => {
  const sent = []
  const resume = async text => { sent.push(text) }
  const off = mountQuota({ sessionId: 's', quota: paused, running: false, pending: 0, resume, t }, { now: RESET + 3600e3, storage: new Map([['dsh-host.quotaResume.enabled', 'off']]) })
  assert.match(off.text(), /quotaChip_off/)
  mountQuota({ sessionId: 's', quota: paused, running: false, pending: 0, resume, t }, { now: RESET + 7 * 3600e3 })
  mountQuota({ sessionId: 's', quota: { ...paused, streak: 4 }, running: false, pending: 0, resume, t }, { now: RESET + 3600e3 })
  mountQuota({ sessionId: 's', quota: { streak: 1, paused: { ...paused.paused, resetAt: undefined } }, running: false, pending: 0, resume, t }, { now: RESET + 3600e3 })
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
})

test('a reset time already past at failure waits 10 minutes after the failure instead', async () => {
  const sent = []
  const late = { streak: 1, paused: { turn: 1, resetAt: RESET, failedAt: RESET + 60000, seq: 5 } }
  const ui = mountQuota({ sessionId: 's', quota: late, running: false, pending: 0, resume: async x => { sent.push(x) }, t }, { now: RESET + 180000 })
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 0)
  ui.clock.now = RESET + 60000 + 600000; ui.update({})
  await new Promise(r => setImmediate(r))
  assert.equal(sent.length, 1)
})
