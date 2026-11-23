import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import vm from 'node:vm'
import { installCollaborationBridge } from '../host-collaboration.mjs'

async function fixture() {
  const cleanups = [], calls = []
  let active = true
  const driver = { collaborationFor: thread => active && thread === 'owned-thread' ? { call: async value => { calls.push(value); return { content: [{ type: 'text', text: '真实中文队友结果' }] } } } : undefined }
  const bridge = await installCollaborationBridge({ effect: factory => cleanups.push(factory()) }, driver, {})
  const env = { ...bridge.environment, CODEXHOST_THREAD_ID: 'owned-thread' }
  return { env, calls, deactivate() { active = false }, async close() { for (const cleanup of cleanups.reverse()) await cleanup() } }
}
for (const artifact of ['source', 'built']) test(`Claude ${artifact} SDK MCP routes calls to the active DSH-owned Thread without exposing CLI credentials`, async () => {
  const f = await fixture()
  try {
    const raw = await readFile(new URL(artifact === 'source' ? '../claude-collaboration-sdk.txt' : '../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
    const code = artifact === 'source' ? raw : raw.slice(raw.indexOf('function dshCollaborationMcp('), raw.indexOf('function dshNativeWebEnvironment('))
    const sdk = vm.runInNewContext(code + '\n({dshCollaborationMcp,dshCollaborationPermission,dshCollaborationChildEnvironment})', { fetch, AbortSignal })
    assert.deepEqual(Object.keys(sdk.dshCollaborationMcp({})), [])
    assert.equal(sdk.dshCollaborationPermission('Bash', {}, f.env), undefined)
    assert.equal(sdk.dshCollaborationPermission('mcp__dsh-collaboration__dsh_collaboration', {}, {}), undefined)
    assert.equal(sdk.dshCollaborationPermission('mcp__dsh-collaboration__dsh_collaboration', {}, f.env).behavior, 'allow')
    const mcp = sdk.dshCollaborationMcp(f.env)['dsh-collaboration'], frames = []
    const transport = { start: async () => {}, send: async frame => frames.push(frame) }
    await mcp.instance.connect(transport)
    await transport.onmessage({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    await transport.onmessage({ id: 2, method: 'tools/list' })
    assert.equal(frames[1].result.tools[0].name, 'dsh_collaboration')
    await transport.onmessage({ id: 3, method: 'tools/call', params: { name: 'dsh_collaboration', arguments: { name: 'send_message', arguments: { agent: '同伴', message: '中文消息' } } } })
    assert.equal(frames[2].result.content[0].text, '真实中文队友结果')
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].id, 'claude-mcp:3')
    assert.equal(f.calls[0].arguments.message, '中文消息')
    const clean = sdk.dshCollaborationChildEnvironment({ ...f.env, DSH_WEB_BRIDGE_TOKEN: 'fixture-web', ANTHROPIC_API_KEY: 'fixture-engine' })
    assert.equal(clean.DSH_COLLABORATION_TOKEN, undefined)
    assert.equal(clean.DSH_WEB_BRIDGE_TOKEN, undefined)
    assert.equal(clean.ANTHROPIC_API_KEY, 'fixture-engine')
    f.deactivate()
    await transport.onmessage({ id: 4, method: 'tools/call', params: { name: 'dsh_collaboration', arguments: { name: 'list_agents', arguments: {} } } })
    assert.equal(frames[3].result.isError, true)
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('all bundled Codex and detached Claude launch paths strip private DSH bridge credentials', async () => {
  const runtime = await readFile(new URL('../backend/host-runtime.mjs', import.meta.url), 'utf8')
  const body = runtime.match(/function officialEnvironment\(source\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(body)
  const clean = vm.runInNewContext(body + '\nofficialEnvironment(source)', { source: { ANTHROPIC_API_KEY: 'fixture-engine', DSH_COLLABORATION_TOKEN: 'private', DSH_COLLABORATION_URL: 'private-url', DSH_WEB_BRIDGE_TOKEN: 'web-private', DSH_WEB_BRIDGE_URL: 'web-url' }, DELEGATION_CLI_PATH_ENV: 'cli', DELEGATION_RUNTIME_ENDPOINT_ENV: 'endpoint', DELEGATION_RUNTIME_TOKEN_ENV: 'runtime-token' })
  for (const key of ['DSH_COLLABORATION_TOKEN', 'DSH_COLLABORATION_URL', 'DSH_WEB_BRIDGE_TOKEN', 'DSH_WEB_BRIDGE_URL']) assert.equal(clean[key], undefined)
  assert.equal(clean.ANTHROPIC_API_KEY, 'fixture-engine')
  const claude = await readFile(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  assert.match(claude, /env: withNodeRuntimeOnPath\(\{\s*\.\.\.dshCollaborationChildEnvironment\(environment\)/, 'Detached keepalive must use the same scrubber as ordinary SDK queries')
})

test('private collaboration callback rejects missing auth, browser origins and unknown Thread identities', async () => {
  const f = await fixture(), url = f.env.DSH_COLLABORATION_URL
  const call = (headers, threadId = 'owned-thread') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ threadId, id: 'request', name: 'list_agents', arguments: {} }) })
  try {
    assert.equal((await call({})).status, 403)
    const authorization = 'Bearer ' + f.env.DSH_COLLABORATION_TOKEN
    assert.equal((await call({ authorization, origin: 'http://localhost' })).status, 403)
    assert.equal((await call({ authorization }, 'unrelated-thread')).status, 403)
    assert.equal(f.calls.length, 0)
    assert.equal((await call({ authorization })).status, 200)
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})

test('private callback decodes split UTF-8 correctly and refuses an oversized request', async () => {
  const f = await fixture(), url = f.env.DSH_COLLABORATION_URL, authorization = 'Bearer ' + f.env.DSH_COLLABORATION_TOKEN
  try {
    const body = Buffer.from(JSON.stringify({ threadId: 'owned-thread', id: 'split', name: 'send_message', arguments: { message: '中文😀' } }))
    const split = body.indexOf(Buffer.from('中文')) + 1
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })) })
      req.on('error', reject); req.write(body.subarray(0, split)); setImmediate(() => req.end(body.subarray(split)))
    })
    assert.equal(response.status, 200)
    assert.equal(f.calls[0].arguments.message, '中文😀')
    const large = await fetch(url, { method: 'POST', headers: { authorization }, body: 'x'.repeat(33000) })
    assert.equal(large.status, 413)
    assert.equal(f.calls.length, 1)
  } finally { await f.close() }
})
