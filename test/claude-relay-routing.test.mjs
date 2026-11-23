import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { dshCreateClaude503Relay, dshClaudeEffectiveBaseUrl, dshClaudeRelayEnvironment } from '../claude-503-relay.mjs'

const QUOTA = '{"error":{"type":"overloaded_error","message":"账号五小时用量达到95% 保护线，已暂停接收新请求。 预计最早重置：北京时间 2026-11-22 08:00:00（以用量更新为准）。"}}'

test('relay target follows the settings-file precedence the CLI applies (local > project > user > process)', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-target-')), config = join(root, 'cfg'), cwd = join(root, 'cwd')
  try {
    mkdirSync(config); mkdirSync(join(cwd, '.claude'), { recursive: true })
    const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: 'https://process.example' }
    assert.equal(dshClaudeEffectiveBaseUrl(env, cwd), 'https://process.example')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: ' https://user.example ' } }))
    assert.equal(dshClaudeEffectiveBaseUrl(env, cwd), 'https://user.example')
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://project.example' } }))
    assert.equal(dshClaudeEffectiveBaseUrl(env, cwd), 'https://project.example')
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), '{ not json')
    assert.equal(dshClaudeEffectiveBaseUrl(env, cwd), 'https://project.example', 'unreadable files are skipped')
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://local.example' } }))
    assert.equal(dshClaudeEffectiveBaseUrl(env, cwd), 'https://local.example')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('relay environment points the CLI at the relay and disables native double retries', () => {
  const env = dshClaudeRelayEnvironment({ baseUrl: 'http://127.0.0.1:1/abc' }, { NO_PROXY: 'corp.example' })
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1/abc')
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, '0')
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,corp.example')
})

test('production bundle passes the relay URL as flag settings, which outrank settings.json', () => {
  const bundle = readFileSync(new URL('../backend/plugins/claude-code/plugin.mjs', import.meta.url), 'utf8')
  assert.match(bundle, /\.\.\.this\.#dsh503Relay \? \{ settings: \{ env: dshClaudeRelayEnvironment\(this\.#dsh503Relay, this\.#environment\) \} \} : \{\},/)
  assert.match(bundle, /dshCreateClaude503Relay\(this\.#environment, \{ baseUrl: dshRelayTarget \}\)/)
})

async function gateway(respond) {
  const calls = []
  const server = http.createServer(async (req, res) => { for await (const _ of req); calls.push(Date.now()); respond(calls.length, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const relay = await dshCreateClaude503Relay({}, { baseUrl: `http://127.0.0.1:${server.address().port}`, sleep: async () => {}, log: () => {} })
  const request = () => fetch(relay.baseUrl + '/v1/messages', { method: 'POST', body: '{}' })
  return { calls, request, async close() { await relay.close(); server.closeAllConnections(); await new Promise(r => server.close(r)) } }
}

for (const encoding of ['identity', 'gzip']) test(`quota 503 (${encoding}) is forwarded at once with its original bytes`, async () => {
  const body = encoding === 'gzip' ? gzipSync(Buffer.from(QUOTA)) : Buffer.from(QUOTA)
  const g = await gateway((n, res) => { res.writeHead(503, { 'content-type': 'application/json', ...(encoding === 'gzip' ? { 'content-encoding': 'gzip' } : {}) }); res.end(body) })
  try {
    const r = await g.request()
    assert.equal(r.status, 503)
    assert.equal(await r.text(), QUOTA, 'fetch decodes the original encoding: bytes and header were preserved')
    assert.equal(g.calls.length, 1, 'no relay retry for a quota guard')
  } finally { await g.close() }
})

test('an ordinary 503 is still retried and the success is streamed', async () => {
  const g = await gateway((n, res) => { if (n === 1) { res.writeHead(503); res.end('{"error":"temporarily_unavailable"}'); return } res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ok\n\n') })
  try {
    const r = await g.request()
    assert.equal(r.status, 200); assert.equal(await r.text(), 'data: ok\n\n'); assert.equal(g.calls.length, 2)
  } finally { await g.close() }
})
