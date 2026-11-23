import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexHostRuntimeClient, cliArguments } from '../runtime-client.mjs'

test('uses bearer auth and exposes the Runtime harness list', async () => {
  let request
  const client = new CodexHostRuntimeClient({
    endpoint: 'http://127.0.0.1:43999/',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options }
      return new Response(JSON.stringify({ harnesses: [{ id: 'claude-code' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await client.listHarnesses('request-1')
  assert.equal(request.url, 'http://127.0.0.1:43999/v1/harness/list')
  assert.equal(request.options.headers.authorization, 'Bearer secret')
  assert.deepEqual(result.result, { harnesses: [{ id: 'claude-code' }] })
})

test('returns a stable diagnostic when Runtime configuration is absent', async () => {
  const client = new CodexHostRuntimeClient({ endpoint: '', token: '', cliScript: 'Z:/missing/codexhost.js' })
  const result = await client.safeListHarnesses(undefined)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'runtime_not_configured')
})

test('maps Thread list and send calls to the Runtime API', async () => {
  const calls = []
  const client = new CodexHostRuntimeClient({
    endpoint: 'http://127.0.0.1:43999/',
    token: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ threads: [{ threadId: 't1' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const list = await client.listThreads('r1', { cwd: 'D:/work', limit: 5 })
  const send = await client.sendThread('r2', { threadId: 't1', message: 'hello' })
  assert.deepEqual(list.result, { threads: [{ threadId: 't1' }] })
  assert.deepEqual(send.result, { threads: [{ threadId: 't1' }] })
  assert.deepEqual(calls.map(call => [call.url, call.body]), [
    ['http://127.0.0.1:43999/v1/thread/list', { cwd: 'D:/work', limit: 5, sort: 'updated-desc' }],
    ['http://127.0.0.1:43999/v1/thread/send', { threadId: 't1', message: 'hello' }],
  ])
})

test('forwards explicit parent Thread and task name to the Host Runtime', async () => {
  let body
  const client = new CodexHostRuntimeClient({
    endpoint: 'http://127.0.0.1:43999/',
    token: 'secret',
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return new Response(JSON.stringify({ threadId: 'child' }), { status: 200 })
    },
  })
  await client.startDelegate('request', {
    harnessId: 'codex', task: 'inspect', cwd: 'D:/work/TMC',
    parentThreadId: 'session-parent', taskName: 'TMC review', watch: true,
  })
  assert.deepEqual(body, {
    harnessId: 'codex', task: 'inspect', cwd: 'D:/work/TMC',
    parentThreadId: 'session-parent', taskName: 'TMC review', watch: true,
  })
})

test('encodes an explicit parent and retry-stable task metadata for CLI start', () => {
  assert.deepEqual(cliArguments('/v1/delegate/start', {
    harnessId: 'codex', task: 'inspect', cwd: 'D:/work/TMC',
    parentThreadId: 'session-parent', taskName: 'TMC review', watch: false,
  }), [
    'delegate', 'start', '--harness', 'codex', '--task', 'inspect', '--cwd', 'D:/work/TMC',
    '--parent-thread', 'session-parent', '--task-name', 'TMC review', '--watch', 'false',
  ])
  assert.deepEqual(cliArguments('/v1/delegate/start', { harnessId: 'claude-code', task: 'task' }), [
    'delegate', 'start', '--harness', 'claude-code', '--task', 'task', '--cwd', process.cwd(),
  ])
})

test('uses the CodexHost CLI when no Runtime HTTP endpoint is configured', async () => {
  const client = new CodexHostRuntimeClient({
    endpoint: '',
    token: '',
    cliScript: process.execPath,
    cliNodePath: 'C:/host/node.exe',
    npmCliPath: 'unused',
  })
  assert.deepEqual(await client.status(), { configured: true, mode: 'cli' })
})
