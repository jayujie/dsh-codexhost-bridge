import dshAgyVisFs from 'node:fs';
import * as dshAgyVisFsPromises from 'node:fs/promises';
import dshAgyVisOs from 'node:os';
import dshAgyVisPath from 'node:path';

const DSH_AGY_VIS_MAX_READ_BYTES = 2 * 1024 * 1024;
const DSH_AGY_VIS_MAX_THINKING_CHARS = 32_768;
const DSH_AGY_VIS_MAX_SYSTEM_CHARS = 600;
const DSH_AGY_VIS_POLL_MS = 400;

export function dshAntigravityTranscriptPath(environment, conversationId, { homedir } = {}) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  const home = homedir ?? ((process.platform === 'win32' ? environment?.USERPROFILE : environment?.HOME) || dshAgyVisOs.homedir());
  return dshAgyVisPath.join(home, '.gemini', 'antigravity-cli', 'brain', conversationId.trim(), '.system_generated', 'logs', 'transcript.jsonl');
}

function dshAgyVisClip(text, maxChars) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Detect agy startup log lines showing that silent OAuth token refresh failed
 * purely due to a transient network/proxy error (not revoked/invalid credentials).
 */
export function dshParseAntigravityAuthRefreshNetworkError(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  const match = line.match(/token\s+(?:refresh|validation)\s+failed\s+due\s+to\s+network\s+error(?:\s*\([^)]*\))?:\s*(.+)$/iu);
  if (!match) return null;
  const reason = match[1].trim();
  if (!reason) return null;
  if (/invalid_grant|unauthorized|forbidden|permission denied|revoked|\b(?:400|401|403)\b/iu.test(reason)) return null;
  return dshAgyVisClip(reason, 240);
}

/** Detect agy print-mode falling back to interactive browser OAuth (which hangs 60s headless). */
export function dshIsAntigravityInteractiveOAuthTrigger(line) {
  if (typeof line !== 'string' || !line.trim()) return false;
  return /Print mode:\s*triggering interactive OAuth|Starting OAuth authentication flow|consumerOAuth:\s*starting OAuth flow/iu.test(line);
}

/**
 * Parse meaningful runtime status lines from agy's --log-file.
 * Startup noise before silent OAuth/send-message (e.g. "You are not logged into Antigravity")
 * is intentionally ignored by the caller via `postStartup`.
 */
export function dshParseAntigravityLogLine(line, { postStartup = false, hadRetry = false } = {}) {
  if (typeof line !== 'string' || !line.trim()) return null;

  if (/Sending user message to conversation|Print mode:\s+conversation=|streamGenerateContent\?alt=sse/iu.test(line)) {
    if (/streamGenerateContent\?alt=sse/iu.test(line) && hadRetry) {
      return { kind: 'request-retry', markPostStartup: true, text: '[AGY 状态] 正在重新发起模型请求…' };
    }
    return { kind: 'started', markPostStartup: true };
  }

  const retryMatch = line.match(/Run:\s+attempt\s+(\d+)\s+failed\s+\((.+)\),\s+retrying\s+in\s+(\S+)/iu);
  if (retryMatch) {
    const attempt = Number(retryMatch[1]);
    const reason = retryMatch[2].trim();
    const delay = retryMatch[3].trim();
    return {
      kind: 'retry',
      markPostStartup: true,
      attempt,
      error: reason,
      delay,
      dedupeKey: `attempt:${attempt}:${reason.toLowerCase()}`,
      text: `[AGY 重试] 第 ${attempt} 次请求失败（${dshAgyVisClip(reason, 240)}），${delay} 后自动重试…`,
    };
  }

  if (!postStartup) return null;

  // Post-startup fatal/error lines, excluding benign telemetry/experiment refresh warnings.
  if (/^[EF]\d{4}\s/u.test(line)) {
    if (/ListExperiments|peopleInfo|loadCodeAssistResponse|admin controls not applicable|Failed to resolve GeminiDir|Not reloading plugin MCP servers|error getting token source:\s*You are not logged into Antigravity/iu.test(line)) {
      return null;
    }
    const body = line.replace(/^[EF]\d{4}\s+\S+\s+\d+\s+\S+\]\s*/u, '').trim();
    if (!body) return null;
    return {
      kind: 'error',
      dedupeKey: `logerr:${body.slice(0, 160).toLowerCase()}`,
      text: `[AGY 错误] ${dshAgyVisClip(body, 320)}`,
    };
  }

  return null;
}

/**
 * Parse Antigravity startup & execution milestones from agy's --log-file for the
 * ephemeral live status indicator (never appended to durable reasoning history).
 */
export function dshParseAntigravityStartupMilestone(line) {
  if (typeof line !== 'string' || !line.trim()) return null;

  if (/token\s+(?:refresh|validation)\s+failed\s+due\s+to\s+network\s+error/iu.test(line)) {
    return { phase: 'retrying', label: 'OAuth 刷新遇到网络抖动，准备重试…' };
  }

  const retryMatch = line.match(/Run:\s+attempt\s+(\d+)\s+failed\s+\((.+)\),\s+retrying\s+in\s+(\S+)/iu);
  if (retryMatch) {
    return {
      phase: 'retrying',
      label: `模型请求失败，第 ${retryMatch[1]} 次自动重试（${retryMatch[3]} 后）…`,
      detail: dshAgyVisClip(retryMatch[2], 120),
    };
  }

  if (/streamGenerateContent\?alt=sse/iu.test(line)) {
    return { phase: 'requesting', label: '已收到模型响应流，正在解析…' };
  }

  if (/Sending user message to conversation|Print mode:\s+conversation=/iu.test(line)) {
    return { phase: 'sending', label: '已发送给模型，等待首响应…' };
  }

  if (/(?:starting|connecting|initialized?|loading)\s+mcp|mcp\s+server/iu.test(line)) {
    return { phase: 'mcp', label: '正在加载 MCP 工具…' };
  }

  if (/Cache\(loadCodeAssistResponse\):\s*Singleflight refresh failed/iu.test(line)) {
    return null;
  }

  if (/silent auth|loadCodeAssist|Eligibility|oauth2\.googleapis\.com|consumerOAuth|Refreshing OAuth/iu.test(line)) {
    return { phase: 'auth', label: '正在校验登录与网络…' };
  }

  return null;
}

/**
 * Extract actionable runtime information from a native SYSTEM_MESSAGE entry,
 * filtering out repetitive print-mode boilerplate reminders.
 */
export function dshExtractAntigravitySystemMessage(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  // Strip Antigravity's outer boilerplate intro (which itself contains a literal "<SYSTEM_MESSAGE>"
  // mention before the real opening <SYSTEM_MESSAGE>...</SYSTEM_MESSAGE> block).
  let inner = content.replace(
    /^\s*(?:The following is a\s*)?(?:<SYSTEM_MESSAGE>\s*)?not actually sent by the user\.\s*It is provided by the system as important information to pay attention to\.?\s*/iu,
    '',
  );
  // Extract the innermost <SYSTEM_MESSAGE>...</SYSTEM_MESSAGE> block so any remaining prose
  // mentioning "<SYSTEM_MESSAGE>" cannot swallow the real opening tag.
  const tagMatch = inner.match(/<SYSTEM_MESSAGE>\s*((?:(?!<SYSTEM_MESSAGE>)[\s\S])*?)\s*<\/SYSTEM_MESSAGE>/iu);
  if (tagMatch) inner = tagMatch[1];
  inner = inner.trim();
  if (!inner) return null;

  // Filter repetitive built-in reminders and per-turn print-mode restart notices.
  if (/^Reminder:\s*work efficiently\./iu.test(inner)) return null;
  if (/^\[System Instruction:/iu.test(inner)) return null;
  if (/All your subagents and background tasks have been stopped due to server restart/iu.test(inner)) return null;

  // Summarize background task / agent messages concisely so the status block stays scannable.
  const msgMatch = inner.match(/^\[Message\]\s+timestamp=\S+\s+sender=(\S+)\s+priority=\S+\s+content=([\s\S]+)$/iu);
  if (msgMatch) {
    const sender = msgMatch[1];
    const body = msgMatch[2].trim();
    const taskShort = sender.includes('/') ? sender.split('/').pop() : sender;
    const firstLine = body.split(/\r?\n/u).map((l) => l.trim()).find(Boolean) ?? body;
    return `[AGY 系统] ${taskShort}: ${dshAgyVisClip(firstLine, DSH_AGY_VIS_MAX_SYSTEM_CHARS)}`;
  }

  const compact = inner.replace(/\s+/gu, ' ').trim();
  return `[AGY 系统] ${dshAgyVisClip(compact, DSH_AGY_VIS_MAX_SYSTEM_CHARS)}`;
}

/**
 * Convert one newly appended transcript.jsonl record into a live visibility event.
 */
export function dshParseAntigravityTranscriptLiveRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const stepIndex = typeof record.step_index === 'number' && Number.isSafeInteger(record.step_index) ? record.step_index : null;

  if (record.type === 'PLANNER_RESPONSE') {
    if (typeof record.thinking !== 'string' || !record.thinking.trim()) return null;
    const text = dshAgyVisClip(record.thinking, DSH_AGY_VIS_MAX_THINKING_CHARS);
    return {
      kind: 'thinking',
      stepIndex,
      failed: record.status === 'ERROR',
      text,
    };
  }

  if (record.type === 'ERROR_MESSAGE') {
    const rawMsg = typeof record.error === 'string' && record.error.trim()
      ? record.error.trim()
      : (typeof record.content === 'string' && record.content.trim() ? record.content.trim() : '');
    if (!rawMsg) return null;
    const attemptMatch = rawMsg.match(/^API error\s*\(attempt\s+(\d+)\):\s*([\s\S]+)$/iu);
    const dedupeKey = attemptMatch
      ? `attempt:${Number(attemptMatch[1])}:${attemptMatch[2].trim().toLowerCase()}`
      : `err:${rawMsg.slice(0, 160).toLowerCase()}`;
    return {
      kind: 'error',
      stepIndex,
      dedupeKey,
      text: `[AGY 错误] ${dshAgyVisClip(rawMsg, 320)}`,
    };
  }

  if (record.type === 'SYSTEM_MESSAGE') {
    const text = dshExtractAntigravitySystemMessage(record.content);
    if (!text) return null;
    return {
      kind: 'system',
      stepIndex,
      text,
    };
  }

  return null;
}

async function dshReadFileDelta(filePath, state) {
  let stat;
  try {
    stat = await dshAgyVisFsPromises.stat(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if (stat.size < state.offset) {
    state.offset = 0;
    state.remainder = '';
  }
  const toRead = Math.min(stat.size - state.offset, DSH_AGY_VIS_MAX_READ_BYTES);
  if (toRead <= 0) return [];

  let fh;
  try {
    fh = await dshAgyVisFsPromises.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, state.offset);
    if (bytesRead <= 0) return [];
    state.offset += bytesRead;
    const combined = state.remainder + buf.subarray(0, bytesRead).toString('utf8');
    const parts = combined.split(/\r?\n/u);
    state.remainder = parts.pop() ?? '';
    return parts;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => void 0);
  }
}

/**
 * Incremental byte-offset observer for one active Antigravity turn.
 * Tails agy's --log-file (live retries/errors) and native transcript.jsonl
 * (per-step thinking, errors, and non-boilerplate system notifications).
 */
export class DshAntigravityLiveObserver {
  #environment;
  #homedir;
  #logPath;
  #transcriptPath = null;
  #logState = { offset: 0, remainder: '' };
  #transcriptState = { offset: 0, remainder: '' };
  #postStartup = false;
  #hadRetry = false;
  #authRefreshNetworkReason = null;
  #authRefreshStallEmitted = false;
  #seenThinkingSteps = new Set();
  #seenSystemSteps = new Set();
  #seenErrorKeys = new Set();
  #onEvent;
  #onReady;
  #pending = [];
  #pollMs;
  #timer = null;
  #stopped = false;
  #chain = Promise.resolve();

  constructor({ environment, homedir, logPath, initialConversationId, pollMs = DSH_AGY_VIS_POLL_MS, onEvent, onReady }) {
    this.#environment = environment;
    this.#homedir = homedir;
    this.#logPath = typeof logPath === 'string' && logPath ? logPath : null;
    this.#pollMs = pollMs;
    this.#onEvent = onEvent;
    this.#onReady = onReady;
    if (initialConversationId) {
      this.#initTranscript(initialConversationId, true);
    }
  }

  get authRefreshNetworkReason() {
    return this.#authRefreshNetworkReason;
  }

  drain() {
    if (this.#pending.length === 0) return [];
    const items = this.#pending;
    this.#pending = [];
    return items;
  }

  #initTranscript(conversationId, seekToEnd) {
    if (this.#transcriptPath) return;
    const file = dshAntigravityTranscriptPath(this.#environment, conversationId, { homedir: this.#homedir });
    if (!file) return;
    this.#transcriptPath = file;
    if (seekToEnd) {
      try {
        const st = dshAgyVisFs.statSync(file);
        if (st.isFile() && st.size > 0) this.#transcriptState.offset = st.size;
      } catch {
        this.#transcriptState.offset = 0;
      }
    }
  }

  attachConversation(conversationId) {
    if (this.#stopped || !conversationId) return;
    // If conversationId was not known at turn start, this is a newly created conversation -> read from 0.
    this.#initTranscript(conversationId, false);
  }

  start() {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#pollMs);
    this.#timer.unref?.();
  }

  flush() {
    if (this.#stopped) return this.#chain;
    this.#chain = this.#chain.catch(() => void 0).then(() => this.#pollOnce());
    return this.#chain;
  }

  stop() {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #pollOnce() {
    if (this.#stopped) return;
    if (this.#logPath) {
      const lines = await dshReadFileDelta(this.#logPath, this.#logState);
      if (this.#stopped) return;
      for (const line of lines) {
        if (!this.#postStartup) {
          const refreshReason = dshParseAntigravityAuthRefreshNetworkError(line);
          if (refreshReason) {
            this.#authRefreshNetworkReason = refreshReason;
          } else if (this.#authRefreshNetworkReason && !this.#authRefreshStallEmitted && dshIsAntigravityInteractiveOAuthTrigger(line)) {
            this.#authRefreshStallEmitted = true;
            this.#emit({ kind: 'auth-refresh-network-stalled', reason: this.#authRefreshNetworkReason });
          }
        }
        const parsed = dshParseAntigravityLogLine(line, { postStartup: this.#postStartup, hadRetry: this.#hadRetry });
        if (!parsed) continue;
        if (parsed.markPostStartup) this.#postStartup = true;
        if (parsed.kind === 'started') continue;
        if (parsed.kind === 'retry') {
          this.#hadRetry = true;
          if (parsed.dedupeKey && this.#seenErrorKeys.has(parsed.dedupeKey)) continue;
          if (parsed.dedupeKey) this.#seenErrorKeys.add(parsed.dedupeKey);
          this.#emit(parsed);
          continue;
        }
        if (parsed.kind === 'request-retry') {
          this.#hadRetry = false;
          this.#emit(parsed);
          continue;
        }
        if (parsed.kind === 'error') {
          if (parsed.dedupeKey && this.#seenErrorKeys.has(parsed.dedupeKey)) continue;
          if (parsed.dedupeKey) this.#seenErrorKeys.add(parsed.dedupeKey);
          this.#emit(parsed);
        }
      }
    }

    if (this.#transcriptPath) {
      const lines = await dshReadFileDelta(this.#transcriptPath, this.#transcriptState);
      if (this.#stopped) return;
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const parsed = dshParseAntigravityTranscriptLiveRecord(rec);
        if (!parsed) continue;
        if (parsed.kind === 'thinking') {
          const key = parsed.stepIndex !== null ? parsed.stepIndex : parsed.text.slice(0, 120);
          if (this.#seenThinkingSteps.has(key)) continue;
          this.#seenThinkingSteps.add(key);
          this.#emit(parsed);
          continue;
        }
        if (parsed.kind === 'error') {
          if (parsed.dedupeKey && this.#seenErrorKeys.has(parsed.dedupeKey)) continue;
          if (parsed.dedupeKey) this.#seenErrorKeys.add(parsed.dedupeKey);
          this.#emit(parsed);
          continue;
        }
        if (parsed.kind === 'system') {
          const key = parsed.stepIndex !== null ? parsed.stepIndex : parsed.text.slice(0, 120);
          if (this.#seenSystemSteps.has(key)) continue;
          this.#seenSystemSteps.add(key);
          this.#emit(parsed);
        }
      }
    }
  }

  #emit(event) {
    if (this.#stopped) return;
    if (this.#onEvent) {
      try {
        this.#onEvent(event);
      } catch {
        // Never break observer loop on downstream errors.
      }
      return;
    }
    const wasEmpty = this.#pending.length === 0;
    this.#pending.push(event);
    if (wasEmpty && this.#onReady) {
      try {
        this.#onReady();
      } catch {
        // Never break observer loop on downstream errors.
      }
    }
  }
}
