import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFileUriMarkdownLinks,
  parseFileUriHref,
  buildSessionFileAddress,
  installFileUriLinkClient,
} from '../file-uri-links.mjs'
import { NativeTurnProjector } from '../native-turn-projector.mjs'
import { locallyCovered } from '../native-replies.mjs'
import { installNativeRepliesClient } from '../native-replies-client.mjs'

function makeHelpers() {
  return {
    AssistantStreamAccumulator: class {
      #chunks = []
      push(item) { this.#chunks.push(item); return item }
      snapshot() { return this.#chunks }
    },
    BlockAssembler: class {
      #blocks = new Map()
      push(chunk) {
        if (chunk.type === 'block-start') this.#blocks.set(chunk.index, { type: chunk.blockType, text: '' })
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') this.#blocks.get(chunk.index).text += chunk.text
      }
      blocks() { return [...this.#blocks.values()] }
    },
    createAssistantMessage: ({ content, source }) => ({ role: 'assistant', content, source }),
    ToolCallId: id => id,
  }
}

test('normalizeFileUriMarkdownLinks rewrites local file:/// links for Windows and POSIX', () => {
  const input = [
    'See [antigravity-visibility.test.mjs](file:///D:/workspace/demo/source/deepseek-harness/packages/experimental/dsh-host/test/antigravity-visibility.test.mjs)',
    'and [notes.md](file:///C:/Users/alice/.dsh/AGENTS.md#L10-L20)',
    'and [spaced](file:///D:/My%20Docs/a%20b.md#L5)',
    'and [angled](<file:///D:/My Docs/c d.md#L8>)',
    'and [localhost](file://localhost/D:/Desktop/out.html)',
    'and [posix](file:///Users/alice/project/app.ts#L42)',
    'and [parens](file:///D:/dir(1)/foo.ts#L3)',
    'and [encodedDrive](file:///D%3A/Desktop/x.txt)',
  ].join('\n')

  const actual = normalizeFileUriMarkdownLinks(input)
  assert.equal(actual, [
    'See [antigravity-visibility.test.mjs](D:/workspace/demo/source/deepseek-harness/packages/experimental/dsh-host/test/antigravity-visibility.test.mjs)',
    'and [notes.md](C:/Users/alice/.dsh/AGENTS.md#L10-L20)',
    'and [spaced](D:/My%20Docs/a%20b.md#L5)',
    'and [angled](<D:/My Docs/c d.md#L8>)',
    'and [localhost](D:/Desktop/out.html)',
    'and [posix](/Users/alice/project/app.ts#L42)',
    'and [parens](D:/dir(1)/foo.ts#L3)',
    'and [encodedDrive](D:/Desktop/x.txt)',
  ].join('\n'))
})

test('normalizeFileUriMarkdownLinks preserves code spans, fenced blocks, images, and non-local URLs', () => {
  const input = [
    'Inline `[a.md](file:///D:/Desktop/a.md)` stays untouched.',
    '```markdown',
    '[b.md](file:///D:/Desktop/b.md)',
    '```',
    '~~~',
    '[c.md](file:///D:/Desktop/c.md)',
    '~~~',
    '![img](file:///D:/Desktop/img.png)',
    '[web](https://example.com/file:///D:/a.md)',
    '[unc](file://fileserver.corp/share/doc.md)',
    'Real link: [real.md](file:///D:/Desktop/real.md#L12)',
  ].join('\n')

  const actual = normalizeFileUriMarkdownLinks(input)
  assert.ok(actual.includes('Inline `[a.md](file:///D:/Desktop/a.md)` stays untouched.'))
  assert.ok(actual.includes('[b.md](file:///D:/Desktop/b.md)'))
  assert.ok(actual.includes('[c.md](file:///D:/Desktop/c.md)'))
  assert.ok(actual.includes('![img](file:///D:/Desktop/img.png)'))
  assert.ok(actual.includes('[web](https://example.com/file:///D:/a.md)'))
  assert.ok(actual.includes('[unc](file://fileserver.corp/share/doc.md)'))
  assert.ok(actual.includes('Real link: [real.md](D:/Desktop/real.md#L12)'))
})

test('NativeTurnProjector normalizes streamed file:/// links and locallyCovered stays compatible', () => {
  const events = []
  const session = {
    append(type, data, options) {
      const event = { type, seq: events.length, data, ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}) }
      events.push(event)
      return event
    },
    snapshotEvents() { return events },
  }
  events.push({ type: 'plugin:dsh-host/thread', ignorable: true, data: { hostTurnId: 'turn-1', localTurn: 1 } })

  const projector = new NativeTurnProjector({
    agent: { id: 'session-1', session },
    turn: 1,
    step: 1,
    helpers: makeHelpers(),
    dispatch: { emit() {} },
    nextRevision: () => 1,
    provider: 'codexhost/antigravity',
    model: 'gemini-3.1-pro',
  })
  // Split the file:/// URI across streaming deltas just like live SSE chunks.
  projector.accept({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Checked [test.mjs](fi' } })
  projector.accept({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'le:///D:/Desktop/test.mjs#L10-L20).' } })
  projector.settle()

  const assistantEvent = events.find(e => e.type === 'assistant/message')
  assert.equal(assistantEvent.data.message.content[0].text, 'Checked [test.mjs](D:/Desktop/test.mjs#L10-L20).')
  // NativeReplySync compares Host's raw file:/// text against DSH's normalized assistant/message.
  assert.equal(locallyCovered(session, 'turn-1', 'Checked [test.mjs](file:///D:/Desktop/test.mjs#L10-L20).'), true)
})

test('native-replies-client normalizes file:/// links in projected blocks', () => {
  const defs = []
  const dispose = installNativeRepliesClient({
    uiConversation: { events: { register(def) { defs.push(def); return () => {} } } },
  })
  const chatDef = defs.find(d => d.target === 'chat')
  const event = {
    type: 'plugin:dsh-host/native-message',
    seq: 1,
    time: 1000,
    data: {
      version: 1, harnessId: 'antigravity', threadId: 't1', hostTurnId: 'h1', itemId: 'i1',
      revision: 1, text: 'Open [doc.md](file:///D:/Desktop/doc.md#L7)', status: 'completed',
    },
  }
  const match = chatDef.match['plugin:dsh-host/native-message'](event)
  const node = chatDef.buildViewNode({ key: 'k', id: match.id, kind: chatDef.kind, matches: [{ event }] })
  assert.equal(node.data.blocks[0].text, 'Open [doc.md](D:/Desktop/doc.md#L7)')
  dispose()
})

test('parseFileUriHref and buildSessionFileAddress handle Windows, POSIX, spaces, and lines', () => {
  assert.deepEqual(
    parseFileUriHref('file:///D:/workspace/demo/test/antigravity-visibility.test.mjs#L12-L34'),
    { path: 'D:/workspace/demo/test/antigravity-visibility.test.mjs', line: 12 },
  )
  assert.deepEqual(
    parseFileUriHref('file:///D:/My%20Docs/notes.md:45:2'),
    { path: 'D:/My Docs/notes.md', line: 45 },
  )
  assert.deepEqual(
    parseFileUriHref('file://localhost/Users/alice/a.md#L9'),
    { path: '/Users/alice/a.md', line: 9 },
  )
  assert.equal(parseFileUriHref('https://example.com/a.md'), null)
  assert.equal(parseFileUriHref('file://remote-host/share/a.md'), null)

  assert.equal(
    buildSessionFileAddress('session-1', 'D:/Desktop/sub/a.html', 'D:\\Desktop'),
    'dsh-resource://file/session/session-1/sub/a.html',
  )
  assert.equal(
    buildSessionFileAddress('session-1', 'D:/Desktop2/a.html', 'D:\\Desktop'),
    'dsh-resource://file/session/session-1/D:/Desktop2/a.html',
  )
  assert.equal(
    buildSessionFileAddress('session-1', 'D:/My Docs/file#1.mjs', 'D:\\Desktop'),
    'dsh-resource://file/session/session-1/D:/My%20Docs/file%231.mjs',
  )
})

test('installFileUriLinkClient intercepts left-clicks on historical file:/// anchors and opens right sidebar', () => {
  const listeners = new Map()
  const originalDocument = globalThis.document
  globalThis.document = {
    addEventListener(type, fn, capture) { listeners.set(`${type}:${capture}`, fn) },
    removeEventListener(type, fn, capture) { if (listeners.get(`${type}:${capture}`) === fn) listeners.delete(`${type}:${capture}`) },
  }
  const opened = []
  try {
    const dispose = installFileUriLinkClient({
      uiSession: { adapter: { current: { getSnapshot: () => ({ props: { sessionId: 'sess-agy' } }) } } },
      sessions: { list: { getSnapshot: () => ({ byId: { 'sess-agy': { cwd: 'D:\\Desktop', retainedBy: { mainView: 1 } } } }) } },
      sidebarRight: { openResource(url, opts) { opened.push([url, opts]) } },
    })
    const handler = listeners.get('click:true')
    assert.equal(typeof handler, 'function')

    let prevented = false, stopped = false
    handler({
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: () => ({ getAttribute: () => 'file:///D:/workspace/demo/foo.mjs#L18-L25' }) },
      preventDefault() { prevented = true },
      stopPropagation() { stopped = true },
    })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
    assert.deepEqual(opened, [['dsh-resource://file/session/sess-agy/D:/workspace/demo/foo.mjs', { params: { line: 18 } }]])

    // Non-file links are ignored.
    let webPrevented = false
    handler({
      defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: () => ({ getAttribute: () => 'https://example.com' }) },
      preventDefault() { webPrevented = true },
      stopPropagation() {},
    })
    assert.equal(webPrevented, false)
    assert.equal(opened.length, 1)

    dispose()
    assert.equal(listeners.size, 0)
  } finally {
    globalThis.document = originalDocument
  }
})
