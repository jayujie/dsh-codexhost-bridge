import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import vm from 'node:vm'
import { backendEnvironment } from '../backend-paths.mjs'

// Read real build output, but never import/start the bundled SDK or contact a provider.
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8')
const nativeEnvironment = async environment => {
  const source = await read('claude-native-web.txt')
  return vm.runInNewContext(source + '\ndshNativeWebEnvironment(environment)', {
    environment,
    fetch: () => { throw new Error('Network is forbidden in native-web tests') },
  })
}
const installation = Object.freeze({
  nodePath: 'C:/fixture/node.exe', runtimePath: 'C:/fixture/backend/host-runtime.mjs',
  descriptorPath: 'C:/fixture/descriptor.json', stockCodexPath: 'C:/fixture/codex.exe',
})
const legacyKeys = ['DSH_WEB_BRIDGE_URL', 'DSH_WEB_BRIDGE_TOKEN', 'DSH_CLAUDE_NATIVE_SEARCH']

function mainTransportOptions(artifact) {
  const start = artifact.indexOf('activeQuery = this.#queryFactory({')
  assert.notEqual(start, -1, 'actual SDK transport query must be present')
  const end = artifact.indexOf('this.#query = activeQuery;', start)
  assert.notEqual(end, -1, 'actual SDK transport query boundary must be present')
  return artifact.slice(start, end)
}

test('native web beta is merged once without mutating the supplied environment', async () => {
  const environment = Object.freeze({
    ANTHROPIC_BETAS: ' existing ,claude-code-20250219,existing, other , ',
    ANTHROPIC_AUTH_TOKEN: 'fixture-auth', ENABLE_PROMPT_CACHING_1H: '1',
  })
  const before = { ...environment }
  const result = await nativeEnvironment(environment)
  assert.equal(result.ANTHROPIC_BETAS, 'existing,claude-code-20250219,other')
  assert.deepEqual(environment, before)
  assert.notEqual(result, environment)
  for (const value of [undefined, '', '   ', 'existing']) {
    const merged = await nativeEnvironment(Object.freeze(value === undefined ? {} : { ANTHROPIC_BETAS: value }))
    assert.equal(merged.ANTHROPIC_BETAS, value === 'existing' ? 'existing,claude-code-20250219' : 'claude-code-20250219')
  }
})

test('legacy native-search flag zero cannot restore the retired DSH web path', async () => {
  const source = await read('claude-native-web.txt')
  assert.deepEqual(Array.from(source.matchAll(/\bfunction\s+(\w+)\s*\(/g), match => match[1]), ['dshNativeWebEnvironment'])
  assert.doesNotMatch(source, /DSH_CLAUDE_NATIVE_SEARCH|DSH_WEB_BRIDGE_|dshWebMcp/)
  for (const flag of ['0', '1', undefined]) {
    const environment = Object.freeze({ DSH_CLAUDE_NATIVE_SEARCH: flag, ANTHROPIC_BETAS: 'existing' })
    assert.equal((await nativeEnvironment(environment)).ANTHROPIC_BETAS, 'existing,claude-code-20250219')
    const child = backendEnvironment(installation, { nativeClaudeWebSearch: false }, environment)
    for (const key of legacyKeys) assert.equal(Object.hasOwn(child, key), false, key)
    assert.equal(environment.DSH_CLAUDE_NATIVE_SEARCH, flag)
  }
})

test('backend scrubs stale web settings after merging Claude environment and preserves auth/cache/collaboration', () => {
  const parent = Object.freeze({
    PATH: 'fixture-path', ANTHROPIC_API_KEY: 'fixture-api-key', ANTHROPIC_AUTH_TOKEN: 'parent-auth',
    ANTHROPIC_BASE_URL: 'https://provider.invalid', ANTHROPIC_BETAS: 'existing',
    ENABLE_PROMPT_CACHING_1H: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    DSH_COLLABORATION_URL: 'http://127.0.0.1:1/collaboration', DSH_COLLABORATION_TOKEN: 'parent-collaboration',
    DSH_WEB_BRIDGE_URL: 'http://127.0.0.1:1/retired', DSH_WEB_BRIDGE_TOKEN: 'stale-parent', DSH_CLAUDE_NATIVE_SEARCH: '0',
  })
  const claudeEnvironment = Object.freeze({
    ANTHROPIC_AUTH_TOKEN: 'configured-auth', DSH_COLLABORATION_TOKEN: 'configured-collaboration',
    DSH_WEB_BRIDGE_URL: 'http://127.0.0.1:1/stale-config', DSH_WEB_BRIDGE_TOKEN: 'stale-config', DSH_CLAUDE_NATIVE_SEARCH: '0',
  })
  const beforeParent = { ...parent }, beforeClaude = { ...claudeEnvironment }
  const child = backendEnvironment(installation, { claudeEnvironment, claudeWebEnvironment: { RETIRED_WEB_CONFIG: 'must-not-merge' } }, parent)
  for (const key of legacyKeys) assert.equal(Object.hasOwn(child, key), false, key)
  assert.equal(Object.hasOwn(child, 'RETIRED_WEB_CONFIG'), false)
  for (const key of ['PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BETAS', 'ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'DSH_COLLABORATION_URL']) assert.equal(child[key], parent[key], key)
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, claudeEnvironment.ANTHROPIC_AUTH_TOKEN)
  assert.equal(child.DSH_COLLABORATION_TOKEN, claudeEnvironment.DSH_COLLABORATION_TOKEN)
  assert.deepEqual(parent, beforeParent)
  assert.deepEqual(claudeEnvironment, beforeClaude)
})

test('actual main SDK artifact registers collaboration only and does not disable native web tools', async () => {
  const artifact = await read('backend/plugins/claude-code/plugin.mjs')
  assert.doesNotMatch(artifact, /\bfunction\s+dshWebMcp\s*\(|\bdshWebMcp\s*\(/)
  assert.match(artifact, /\bfunction\s+dshNativeWebEnvironment\s*\(/)
  const options = mainTransportOptions(artifact)
  assert.match(options, /mcpServers:\s*(?:\{\s*\.\.\.\s*)?dshCollaborationMcp\(this\.#environment\)/)
  assert.match(options, /\.\.\.dshNativeWebEnvironment\(this\.#environment\)/)
  assert.doesNotMatch(options, /dshWebMcp|DSH_WEB_BRIDGE_|DSH_CLAUDE_NATIVE_SEARCH/)
  // Scope this assertion to our query options: the SDK has legitimate generic disallowedTools support.
  assert.doesNotMatch(options, /disallowedTools\s*:|["']WebSearch["']|["']WebFetch["']/)
})

test('plugin wiring passes only collaboration environment through the renamed owned-runtime setter', async () => {
  const index = await read('index.mjs')
  const runtime = await read('owned-host-runtime.mjs')
  assert.doesNotMatch(index, /installClaudeWebBridge|claude-web-bridge|setClaudeWebEnvironment/)
  assert.match(index, /runtime\.setClaudeEnvironment\(collaboration\.environment\)/)
  assert.match(runtime, /setClaudeEnvironment\(environment\)/)
  assert.match(runtime, /claudeEnvironment:\s*environment/)
  assert.doesNotMatch(runtime, /setClaudeWebEnvironment|claudeWebEnvironment/)
})

test('package and build inputs no longer reference deleted web bridge files', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.ok(manifest.files.includes('claude-native-web.txt'))
  for (const name of ['claude-web-sdk.txt', 'claude-web-bridge.mjs']) {
    assert.equal(manifest.files.includes(name), false, name)
    await assert.rejects(access(new URL('../' + name, import.meta.url)), { code: 'ENOENT' })
  }
  for (const name of ['native-search.test.mjs', 'claude-web.test.mjs']) {
    await assert.rejects(access(new URL(name, import.meta.url)), { code: 'ENOENT' })
  }
  const build = await read('backend-builder.mjs')
  assert.match(build, /claude-native-web\.txt/)
  assert.doesNotMatch(build, /claude-web-sdk\.txt|claude-web-bridge\.mjs|dshWebMcp|dshNativeSearchEnvironment/)
})

test('keepalive source and actual artifact retain deny-all tools without DSH web MCP', async () => {
  const source = await read('claude-keepalive-backend.txt')
  const artifact = await read('backend/plugins/claude-code/plugin.mjs')
  // esbuild may rename local identifiers (input2/environment2) between builds.
  const start = artifact.search(/\basync\s+dshKeepalive\s*\(\s*[$\w]+\s*\)\s*\{/)
  assert.notEqual(start, -1)
  const tail = artifact.slice(start)
  const end = tail.search(/this\.#readingHistory\s*=\s*(?:false|!1);/)
  assert.notEqual(end, -1)
  for (const keepalive of [source, tail.slice(0, end)]) {
    assert.doesNotMatch(keepalive, /dshWebMcp|DSH_WEB_BRIDGE_/)
    const environment = keepalive.match(/(?:\b(?:const|let|var)\s+|,\s*)([$\w]+)\s*=\s*\{\s*\.\.\.this\.#dshEnvironment\b/)
    assert.ok(environment, 'keepalive must derive its environment from the owned session')
    const collaboration = keepalive.match(/mcpServers:\s*dshCollaborationMcp\(\s*([$\w]+)\s*\)/)
    assert.ok(collaboration, 'keepalive must register only the collaboration MCP')
    assert.equal(collaboration[1], environment[1], 'collaboration must use the owned keepalive environment')
    assert.match(keepalive, /canUseTool:\s*async\s*\(\)\s*=>\s*\(\{\s*behavior:\s*["']deny["']/)
    assert.match(keepalive, /Cache keepalive cannot execute tools/)
    assert.match(keepalive, /allowDangerouslySkipPermissions:\s*(?:false|!1)/)
    assert.match(keepalive, /disableAllHooks:\s*(?:true|!0)/)
  }
})
