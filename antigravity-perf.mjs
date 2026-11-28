import dshAgyFs from 'node:fs';
import * as dshAgyFsPromises from 'node:fs/promises';
import dshAgyHttps from 'node:https';
import dshAgyOs from 'node:os';
import dshAgyPath from 'node:path';
import { randomUUID as dshAgyRandomUUID } from 'node:crypto';
import { fileURLToPath as dshAgyFileURLToPath } from 'node:url';

export const DSH_AGY_HISTORY_BUDGET_BYTES = 8 * 1024 * 1024;
export const DSH_AGY_MAX_TRAJECTORY_BYTES = 16 * 1024 * 1024;
export const DSH_AGY_CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS = 516_000;
export const DSH_AGY_AUTO_COMPACT_RATIO = 0.8;
const DSH_AGY_CATALOG_CACHE_VERSION = 3;
const DSH_AGY_TRIMMED_COMMAND_OUTPUT = '[older command output trimmed]';
const DSH_AGY_TRIMMED_TOOL_OUTPUT = '[older tool output trimmed]';
const DSH_AGY_TRIMMED_DIFF = '[older diff trimmed]';
const DSH_AGY_TRIMMED_REASONING = '[older reasoning trimmed]';
const DSH_AGY_TRIMMED_PROMPT = '[older subagent prompt trimmed]';

function dshAgyJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function dshAgySafeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function dshAgyTrimText(text, limit, suffix) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return text.slice(0, limit) + suffix;
}

export function dshAntigravityAutoCompactThreshold(windowTokens = DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS, ratio = DSH_AGY_AUTO_COMPACT_RATIO) {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0 || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return 0;
  return Math.floor(windowTokens * ratio);
}

export function dshShouldAutoCompactAntigravity(usedTokens, windowTokens, lastCompactedAtUsed = 0, ratio = DSH_AGY_AUTO_COMPACT_RATIO) {
  const threshold = dshAntigravityAutoCompactThreshold(windowTokens, ratio);
  if (threshold <= 0 || !Number.isFinite(usedTokens) || usedTokens <= 0) return false;
  return usedTokens >= threshold && usedTokens > (Number.isFinite(lastCompactedAtUsed) ? lastCompactedAtUsed : 0);
}

/** Detect transient upstream transport / 5xx / non-quota 429 failures safe to retry before any side effects. */
export function dshIsTransientAntigravityError(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  if (/User location is not supported|Individual quota reached|quota exhausted|authentication|sign[ -]?in|login|permission denied|invalid[_ ]request|400\b|401\b|403\b/iu.test(message)) return false;
  return /\b(?:429|502|503|504|529)\b|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|econnreset|etimedout|econnrefused|epipe|socket hang up|tls|fetch failed|UNAVAILABLE|DEADLINE_EXCEEDED|unexpected eof|:\s*eof\b/iu.test(message);
}

export const DSH_AGY_PRETURN_RETRY_DELAYS_MS = [30_000, 30_000, 30_000];

/**
 * Parse pre-turn retry backoff delays (ms). Defaults to [30000, 30000, 30000].
 * Set DSH_AGY_PRETURN_RETRY_DELAYS_MS="0" or "off" to disable retries.
 */
export function dshAntigravityPreTurnRetryDelays(environment = process.env) {
  const raw = environment?.DSH_AGY_PRETURN_RETRY_DELAYS_MS;
  if (typeof raw !== 'string' || !raw.trim()) return DSH_AGY_PRETURN_RETRY_DELAYS_MS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '0' || trimmed === 'off' || trimmed === 'false' || trimmed === 'none') return [];
  const parsed = trimmed
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((ms) => Number.isFinite(ms) && ms >= 0 && ms <= 60_000);
  return parsed.length > 0 ? parsed : DSH_AGY_PRETURN_RETRY_DELAYS_MS;
}

/**
 * Narrow classifier for zero-side-effect pre-turn Antigravity failures (such as
 * proxy EOF during OAuth userinfo eligibility check or OAuth token refresh)
 * safe to retry automatically.
 */
export function dshIsPreTurnRetryableAntigravityError(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  // Location 400s are intermittent behind proxies (exit IP briefly lands in an
  // unsupported region); the caller only retries when no side effects exist.
  if (/User location is not supported/iu.test(message)) return true;
  if (/Individual quota reached|quota exhausted|You are not logged into|invalid_grant|authentication failed|unauthorized|forbidden|permission denied|invalid[_ ]request|\b(?:400|401|403)\b/iu.test(message)) {
    return false;
  }
  return /(?:(?:OAuth\s+)?token\s+(?:refresh|validation)\s+failed\s+due\s+to\s+network\s+error)|(?:Eligibility check failed[\s\S]*?(?:unexpected eof|:\s*eof\b|econnreset|etimedout|econnrefused|epipe|socket hang up|connection reset|connection closed|broken pipe|tls|context deadline exceeded))|(?:unexpected eof|:\s*eof\b|econnreset|etimedout|econnrefused|epipe|socket hang up|connection reset|bad record mac|tls:|DEADLINE_EXCEEDED|UNAVAILABLE|\b(?:502|503|504)\b)/iu.test(message);
}

/**
 * Resolve a collision-free nativeTurnKey for an Antigravity result event.
 *
 * - Failed/cancelled turns that never advanced native num_turns (num_turns <= 0
 *   or duplicating an already-recorded nativeTurnKey) return null so the adapter
 *   omits nativeTurnRef; otherwise MappingStore throws MAPPING_CONFLICT and
 *   latches thread.persistenceError, masking the real error and bricking the thread.
 * - Succeeded turns must always receive a unique positive nativeTurnKey.
 */
export function dshResolveAntigravityTurnKey({ numTurns, existingKeys, willSucceed }) {
  const used = existingKeys instanceof Set ? existingKeys : new Set(existingKeys ?? []);
  const hasPositiveTurn = typeof numTurns === 'number' && Number.isSafeInteger(numTurns) && numTurns > 0;
  const candidate = hasPositiveTurn ? `turn:${numTurns}` : null;

  if (!willSucceed) {
    if (candidate && !used.has(candidate)) return candidate;
    return null;
  }

  if (candidate && !used.has(candidate)) return candidate;
  let next = used.size + 1;
  for (const key of used) {
    const match = /^turn:(\d+)$/u.exec(key);
    if (match) {
      const n = Number(match[1]);
      if (Number.isSafeInteger(n) && n >= next) next = n + 1;
    }
  }
  while (used.has(`turn:${next}`)) next += 1;
  return `turn:${next}`;
}

export function dshNormalizeAntigravityModelForPrice(model) {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed || !/\s/u.test(trimmed)) return null;
  const normalized = trimmed.replace(/\s*\((?:low|medium|high|xhigh|max)\)$/iu, '').trim().toLowerCase().replace(/\s+/gu, '-');
  return normalized && normalized !== trimmed ? normalized : null;
}

/**
 * Parse Antigravity's native transcript.jsonl PLANNER_RESPONSE lines into Host
 * UsageMeter request records (deduplicated per step_index, inputTokens inclusive
 * of cacheRead + cacheWrite, cacheWriteInputTokens explicit so publicPrice works).
 */
export function dshAntigravityTranscriptUsageRequests(text, conversationId, fallbackModelId) {
  if (typeof text !== 'string' || !text || !conversationId) return [];
  const byStep = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes('"input_tokens"') || !line.includes('PLANNER_RESPONSE')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || record.type !== 'PLANNER_RESPONSE') continue;
    const stepIndex = dshAgySafeCount(record.step_index);
    const uncached = dshAgySafeCount(record.input_tokens);
    const outputTokens = dshAgySafeCount(record.output_tokens);
    if (stepIndex === undefined || uncached === undefined || outputTokens === undefined) continue;
    const cachedInputTokens = dshAgySafeCount(record.cache_read_tokens) ?? 0;
    const cacheWriteInputTokens = dshAgySafeCount(record.cache_write_tokens ?? record.cache_creation_input_tokens) ?? 0;
    const inputTokens = uncached + cachedInputTokens + cacheWriteInputTokens;
    if (!Number.isSafeInteger(inputTokens)) continue;
    const rawModel = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : (typeof fallbackModelId === 'string' && fallbackModelId.trim() ? fallbackModelId.trim() : undefined);
    const model = rawModel ? (dshNormalizeAntigravityModelForPrice(rawModel) ?? rawModel) : undefined;
    const provider = model && /^claude(?:[-_.]|$)/iu.test(model) ? 'anthropic' : 'google';
    const thinking = dshAgySafeCount(record.thinking_tokens);
    const request = {
      requestId: `agy:${conversationId}:${stepIndex}`,
      ...(model ? { model, provider } : {}),
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      ...(thinking !== undefined && thinking <= outputTokens ? { reasoningOutputTokens: thinking } : {}),
    };
    byStep.set(stepIndex, { stepIndex, request });
  }
  return [...byStep.values()].sort((a, b) => a.stepIndex - b.stepIndex);
}

export async function dshReadAntigravityTranscriptUsageRequests(environment, conversationId, fallbackModelId, { homedir } = {}) {
  if (!conversationId || typeof conversationId !== 'string') return { ok: false, entries: [] };
  const home = homedir ?? ((process.platform === 'win32' ? environment?.USERPROFILE : environment?.HOME) || dshAgyOs.homedir());
  const file = dshAgyPath.join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    const text = await dshAgyFsPromises.readFile(file, 'utf8');
    return { ok: true, entries: dshAntigravityTranscriptUsageRequests(text, conversationId, fallbackModelId) };
  } catch {
    return { ok: false, entries: [] };
  }
}

function dshAgyCompactItemPayload(snapshot) {
  const item = snapshot?.item;
  if (!item || typeof item !== 'object') return snapshot;
  let nextItem = item;
  if (item.type === 'commandExecution') {
    if (typeof item.output === 'string' && item.output.length > 512) {
      nextItem = { ...item, output: DSH_AGY_TRIMMED_COMMAND_OUTPUT, outputTruncated: true };
    }
  } else if (item.type === 'toolExecution') {
    let changed = false;
    const copy = { ...item };
    if (item.output !== undefined && dshAgyJsonBytes(item.output) > 512) {
      copy.output = { content: [{ type: 'text', text: DSH_AGY_TRIMMED_TOOL_OUTPUT }], truncated: true };
      changed = true;
    }
    if (item.arguments !== null && item.arguments !== undefined && dshAgyJsonBytes(item.arguments) > 512) {
      copy.arguments = { _trimmed: true };
      changed = true;
    }
    if (changed) nextItem = copy;
  } else if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    let changed = false;
    const changes = item.changes.map((change) => {
      if (typeof change?.unifiedDiff === 'string' && change.unifiedDiff.length > 1024) {
        changed = true;
        return { ...change, unifiedDiff: DSH_AGY_TRIMMED_DIFF };
      }
      return change;
    });
    if (changed) nextItem = { ...item, changes };
  } else if (item.type === 'reasoning') {
    if (typeof item.text === 'string' && item.text.length > 512) {
      nextItem = { ...item, text: DSH_AGY_TRIMMED_REASONING };
    }
  } else if (item.type === 'subagentDelegation') {
    // Keep subagents[] intact: historySubagentState() depends on every nativeSubagentId.
    if (typeof item.prompt === 'string' && item.prompt.length > 512) {
      nextItem = { ...item, prompt: DSH_AGY_TRIMMED_PROMPT };
    }
  }
  return nextItem === item ? snapshot : { ...snapshot, item: nextItem };
}

function dshAgyCompactTurnHeavyPayloads(turn) {
  if (!Array.isArray(turn?.items) || turn.items.length === 0) return turn;
  let changed = false;
  const items = turn.items.map((snapshot) => {
    const compacted = dshAgyCompactItemPayload(snapshot);
    if (compacted !== snapshot) changed = true;
    return compacted;
  });
  return changed ? { ...turn, items } : turn;
}

function dshAgyCompactTurnMessages(turn) {
  let changed = false;
  let input = turn.input;
  if (Array.isArray(turn.input)) {
    const nextInput = turn.input.map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > 2048) {
        changed = true;
        return { ...part, text: dshAgyTrimText(part.text, 2048, '\n…[older message trimmed]') };
      }
      return part;
    });
    if (changed) input = nextInput;
  }
  let items = turn.items;
  let itemsChanged = false;
  if (Array.isArray(turn.items)) {
    const nextItems = turn.items.map((snapshot) => {
      const item = snapshot?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 2048) {
        itemsChanged = true;
        return { ...snapshot, item: { ...item, text: dshAgyTrimText(item.text, 2048, '\n…[older message trimmed]') } };
      }
      return snapshot;
    });
    if (itemsChanged) items = nextItems;
  }
  return changed || itemsChanged ? { ...turn, input, items } : turn;
}

/**
 * Bound AntigravityHistory file growth without ever changing `turns.length` or
 * dropping `nativeTurnRef` / `checkpoint` / `subagentDelegation.subagents`.
 * Fork and rollback index SQLite steps using `turns.length` and checkpoints.
 */
export function dshCompactAntigravityTurns(turns, maxBytes = DSH_AGY_HISTORY_BUDGET_BYTES) {
  if (!Array.isArray(turns) || turns.length <= 1) return turns;
  const sizes = turns.map(dshAgyJsonBytes);
  let total = 0;
  for (const s of sizes) total += s;
  if (total <= maxBytes) return turns;

  // Always keep the newest Turn intact; find how many recent Turns fit in the budget.
  let keptBytes = sizes[turns.length - 1];
  let keepFrom = turns.length - 1;
  while (keepFrom > 0 && keptBytes + sizes[keepFrom - 1] <= maxBytes) {
    keepFrom -= 1;
    keptBytes += sizes[keepFrom];
  }

  let result = turns.slice();
  let compactedTotal = total;
  for (let i = 0; i < keepFrom; i++) {
    const compacted = dshAgyCompactTurnHeavyPayloads(result[i]);
    if (compacted !== result[i]) {
      const nextSize = dshAgyJsonBytes(compacted);
      compactedTotal += nextSize - sizes[i];
      sizes[i] = nextSize;
      result[i] = compacted;
    }
  }
  if (compactedTotal <= maxBytes) return result;

  // Second pass only if hundreds of older Turns still exceed the budget via large messages.
  for (let i = 0; i < keepFrom && compactedTotal > maxBytes; i++) {
    const compacted = dshAgyCompactTurnMessages(result[i]);
    if (compacted !== result[i]) {
      const nextSize = dshAgyJsonBytes(compacted);
      compactedTotal += nextSize - sizes[i];
      sizes[i] = nextSize;
      result[i] = compacted;
    }
  }
  return result;
}

export function dshAntigravityCatalogCachePath(environment) {
  const dataDirectory = environment?.CODEXHOST_DATA_DIR;
  const root = dataDirectory ? dshAgyPath.resolve(dataDirectory) : dshAgyPath.join(dshAgyOs.homedir(), '.codexhost');
  return dshAgyPath.join(root, 'antigravity-catalog-cache.json');
}

function dshAgySameExecutable(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function dshReadAntigravityCatalogCache(environment, executable, catalogSchema, { now = Date.now(), ttlMs = DSH_AGY_CATALOG_CACHE_TTL_MS, platform = process.platform } = {}) {
  try {
    const stat = dshAgyFs.statSync(executable);
    if (!stat.isFile()) return null;
    const raw = JSON.parse(dshAgyFs.readFileSync(dshAntigravityCatalogCachePath(environment), 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.version !== DSH_AGY_CATALOG_CACHE_VERSION) return null;
    if (!dshAgySameExecutable(raw.executable, executable, platform)) return null;
    if (raw.size !== stat.size || Math.floor(Number(raw.mtimeMs)) !== Math.floor(stat.mtimeMs)) return null;
    if (typeof raw.cachedAt !== 'number' || !Number.isFinite(raw.cachedAt)) return null;
    const age = now - raw.cachedAt;
    if (age < 0 || age > ttlMs) return null;
    const parsed = catalogSchema.safeParse(raw.catalog);
    if (!parsed.success) return null;
    return { catalog: parsed.data, cachedAt: raw.cachedAt };
  } catch {
    return null;
  }
}

export async function dshWriteAntigravityCatalogCache(environment, executable, catalog, { now = Date.now() } = {}) {
  try {
    const stat = await dshAgyFsPromises.stat(executable);
    if (!stat.isFile()) return false;
    const file = dshAntigravityCatalogCachePath(environment);
    const directory = dshAgyPath.dirname(file);
    await dshAgyFsPromises.mkdir(directory, { recursive: true, mode: 448 });
    const temporary = dshAgyPath.join(directory, `.${dshAgyPath.basename(file)}.${dshAgyRandomUUID()}.tmp`);
    try {
      await dshAgyFsPromises.writeFile(temporary, `${JSON.stringify({
        version: DSH_AGY_CATALOG_CACHE_VERSION,
        executable,
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        cachedAt: now,
        catalog,
      })}\n`, { mode: 384 });
      await dshAgyFsPromises.rename(temporary, file);
      return true;
    } finally {
      await dshAgyFsPromises.rm(temporary, { force: true }).catch(() => void 0);
    }
  } catch {
    return false;
  }
}

/**
 * Bounded HTTPS fetch for GetCascadeTrajectorySteps. Uses Buffer chunking with
 * a hard byte cap so long sessions degrade cleanly instead of blocking or OOMing.
 */
export function dshRequestAntigravityTrajectorySteps(port, conversationId, timeoutMs, parseActions, { httpsModule = dshAgyHttps, maxBytes = DSH_AGY_MAX_TRAJECTORY_BYTES } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let oversized = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const request = httpsModule.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > maxBytes) {
          oversized = true;
          request.destroy();
          finish({ ok: false, reason: 'oversize', actions: [] });
          return;
        }
        chunks.push(buf);
      });
      response.on('error', () => {
        finish({ ok: false, reason: oversized ? 'oversize' : timedOut ? 'timeout' : 'error', actions: [] });
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode !== 200) {
          finish({ ok: false, reason: 'http', actions: [] });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
          finish({ ok: true, actions: parseActions(parsed) });
        } catch {
          finish({ ok: false, reason: 'parse', actions: [] });
        }
      });
    });
    request.on('timeout', () => {
      timedOut = true;
      request.destroy();
      finish({ ok: false, reason: 'timeout', actions: [] });
    });
    request.on('error', () => {
      finish({ ok: false, reason: oversized ? 'oversize' : timedOut ? 'timeout' : 'error', actions: [] });
    });
    request.end(JSON.stringify({ cascadeId: conversationId }));
  });
}

function dshAgyHomeDir(environment) {
  return (process.platform === 'win32' ? environment?.USERPROFILE : environment?.HOME) || dshAgyOs.homedir();
}

function dshAgyCleanImportText(value, maxLen = 4000) {
  if (typeof value !== 'string') return null;
  let text = value;
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/iu);
  if (reqMatch) text = reqMatch[1];
  // Strip CodexHost injected system instructions if a preview came from a headless turn.
  text = text.replace(/^(?:\[System Instruction:[\s\S]*?\]\s*)+/gu, '');
  if (/^\[System Instruction:/iu.test(text.trimStart())) return null;
  text = text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return text.length > maxLen ? text.slice(0, maxLen).trimEnd() : text;
}

function dshAgyWorkspaceCwd(workspaceUrisRaw) {
  if (typeof workspaceUrisRaw !== 'string' || !workspaceUrisRaw.trim()) return null;
  let uris;
  try {
    uris = JSON.parse(workspaceUrisRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  for (const uri of uris) {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) continue;
    if (/[/\\]antigravity-history[/\\]hooks[/\\]/iu.test(uri) || /[/\\]mcp-probe[/\\]hook-dir/iu.test(uri)) continue;
    try {
      const candidate = dshAgyFileURLToPath(uri);
      if (!candidate || candidate.includes('\0') || !dshAgyPath.isAbsolute(candidate)) continue;
      const st = dshAgyFs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function dshAgyRowToImportCandidate(row, agyRoot) {
  const id = typeof row?.conversation_id === 'string' ? row.conversation_id.trim() : '';
  if (!id || id.includes('\0') || id.length > 1024) return null;
  if (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.trim()) return null;
  if (row.killed) return null;
  if (typeof row.step_count === 'number' && row.step_count <= 0) return null;
  const dbExists = dshAgyFs.existsSync(dshAgyPath.join(agyRoot, 'conversations', `${id}.db`));
  const transcriptExists = dshAgyFs.existsSync(dshAgyPath.join(agyRoot, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'));
  if (!dbExists && !transcriptExists) return null;
  const cwd = dshAgyWorkspaceCwd(row.workspace_uris);
  if (!cwd || cwd.length > 16384) return null;
  const title = dshAgyCleanImportText(row.title, 4096) ?? dshAgyCleanImportText(row.preview, 4096);
  const parsedTime = typeof row.last_modified_time === 'string' ? Date.parse(row.last_modified_time) : Number.NaN;
  const updatedAt = Number.isFinite(parsedTime) && parsedTime >= 0 ? Math.min(Math.floor(parsedTime), 864e13) : 0;
  return {
    nativeSessionId: id,
    title,
    updatedAt,
    cwd,
    running: row.status === 'CASCADE_RUN_STATUS_RUNNING' ? true : null,
  };
}

export async function dshListAntigravityImportCandidates(environment = process.env, { rootDir } = {}) {
  const agyRoot = rootDir ?? dshAgyPath.join(dshAgyHomeDir(environment), '.gemini', 'antigravity-cli');
  const dbPath = dshAgyPath.join(agyRoot, 'conversation_summaries.db');
  if (!dshAgyFs.existsSync(dbPath)) return { ok: true, value: [] };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, killed
         FROM conversation_summaries
         WHERE COALESCE(parent_conversation_id, '') = '' AND COALESCE(killed, 0) = 0 AND COALESCE(step_count, 0) > 0
         ORDER BY last_modified_time DESC`,
      ).all();
      const candidates = [];
      const seen = new Set();
      for (const row of rows) {
        const candidate = dshAgyRowToImportCandidate(row, agyRoot);
        if (!candidate || seen.has(candidate.nativeSessionId)) continue;
        seen.add(candidate.nativeSessionId);
        candidates.push(candidate);
      }
      return { ok: true, value: candidates };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'nativeFailure',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

export async function dshResolveAntigravityImportCandidate(environment = process.env, nativeSessionId, { rootDir } = {}) {
  const id = typeof nativeSessionId === 'string' ? nativeSessionId.trim() : '';
  if (!id || id.includes('\0')) {
    return { ok: false, error: { code: 'sessionNotFound', message: 'Antigravity Session was not found', retryable: false } };
  }
  const agyRoot = rootDir ?? dshAgyPath.join(dshAgyHomeDir(environment), '.gemini', 'antigravity-cli');
  const dbPath = dshAgyPath.join(agyRoot, 'conversation_summaries.db');
  if (!dshAgyFs.existsSync(dbPath)) {
    return { ok: false, error: { code: 'sessionNotFound', message: 'Antigravity Session was not found', retryable: false } };
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, parent_conversation_id, killed
         FROM conversation_summaries WHERE conversation_id = ? LIMIT 1`,
      ).get(id);
      const candidate = row ? dshAgyRowToImportCandidate(row, agyRoot) : null;
      if (!candidate) {
        return { ok: false, error: { code: 'sessionNotFound', message: 'Antigravity Session was not found', retryable: false } };
      }
      return {
        ok: true,
        value: {
          candidate,
          nativeRef: { harnessId: 'antigravity', nativeSessionId: candidate.nativeSessionId, formatVersion: 1 },
        },
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'nativeFailure',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function dshAgyParseTranscriptModel(rawModel) {
  if (typeof rawModel !== 'string' || !rawModel.trim()) return {};
  const trimmed = rawModel.trim();
  const effortMatch = trimmed.match(/^(.*)-(low|medium|high|xhigh|max)$/iu);
  if (effortMatch && effortMatch[1]) {
    return { model: { id: effortMatch[1] }, thinkingOptionId: effortMatch[2].toLowerCase() };
  }
  const normalized = dshNormalizeAntigravityModelForPrice(trimmed) ?? trimmed;
  return { model: { id: normalized } };
}

function dshAgyExtractUserPrompt(content) {
  if (typeof content !== 'string') return '';
  let text = content;
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/iu);
  if (reqMatch) text = reqMatch[1];
  text = text.replace(/^(?:\[System Instruction:[\s\S]*?\]\s*)+/gu, '').trim();
  return text;
}

function dshAgyUnquoteArg(value) {
  if (typeof value !== 'string') return value;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function dshAgyCleanToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return {};
  const cleaned = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    cleaned[k] = typeof v === 'string' ? dshAgyUnquoteArg(v) : v;
  }
  return cleaned;
}

/**
 * Reconstruct CodexHost-compatible Antigravity history turns from native
 * ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
 * when importing a native AGY CLI session that has no antigravity-history file yet.
 */
export async function dshReadAntigravityTranscriptTurns(environment = process.env, nativeSessionId, { rootDir, maxBytes = DSH_AGY_HISTORY_BUDGET_BYTES } = {}) {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) return { turns: [] };
  const agyRoot = rootDir ?? dshAgyPath.join(dshAgyHomeDir(environment), '.gemini', 'antigravity-cli');
  const file = dshAgyPath.join(agyRoot, 'brain', nativeSessionId, '.system_generated', 'logs', 'transcript.jsonl');
  let raw;
  try {
    raw = await dshAgyFsPromises.readFile(file, 'utf8');
  } catch {
    return { turns: [] };
  }
  const records = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      continue;
    }
  }
  if (records.length === 0) return { turns: [] };

  const prefix = nativeSessionId.replace(/[^A-Za-z0-9]/gu, '').slice(0, 12) || 'agy';
  const turns = [];
  let current = null;
  let pendingTools = [];
  let lastModelInfo = {};

  const finalizeTurn = () => {
    if (!current) return;
    pendingTools = [];
    const turnNumber = turns.length + 1;
    const key = `turn:${turnNumber}`;
    turns.push({
      nativeTurnRef: { harnessId: 'antigravity', nativeSessionId, nativeTurnKey: key, formatVersion: 1 },
      checkpoint: { harnessId: 'antigravity', nativeSessionId, checkpointId: key, formatVersion: 1 },
      input: current.input,
      items: current.items,
      outcome: current.failedError
        ? { status: 'failed', error: { code: 'nativeFailure', message: current.failedError, retryable: false } }
        : { status: 'succeeded' },
      ...(current.model ? { model: current.model } : {}),
    });
    current = null;
  };

  for (const rec of records) {
    const stepIdx = typeof rec.step_index === 'number' ? rec.step_index : records.indexOf(rec);
    if (rec.type === 'USER_INPUT') {
      finalizeTurn();
      const prompt = dshAgyExtractUserPrompt(rec.content);
      current = {
        input: prompt ? [{ type: 'text', text: prompt }] : [],
        items: [],
        model: undefined,
        failedError: null,
      };
      continue;
    }
    if (!current) continue;
    if (rec.type === 'PLANNER_RESPONSE') {
      current.failedError = null;
      const modelInfo = dshAgyParseTranscriptModel(rec.model);
      if (modelInfo.model) {
        current.model = modelInfo.model;
        lastModelInfo = modelInfo;
      }
      if (typeof rec.thinking === 'string' && rec.thinking.trim()) {
        current.items.push({
          item: { type: 'reasoning', itemId: `agy-${prefix}-${stepIdx}-r`, text: rec.thinking },
          outcome: { status: 'succeeded' },
        });
      }
      if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
        for (let i = 0; i < rec.tool_calls.length; i++) {
          const call = rec.tool_calls[i];
          const toolName = typeof call?.name === 'string' && call.name.trim() ? call.name.trim() : 'antigravity.tool';
          const args = dshAgyCleanToolArgs(call?.args);
          const itemId = `agy-${prefix}-${stepIdx}-t${i}`;
          const isCmd = /^(?:run_command|bash|exec|terminal|shell|powershell|command)$/iu.test(toolName) && typeof args.CommandLine === 'string';
          const entry = isCmd
            ? { item: { type: 'commandExecution', itemId, command: args.CommandLine }, outcome: { status: 'succeeded' } }
            : { item: { type: 'toolExecution', itemId, toolName, arguments: args }, outcome: { status: 'succeeded' } };
          current.items.push(entry);
          pendingTools.push(entry);
        }
      }
      if (typeof rec.content === 'string' && rec.content.trim()) {
        current.items.push({
          item: { type: 'agentMessage', itemId: `agy-${prefix}-${stepIdx}-m`, text: rec.content },
          outcome: { status: 'succeeded' },
        });
      }
      continue;
    }
    if (rec.type === 'GENERIC' && pendingTools.length > 0) {
      const target = pendingTools.shift();
      const outputText = typeof rec.content === 'string' ? rec.content : (typeof rec.error === 'string' ? rec.error : '');
      const trimmedOutput = outputText.length > 16_000 ? outputText.slice(0, 16_000) : outputText;
      if (target.item.type === 'commandExecution') {
        if (trimmedOutput) {
          target.item.output = trimmedOutput;
          if (outputText.length > 16_000) target.item.outputTruncated = true;
        }
      } else if (trimmedOutput) {
        target.item.output = {
          content: [{ type: 'text', text: trimmedOutput }],
          ...(outputText.length > 16_000 ? { truncated: true } : {}),
        };
      }
      if (rec.status === 'ERROR') {
        target.outcome = {
          status: 'failed',
          error: {
            code: 'nativeFailure',
            message: typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim() : 'Antigravity tool failed',
            retryable: false,
          },
        };
      }
      continue;
    }
    if (rec.type === 'ERROR_MESSAGE') {
      const msg = typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim() : (typeof rec.content === 'string' ? rec.content.trim() : '');
      if (msg) current.failedError = msg;
    }
  }
  finalizeTurn();

  const compacted = dshCompactAntigravityTurns(turns, { maxBytes });
  return {
    turns: compacted,
    ...(lastModelInfo.model ? { model: lastModelInfo.model } : {}),
    ...(lastModelInfo.thinkingOptionId ? { thinkingOptionId: lastModelInfo.thinkingOptionId } : {}),
  };
}
