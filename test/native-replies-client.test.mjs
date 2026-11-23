import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { installNativeRepliesClient } from '../native-replies-client.mjs'

const eventType = 'plugin:codexhost/native-message'
const root = new URL('../../../', import.meta.url)
const data = { version: 1, harnessId: 'codex', threadId: 'thread', hostTurnId: 'turn', itemId: 'item', text: '原文\n**保持**', status: 'completed' }
function event(seq = 1, patch = {}) { return { type: eventType, seq, time: 1000 + seq, surfaceOp: 'none', data: { ...data, revision: seq, ...patch } } }
function definitions() {
  const result = []
  installNativeRepliesClient({ uiConversation: { events: { register(value) { result.push(value); return () => {} } } } })
  return result
}
function build(definition, events, id) {
  const matches = events.map(event => ({ event, location: { kind: 'unresolved' }, ...definition.match[eventType](event) }))
  const identity = id ?? matches[0].id
  return definition.buildViewNode({ kind: definition.kind, id: identity, key: `${definition.kind}:${identity}`, matches, state: undefined, start: undefined, current: new Map() })
}

test('仅注册新事件的两个 target，注销幂等且部分失败会回滚', () => {
  const registered = definitions()
  assert.deepEqual(registered.map(x => x.target), ['chat', 'trajectory'])
  assert.equal(new Set(registered.map(x => x.kind)).size, 2)
  for (const definition of registered) assert.deepEqual(Object.keys(definition.match), [eventType])
  let disposed = 0
  const dispose = installNativeRepliesClient({ uiConversation: { events: { register: () => () => { disposed++ } } } })
  dispose(); dispose()
  assert.equal(disposed, 2)
  let calls = 0
  assert.throws(() => installNativeRepliesClient({ uiConversation: { events: { register() { if (calls++) throw Error('test'); return () => { disposed++ } } } } }), /test/)
  assert.equal(disposed, 3)
})

test('原生 text block 和 settled assistant 契约，原文字不改、不伪造执行坐标', () => {
  const [chat, trajectory] = definitions().map(d => build(d, [event(1, { nativeTime: 80 })]))
  assert.equal(chat.kind, 'assistant-step')
  assert.equal(chat.data.status, 'settled')
  assert.deepEqual(chat.data.blocks, [{ kind: 'text', text: data.text }])
  assert.deepEqual(chat.location, { kind: 'session' })
  assert.equal(chat.data.time, 80)
  assert.equal(chat.data.turn, 0)
  assert.equal(chat.data.step, 0)
  assert.equal(chat.data.finalNode.messageId, undefined)
  assert.equal(trajectory.data.kind, 'assistant')
  assert.deepEqual(trajectory.data.node, chat.data.finalNode)
  assert.equal(trajectory.data.partial, null)
  assert.equal(trajectory.data.request, undefined)
})

test('同 tuple 最新全量快照覆盖，重连重复、乱序证据和 update-only 分页均可 build', () => {
  for (const definition of definitions()) {
    const events = [event(10, { text: '旧' }), event(12, { text: '最新' }), event(11, { text: '中间' }), event(12, { text: '最新' })]
    const node = build(definition, events)
    assert.equal(node.anchorSeq, 10)
    assert.equal((node.data.finalNode ?? node.data.node).blocks[0].text, '最新')
    const paged = build(definition, [events[1]])
    assert.equal(paged.key, node.key)
    assert.equal((paged.data.finalNode ?? paged.data.node).blocks[0].text, '最新')
    assert.equal(definition.match[eventType](events[1]).role, 'update')
  }
})

test('item、host turn、thread、harness 的独立 identity 不按 DSH step 合并且无分隔符碰撞', () => {
  const definition = definitions()[0]
  const inputs = [event(), event(2, { itemId: 'second' }), event(3, { hostTurnId: 'second' }), event(4, { threadId: 'second' }), event(5, { harnessId: 'claude-code' }), event(6, { threadId: 'a:b', hostTurnId: 'c' }), event(7, { threadId: 'a', hostTurnId: 'b:c' })]
  const nodes = inputs.map(e => build(definition, [e]))
  assert.equal(new Set(nodes.map(x => x.key)).size, inputs.length)
  assert.equal(build(definition, [inputs[0], inputs[1]], nodes[0].id).data.blocks[0].text, data.text)
})

test('streaming、failed、interrupted、suppressed、空白的原生契约', () => {
  const [chatDef, trajectoryDef] = definitions()
  const streaming = event(1, { status: 'streaming' })
  const chat = build(chatDef, [streaming])
  const trajectory = build(trajectoryDef, [streaming])
  assert.equal(chat.data.status, 'running')
  assert.equal(chat.data.finalNode, undefined)
  assert.deepEqual(trajectory.data.partial, { turn: 0, step: 0, blocks: chat.data.blocks })
  assert.equal(trajectory.data.node, undefined)
  for (const status of ['failed', 'interrupted']) {
    const node = build(chatDef, [event(1, { status })])
    assert.equal(node.data.status, status === 'interrupted' ? 'interrupted' : 'settled')
    assert.equal(node.data.finalNode.interrupted, status === 'interrupted' ? true : undefined)
  }
  for (const patch of [{ suppressed: true }, { text: ' \n' }]) {
    const node = build(chatDef, [event(), event(2, patch)])
    assert.equal(node.visibility, 'hidden')
    assert.deepEqual(node.data.blocks, [])
    assert.equal(node.data.finalNode, undefined)
    assert.deepEqual(build(trajectoryDef, [event(), event(2, patch)]).data, { kind: 'assistant', partial: null })
  }
})

test('revision 单调去重、append 增量拼接、分页无初始文本和完整 snapshot 恢复', () => {
  for (const definition of definitions()) {
    const events = [
      event(1, { revision: 1, text: '初始', status: 'streaming' }),
      event(2, { revision: 2, text: '追加', append: true, status: 'streaming' }),
      event(3, { revision: 2, text: '重复不可追加', append: true, status: 'streaming' }),
      event(4, { revision: 1, text: '过时不可替换', status: 'completed' }),
    ]
    const streaming = build(definition, events)
    assert.equal((streaming.data.partial ?? streaming.data).blocks[0].text, '初始追加')
    const partial = build(definition, [events[1]])
    assert.equal((partial.data.partial ?? partial.data).blocks[0].text, '追加')
    const complete = event(5, { revision: 3, text: '完整恢复', status: 'completed' })
    const restored = build(definition, [events[1], complete])
    assert.equal((restored.data.finalNode ?? restored.data.node).blocks[0].text, '完整恢复')
    assert.equal((build(definition, [...events, complete]).data.finalNode ?? build(definition, [...events, complete]).data.node).blocks[0].text, '完整恢复')
  }
})

test('坏 schema、其它事件和旧 assistant/message 均不匹配', () => {
  const match = definitions()[0].match[eventType]
  for (const patch of [{ revision: 0 }, { revision: undefined }, { revision: 1.5 }, { append: 'true' }, { version: 2 }, { harnessId: 'other' }, { threadId: '' }, { itemId: null }, { hostTurnId: 1 }, { text: {} }, { status: 'other' }, { nativeTime: Infinity }, { suppressed: 'true' }, { model: 1 }]) assert.equal(match(event(1, patch)), null)
  assert.equal(match({ ...event(), type: 'assistant/message' }), null)
})

// Load the actual repository TS functions without touching build output or adding dependencies.
// Infrastructure-only stubs cover notifications, Cordis effect tracking, brands and assertNever.
// createSnapshotStore deliberately throws if used: subscription-store tests are out of scope.
// Builder/index/group/projection/registry/assembler logic below is actual repository source.
const sources = new Map()
async function typescriptModuleUrl(url) {
  const key = url.href
  if (sources.has(key)) return sources.get(key)
  let source = stripTypeScriptTypes(await readFile(url, 'utf8'), { mode: 'transform', sourceMap: false })
  // location-index.ts uses `import { type A, type B }`; Node retains a bare import after erasure.
  // Those symbols are all type-only, so no actual session-controller runtime is needed.
  source = source.replace(/^import ['"]@deepseek-ai\/dsh-api-session-controller\/client['"];?\s*$/gm, '')
  const imports = [...source.matchAll(/(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)]
  for (const match of imports) {
    const specifier = match[1]
    let replacement
    if (specifier.startsWith('.')) replacement = await typescriptModuleUrl(new URL(specifier, url))
    else if (specifier === '@deepseek-ai/dsh-client-store') replacement = 'data:text/javascript,export function notifySubscribers(listeners){for(const listener of listeners)listener()} export function createSnapshotStore(){throw Error("observable stores are outside this test")} '
    else if (specifier === '@deepseek-ai/dsh-util-values') replacement = 'data:text/javascript,export function assertNever(value){throw Error("unexpected value")} '
    else if (specifier === '@deepseek-ai/dsh-brand') replacement = 'data:text/javascript,export function brandString(value){return value}'
    else if (specifier === '@deepseek-ai/cordis') replacement = 'data:text/javascript,export const Service={tracker:Symbol.for("test.cordis.tracker")}'
    else throw new Error(`Unstubbed runtime dependency ${specifier} in ${url.pathname}`)
    source = source.replace(match[0], match[0].replace(specifier, replacement))
  }
  const result = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  sources.set(key, result)
  return result
}
async function actualModule(path) { return import(await typescriptModuleUrl(new URL(path, root))) }
const emptyTimeline = { turnOrder: [], turns: new Map() }
const hasMonorepoClient = existsSync(new URL('client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts', root))

test('实际 ChatSnapshotBuilder 接受 session 节点：多 item、流式、反复 replace/upsert、suppressed', { skip: !hasMonorepoClient }, async () => {
  const { ChatSnapshotBuilder } = await actualModule('client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')
  const definition = definitions()[0]
  const builder = new ChatSnapshotBuilder()
  const first = build(definition, [event()])
  const second = build(definition, [event(2, { itemId: 'second', text: '独立回复' })])
  let snapshot = builder.replace({ nodes: [first, second], timeline: emptyTimeline })
  assert.deepEqual(snapshot.order, [first.key, second.key])
  assert.equal(snapshot.nodes.get(second.key).data.blocks[0].text, '独立回复')
  assert.equal(snapshot.legacy.nodes.length, 2)
  assert.equal(snapshot.locations.getPosition(first.key).turn, undefined)
  assert.deepEqual(snapshot.navigation.items(), [])
  for (let i = 0; i < 3; i++) snapshot = builder.replace({ nodes: [first, second], timeline: emptyTimeline })
  assert.equal(snapshot.order.length, 2)
  const changed = build(definition, [event(), event(3, { text: '覆盖' })])
  snapshot = builder.apply({ upserts: [changed], timeline: emptyTimeline })
  assert.equal(snapshot.order.length, 2)
  assert.equal(snapshot.nodes.get(first.key).data.blocks[0].text, '覆盖')
  const running = build(definition, [event(), event(4, { status: 'streaming' })])
  snapshot = builder.apply({ upserts: [running], timeline: emptyTimeline })
  assert.equal(snapshot.legacy.partial.blocks[0].text, data.text)
  assert.equal(snapshot.order.length, 2)
  const suppressed = build(definition, [event(), event(5, { suppressed: true })])
  snapshot = builder.apply({ upserts: [suppressed], timeline: emptyTimeline })
  assert.deepEqual(snapshot.order, [second.key])
  assert.equal(snapshot.legacy.nodes.length, 1)
  assert.equal(snapshot.legacy.partial, null)
  // Session-position assistants survive the actual Chat process grouping as standalone rows.
  const { ProcessState } = await actualModule('client/ui-chat/src/client/conversation-nodes/process-groups.ts')
  const process = new ProcessState()
  process.accept(builder.groupInput())
  assert.deepEqual(process.output().entries, [{ kind: 'node', key: second.key }])
})

test('实际 TrajectorySnapshotBuilder 接受 session 位置及独立 settled item', { skip: !hasMonorepoClient }, async () => {
  const { TrajectorySnapshotBuilder } = await actualModule('client/ui-trajectory/src/client/trajectory-snapshot-builder.ts')
  const definition = definitions()[1]
  const builder = new TrajectorySnapshotBuilder()
  const first = build(definition, [event()])
  const second = build(definition, [event(2, { itemId: 'second', text: '第二项' })])
  let snapshot = builder.replace({ nodes: [first, second], timeline: emptyTimeline })
  assert.equal(snapshot.eventNodes.length, 2)
  // Upstream builder records eventLocations only for data.kind === 'node', not assistants.
  assert.equal(snapshot.eventLocations.get(1), undefined)
  assert.deepEqual(first.location, { kind: 'session' })
  assert.deepEqual(snapshot.requests, [])
  for (let i = 0; i < 3; i++) snapshot = builder.replace({ nodes: [first, second], timeline: emptyTimeline })
  assert.equal(snapshot.eventNodes.length, 2)
  const changed = build(definition, [event(), event(3, { text: '覆盖' })])
  snapshot = builder.apply({ upserts: [changed], timeline: emptyTimeline })
  assert.equal(snapshot.eventNodes.length, 2)
  assert.equal(snapshot.eventNodes.at(-1).blocks[0].text, '覆盖')
  snapshot = builder.apply({ upserts: [build(definition, [event(), event(4, { status: 'streaming' })])], timeline: emptyTimeline })
  assert.equal(snapshot.partial.blocks[0].text, data.text)
  assert.equal(snapshot.eventNodes.length, 1)
  snapshot = builder.apply({ upserts: [build(definition, [event(), event(5, { suppressed: true })])], timeline: emptyTimeline })
  assert.equal(snapshot.partial, null)
  assert.equal(snapshot.eventNodes.length, 1)
})

test('真实 EventRegistry → ConversationNodeAssembler → 原生两个 builder：无 start、分页 prepend、append 和重连', { skip: !hasMonorepoClient }, async () => {
  const [{ ConversationEventRegistry }, { ConversationViewRegistry }, { ConversationNodeAssembler }, chatModule, trajectoryModule] = await Promise.all([
    actualModule('client/ui-conversation/src/client/conversation/event-registry.ts'),
    actualModule('client/ui-conversation/src/client/conversation/view-registry.ts'),
    actualModule('client/ui-conversation/src/client/conversation/assembler.ts'),
    actualModule('client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'),
    actualModule('client/ui-trajectory/src/client/trajectory-snapshot-builder.ts'),
  ])
  const owner = { effect: initialize => initialize() }
  const registry = new ConversationEventRegistry(owner)
  const views = new ConversationViewRegistry(owner)
  const dispose = installNativeRepliesClient({ uiConversation: { events: registry } })
  views.register(chatModule.chatViewDefinition)
  views.register(trajectoryModule.trajectoryViewDefinition)
  assert.equal(registry.forEvent(eventType).size, 2)
  assert.equal(registry.forEvent('assistant/message').size, 0)
  const assembler = new ConversationNodeAssembler(registry, views)
  assembler.activateTarget('chat')
  assembler.activateTarget('trajectory')
  const input = event => ({ type: 'event', event: { ...event, ignorable: true } })
  const initial = input(event(1, { text: '原始', status: 'streaming' }))
  const delta = input(event(2, { text: '增量', status: 'streaming', append: true }))
  const duplicate = input(event(3, { revision: 2, text: '重复', status: 'streaming', append: true }))
  // Open a truncated history window containing only an update delta (no start, no full snapshot).
  assembler.replaceWindow([delta], true)
  assembler.flush()
  let chat = assembler.snapshot('chat')
  let trajectory = assembler.snapshot('trajectory')
  assert.equal(chat.order.length, 1)
  const key = chat.order[0]
  assert.equal(chat.nodes.get(key).data.blocks[0].text, '增量')
  assert.equal(trajectory.partial.blocks[0].text, '增量')
  assert.equal(assembler.openTurn(), undefined)
  assert.deepEqual(chat.timeline.turnOrder, [])
  // Prepend older evidence: the engine must retain complete ordered context.matches for folding.
  assembler.prepend([initial], false)
  assembler.flush()
  chat = assembler.snapshot('chat')
  assert.equal(chat.order[0], key)
  assert.equal(chat.nodes.get(key).data.blocks[0].text, '原始增量')
  assert.equal(assembler.snapshot('trajectory').partial.blocks[0].text, '原始增量')
  assembler.append(duplicate)
  assembler.flush()
  assert.equal(assembler.snapshot('chat').nodes.get(key).data.blocks[0].text, '原始增量')
  const complete = input(event(4, { revision: 3, text: '完整最终' }))
  assembler.append(complete)
  assembler.flush()
  chat = assembler.snapshot('chat')
  trajectory = assembler.snapshot('trajectory')
  assert.equal(chat.nodes.get(key).data.status, 'settled')
  assert.equal(chat.nodes.get(key).data.blocks[0].text, '完整最终')
  assert.equal(trajectory.eventNodes.length, 1)
  assert.equal(trajectory.partial, null)
  assert.deepEqual(chat.nodes.get(key).location, { kind: 'session' })
  assert.deepEqual(chat.timeline.turnOrder, [])
  const second = input(event(5, { itemId: 'second', text: '独立回复' }))
  assembler.append(second)
  assembler.flush()
  assert.equal(assembler.snapshot('chat').order.length, 2)
  assert.equal(assembler.snapshot('trajectory').eventNodes.length, 2)
  // Reconnects and a repeated input cannot add duplicate rows or concatenate a snapshot twice.
  for (let i = 0; i < 3; i++) {
    assembler.replaceWindow([initial, delta, duplicate, complete, second], false)
    assembler.flush()
    assembler.append(second)
    assembler.flush()
    assert.equal(assembler.snapshot('chat').order.length, 2)
    assert.equal(assembler.snapshot('trajectory').eventNodes.length, 2)
    assert.equal(assembler.snapshot('chat').nodes.get(key).data.blocks[0].text, '完整最终')
  }
  assembler.append(input(event(6, { revision: 4, suppressed: true })))
  assembler.flush()
  assert.equal(assembler.snapshot('chat').order.length, 1)
  assert.equal(assembler.snapshot('trajectory').eventNodes.length, 1)
  dispose()
  assert.equal(registry.entries().length, 0)
})
