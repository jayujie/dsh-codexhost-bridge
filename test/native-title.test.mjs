import test from 'node:test'
import assert from 'node:assert/strict'
import { completeExternalTitle, collectTitleMessages, extractUserMessageTexts, isContinuePrompt } from '../native-title.mjs'
import { NativeSessionDriver } from '../native-session-driver.mjs'

test('Missing native titles use the existing DSH auxiliary caller and keep manual/native changes', async () => {
  const calls = [], events = []
  let current = { title: 'raw first prompt', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { append(type, data) { events.push({ type, data }) } }
  const service = { get: () => current }
  let duringCall = () => {}
  const ctx = { get: key => key === 'sessionTitle' ? service : {}, loader: { async import(name) {
    if (name === '@deepseek-ai/dsh-session-title-llm') return { async executeSessionTitleLlm(...args) {
      calls.push(args); duringCall(); return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '文件预览验证' }], model: { provider: 'configured', model: 'title-model' } }
    } }
    if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
    throw new Error(name)
  } } }
  const agent = { session, model: { current: () => ({ provider: 'configured', model: 'title-model' }) } }
  const policy = { enabled: true, maxInputBytes: 16000, maxOutputTokens: 128, timeoutMs: 15000 }
  await completeExternalTitle(ctx, agent, { seq: 2, text: '原始问题' }, new AbortController().signal, policy)
  assert.equal(events.length, 1)
  assert.equal(events[0].data.title, '文件预览验证')
  assert.equal(calls[0][1].provider, 'configured')
  assert.deepEqual(calls[0][4].messageSeqs, [2])
  current = { ...current, source: { kind: 'provider', provider: 'dsh-host-native-title' } }
  await completeExternalTitle(ctx, agent, { seq: 2, text: 'x' }, new AbortController().signal, policy)
  assert.equal(calls.length, 1)
  current = { ...current, source: { kind: 'fallback' } }
  duringCall = () => { current = { ...current, eventSeq: 8, source: { kind: 'user' } } }
  await completeExternalTitle(ctx, agent, { seq: 2, text: 'x' }, new AbortController().signal, policy)
  assert.equal(events.length, 1)
})

test('completeExternalTitle prefers explicit policy.provider/model over agent.model.current()', async () => {
  const calls = [], events = [], warns = []
  const current = { title: 'raw prompt', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { append(type, data) { events.push({ type, data }) } }
  const service = { get: () => current }
  let finishKind = 'stop'
  const ctx = {
    logger: { warn: msg => warns.push(msg) },
    get: key => key === 'sessionTitle' ? service : {},
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_ctx, cfg) {
            calls.push(cfg)
            return { finish: { kind: finishKind }, blocks: [{ type: 'text', text: '外阴白斑证型对比分析' }], model: { provider: cfg.provider, model: cfg.model } }
          },
        }
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        throw new Error(name)
      },
    },
  }
  const agent = { session, model: { current: () => ({ provider: 'botcf', model: 'gpt-6.1-sol' }) } }
  const policy = { enabled: true, provider: 'dswh', model: 'deepseek-v4.1-flash', maxInputBytes: 16000, maxOutputTokens: 2048, timeoutMs: 60000 }
  const ok = await completeExternalTitle(ctx, agent, { seq: 2, text: '原始问题' }, new AbortController().signal, policy)
  assert.equal(ok, true)
  assert.equal(calls[0].provider, 'dswh')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(calls[0].maxOutputTokens, 2048)
  assert.equal(events[0].data.title, '外阴白斑证型对比分析')
  assert.deepEqual(events[0].data.source.model, { provider: 'dswh', model: 'deepseek-v4.1-flash' })

  finishKind = 'max-tokens'
  const clipped = await completeExternalTitle(ctx, agent, { seq: 2, text: '原始问题' }, new AbortController().signal, policy)
  assert.equal(clipped, false)
  assert.ok(warns.some(w => w.includes('finish=max-tokens') && w.includes('dswh/deepseek-v4.1-flash')))
})

test('completeExternalTitle inherits provider/model/budget from enabled DSH title plugin when policy omits route', async () => {
  const calls = [], events = []
  const current = { title: 'raw', eventSeq: 4, source: { kind: 'fallback' }, messageSeqs: [2] }
  const session = { append(type, data) { events.push({ type, data }) } }
  const service = { get: () => current }
  const ctx = {
    get: key => key === 'sessionTitle' ? service : {},
    loader: {
      entries: () => [
        { options: { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm', disabled: true, config: { provider: 'botcf', model: 'gpt-6.1-sol' } } },
        { options: { id: 'optional-session-title-all-prompts', name: '@deepseek-ai/dsh-session-title-all-prompts-llm' }, fiber: { effectiveConfig: { provider: 'dswh', model: 'deepseek-v4.1-flash', maxInputBytes: 32768, maxOutputTokens: 2048, timeoutMs: 60000 } } },
      ],
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_ctx, cfg) {
            calls.push(cfg)
            return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: 'HWSeek 标题路由验证' }], model: { provider: cfg.provider, model: cfg.model } }
          },
        }
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        throw new Error(name)
      },
    },
  }
  const agent = { session, model: { current: () => ({ provider: 'botcf', model: 'gpt-6.1-sol' }) } }
  const policy = { enabled: true, maxInputBytes: 16000, maxOutputTokens: 512, timeoutMs: 30000 }
  const ok = await completeExternalTitle(ctx, agent, { seq: 2, text: '测试' }, new AbortController().signal, policy)
  assert.equal(ok, true)
  assert.equal(calls[0].provider, 'dswh')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(calls[0].maxInputBytes, 32768)
  assert.equal(calls[0].maxOutputTokens, 2048)
  assert.equal(calls[0].timeoutMs, 60000)
  assert.equal(events[0].data.title, 'HWSeek 标题路由验证')
})

test('collectTitleMessages keeps first message plus most recent 20 human messages and filters continue/slash prompts', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'env' }] } },
  ]
  let seq = 2
  for (let i = 1; i <= 25; i++) {
    events.push({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `消息${i}` }] } })
    if (i === 10) {
      events.push({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
      events.push({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '/compact' }] } })
      events.push({ seq: seq++, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } })
    }
  }
  const session = { snapshotEvents: () => events }
  const collected = collectTitleMessages(session)
  assert.equal(collected.length, 21)
  assert.equal(collected[0].text, '消息1')
  assert.equal(collected[1].text, '消息6')
  assert.equal(collected.at(-1).text, '消息25')
  assert.ok(collected.every(item => item.text !== '继续' && item.text !== '/compact'))
})

test('isContinuePrompt and extractUserMessageTexts skip pure continuation prompts while keeping real instructions', () => {
  for (const sample of [
    '继续',
    '继续。',
    '请继续！',
    '好的，继续',
    '继续吧',
    '继续执行',
    '继续下一步',
    '接着做',
    'continue',
    'Please continue.',
    'go on',
    'proceed',
    '继续完成之前的任务。（上一轮因五小时额度保护暂停，额度已重置，这是自动续跑。）',
    'Continue the previous task. (The last turn stopped on the five-hour quota guard; the quota has reset and this is an automatic resume.)',
  ]) {
    assert.equal(isContinuePrompt(sample), true, `expected continue prompt: ${sample}`)
  }
  for (const sample of [
    '继续把登录页面的样式也改一下',
    '继续优化 MySQL 慢查询索引',
    '继续，顺便把单测也补上',
    'continue refactoring the sidebar badges',
  ]) {
    assert.equal(isContinuePrompt(sample), false, `expected substantive prompt: ${sample}`)
  }
  const skipped = extractUserMessageTexts([{ source: { kind: 'user', rpcId: 'r-cont' }, content: [{ type: 'text', text: '继续' }] }])
  assert.deepEqual(skipped, { texts: [], key: '', continueOnly: true })
  const kept = extractUserMessageTexts([{ source: { kind: 'user', rpcId: 'r-real' }, content: [{ type: 'text', text: '继续把按钮颜色改绿' }] }])
  assert.deepEqual(kept, { texts: ['继续把按钮颜色改绿'], key: 'rpc:r-real', continueOnly: false })
})

test('completeExternalTitle with refresh commits initial undefined->fallback, skips unchanged refresh, updates on topic shift, and protects user titles', async () => {
  const calls = [], events = [], synced = []
  let current = undefined
  let replyText = '直登标题排查'
  let onDuringCall = () => {}
  const session = {
    append(type, data) {
      events.push({ type, data })
      if (type === 'session/title') current = { ...data, eventSeq: events.length + 10 }
    },
  }
  const service = { get: () => current }
  const ctx = {
    sessionPersistence: { async flush() {} },
    get: key => key === 'sessionTitle' ? service : {},
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_ctx, _cfg, _req, _provider, opts) {
            calls.push(opts)
            onDuringCall()
            return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: replyText }], model: { provider: 'dswh', model: 'deepseek-v4.1-flash' } }
          },
        }
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        throw new Error(name)
      },
    },
  }
  const peer = { async request(method, params) { synced.push({ method, params }); return {} } }
  const agent = { session, model: { current: () => ({ provider: 'dswh', model: 'deepseek-v4.1-flash' }) } }
  const policy = { enabled: true, provider: 'dswh', model: 'deepseek-v4.1-flash', maxInputBytes: 512, maxOutputTokens: 2048, timeoutMs: 60000 }

  // 1) Initial turn: current starts undefined and DSH writes fallback while LLM is in flight
  onDuringCall = () => { current = { title: '排查一下', eventSeq: 5, source: { kind: 'fallback' }, messageSeqs: [2] } }
  assert.equal(await completeExternalTitle(ctx, agent, [{ seq: 2, text: '排查一下直登命名' }], new AbortController().signal, policy, { peer, threadId: 't-1', refresh: true }), true)
  assert.equal(events.length, 1)
  assert.equal(events[0].data.title, '直登标题排查')
  assert.equal(synced.length, 1)

  // 2) Turn 2 same direction: model returns currentTitle verbatim -> no redundant event or sync
  onDuringCall = () => {}
  replyText = '直登标题排查'
  assert.equal(await completeExternalTitle(ctx, agent, [{ seq: 2, text: '排查一下直登命名' }, { seq: 8, text: '再看下日志' }], new AbortController().signal, policy, { peer, threadId: 't-1', refresh: true }), false)
  assert.equal(events.length, 1)
  assert.equal(synced.length, 1)
  assert.match(calls[1].system, /return currentTitle verbatim unchanged/i)
  assert.equal(JSON.parse(calls[1].input).currentTitle, '直登标题排查')
  assert.equal(JSON.parse(calls[1].input).messages.length, 2)

  // 3) Turn 3 topic clearly shifted -> updates title and syncs Host
  replyText = '优化数据库索引性能'
  assert.equal(await completeExternalTitle(ctx, agent, [{ seq: 2, text: '排查一下直登命名' }, { seq: 8, text: '再看下日志' }, { seq: 14, text: '换个话题，帮我优化 MySQL 慢查询索引' }], new AbortController().signal, policy, { peer, threadId: 't-1', refresh: true }), true)
  assert.equal(events.length, 2)
  assert.equal(events[1].data.title, '优化数据库索引性能')
  assert.deepEqual(events[1].data.messageSeqs, [2, 8, 14])
  assert.equal(synced.length, 2)
  assert.equal(synced[1].params.name, '优化数据库索引性能')

  // 4) User manually renamed -> never calls LLM again
  current = { title: '手动锁定标题', eventSeq: 99, source: { kind: 'user' }, messageSeqs: [] }
  assert.equal(await completeExternalTitle(ctx, agent, [{ seq: 2, text: '排查' }, { seq: 20, text: '完全新话题' }], new AbortController().signal, policy, { peer, threadId: 't-1', refresh: true }), false)
  assert.equal(calls.length, 3)

  // 5) Oversized refresh payload stays within maxInputBytes without broken surrogates
  current = { title: '短标题', eventSeq: 100, source: { kind: 'provider', provider: 'dsh-host-dsh-title' }, messageSeqs: [2] }
  replyText = '长消息截断验证'
  const big = '测试😀内容'.repeat(100)
  assert.equal(await completeExternalTitle(ctx, agent, [{ seq: 2, text: big }, { seq: 22, text: big }], new AbortController().signal, { ...policy, maxInputBytes: 220 }, { peer, threadId: 't-1', refresh: true }), true)
  assert.ok(Buffer.byteLength(calls[3].input, 'utf8') <= 220)
  assert.ok(!calls[3].input.includes('\uFFFD'))
  assert.equal(JSON.parse(calls[3].input).currentTitle, '短标题')
})

test('NativeSessionDriver triggers title immediately when a turn starts and refreshes on topic shift in later turns without duplicating at turn end', async () => {
  const titleCalls = [], listeners = new Set(), events = []
  let seq = 0, currentTitle = undefined
  const titleStarted = Promise.withResolvers()
  const titleFinished = Promise.withResolvers()
  let replyTitle = '初始对话标题'
  const session = {
    id: 'local-start-title',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => events,
    append(type, data, options) {
      const ev = { seq: ++seq, type, data, ...(options?.ignorable ? { ignorable: true } : {}) }
      events.push(ev)
      if (type === 'session/title') currentTitle = { ...data, eventSeq: ev.seq }
      return ev
    },
  }
  const agent = { id: session.id, session, model: { current: () => ({ provider: 'dswh', model: 'deepseek-v4.1-flash' }) } }
  let turnStartCount = 0
  const opusId = 'claude-model-v1.' + Buffer.from('opus').toString('base64url')
  const peer = {
    closed: new Promise(() => {}),
    close() {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async request(method, params) {
      if (method === 'codexhost/harness/inspect') return { status: 'ready', catalog: { models: [{ ref: { id: opusId }, label: 'Claude Opus' }] }, permissionModes: { modes: [{ id: 'bypassPermissions', label: 'Bypass' }] } }
      if (method === 'thread/start') return { thread: { id: 'ext-t1' } }
      if (method === 'thread/resume') return {}
      if (method === 'thread/read') return { thread: { id: 'ext-t1', status: { type: 'idle' } } }
      if (method === 'codexhost/thread/usage/inspect') return {}
      if (method === 'thread/name/set') return {}
      if (method === 'turn/start') {
        turnStartCount++
        const turnId = `host-turn-${turnStartCount}`
        // Emit completion only AFTER verifying turn-start title already fired while turn is in progress
        queueMicrotask(async () => {
          if (turnStartCount === 1) await titleFinished.promise
          for (const fn of listeners) fn({ method: 'turn/completed', params: { threadId: 'ext-t1', turn: { id: turnId, status: 'completed' } } })
        })
        return { turn: { id: turnId } }
      }
      throw new Error(`Unexpected RPC: ${method}`)
    },
  }
  const ctx = {
    agentPresets: { presetForSession: () => 'dsh-host-claude-code' },
    agents: {},
    sessionPersistence: { async flush() {} },
    logger: { warn() {} },
    get(key) {
      if (key === 'sessionTitle') return { get: () => currentTitle }
      if (key === 'llm') return {}
      return undefined
    },
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_c, _cfg, _req, _p, opts) {
            titleCalls.push({ turnStartCount, opts })
            titleStarted.resolve()
            const out = { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: replyTitle }], model: { provider: 'dswh', model: 'deepseek-v4.1-flash' } }
            queueMicrotask(() => titleFinished.resolve())
            return out
          },
        }
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        throw new Error(name)
      },
    },
  }
  const helpers = {
    appendPluginRecord(target, type, data) { target.append(type, data, { ignorable: true }) },
    agentEvents: () => ({ emit() {} }),
    AssistantStreamAccumulator: class { push(v) { return v } snapshot() { return [] } },
    BlockAssembler: class { push() {} blocks() { return [] } },
    createAssistantMessage: ({ content, source }) => ({ content, source }),
  }
  const driver = new NativeSessionDriver(ctx, helpers, {
    connect: async () => peer,
    titlePolicy: { enabled: true, provider: 'dswh', model: 'deepseek-v4.1-flash', maxInputBytes: 16000, maxOutputTokens: 2048, timeoutMs: 30000, nativeClaude: { enabled: false } },
  })
  try {
    // Turn 1: title must start and commit BEFORE turn/completed arrives, with no duplicate call after turn end
    await driver.run({
      agent, turn: 1, step: 1, signal: new AbortController().signal,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我排查直登会话命名' }] }],
    })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(titleCalls.length, 1, 'turn 1 should call title once at start and not duplicate at turn end')
    assert.equal(currentTitle?.title, '初始对话标题')

    // Turn 2: sending "继续" must NOT trigger any title update
    await driver.run({
      agent, turn: 2, step: 1, signal: new AbortController().signal,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }],
    })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(titleCalls.length, 1, 'sending "继续" must not trigger title generation')
    assert.equal(currentTitle?.title, '初始对话标题')

    // Turn 3: topic shifts -> title refreshes automatically on turn 3 start
    replyTitle = '重构前端状态管理'
    await driver.run({
      agent, turn: 3, step: 1, signal: new AbortController().signal,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '现在换个任务，帮我重构 React 状态管理' }] }],
    })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(titleCalls.length, 2)
    assert.equal(JSON.parse(titleCalls[1].opts.input).currentTitle, '初始对话标题')
    assert.equal(currentTitle?.title, '重构前端状态管理')
  } finally {
    await driver.dispose()
  }
})

test('agent/inbox/spliced triggers title immediately while a turn is running and deduplicates on subsequent run()', async () => {
  const titleCalls = [], listeners = new Map(), events = []
  let seq = 0, currentTitle = { title: '初始标题', eventSeq: 2, source: { kind: 'provider', provider: 'dsh-host-dsh-title' }, messageSeqs: [1] }
  const session = {
    id: 'local-inbox-title',
    header: { cwd: 'D:/work' },
    snapshotEvents: () => events,
    append(type, data, options) {
      const ev = { seq: ++seq, type, data, ...(options?.ignorable ? { ignorable: true } : {}) }
      events.push(ev)
      if (type === 'session/title') currentTitle = { ...data, eventSeq: ev.seq }
      return ev
    },
  }
  events.push({ seq: ++seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复构建脚本' }] } })
  events.push({ seq: ++seq, type: 'session/title', data: { title: '初始标题', source: { kind: 'provider', provider: 'dsh-host-dsh-title' }, messageSeqs: [1] } })
  const agent = { id: session.id, session, model: { current: () => ({ provider: 'dswh', model: 'deepseek-v4.1-flash' }) } }
  const ctx = {
    agentPresets: { presetForSession: () => 'dsh-host-antigravity' },
    agentLoop: { register: () => () => {} },
    agents: { get: id => id === session.id ? agent : undefined },
    sessionPersistence: { async flush() {} },
    logger: { warn() {} },
    effect: () => () => {},
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => {}
    },
    get(key) {
      if (key === 'sessionTitle') return { get: () => currentTitle }
      if (key === 'llm') return {}
      return undefined
    },
    loader: {
      async import(name) {
        if (name === '@deepseek-ai/dsh-session-title-llm') return {
          async executeSessionTitleLlm(_c, _cfg, _req, _p, opts) {
            titleCalls.push(opts)
            return { finish: { kind: 'stop' }, blocks: [{ type: 'text', text: '数据库索引优化方案' }], model: { provider: 'dswh', model: 'deepseek-v4.1-flash' } }
          },
        }
        if (name === '@deepseek-ai/dsh-session-title') return { normalizeSessionTitle: text => text.trim() }
        throw new Error(name)
      },
    },
  }
  const driver = new NativeSessionDriver(ctx, {}, {
    connect: async () => { throw new Error('should not connect to Host just to title an inbox prompt') },
    titlePolicy: { enabled: true, provider: 'dswh', model: 'deepseek-v4.1-flash', maxInputBytes: 16000, maxOutputTokens: 2048, timeoutMs: 30000, nativeClaude: { enabled: false } },
  })
  driver.install()
  try {
    // Pure "继续" entering inbox while a turn is running must NOT trigger a title refresh.
    const continueSplicedEvent = {
      seq: ++seq,
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn',
        inserted: [{ source: { kind: 'user', rpcId: 'rpc-mid-continue' }, content: [{ type: 'text', text: '请继续。' }] }],
      },
    }
    for (const fn of listeners.get('session/event') ?? []) fn(session, continueSplicedEvent)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(titleCalls.length, 0, 'inbox "继续" should not trigger title update')
    assert.equal(currentTitle.title, '初始标题')

    // Mid-turn queued user message enters inbox while previous turn is still running.
    const splicedEvent = {
      seq: ++seq,
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn',
        inserted: [{ source: { kind: 'user', rpcId: 'rpc-mid-1' }, content: [{ type: 'text', text: '换个话题，帮我优化数据库慢查询索引' }] }],
      },
    }
    for (const fn of listeners.get('session/event') ?? []) fn(session, splicedEvent)
    await new Promise(r => setTimeout(r, 30))
    assert.equal(titleCalls.length, 1, 'inbox splice should trigger title immediately without waiting for turn end')
    assert.equal(currentTitle.title, '数据库索引优化方案')
    assert.match(titleCalls[0].input, /优化数据库慢查询索引/)

    // Re-emitting the exact same rpcId within dedupe window must not trigger a duplicate LLM call.
    for (const fn of listeners.get('session/event') ?? []) fn(session, splicedEvent)
    await new Promise(r => setTimeout(r, 20))
    assert.equal(titleCalls.length, 1)

    // Slash commands are ignored by extractUserMessageTexts.
    assert.deepEqual(extractUserMessageTexts([{ source: { kind: 'user' }, content: [{ type: 'text', text: '/compact' }] }]).texts, [])
  } finally {
    await driver.dispose()
  }
})
