import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshParseAntigravityStartupMilestone } from './antigravity-visibility.mjs'

const ENGINE_LABELS = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  antigravity: 'Antigravity',
}

const AGY_LOG_PREFIX = 'codexhost-antigravity-'
const AGY_LOG_SUFFIX = '.log'
const AGY_WATCH_POLL_MS = 400
const AGY_MAX_READ_BYTES = 256 * 1024

const AGY_STARTUP_PHASE_RANK = {
  preparing: 0,
  connecting: 0,
  catalog: 0,
  thread: 0,
  observe: 0,
  dispatching: 0,
  starting: 0,
  auth: 1,
  mcp: 2,
  sending: 3,
  requesting: 4,
  thinking: 5,
  tool: 5,
  responding: 5,
  compacting: 5,
  'waiting-approval': 5,
  'waiting-subagent': 5,
}

/**
 * Prevent asynchronous background log lines (such as a post-send loadCodeAssist refresh)
 * from regressing the live status indicator back to an earlier startup stage.
 */
export function shouldAcceptAntigravityMilestone(currentPhase, milestonePhase) {
  if (!milestonePhase) return false
  if (milestonePhase === 'retrying') return true
  const curRank = AGY_STARTUP_PHASE_RANK[currentPhase] ?? 0
  const nextRank = AGY_STARTUP_PHASE_RANK[milestonePhase]
  if (nextRank === undefined) return curRank < 5
  if (curRank >= 5) return false
  return nextRank >= curRank
}

export function engineDisplayLabel(harnessId) {
  return ENGINE_LABELS[harnessId] ?? harnessId ?? 'Host'
}

export function formatToolLabel(item) {
  if (!item || typeof item !== 'object') return ''
  const raw = item.toolName ?? item.tool ?? (item.type === 'commandExecution' ? '命令执行' : item.type === 'fileChange' ? '文件修改' : item.type === 'collabAgentToolCall' ? '子智能体' : item.type)
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, 64)
}

/**
 * In-memory per-session live execution phase tracker for active DSH Host turns.
 * Never persists to session logs or alters model context.
 */
export class NativeLiveStatusTracker {
  #states = new Map()
  #now

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now
  }

  start(sessionId, { harnessId, phase = 'preparing', label = '正在准备会话…', detail = '' } = {}) {
    const t = this.#now()
    const record = {
      active: true,
      harnessId: harnessId ?? 'antigravity',
      phase,
      label,
      detail,
      startedAt: t,
      phaseStartedAt: t,
      lastActivityAt: t,
      activityCount: 1,
      paused: false,
      activeTools: new Map(),
    }
    this.#states.set(sessionId, record)
    return this.snapshot(sessionId)
  }

  update(sessionId, { phase, label, detail, paused, bumpActivity = true } = {}) {
    const record = this.#states.get(sessionId)
    if (!record) return null
    const t = this.#now()
    if (phase !== undefined && phase !== record.phase) {
      record.phase = phase
      record.phaseStartedAt = t
    }
    if (label !== undefined) record.label = label
    if (detail !== undefined) record.detail = detail
    if (paused !== undefined) record.paused = Boolean(paused)
    if (bumpActivity) {
      record.lastActivityAt = t
      record.activityCount += 1
    }
    return this.snapshot(sessionId)
  }

  touch(sessionId) {
    const record = this.#states.get(sessionId)
    if (!record) return
    record.lastActivityAt = this.#now()
    record.activityCount += 1
  }

  /** Translate incoming Host JSON-RPC notifications into live status updates. */
  observeNotification(sessionId, message) {
    const record = this.#states.get(sessionId)
    if (!record || !message || typeof message !== 'object') return
    const method = message.method
    const params = message.params ?? {}

    if (method === 'turn/started') {
      const engine = engineDisplayLabel(record.harnessId)
      if (record.harnessId === 'antigravity') {
        if ((AGY_STARTUP_PHASE_RANK[record.phase] ?? 0) === 0) {
          this.update(sessionId, {
            phase: 'starting',
            label: `${engine} 已启动，初始化中…`,
            detail: '',
          })
        } else {
          this.touch(sessionId)
        }
        return
      }
      this.update(sessionId, {
        phase: 'requesting',
        label: `${engine} 已接单，等待模型响应…`,
        detail: '',
      })
      return
    }

    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (delta.includes('[AGY 重试]') || delta.includes('[AGY 启动前瞬断]')) {
        const line = delta.trim().split(/\r?\n/)[0].slice(0, 120)
        this.update(sessionId, { phase: 'retrying', label: line, detail: '' })
        return
      }
      if (record.activeTools.size === 0) {
        this.update(sessionId, { phase: 'thinking', label: '模型思考中…', detail: '' })
      } else {
        this.touch(sessionId)
      }
      return
    }

    if (method === 'item/agentMessage/delta') {
      this.update(sessionId, { phase: 'responding', label: '正在生成回复…', detail: '' })
      return
    }

    if (method === 'item/commandExecution/outputDelta') {
      this.touch(sessionId)
      return
    }

    if (method === 'item/started' || method === 'codexhost/item/started') {
      const item = params.item
      if (!item) { this.touch(sessionId); return }
      if (item.type === 'contextCompaction') {
        this.update(sessionId, { phase: 'compacting', label: '正在压缩上下文…', detail: '' })
        return
      }
      if (item.type === 'reasoning') {
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (text.includes('[AGY 重试]') || text.includes('[AGY 启动前瞬断]')) {
          this.update(sessionId, { phase: 'retrying', label: text.split(/\r?\n/)[0].slice(0, 120), detail: '' })
          return
        }
        if (record.activeTools.size === 0) {
          this.update(sessionId, { phase: 'thinking', label: '模型思考中…', detail: '' })
        } else {
          this.touch(sessionId)
        }
        return
      }
      if (item.type === 'agentMessage') {
        if (typeof item.text === 'string' && item.text.length > 0) {
          this.update(sessionId, { phase: 'responding', label: '正在生成回复…', detail: '' })
        } else {
          this.touch(sessionId)
        }
        return
      }
      if (item.type !== 'userMessage') {
        const id = item.itemId ?? item.id ?? `tool-${record.activeTools.size + 1}`
        const name = formatToolLabel(item) || '工具'
        record.activeTools.set(id, name)
        const count = record.activeTools.size
        this.update(sessionId, {
          phase: 'tool',
          label: count > 1 ? `正在执行 ${name} 等 ${count} 个工具…` : `正在执行工具：${name}`,
          detail: name,
        })
        return
      }
      return
    }

    if (method === 'item/completed' || method === 'codexhost/item/completed') {
      const item = params.item
      if (!item) { this.touch(sessionId); return }
      if (item.type === 'contextCompaction') {
        this.update(sessionId, { phase: 'requesting', label: '压缩完成，继续处理中…', detail: '' })
        return
      }
      const id = item.itemId ?? item.id
      if (id && record.activeTools.has(id)) {
        record.activeTools.delete(id)
        if (record.activeTools.size > 0) {
          const remaining = [...record.activeTools.values()]
          const first = remaining[0]
          this.update(sessionId, {
            phase: 'tool',
            label: remaining.length > 1 ? `正在执行 ${first} 等 ${remaining.length} 个工具…` : `正在执行工具：${first}`,
            detail: first,
          })
        } else {
          this.update(sessionId, { phase: 'thinking', label: '工具完成，继续推理中…', detail: '' })
        }
        return
      }
      this.touch(sessionId)
      return
    }

    if (method === 'turn/completed') {
      this.clear(sessionId)
      return
    }

    this.touch(sessionId)
  }

  clear(sessionId) {
    this.#states.delete(sessionId)
  }

  snapshot(sessionId) {
    const record = this.#states.get(sessionId)
    if (!record) return { active: false }
    return {
      active: true,
      harnessId: record.harnessId,
      phase: record.phase,
      label: record.label,
      ...(record.detail ? { detail: record.detail } : {}),
      startedAt: record.startedAt,
      phaseStartedAt: record.phaseStartedAt,
      lastActivityAt: record.lastActivityAt,
      activityCount: record.activityCount,
      paused: record.paused,
    }
  }
}

function listAgyTempLogs(tmpDir) {
  try {
    return fs.readdirSync(tmpDir).filter(name => name.startsWith(AGY_LOG_PREFIX) && name.endsWith(AGY_LOG_SUFFIX))
  } catch {
    return []
  }
}

/**
 * Lightweight read-only watcher for Antigravity's per-turn temp --log-file in tmpdir.
 * Reports startup milestones (OAuth, MCP, model SSE request, retries) into the live
 * status tracker without modifying backend/ or writing anything into session history.
 */
export function createAntigravityStartupLogWatcher({
  tmpDir = os.tmpdir(),
  pollMs = AGY_WATCH_POLL_MS,
  onMilestone,
  onActivity,
} = {}) {
  const baseline = new Set(listAgyTempLogs(tmpDir))
  let targetPath = null
  let offset = 0
  let remainder = ''
  let stopped = false
  let timer = null

  function findNewLog() {
    const current = listAgyTempLogs(tmpDir)
    const fresh = current
      .filter(name => !baseline.has(name))
      .map(name => {
        const full = path.join(tmpDir, name)
        try { return { full, mtime: fs.statSync(full).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
    if (fresh.length > 0) targetPath = fresh[0].full
  }

  function poll() {
    if (stopped) return
    try {
      if (!targetPath) findNewLog()
      if (!targetPath) return
      let st
      try { st = fs.statSync(targetPath) } catch { return }
      if (!st.isFile() || st.size <= offset) return
      const readLen = Math.min(AGY_MAX_READ_BYTES, st.size - offset)
      const buf = Buffer.allocUnsafe(readLen)
      const fd = fs.openSync(targetPath, 'r')
      let bytesRead = 0
      try { bytesRead = fs.readSync(fd, buf, 0, readLen, offset) } finally { fs.closeSync(fd) }
      if (bytesRead <= 0) return
      offset += bytesRead
      onActivity?.()
      const text = remainder + buf.subarray(0, bytesRead).toString('utf8')
      const lines = text.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        const milestone = dshParseAntigravityStartupMilestone(line)
        if (milestone) onMilestone?.(milestone)
      }
    } catch {
      // Best-effort read-only telemetry: never break an active turn.
    }
  }

  return {
    start() {
      if (stopped || timer !== null) return
      timer = setInterval(poll, pollMs)
      timer.unref?.()
    },
    poll,
    stop() {
      stopped = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
