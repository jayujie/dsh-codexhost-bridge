import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { DELEGATION_AGENTS, delegationCarrier, selectedDelegationTargets } from '../delegation-mentions.mjs'
import { NativeDelegation, installUnifiedSubagentEntry, nativeTargetPreset } from '../native-delegation.mjs'
import { HostCollaboration, installCollaborationBridge } from '../host-collaboration.mjs'
import { AutonomousTeamCollaboration } from '../autonomous-team-collaboration.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'
import {
  dshAntigravityChildEnvironment,
  dshAntigravityCollaborationEnabled,
  dshAntigravityCollaborationTools,
  dshAntigravityUnifiedWakeDecision,
  dshSetupAntigravityCollaborationBridge,
} from '../antigravity-collaboration.mjs'

const signal = () => new AbortController().signal

test('delegation target registry and carrier accept Antigravity alongside Codex, Claude and DSH', () => {
  assert.deepEqual(DELEGATION_AGENTS.map(item => item.id), ['codex', 'claude-code', 'antigravity', 'deepseek-harness'])
  const carrier = delegationCarrier('antigravity')
  assert.equal(carrier, '[@Antigravity](subagent://codexhost.antigravity)')
  assert.deepEqual(selectedDelegationTargets([{ source: { kind: 'user' }, content: [{ type: 'text', text: `${carrier} please review` }] }]), ['antigravity'])
})

test('NativeDelegation activates Antigravity child with dsh-host-antigravity preset and skip-permissions mode', async () => {
  const events = [], specs = []
  const parent = {
    id: 'parent-agy',
    session: {
      id: 'parent-agy',
      header: { cwd: 'D:/work' },
      snapshotEvents: () => events,
      append(type, data) {
        const event = { seq: events.length, type, data, ...(type.startsWith('plugin:') ? { ignorable: true } : {}) }
        events.push(event)
        return event
      },
    },
  }
  parent.session.append('turn/start', { turn: 1 })
  parent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: delegationCarrier('antigravity') }] })

  let manager
  const ctx = {
    agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 0 }), get: () => undefined },
    sessionPersistence: { flush: async () => {}, stat: async () => undefined },
    subagents: {
      resolveMaxDepth: () => 2,
      startActivation: async spec => {
        specs.push({ ...spec, initialConfig: manager.initialConfigurations.get(spec.childId) })
        return { childId: spec.childId, name: spec.name ?? 'agy-worker', result: Promise.resolve() }
      },
    },
  }
  const driver = {
    available: () => true,
    owner: () => undefined,
    catalog: async (_agent, engine, childDefaults) => {
      assert.equal(engine, 'antigravity')
      assert.equal(childDefaults, true)
      return {
        status: 'ready',
        models: [{ id: 'gemini-4-carbon', thinkingOptions: [{ id: 'high' }] }],
        selection: { modelId: 'gemini-4-carbon', thinkingOptionId: 'high', permissionModeId: 'dangerously-skip-permissions' },
      }
    },
  }
  manager = new NativeDelegation(ctx, driver, { appendPluginRecord: (s, t, d) => s.append(t, d) })
  try {
    const result = await manager.start(parent, {
      engine: 'antigravity',
      task: 'Inspect repository architecture',
      name: 'agy-architect',
      model: 'gemini-4-carbon',
      reasoning_effort: 'high',
    }, signal(), { requireSelection: true })
    assert.equal(result.engine, 'antigravity')
    assert.equal(result.name, 'agy-architect')
    assert.equal(specs.length, 1)
    assert.equal(specs[0].agentPreset, 'dsh-host-antigravity')
    assert.deepEqual(specs[0].initialConfig, {
      harnessId: 'antigravity',
      modelId: 'gemini-4-carbon',
      permissionModeId: 'dangerously-skip-permissions',
      thinkingOptionId: 'high',
    })
  } finally {
    await manager.dispose()
  }
})

test('Antigravity root routes reverse DSH delegation to saved original preset and never reuses dsh-host-antigravity', () => {
  const events = []
  const root = { session: { snapshotEvents: () => events } }
  const ctx = {
    subagents: { rootOf: () => root },
    agentPresets: { presetForSession: () => 'dsh-host-antigravity', defaultId: 'dsh-host-antigravity' },
  }
  const driver = { owner: () => 'antigravity' }
  assert.throws(() => nativeTargetPreset(ctx, driver, root), /native DSH preset is required/)
  events.push({ type: 'plugin:dsh-host/original-preset', ignorable: true, data: { preset: 'dsh-standard' } })
  assert.equal(nativeTargetPreset(ctx, driver, root), 'dsh-standard')
})

test('unified subagent entry and list_host_subagent_models admit engine=antigravity', async () => {
  const registered = new Map(), effects = [], calls = []
  const original = {
    name: 'subagent',
    description: 'native',
    parameters: { type: 'object', properties: { prompt: { type: 'string', required: true } } },
    output: {},
    execute: async () => ({ kind: 'activation', name: 'native' }),
  }
  const agent = { ctx: { tools: { register: d => { registered.set(d.name, d); return () => registered.delete(d.name) } } } }
  const ctx = {
    agents: { list: () => [agent] },
    tools: { get: () => original, register: d => { registered.set(d.name, d); return () => registered.delete(d.name) } },
    on() {},
    effect: fn => effects.push(fn()),
  }
  const manager = { start: async (...args) => { calls.push(args); return { name: 'agy-teammate' } } }
  const driver = {
    catalog: async (_a, engine) => ({
      status: 'ready',
      models: [{ id: `${engine}-model`, thinkingOptions: [{ id: 'high' }] }],
      selection: { modelId: `${engine}-model`, thinkingOptionId: 'high' },
    }),
  }
  await installUnifiedSubagentEntry(ctx, manager, driver, { defineTool: d => ({ ...d, parameters: { type: 'object', properties: d.parameters } }) })
  try {
    const subagentTool = registered.get('subagent')
    assert.ok(subagentTool.parameters.properties.engine.enum.includes('antigravity'))
    const modelsTool = registered.get('list_host_subagent_models')
    assert.ok(modelsTool.parameters.properties.engine.enum.includes('antigravity'))

    const exec = { agent, signal: signal() }
    const discovery = JSON.parse((await modelsTool.execute({ engine: 'antigravity' }, exec)).result)
    assert.equal(discovery.engine, 'antigravity')
    assert.equal(discovery.models[0].id, 'antigravity-model')

    const activated = await subagentTool.execute({ engine: 'antigravity', prompt: 'Audit module', model: 'antigravity-model', reasoning_effort: 'high' }, exec)
    assert.deepEqual(activated, { kind: 'activation', name: 'agy-teammate' })
    assert.equal(calls[0][1].engine, 'antigravity')
  } finally {
    for (const fn of effects.reverse()) if (typeof fn === 'function') fn()
  }
})

test('Antigravity child environment scrubber removes all private DSH bridge credentials in source and shipped bundle', async () => {
  const dirty = Object.freeze({
    PATH: 'C:/bin',
    GOOGLE_CLOUD_PROJECT: 'demo',
    DSH_UNIFIED_WAKE: '1',
    DSH_COLLABORATION_URL: 'http://127.0.0.1:54321/collaboration',
    DSH_COLLABORATION_TOKEN: 'ab'.repeat(32),
    DSH_WEB_BRIDGE_URL: 'http://127.0.0.1:54322/web',
    DSH_WEB_BRIDGE_TOKEN: 'cd'.repeat(32),
  })
  const clean = dshAntigravityChildEnvironment(dirty)
  assert.equal(clean.PATH, 'C:/bin')
  assert.equal(clean.GOOGLE_CLOUD_PROJECT, 'demo')
  for (const key of ['DSH_UNIFIED_WAKE', 'DSH_COLLABORATION_URL', 'DSH_COLLABORATION_TOKEN', 'DSH_WEB_BRIDGE_URL', 'DSH_WEB_BRIDGE_TOKEN']) {
    assert.equal(Object.hasOwn(clean, key), false)
  }
  const bundled = await readFile(new URL('../backend/plugins/antigravity/plugin.mjs', import.meta.url), 'utf8')
  assert.match(bundled, /dshAntigravityChildEnvironment/)
  assert.match(bundled, /dshSetupAntigravityCollaborationBridge/)
})

test('Antigravity collaboration validation fails closed on missing or non-loopback endpoints', () => {
  const valid = () => ({
    DSH_UNIFIED_WAKE: '1',
    DSH_COLLABORATION_URL: 'http://127.0.0.1:19999/collaboration',
    DSH_COLLABORATION_TOKEN: 'ab'.repeat(32),
    CODEXHOST_THREAD_ID: 'agy-thread-1',
  })
  assert.equal(dshAntigravityCollaborationEnabled(valid()), true)
  assert.deepEqual(dshAntigravityCollaborationTools(valid()).map(t => t.name), ['dsh_collaboration', 'dsh_background'])
  assert.deepEqual(dshAntigravityCollaborationTools({ ...valid(), DSH_UNIFIED_WAKE: '0' }).map(t => t.name), ['dsh_collaboration'])
  for (const bad of [
    {},
    { ...valid(), DSH_COLLABORATION_URL: 'http://localhost:19999/collaboration' },
    { ...valid(), DSH_COLLABORATION_URL: 'https://127.0.0.1:19999/collaboration' },
    { ...valid(), DSH_COLLABORATION_TOKEN: 'short' },
    { ...valid(), CODEXHOST_THREAD_ID: '' },
  ]) {
    assert.equal(dshAntigravityCollaborationEnabled(bad), false)
    assert.deepEqual(dshAntigravityCollaborationTools(bad), [])
  }
})

test('real stdio MCP server and wake hook route AGY collaboration & background calls end-to-end and clean up on dispose', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-agy-collab-e2e-'))
  const cleanups = [], executed = [], events = []
  const session = {
    snapshotEvents: () => events,
    append(type, data, options) { const e = { type, data, seq: events.length, ...options }; events.push(e); return e },
  }
  const agent = { id: 'agy-session', session, model: { current: () => ({ provider: 'codexhost/antigravity', model: 'gemini-4-carbon' }) }, inject() {} }
  const admittedNames = ['subagent', 'list_host_subagent_models', 'list_agents', 'send_message', 'pwsh', 'job_list']
  const ctx = {
    subagents: { namesOf: () => ({ self: 'agy-lead' }) },
    tools: {
      async resolve() { return { dispose() {} } },
      schemas: () => admittedNames.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
      get: name => admittedNames.includes(name) ? {} : undefined,
      async execute(input) {
        executed.push(input.calls[0])
        return { additionalContexts: [], results: [{ result: { content: [{ type: 'text', text: `ok:${input.calls[0].name}` }] } }] }
      },
    },
    sessionPersistence: { async flush() {} },
    effect: fn => cleanups.push(fn()),
  }
  const helpers = { appendPluginRecord: (s, t, d) => s.append(t, d), ToolCallId: x => x, createAssistantMessage: x => x, createToolResultMessage: x => x }
  const manager = new HostCollaboration(ctx, helpers)
  const lease = await manager.open({ agent, turn: 1, step: 1, signal: signal() })
  lease.source = { kind: 'model', provider: 'codexhost/antigravity', model: 'gemini-4-carbon' }

  let active = true
  const bridge = await installCollaborationBridge(ctx, { collaborationFor: id => active && id === 'agy-thread-live' ? lease : undefined }, helpers)
  const bridgeEnv = { CODEXHOST_AGY_QUESTION_NODE: `"${process.execPath.replaceAll('\\', '/')}"` }
  const sessionEnv = { ...bridge.environment, CODEXHOST_THREAD_ID: 'agy-thread-live' }
  const agyCollab = await dshSetupAntigravityCollaborationBridge({ directory: dir, sessionEnvironment: sessionEnv, bridgeEnvironment: bridgeEnv })

  let mcpChild
  try {
    // 1. Verify wake hook config and real wake-hook.cjs execution
    assert.ok(agyCollab.hooks['dsh-unified-wake'])
    const wakeScript = path.join(dir, 'wake-hook.cjs')
    for (const toolName of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'swarm', 'run_workflow', 'schedule', 'send_message']) {
      assert.equal(dshAntigravityUnifiedWakeDecision(toolName)?.decision, 'deny')
      const out = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [wakeScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        proc.stdout.setEncoding('utf8').on('data', c => { stdout += c })
        proc.on('error', reject)
        proc.on('close', () => resolve(JSON.parse(stdout)))
        proc.stdin.end(JSON.stringify({ toolCall: { id: 't1', name: toolName, args: { Prompt: 'secret-prompt' } } }))
      })
      assert.equal(out.decision, 'deny')
      assert.doesNotMatch(out.reason, /permission check failed|denied permission|permission denied|secret-prompt/i)
      assert.match(out.reason, /dsh_collaboration/)
    }

    // 2. Verify mcp_config.json uses ephemeral relay token, never DSH_COLLABORATION_TOKEN
    const mcpConfigRaw = await readFile(path.join(dir, '.agents', 'plugins', 'dsh-collaboration', 'mcp_config.json'), 'utf8')
    assert.equal(mcpConfigRaw.includes(sessionEnv.DSH_COLLABORATION_TOKEN), false, 'Long-lived DSH token must never be written to disk')
    const mcpConfig = JSON.parse(mcpConfigRaw).mcpServers['dsh-collaboration']
    assert.deepEqual(mcpConfig.tools, { dsh_collaboration: { eager: true }, dsh_background: { eager: true } })

    // 3. Spawn real stdio MCP server and test discovery + collaboration + background calls
    mcpChild = spawn(mcpConfig.command, mcpConfig.args, {
      env: { ...dshAntigravityChildEnvironment(process.env), ...mcpConfig.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const rl = readline.createInterface({ input: mcpChild.stdout, crlfDelay: Infinity })
    const pending = new Map()
    rl.on('line', line => {
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
    })
    const rpc = (id, method, params) => new Promise((resolve) => {
      pending.set(id, resolve)
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })

    const discover = await rpc(1, 'server/discover', {})
    assert.equal(discover.error.code, -32601)
    const init = await rpc(2, 'initialize', { protocolVersion: '2025-11-25' })
    assert.equal(init.result.serverInfo.name, 'dsh-collaboration')
    const listed = await rpc(3, 'tools/list', {})
    assert.deepEqual(listed.result.tools.map(t => t.name), ['dsh_collaboration', 'dsh_background'])

    const discoveredTools = await rpc(4, 'tools/call', { name: 'dsh_collaboration', arguments: { name: '__list__', arguments: {} } })
    const meta = JSON.parse(discoveredTools.result.content[0].text)
    assert.equal(meta.agent.self, 'agy-lead')
    assert.match(meta.instructions, /antigravity/)

    const delegated = await rpc(5, 'tools/call', { name: 'dsh_collaboration', arguments: { name: 'subagent', arguments: { engine: 'claude-code', prompt: 'Review PR' } } })
    assert.equal(delegated.result.content[0].text, 'ok:subagent')

    const bgStarted = await rpc(6, 'tools/call', { name: 'dsh_background', arguments: { action: 'start', command: 'Write-Output ready' } })
    assert.equal(bgStarted.result.content[0].text, 'ok:pwsh')
    assert.deepEqual(executed.map(c => c.name), ['subagent', 'pwsh'])

    // 4. Stopping the turn bridge immediately revokes relay access; dispose removes disk artifacts
    agyCollab.stop()
    const afterStop = await rpc(7, 'tools/call', { name: 'dsh_collaboration', arguments: { name: 'list_agents', arguments: {} } })
    assert.equal(afterStop.result.isError, true)
    assert.equal(executed.length, 2)

    const exited = new Promise(resolve => mcpChild.once('close', resolve))
    mcpChild.stdin.end()
    await exited
    mcpChild = undefined

    await agyCollab.dispose()
    await assert.rejects(stat(path.join(dir, '.agents', 'plugins', 'dsh-collaboration')))
    await assert.rejects(stat(path.join(dir, 'dsh-collaboration-mcp.cjs')))
    await assert.rejects(stat(path.join(dir, 'wake-hook.cjs')))
  } finally {
    mcpChild?.kill()
    await agyCollab.dispose()
    active = false
    await lease.close()
    for (const fn of cleanups.reverse()) await fn()
    await manager.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('AutonomousTeamCollaboration admits active Antigravity Turn for shared task-board operations', async () => {
  const events = [{ type: 'plugin:dsh-host/thread', ignorable: true, data: { version: 1, harnessId: 'antigravity', phase: 'ready', threadId: 'agy-t1', sessionId: 'agy-agent' } }]
  let executed = 0
  const agent = {
    id: 'agy-agent',
    status: 'idle',
    model: { current: () => ({ provider: 'fixture', model: 'fixture' }) },
    session: { header: {}, snapshotEvents: () => events, append(type, data) { events.push({ type, data, ignorable: true }) } },
    async runMaintenance(fn) { return fn(signal()) },
  }
  const ctx = {
    agents: { list: () => [agent] },
    subagents: { namesOf: () => ({ self: 'agy-member' }) },
    sessionPersistence: { async flush() {} },
    tools: {
      async resolve() { return { dispose() {} } },
      schemas: () => [{ name: 'team_task_list', parameters: { type: 'object', properties: {} } }],
      get: name => name === 'team_task_list' ? {} : undefined,
      async execute() { executed++; return { results: [{ result: { content: [{ type: 'text', text: '[]' }] } }], additionalContexts: [] } },
    },
  }
  const peer = {
    async request(method) {
      if (method === 'thread/read') return { thread: { id: 'agy-t1', status: { type: 'active' } } }
      return { data: [{ id: 'turn-1', status: 'inProgress' }], nextCursor: null }
    },
  }
  const autonomous = new AutonomousTeamCollaboration(ctx, { ToolCallId: id => id, appendPluginRecord: (s, t, d) => s.append(t, d) }, {
    connect: async () => peer,
    owner: () => 'antigravity',
    isRequested: () => false,
    isStopped: () => false,
    lifecycleSignal: signal(),
    bound: r => r,
  })
  const res = await autonomous.call({ threadId: 'agy-t1', id: 'antigravity-mcp:1', name: 'team_task_list', arguments: {} })
  assert.equal(res.isError, undefined)
  assert.equal(executed, 1)
})

test('subagent catalog defaults: Codex workspace-write, Claude bypassPermissions, Antigravity dangerously-skip-permissions', async () => {
  const sonnetRef = 'claude-model-v1.' + Buffer.from('sonnet').toString('base64url')
  const peer = {
    closed: new Promise(() => {}),
    subscribe: () => () => {},
    close() {},
    async request(method, params) {
      if (method === 'model/list') return { data: [{ model: 'gpt-5.4', isDefault: true }] }
      if (method === 'codexhost/harness/inspect' && params.harnessId === 'claude-code') {
        return {
          status: 'ready',
          catalog: { models: [{ ref: { id: sonnetRef }, label: 'sonnet' }] },
          permissionModes: { modes: [{ id: 'default' }, { id: 'plan' }, { id: 'bypassPermissions', dangerous: true }], defaultModeId: 'default' },
        }
      }
      if (method === 'codexhost/harness/inspect' && params.harnessId === 'antigravity') {
        return {
          status: 'ready',
          catalog: { models: [{ ref: { id: 'gemini-4-carbon' }, label: 'Gemini 4 Carbon' }], defaultModel: { id: 'gemini-4-carbon' } },
          permissionModes: { modes: [{ id: 'dangerously-skip-permissions', dangerous: true }], defaultModeId: 'dangerously-skip-permissions' },
        }
      }
      throw new Error('Unexpected RPC: ' + method)
    },
  }
  const presets = { codex: 'dsh-host-codex', 'claude-code': 'dsh-host-claude-code', antigravity: 'dsh-host-antigravity' }
  for (const [engine, expectedMode] of [['codex', 'workspace-write'], ['claude-code', 'bypassPermissions'], ['antigravity', 'dangerously-skip-permissions']]) {
    const driver = new NativeSessionDriver({ agentPresets: { presetForSession: () => presets[engine] } }, {}, { connect: async () => peer })
    try {
      const childAgent = { id: `child-${engine}`, session: { header: { cwd: 'D:/work', origin: 'subagent', parentSession: 'root' }, snapshotEvents: () => [] } }
      const childCat = await driver.catalog(childAgent)
      assert.equal(childCat.selection.permissionModeId, expectedMode, `${engine} subagent session default`)

      const parentAgent = { id: 'root', session: { header: { cwd: 'D:/work' }, snapshotEvents: () => [] } }
      const targetCat = await driver.catalog(parentAgent, engine, true)
      assert.equal(targetCat.selection.permissionModeId, expectedMode, `${engine} childDefaults lookup`)
    } finally {
      await driver.dispose()
    }
  }
})

test('cross-engine child catalog never inherits parent appliedConfiguration.permissionModeId', async () => {
  const sonnetRef = 'claude-model-v1.' + Buffer.from('sonnet').toString('base64url')
  const peer = {
    closed: new Promise(() => {}),
    subscribe: () => () => {},
    close() {},
    async request(method, params) {
      if (method === 'model/list') return { data: [{ model: 'gpt-6-astra', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
      if (method === 'codexhost/harness/inspect' && params.harnessId === 'claude-code') {
        return {
          status: 'ready',
          catalog: { models: [{ ref: { id: sonnetRef }, label: 'sonnet' }] },
          permissionModes: { modes: [{ id: 'default' }, { id: 'plan' }, { id: 'bypassPermissions', dangerous: true }], defaultModeId: 'default' },
        }
      }
      if (method === 'codexhost/harness/inspect' && params.harnessId === 'antigravity') {
        return {
          status: 'ready',
          catalog: { models: [{ ref: { id: 'gemini-4-carbon' }, label: 'Gemini 4 Carbon' }], defaultModel: { id: 'gemini-4-carbon' } },
          permissionModes: { modes: [{ id: 'dangerously-skip-permissions', dangerous: true }], defaultModeId: 'dangerously-skip-permissions' },
        }
      }
      throw new Error('Unexpected RPC: ' + method)
    },
  }
  const parentStates = [
    ['antigravity', 'dsh-host-antigravity', 'dangerously-skip-permissions'],
    ['claude-code', 'dsh-host-claude-code', 'bypassPermissions'],
    ['codex', 'dsh-host-codex', 'full-access'],
  ]
  const childTargets = [
    ['codex', 'workspace-write'],
    ['claude-code', 'bypassPermissions'],
    ['antigravity', 'dangerously-skip-permissions'],
  ]
  for (const [parentHarness, parentPreset, parentPerm] of parentStates) {
    const driver = new NativeSessionDriver({ agentPresets: { presetForSession: () => parentPreset } }, {}, { connect: async () => peer })
    try {
      const parentAgent = {
        id: `root-${parentHarness}`,
        session: {
          header: { cwd: 'D:/work' },
          snapshotEvents: () => [{
            type: 'plugin:dsh-host/thread',
            ignorable: true,
            data: { version: 1, phase: 'ready', harnessId: parentHarness, threadId: 't-parent', appliedConfiguration: { modelId: 'parent-model', permissionModeId: parentPerm } },
          }],
        },
      }
      for (const [targetEngine, expectedMode] of childTargets) {
        const cat = await driver.catalog(parentAgent, targetEngine, true)
        assert.equal(cat.status, 'ready')
        assert.equal(cat.selection.permissionModeId, expectedMode, `${parentHarness} parent -> ${targetEngine} child must not inherit ${parentPerm}`)
        assert.ok(cat.permissionModes.some(m => m.id === cat.selection.permissionModeId), `${targetEngine} child permission must be advertised`)
      }
    } finally {
      await driver.dispose()
    }
  }
})
