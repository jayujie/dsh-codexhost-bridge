import { randomUUID } from 'node:crypto'
import { NativeToolProjector, nativeModelSource } from './native-tool-projector.mjs'
import { normalizeFileUriMarkdownLinks } from './file-uri-links.mjs'

/** Translates native Host text/reasoning into DSH's existing live and durable stream. */
export class NativeTurnProjector {
  #session
  #helpers
  #dispatch
  #position
  #nextRevision
  #attemptId
  #accumulator
  #assembler
  #blocks = new Map()
  #frameIndex = 0
  #closed = false
  #usage
  #tools

  constructor({ agent, turn, step, helpers, dispatch, nextRevision, provider, model }) {
    this.source = nativeModelSource(provider, model)
    this.#session = agent.session
    this.#helpers = helpers
    this.#dispatch = dispatch
    this.#position = { turn, step }
    this.#nextRevision = nextRevision
    this.#attemptId = `${agent.id}:dsh-host:${randomUUID()}`
    this.#accumulator = new helpers.AssistantStreamAccumulator()
    this.#assembler = new helpers.BlockAssembler()
    this.#tools = new NativeToolProjector(agent.session, helpers, this.#position, provider.split('/').at(-1), this.source)
    this.#dispatch.emit('agent/assistant-stream', { frame: {
      type: 'start', attemptId: this.#attemptId, revision: this.#nextRevision(), turn, step,
    } })
  }

  #push(chunk) {
    const timed = this.#accumulator.push({ time: Date.now(), chunk })
    this.#assembler.push(timed.chunk)
    this.#dispatch.emit('agent/assistant-stream', { frame: {
      type: 'chunk', attemptId: this.#attemptId, revision: this.#nextRevision(),
      index: this.#frameIndex++, time: timed.time, chunk: timed.chunk,
    } })
  }

  #block(id, type) {
    let block = this.#blocks.get(id)
    if (block === undefined) {
      block = { index: this.#blocks.size, type, text: '', ended: false }
      this.#blocks.set(id, block)
      this.#push({ type: 'block-start', index: block.index, blockType: type })
    }
    return block
  }

  accept(message) {
    if (this.#closed) return
    this.#tools.accept(message)
    const p = message.params ?? {}
    if (message.method === 'item/started') {
      const item = p.item
      if (item?.type !== 'agentMessage') return
      const text = typeof item.text === 'string' ? normalizeFileUriMarkdownLinks(item.text) : ''
      if (text === '') return
      const block = this.#block(item.id, 'text')
      if (block.ended || block.text !== '') return
      const now = Date.now()
      block.firstDeltaAt ??= now
      block.lastDeltaAt = now
      block.deltaSamples = (block.deltaSamples ?? 0) + 1
      block.text = text
      this.#push({ type: 'text-delta', index: block.index, text })
      return
    }
    if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta' || message.method === 'item/reasoning/textDelta') {
      const type = message.method === 'item/agentMessage/delta' ? 'text' : 'reasoning'
      const block = this.#block(p.itemId, type)
      if (block.ended || typeof p.delta !== 'string') return
      if (p.delta.length > 0) {
        const now = Date.now()
        block.firstDeltaAt ??= now
        block.lastDeltaAt = now
        block.deltaSamples = (block.deltaSamples ?? 0) + 1
      }
      block.text += p.delta
      this.#push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: p.delta })
    }
    if (message.method === 'item/completed') {
      const item = p.item
      if (item?.type !== 'agentMessage' && item?.type !== 'reasoning') return
      const type = item.type === 'agentMessage' ? 'text' : 'reasoning'
      const rawText = typeof item.text === 'string' ? item.text : Array.isArray(item.summary) ? item.summary.join('\n') : ''
      const text = type === 'text' ? normalizeFileUriMarkdownLinks(rawText) : rawText
      const block = this.#block(item.id, type)
      if (block.ended) return
      // A Host may send only a completed item, without preceding delta frames.
      if (block.text === '' && text !== '') {
        block.text = text
        this.#push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text })
      }
      this.#endBlock(block)
    }
  }

  #endBlock(block) {
    if (block.ended) return
    block.ended = true
    if (block.type === 'text') block.text = normalizeFileUriMarkdownLinks(block.text)
    this.#push({ type: 'block-end', index: block.index, block: { type: block.type, text: block.text } })
  }

  // A single completed/batched payload has no observable decode interval.
  get hasMeasuredStream() {
    const blocks = [...this.#blocks.values()].filter(block => block.text.length > 0)
    return blocks.length > 0 && blocks.every(block => block.deltaSamples >= 2 && block.lastDeltaAt > block.firstDeltaAt)
  }

  usage(value) { this.#usage = value }

  /** Tool observations of this Turn, for background task hand-off. */
  get tools() { return this.#tools }

  settle({ interrupted = false } = {}) {
    if (this.#closed) return
    this.#closed = true
    this.#tools.settle()
    for (const block of this.#blocks.values()) this.#endBlock(block)
    if (this.#usage !== undefined) this.#push({ type: 'usage', usage: this.#usage })
    this.#push({ type: 'finish', reason: { kind: 'stop' } })
    const content = this.#assembler.blocks().map(block =>
      block?.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: normalizeFileUriMarkdownLinks(block.text) }
        : block,
    )
    const stream = [...this.#accumulator.snapshot()]
    let event
    if (content.length > 0) {
      event = this.#session.append('assistant/message', {
        ...this.#position,
        message: this.#helpers.createAssistantMessage({ content, source: this.source }),
        ...(this.#usage === undefined ? {} : { usage: this.#usage }),
        ...(interrupted ? { interrupted: true } : {}), stream,
      }, { surfaceOp: 'append' })
    } else event = this.#session.append('assistant/attempt', { ...this.#position, stream })
    this.#dispatch.emit('agent/assistant-stream', { frame: {
      type: 'end', attemptId: this.#attemptId, revision: this.#nextRevision(), index: this.#frameIndex,
      outcome: { kind: 'committed', eventType: event.type, seq: event.seq },
    } })
  }
}
