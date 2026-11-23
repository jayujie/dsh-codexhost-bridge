import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../claude-wake-policy.txt', import.meta.url), 'utf8')
const context = vm.createContext({ URL })
vm.runInContext(source, context)
const { dshUnifiedWakeEnabled: enabled, dshUnifiedWakeEnvironment: environment, dshUnifiedWakeOptions: options } = context
const root = () => ({ DSH_UNIFIED_WAKE: '1', DSH_COLLABORATION_URL: 'http://127.0.0.1:12345/collaboration', DSH_COLLABORATION_TOKEN: 'ab'.repeat(32), CODEXHOST_THREAD_ID: 'native-thread-1' })
const plain = value => JSON.parse(JSON.stringify(value))
const hook = value => options(value).hooks.PreToolUse[0].hooks[0]

function expectDisabled(value) {
  assert.equal(enabled(value), false)
  assert.deepEqual(plain(environment(value)), {})
  assert.deepEqual(plain(options(value)), {})
}

test('helper is plain stitchable JS and admits only explicit private root authority', () => {
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m)
  assert.equal(enabled(root()), true)
  expectDisabled(undefined)
  expectDisabled(null)
  expectDisabled({})
  for (const marker of [undefined, '', '0', 'true', 1, true]) expectDisabled({ ...root(), DSH_UNIFIED_WAKE: marker })
})

test('missing bridge identity fails closed rather than advertising a redirect', () => {
  for (const key of ['DSH_COLLABORATION_URL', 'DSH_COLLABORATION_TOKEN', 'CODEXHOST_THREAD_ID']) {
    const value = root(); delete value[key]; expectDisabled(value)
  }
})

test('unknown or remote bridge URLs fail closed', () => {
  for (const url of ['not a url', 'https://127.0.0.1:12345/collaboration', 'http://example.com:12345/collaboration', 'http://localhost:12345/collaboration', 'http://127.0.0.1/collaboration', 'http://127.0.0.1:0/collaboration', 'http://127.0.0.1:65536/collaboration', 'http://u:p@127.0.0.1:12345/collaboration', 'http://127.0.0.1:12345/other', 'http://127.0.0.1:12345/collaboration?x=1', 'http://127.0.0.1:12345/collaboration#x']) expectDisabled({ ...root(), DSH_COLLABORATION_URL: url })
})

test('malformed private token and thread identity fail closed', () => {
  for (const token of ['', 'a'.repeat(63), 'g'.repeat(64), 42]) expectDisabled({ ...root(), DSH_COLLABORATION_TOKEN: token })
  for (const id of ['', ' ', 'a b', 'a\nb', 'a\0b', 'a'.repeat(1025), 42]) expectDisabled({ ...root(), CODEXHOST_THREAD_ID: id })
})

test('root environment contains only the two runtime overrides and preserves the parent', () => {
  const value = Object.freeze({ ...root(), OTHER: 'preserve', CLAUDE_CODE_MAX_RETRIES: '10' })
  const before = JSON.stringify(value)
  assert.deepEqual(plain(environment(value)), { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_MAX_RETRIES: '0' })
  assert.equal(JSON.stringify(value), before)
  assert.doesNotMatch(JSON.stringify(environment(value)), /DSH_|CODEXHOST_|preserve|abab/)
})

test('root SDK options disable native delegation and use PreToolUse rather than canUseTool', () => {
  const value = options(root())
  assert.deepEqual(plain(value.disallowedTools), ['Agent', 'Task', 'Workflow', 'ScheduleWakeup'])
  assert.equal(value.hooks.PreToolUse[0].matcher, 'Bash|Agent|Task|Workflow|ScheduleWakeup')
  assert.equal(value.hooks.PreToolUse[0].hooks.length, 1)
  assert.equal('canUseTool' in value, false)
  assert.equal('continue' in value, false)
})

test('explicit native background Bash is denied before execution with DSH direction', async () => {
  const result = plain(await hook(root())({ tool_name: 'Bash', tool_input: { command: 'sensitive command', run_in_background: true } }))
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /DSH MCP dsh_background/)
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /not started/)
  assert.doesNotMatch(JSON.stringify(result), /sensitive command|abab|12345|native-thread-1/)
  assert.equal('continue' in result, false)
})

for (const background of [undefined, false, 'true', 1]) {
  test(`ordinary Bash is not granted or rewritten (run_in_background=${String(background)})`, async () => {
    const input = Object.freeze({ tool_name: 'Bash', tool_input: Object.freeze({ command: 'echo untouched', run_in_background: background }) })
    assert.deepEqual(plain(await hook(root())(input)), {})
    assert.equal(input.tool_input.command, 'echo untouched')
    assert.equal(input.tool_input.run_in_background, background)
  })
}

for (const name of ['Agent', 'Task', 'Workflow', 'ScheduleWakeup']) {
  test(`${name} defaults and explicit foreground/background all redirect without native launch`, async () => {
    for (const run_in_background of [undefined, true, false]) {
      const result = plain(await hook(root())({ tool_name: name, tool_input: { run_in_background } }))
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny')
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /dsh_collaboration.*subagent/)
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /not started/)
    }
  })
}

test('other tools and absent input do not gain permission or side effects', async () => {
  for (const input of [undefined, null, {}, { tool_name: 'Read' }, { tool_name: 'mcp__dsh-collaboration__dsh_collaboration' }]) assert.deepEqual(plain(await hook(root())(input)), {})
})

test('parent environment and SDK input stay immutable; no private values captured in replies', async () => {
  const value = Object.freeze(root())
  const before = JSON.stringify(value)
  const result = await hook(value)(Object.freeze({ tool_name: 'Agent', tool_input: Object.freeze({ prompt: 'private prompt' }) }))
  assert.equal(JSON.stringify(value), before)
  assert.doesNotMatch(JSON.stringify(result), /private prompt|abab|12345|native-thread-1/)
  assert.notEqual(environment(value), environment(value))
  assert.notEqual(options(value), options(value))
})
