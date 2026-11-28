import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { DELEGATION_AGENTS, delegationCarrier, delegationReference, findDelegationTrigger, filterDelegationTargets } from '../delegation-mentions.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import { nativeRemoteDescriptors } from '../remote-contract.mjs'

const source = (await readFile(new URL('../delegation-client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
const pure = (await readFile(new URL('../delegation-mentions.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '')
const api = vm.runInNewContext(`${pure}\n${source}\n;({installDelegationSource,readDelegationHit})`, {})

test('# detection respects word starts, Unicode, issue numbers and revision spans', () => {
  for (const query of ['', 'Claude', 'deepseek-harness', '中文']) {
    const text = `请检查 #${query}`
    const result = findDelegationTrigger(text, { start: text.length, end: text.length, draftRev: 7 })
    assert.equal(result.query, query)
    assert.deepEqual(result.span, { start: 4, end: text.length, draftRev: 7 })
  }
  for (const text of ['#123', '##', '# heading ', 'abc#claude', 'https://example/#claude', '#a'.repeat(40)]) assert.equal(findDelegationTrigger(text, { start: text.length, end: text.length, draftRev: 1 }), null)
  assert.equal(findDelegationTrigger('#claude', { start: 0, end: 7, draftRev: 1 }), null)
  assert.equal(findDelegationTrigger('#claude', { start: 1, end: 1, draftRev: 1 }), null)
})

test('references serialize to original Host carriers, never an Agent-switch command', () => {
  for (const target of DELEGATION_AGENTS) {
    const ref = delegationReference(target.id)
    assert.equal(ref.source, 'dsh-host-agent')
    assert.equal(ref.label, '@' + target.label)
    assert.equal(ref.clipboardText, `[@${target.label}](subagent://codexhost.${target.id})`)
  }
  assert.throws(() => delegationCarrier('other-agent'))
  assert.equal(filterDelegationTargets(DELEGATION_AGENTS, 'CLAUDE')[0].id, 'claude-code')
  assert.equal(filterDelegationTargets(DELEGATION_AGENTS, '@Claude')[0].id, 'claude-code')
  assert.equal(filterDelegationTargets(DELEGATION_AGENTS, 'agy')[0].id, 'antigravity')
  assert.equal(filterDelegationTargets(DELEGATION_AGENTS, '@AGY')[0].id, 'antigravity')
})

test('native @ source offers ready targets to DSH too, refuses disposed sessions, and disposes', async () => {
  let registered, disposed = false, off, external = true, reads = 0
  const scope = { effect(fn) { off = fn() }, inputTriggers: { registerSource(src) { registered = src; return () => { disposed = true } } } }
  api.installDelegationSource(scope, { canDelegate: () => external, t: x => x, directoryFor: () => ({ delegationTargets: async () => { reads++; return { targets: DELEGATION_AGENTS.map(a => ({ ...a, status: a.id === 'codex' ? 'unavailable' : 'ready' })) } } }) })
  const signal = new AbortController().signal
  const candidates = await registered.candidates({ sessionId: 'one' }, { signal, query: '' })
  assert.deepEqual(Array.from(candidates, a => a.value), ['claude-code', 'antigravity', 'deepseek-harness'])
  const pick = registered.onPick({ session: { sessionId: 'one' }, candidate: candidates[2] })
  assert.equal(pick.insert.clipboardText, delegationCarrier('deepseek-harness'))
  assert.equal(await registered.codec.serialize(pick.insert.ref, signal), delegationCarrier('deepseek-harness'))
  external = false
  assert.equal((await registered.candidates({ sessionId: 'one' }, { signal, query: '' })).length, 0)
  assert.equal(reads, 1)
  assert.throws(() => registered.onPick({ session: { sessionId: 'one' }, candidate: candidates[2] }), /delegateSessionUnavailable/)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(registered.codec.serialize('codex', aborted.signal))
  off(); assert.equal(disposed, true)
})

test('DOM trigger reads only the editable text node, not labels inside chips or another composer', () => {
  const editable = { getAttribute: () => 'true' }
  const node = { nodeType: 3, textContent: '#claude', parentElement: { closest: () => editable } }
  const card = { contains: item => item === node || item === editable }
  const actions = { captureInsertion: () => ({ start: 8, end: 8, draftRev: 2 }) }
  const hit = api.readDelegationHit(card, actions, { isCollapsed: true, anchorNode: node, anchorOffset: 7 })
  assert.equal(hit.query, 'claude'); assert.equal(hit.span.start, 1)
  editable.getAttribute = () => 'false'
  assert.equal(api.readDelegationHit(card, actions, { isCollapsed: true, anchorNode: node, anchorOffset: 7 }), null)
  assert.equal(api.readDelegationHit(card, actions, { isCollapsed: false, anchorNode: node, anchorOffset: 7 }), null)
})

test('target discovery performs only read-only inspections and contains unavailable targets', async () => {
  const calls = []
  const peer = { closed: new Promise(() => {}), subscribe: () => () => {}, request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'model/list') return { data: [{}] }
    if (params.harnessId === 'claude-code') throw new Error('private upstream details')
    return { status: 'ready' }
  } }
  const driver = new NativeSessionDriver({ agentPresets: { presetForSession: () => 'dsh-host-codex' } }, {}, { connect: async () => peer })
  const result = await driver.delegationTargets({ session: { header: { cwd: 'D:/work' } } })
  assert.deepEqual(result.targets.map(t => t.status), ['ready', 'unavailable', 'ready'])
  assert.ok(!calls.some(call => call.params.harnessId === 'deepseek-harness'))
  assert.equal(JSON.stringify(result).includes('private upstream details'), false)
  assert.ok(calls.every(c => ['model/list', 'codexhost/harness/inspect'].includes(c.method)))
  assert.ok(calls.filter(c => c.method.endsWith('/inspect')).every(c => c.params.purpose === 'availability' && c.params.cwd === 'D:/work'))
  const native = new NativeSessionDriver({ agentPresets: { presetForSession: () => 'standard' } }, {}, { connect: async () => peer })
  const nativeResult = await native.delegationTargets({ session: { header: { cwd: 'D:/work' } } })
  assert.deepEqual(nativeResult.targets.map(target => target.id), ['codex', 'claude-code', 'antigravity'])
})

test('delegation discovery keeps Session authorization and validates target responses', () => {
  const endpoint = nativeRemoteDescriptors.find(d => d.method === 'delegationTargets')
  assert.equal(endpoint.parameters.length, 1)
  assert.equal(endpoint.parameters[0].lookup, 'agent')
  const parse = endpoint.result.create().parse
  assert.doesNotThrow(() => parse({ targets: [{ id: 'codex', label: 'Codex', status: 'ready' }] }))
  for (const targets of [[{ id: 'unknown', label: 'x', status: 'ready' }], [{ id: 'codex', label: 'x', status: 'running' }], [{ id: 'codex', label: 'x', status: 'ready' }, { id: 'codex', label: 'x', status: 'ready' }]]) assert.throws(() => parse({ targets }))
})
