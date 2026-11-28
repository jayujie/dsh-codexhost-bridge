import { readFile, readdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { hostDataDirectory, legacyHostDataDirectory } from './backend-paths.mjs'

const MAX_SUMMARY_CHARS = 24_000

function homeDir(env = process.env) {
  return (process.platform === 'win32' ? env?.USERPROFILE : env?.HOME) || homedir()
}

function clipSummary(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return undefined
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed
  return trimmed.slice(0, MAX_SUMMARY_CHARS).trimEnd() + '\n\n…（摘要已截断）'
}

/**
 * Clean Antigravity CHECKPOINT content into a readable Markdown summary:
 * keeps the structured <summary> sections while stripping internal agent resume boilerplate.
 */
export function cleanAntigravityCompactionSummary(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return undefined
  let text = rawContent
  const tagged = /<summary>([\s\S]*?)<\/summary>/iu.exec(text)
  if (tagged) {
    text = tagged[1]
  } else {
    const prevIdx = text.search(/^#\s*Previous Session Summary\b/imu)
    if (prevIdx !== -1) text = text.slice(prevIdx).replace(/^#\s*Previous Session Summary\s*:?\s*/iu, '')
  }
  text = text.replace(/^\s*RESUMING MY OWN TASK IN PROGRESS[^\n]*(?:\r?\n)*/iu, '')
  text = text.replace(/\r?\n+RESUME RULES\s*\([^)]*\)\s*:[\s\S]*$/iu, '')
  text = text.replace(/\r?\n+RESUME RULES\s*:[\s\S]*$/iu, '')
  return clipSummary(text)
}

/**
 * Clean Claude Code isCompactSummary user message content into readable Markdown:
 * strips continuation preamble, <system-reminder> tags, and trailing resume instructions.
 */
export function cleanClaudeCompactionSummary(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return undefined
  let text = rawContent
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
  text = text.replace(/^\s*This session is being continued from a previous conversation[^\n]*(?:\r?\n)*/iu, '')
  text = text.replace(/\r?\n+If you need specific details from before compaction[\s\S]*$/iu, '')
  text = text.replace(/\r?\n+Please continue the conversation from where we left off[\s\S]*$/iu, '')
  text = text.replace(/^\s*Summary:\s*\r?\n/iu, '')
  return clipSummary(text)
}

async function readHeadUtf8(filePath, maxBytes = 4096) {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Resolve the native engine session ID for a Host thread ID (read-only). */
export async function resolveNativeSessionId({ harnessId, threadId, config = {}, env = process.env } = {}) {
  if (typeof threadId !== 'string' || !threadId.trim()) return undefined
  if (harnessId === 'codex') return threadId.trim()
  const safeId = threadId.trim()
  const candidates = [
    path.join(legacyHostDataDirectory(config, env), 'mapping-store', 'threads', `${safeId}.json`),
    path.join(hostDataDirectory(config, env), 'mapping-store', 'threads', `${safeId}.json`),
  ]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      const nativeId = parsed?.nativeSessionRef?.nativeSessionId
      if (typeof nativeId === 'string' && nativeId.trim()) return nativeId.trim()
    } catch {}
  }
  if (harnessId === 'antigravity') {
    const historyFile = path.join(hostDataDirectory(config, env), 'antigravity-history', `${safeId}.json`)
    const head = await readHeadUtf8(historyFile, 1024)
    const match = head && /"nativeSessionId"\s*:\s*"([^"]+)"/u.exec(head)
    if (match?.[1]) return match[1]
  }
  return undefined
}

async function readAntigravityCheckpoint({ nativeSessionId, env = process.env, agyRoot } = {}) {
  if (!nativeSessionId) return null
  const root = agyRoot ?? path.join(homeDir(env), '.gemini', 'antigravity-cli')
  const logsDir = path.join(root, 'brain', nativeSessionId, '.system_generated', 'logs')
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    let raw
    try { raw = await readFile(path.join(logsDir, name), 'utf8') } catch { continue }
    const lines = raw.split(/\r?\n/u)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes('"CHECKPOINT"')) continue
      try {
        const rec = JSON.parse(line)
        if (rec?.type !== 'CHECKPOINT') continue
        const summary = cleanAntigravityCompactionSummary(rec.content)
        const inTok = Number.isSafeInteger(rec.input_tokens) && rec.input_tokens >= 0 ? rec.input_tokens : 0
        const crTok = Number.isSafeInteger(rec.cache_read_tokens) && rec.cache_read_tokens >= 0 ? rec.cache_read_tokens : 0
        const beforeTokens = inTok + crTok > 0 ? inTok + crTok : undefined
        let afterTokens
        let latestContextUsed
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]
          if (!nextLine || !nextLine.includes('"PLANNER_RESPONSE"')) continue
          try {
            const nextRec = JSON.parse(nextLine)
            if (nextRec?.type !== 'PLANNER_RESPONSE') continue
            const nIn = Number.isSafeInteger(nextRec.input_tokens) && nextRec.input_tokens >= 0 ? nextRec.input_tokens : 0
            const nCr = Number.isSafeInteger(nextRec.cache_read_tokens) && nextRec.cache_read_tokens >= 0 ? nextRec.cache_read_tokens : 0
            const total = nIn + nCr
            if (total > 0) {
              if (afterTokens === undefined) afterTokens = total
              latestContextUsed = total
            }
          } catch {}
        }
        if (summary || beforeTokens !== undefined || afterTokens !== undefined) {
          return {
            ...(summary ? { summary } : {}),
            ...(beforeTokens === undefined ? {} : { beforeTokens }),
            ...(afterTokens === undefined ? {} : { afterTokens }),
            ...(latestContextUsed === undefined ? {} : { latestContextUsed }),
          }
        }
      } catch {}
    }
  }
  return null
}

async function findClaudeTranscript(nativeSessionId, projectsRoot) {
  let entries
  try { entries = await readdir(projectsRoot, { withFileTypes: true }) } catch { return null }
  const target = `${nativeSessionId}.jsonl`
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(projectsRoot, entry.name, target)
    try {
      const head = await readHeadUtf8(candidate, 16)
      if (head !== null) return candidate
    } catch {}
  }
  return null
}

async function readClaudeCompaction({ nativeSessionId, env = process.env, claudeRoot } = {}) {
  if (!nativeSessionId) return null
  const projectsRoot = claudeRoot ?? path.join(homeDir(env), '.claude', 'projects')
  const file = await findClaudeTranscript(nativeSessionId, projectsRoot)
  if (!file) return null
  let raw
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const lines = raw.split(/\r?\n/u)
  let summary
  let beforeTokens
  let afterTokens
  let boundaryIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    if (!summary && line.includes('"isCompactSummary"')) {
      try {
        const rec = JSON.parse(line)
        if (rec?.isCompactSummary === true) {
          const content = rec.message?.content
          const rawText = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
              : ''
          summary = cleanClaudeCompactionSummary(rawText)
        }
      } catch {}
    }
    if (boundaryIdx === -1 && line.includes('"compact_boundary"')) {
      try {
        const rec = JSON.parse(line)
        if (rec?.type === 'system' && rec?.subtype === 'compact_boundary') {
          boundaryIdx = i
          const meta = rec.compactMetadata
          if (Number.isSafeInteger(meta?.preTokens) && meta.preTokens > 0) beforeTokens = meta.preTokens
          if (Number.isSafeInteger(meta?.postTokens) && meta.postTokens > 0) afterTokens = meta.postTokens
        }
      } catch {}
    }
    if (summary && boundaryIdx !== -1) break
  }
  let latestContextUsed
  if (boundaryIdx !== -1) {
    for (let j = boundaryIdx + 1; j < lines.length; j++) {
      const nextLine = lines[j]
      if (!nextLine || !nextLine.includes('"usage"')) continue
      try {
        const rec = JSON.parse(nextLine)
        const u = rec?.message?.usage
        if (!u || typeof u !== 'object') continue
        const total = (Number.isSafeInteger(u.input_tokens) ? u.input_tokens : 0)
          + (Number.isSafeInteger(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0)
          + (Number.isSafeInteger(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0)
        if (total > 0) {
          if (afterTokens === undefined) afterTokens = total
          latestContextUsed = total
        }
      } catch {}
    }
  }
  if (!summary && beforeTokens === undefined && afterTokens === undefined) return null
  return {
    ...(summary ? { summary } : {}),
    ...(beforeTokens === undefined ? {} : { beforeTokens }),
    ...(afterTokens === undefined ? {} : { afterTokens }),
    ...(latestContextUsed === undefined ? {} : { latestContextUsed }),
  }
}

async function findCodexRollout(nativeSessionId, sessionsRoot, depth = 0) {
  if (depth > 4) return null
  let entries
  try { entries = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return null }
  const suffix = `-${nativeSessionId}.jsonl`
  for (const entry of entries) {
    const full = path.join(sessionsRoot, entry.name)
    if (entry.isFile() && (entry.name.endsWith(suffix) || entry.name === `${nativeSessionId}.jsonl`)) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findCodexRollout(nativeSessionId, path.join(sessionsRoot, entry.name), depth + 1)
    if (found) return found
  }
  return null
}

async function readCodexCompaction({ nativeSessionId, env = process.env, codexRoot } = {}) {
  if (!nativeSessionId) return null
  const sessionsRoot = codexRoot ?? path.join(env?.CODEX_HOME || path.join(homeDir(env), '.codex'), 'sessions')
  const file = await findCodexRollout(nativeSessionId, sessionsRoot)
  if (!file) return null
  let raw
  try { raw = await readFile(file, 'utf8') } catch { return null }
  const lines = raw.split(/\r?\n/u)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('compact')) continue
    try {
      const rec = JSON.parse(line)
      const payload = rec?.payload ?? rec
      if (rec?.type === 'compacted' || payload?.type === 'compacted' || payload?.type === 'context_compacted') {
        const text = typeof payload?.message === 'string' ? payload.message
          : typeof payload?.summary === 'string' ? payload.summary : ''
        const summary = clipSummary(text)
        if (summary) return { summary }
      }
    } catch {}
  }
  return null
}

/**
 * Read the latest native compaction summary and token counts for an external engine
 * from its local transcript file (read-only; never throws).
 */
export async function readNativeCompactionSummary({ harnessId, threadId, nativeSessionId, config = {}, env = process.env, agyRoot, claudeRoot, codexRoot } = {}) {
  try {
    const resolvedId = nativeSessionId || await resolveNativeSessionId({ harnessId, threadId, config, env })
    if (!resolvedId) return null
    if (harnessId === 'antigravity') return await readAntigravityCheckpoint({ nativeSessionId: resolvedId, env, agyRoot })
    if (harnessId === 'claude-code') return await readClaudeCompaction({ nativeSessionId: resolvedId, env, claudeRoot })
    if (harnessId === 'codex') return await readCodexCompaction({ nativeSessionId: resolvedId, env, codexRoot })
    return null
  } catch {
    return null
  }
}
