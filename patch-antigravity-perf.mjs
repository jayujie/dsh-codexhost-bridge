export function patchAntigravityPerf(source, replace) {
  source = replace(
    source,
    'DEFAULT_INSPECT_TIMEOUT_MS = 2e4',
    'DEFAULT_INSPECT_TIMEOUT_MS = 6e4',
    'allow slow agy models probe on Windows',
  );

  source = replace(
    source,
    'var DEFAULT_PRINT_TIMEOUT = "30m";',
    'var DEFAULT_PRINT_TIMEOUT = "0s";',
    'disable hardcoded 30m agy --print-timeout so DSH nativeTurnTimeoutMs governs long turns',
  );

  // 0. Context window (516K) + /compact command + xhigh/max effort merging + canonical model ID for pricing + cache-aware hostUsage + UsageMeter metering.
  source = replace(
    source,
    `var EFFORT_LABELS = /* @__PURE__ */ new Map([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"]
]);
var EFFORT_SUFFIX_PATTERN = /^(?<base>.+)-(?<effort>low|medium|high)$/u;
var EFFORT_LABEL_SUFFIX_PATTERN = /\\s*\\((?:low|medium|high)\\)$/iu;`,
    `var EFFORT_LABELS = /* @__PURE__ */ new Map([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "XHigh"],
  ["max", "Max"]
]);
var EFFORT_SUFFIX_PATTERN = /^(?<base>.+)-(?<effort>low|medium|high|xhigh|max)$/u;
var EFFORT_LABEL_SUFFIX_PATTERN = /\\s*\\((?:low|medium|high|xhigh|max)\\)$/iu;`,
    'merge Antigravity xhigh and max model variants into base model thinking efforts',
  );

  source = replace(
    source,
    '  const defaultThinkingOptionId = options.at(-1)?.id;',
    '  const defaultThinkingOptionId = options.find((option) => option.id === "high")?.id ?? options.at(-1)?.id;',
    'keep high as default Antigravity thinking effort when xhigh/max options exist',
  );

  source = replace(
    source,
    'var GEMINI_CONTEXT_WINDOW_TOKENS = 1048576;',
    'var GEMINI_CONTEXT_WINDOW_TOKENS = DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS;',
    'set Gemini context window to 516K',
  );

  source = replace(
    source,
    `    models.push({
      ref: harnessModelRefSchema.parse({ id }),
      label,
      resolvedModelLabel: label,
      ...ordered.length > 0 ? { supportedThinkingOptionIds: ordered } : {}
    });`,
    `    models.push({
      ref: harnessModelRefSchema.parse({ id }),
      label,
      resolvedModelLabel: id,
      ...ordered.length > 0 ? { supportedThinkingOptionIds: ordered } : {}
    });`,
    'preserve canonical Antigravity model ID in resolvedModelLabel for pricing',
  );

  source = replace(
    source,
    `    {
      id: "antigravity.help",
      invocation: "/help",
      label: "Help",
      description: "Display available Antigravity slash commands and guidance",
      argumentMode: "text"
    }`,
    `    {
      id: "antigravity.compact",
      invocation: "/compact",
      label: "Compact",
      description: "Compact conversation history to free context window",
      argumentMode: "text"
    },
    {
      id: "antigravity.help",
      invocation: "/help",
      label: "Help",
      description: "Display available Antigravity slash commands and guidance",
      argumentMode: "text"
    }`,
    'expose /compact command in Antigravity command catalog',
  );

  source = replace(
    source,
    `function hostUsage(value, modelId, scope) {
  if (!value)
    return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const requestPromptTokens = scope === "request" && inputTokens !== void 0 ? inputTokens + (safeToken(value.cache_read_tokens) ?? 0) : void 0;
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens = contextUsedTokens !== void 0 || rawWindow !== void 0 ? resolveAntigravityContextWindow(modelId, rawWindow) : void 0;
  const usage = {
    ...inputTokens !== void 0 ? { inputTokens } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...reasoningOutputTokens !== void 0 ? { reasoningOutputTokens } : {},
    ...totalTokens !== void 0 ? { totalTokens } : {},
    ...contextUsedTokens !== void 0 && contextWindowTokens !== void 0 && contextWindowTokens > 0 ? { contextUsedTokens, contextWindowTokens } : {}
  };
  return Object.keys(usage).length > 0 ? usage : null;
}`,
    `function hostUsage(value, modelId, scope) {
  if (!value)
    return null;
  const uncachedInputTokens = safeToken(value.input_tokens);
  const cachedInputTokens = safeToken(value.cache_read_tokens);
  const cacheWriteInputTokens = safeToken(value.cache_write_tokens ?? value.cache_creation_input_tokens);
  const inputTokens = uncachedInputTokens !== void 0 ? uncachedInputTokens + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) : void 0;
  const outputTokens = safeToken(value.output_tokens);
  const rawThinking = safeToken(value.thinking_tokens);
  const reasoningOutputTokens = rawThinking !== void 0 && (outputTokens === void 0 || rawThinking <= outputTokens) ? rawThinking : void 0;
  const totalTokens = inputTokens !== void 0 && outputTokens !== void 0 ? inputTokens + outputTokens : safeToken(value.total_tokens);
  const requestPromptTokens = scope === "request" ? inputTokens : void 0;
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens = contextUsedTokens !== void 0 || rawWindow !== void 0 ? resolveAntigravityContextWindow(modelId, rawWindow) : void 0;
  const usage = {
    ...inputTokens !== void 0 ? { inputTokens, cachedInputTokens: cachedInputTokens ?? 0, cacheWriteInputTokens: cacheWriteInputTokens ?? 0 } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...reasoningOutputTokens !== void 0 ? { reasoningOutputTokens } : {},
    ...totalTokens !== void 0 ? { totalTokens } : {},
    ...contextUsedTokens !== void 0 && contextWindowTokens !== void 0 && contextWindowTokens > 0 ? { contextUsedTokens, contextWindowTokens } : {}
  };
  return Object.keys(usage).length > 0 ? usage : null;
}`,
    'preserve cache_read_tokens and inclusive inputTokens in Antigravity hostUsage',
  );

  source = replace(
    source,
    '  #catalog;\n  constructor(input) {',
    `  #catalog;
  #dshEmittedUsageSteps = /* @__PURE__ */ new Set();
  #dshUsageHistoryEmitted = false;
  #dshLastContextUsed = 0;
  #dshLastContextWindow = GEMINI_CONTEXT_WINDOW_TOKENS;
  #dshCompactedAtUsed = 0;
  #dshCompacting = false;
  #dshCompactAbort = new AbortController();
  constructor(input) {`,
    'track Antigravity transcript usage metering and 516K auto-compaction state',
  );

  source = replace(
    source,
    `    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command)
    };
  }`,
    `    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command)
    };
    if (this.#nativeRef?.nativeSessionId) {
      void this.#dshSyncTranscriptUsage(this.#nativeRef.nativeSessionId, this.#model?.id, true);
    }
  }`,
    'prime UsageMeter from native transcript on Antigravity session resume',
  );

  source = replace(
    source,
    '  get isActive() {\n    return this.#active !== null || this.#preparingQuestions !== null || [...this.#subagentObservers].some((observer) => observer.running);\n  }',
    '  get isActive() {\n    return this.#dshCompacting || this.#active !== null || this.#preparingQuestions !== null || [...this.#subagentObservers].some((observer) => observer.running);\n  }',
    'treat pre-turn auto-compaction as active session work',
  );

  source = replace(
    source,
    '    const environment = { ...this.#environment, ...questions.environment };',
    `    let didAutoCompact = false;
    if (!text.startsWith("/") && this.#nativeRef?.nativeSessionId && dshShouldAutoCompactAntigravity(this.#dshLastContextUsed, this.#dshLastContextWindow, this.#dshCompactedAtUsed)) {
      didAutoCompact = await this.#dshRunAutoCompact(this.#nativeRef.nativeSessionId);
      if (this.#closed) {
        await questions.dispose();
        return { ok: false, error: invalidState("Antigravity Session is closed") };
      }
    }
    const environment = { ...this.#environment, ...questions.environment };`,
    'trigger /compact automatically at 80% of 516K context window before next turn',
  );

  source = replace(
    source,
    '    this.#event({ type: "turn.started", turnId: command.turnId });\n    return { ok: true, value: { turnId: command.turnId } };',
    `    this.#event({ type: "turn.started", turnId: command.turnId });
    if (didAutoCompact) {
      const compactItem = { type: "contextCompaction", itemId: this.#newItemId() };
      this.#event({ type: "item.started", turnId: command.turnId, item: compactItem });
      this.#completeItem(active, compactItem, { status: "succeeded" });
    }
    return { ok: true, value: { turnId: command.turnId } };`,
    'emit contextCompaction item when 516K auto-compaction runs',
  );

  source = replace(
    source,
    '    this.#closed = true;\n    const preparing = await this.#preparingQuestions?.catch(() => void 0);',
    '    this.#closed = true;\n    this.#dshCompactAbort.abort();\n    const preparing = await this.#preparingQuestions?.catch(() => void 0);',
    'abort in-flight auto-compaction when session closes',
  );

  source = replace(
    source,
    '      this.#history.bindNativeSession(event.conversation_id);\n      this.#event({ type: "session.state.changed", state: this.#state() });\n      this.#ensureContextUsage(active, event.conversation_id);',
    '      this.#history.bindNativeSession(event.conversation_id);\n      active.liveObserver?.attachConversation(event.conversation_id);\n      this.#event({ type: "session.state.changed", state: this.#state() });\n      if (!this.#dshUsageHistoryEmitted) await this.#dshSyncTranscriptUsage(event.conversation_id, active.model?.id, true);\n      this.#ensureContextUsage(active, event.conversation_id);',
    'initialize UsageMeter history and live observer on Antigravity conversation init',
  );

  source = replace(
    source,
    `    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", checkpoint }, nativeTurnRef);`,
    `    active.liveObserver?.attachConversation(convId);
    await active.liveObserver?.flush();
    await this.#dshSyncTranscriptUsage(convId, active.model?.id, false, event.result.usage, safeTurnId, active);
    if (this.#active !== active)
      return;
    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", checkpoint }, nativeTurnRef);`,
    'flush live visibility observer and emit exact transcript usage requests before turn completion',
  );

  source = replace(
    source,
    `  #publishUsage(active, usage) {
    active.latestUsage = { ...active.latestUsage ?? {}, ...usage };
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId
    });
  }`,
    `  #publishUsage(active, usage) {
    active.latestUsage = { ...active.latestUsage ?? {}, ...usage };
    if (typeof active.latestUsage.contextWindowTokens === "number" && active.latestUsage.contextWindowTokens > 0) {
      this.#dshLastContextWindow = active.latestUsage.contextWindowTokens;
    }
    if (typeof active.latestUsage.contextUsedTokens === "number" && active.latestUsage.contextUsedTokens >= 0) {
      this.#dshLastContextUsed = active.latestUsage.contextUsedTokens;
      if (this.#dshCompactedAtUsed > 0 && this.#dshLastContextUsed < this.#dshCompactedAtUsed * 0.85) {
        this.#dshCompactedAtUsed = 0;
      }
    }
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId
    });
  }
  async #dshRunAutoCompact(conversationId) {
    this.#dshCompacting = true;
    this.#dshCompactedAtUsed = this.#dshLastContextUsed;
    try {
      const compactArgs = [
        "--conversation",
        conversationId,
        "--print=/compact",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--add-dir",
        this.#cwd
      ];
      await runBuffered(this.#executable, compactArgs, this.#cwd, this.#environment, 9e4, this.#dshCompactAbort.signal);
      this.#dshLastContextUsed = 0;
      return true;
    } catch {
      return false;
    } finally {
      this.#dshCompacting = false;
    }
  }
  async #dshSyncTranscriptUsage(conversationId, modelId, historical, fallbackResultUsage, fallbackTurnKey, active) {
    if (this.#closed || !conversationId)
      return;
    const { ok, entries } = await dshReadAntigravityTranscriptUsageRequests(this.#environment, conversationId, modelId);
    if (this.#closed)
      return;
    let latestStepPromptTokens;
    for (const entry of entries) {
      latestStepPromptTokens = entry.request.inputTokens;
      if (this.#dshEmittedUsageSteps.has(entry.stepIndex))
        continue;
      this.#dshEmittedUsageSteps.add(entry.stepIndex);
      this.#event({
        type: "usage.request",
        request: historical ? { ...entry.request, historical: true } : entry.request
      });
    }
    if (!ok && !historical && fallbackResultUsage && fallbackTurnKey) {
      const uncached = safeToken(fallbackResultUsage.input_tokens);
      const outputTokens = safeToken(fallbackResultUsage.output_tokens);
      if (uncached !== void 0 && outputTokens !== void 0) {
        const cachedInputTokens = safeToken(fallbackResultUsage.cache_read_tokens) ?? 0;
        const cacheWriteInputTokens = safeToken(fallbackResultUsage.cache_write_tokens ?? fallbackResultUsage.cache_creation_input_tokens) ?? 0;
        const inputTokens = uncached + cachedInputTokens + cacheWriteInputTokens;
        const normalizedModel = modelId ? (dshNormalizeAntigravityModelForPrice(modelId) ?? modelId) : void 0;
        this.#event({
          type: "usage.request",
          request: {
            requestId: \`agy:\${conversationId}:\${fallbackTurnKey}\`,
            ...normalizedModel ? { model: normalizedModel, provider: /^claude(?:[-_.]|$)/iu.test(normalizedModel) ? "anthropic" : "google" } : {},
            inputTokens,
            cachedInputTokens,
            cacheWriteInputTokens,
            outputTokens
          }
        });
      }
    }
    if (!this.#dshUsageHistoryEmitted) {
      this.#dshUsageHistoryEmitted = true;
      this.#event({ type: "usage.history", complete: true });
    }
    if (active && latestStepPromptTokens !== void 0 && active.latestUsage?.contextUsedTokens === void 0) {
      const contextWindowTokens = resolveAntigravityContextWindow(modelId, void 0);
      this.#publishUsage(active, { contextUsedTokens: latestStepPromptTokens, contextWindowTokens });
    }
  }`,
    'sync Antigravity transcript usage into Host UsageMeter and manage 516K auto-compaction',
  );

  // 1. AntigravityHistory: bound file size without changing turns.length/checkpoints,
  //    clone only newly appended turns, coalesce subagent status writes, and
  //    reconstruct turns from native transcript.jsonl on native AGY session import.
  source = replace(
    source,
    `    if (turns.length === 0 && input.knownTurnRefs) {`,
    `    if (turns.length === 0 && nativeSessionId) {
      const imported = await dshReadAntigravityTranscriptTurns(input.environment, nativeSessionId);
      if (imported.turns.length > 0) {
        turns = imported.turns;
        if (!model2 && imported.model) model2 = imported.model;
        if (!thinkingOptionId && imported.thinkingOptionId) thinkingOptionId = imported.thinkingOptionId;
      }
    }
    if (turns.length === 0 && input.knownTurnRefs) {`,
    'reconstruct native Antigravity transcript turns when importing sessions without history json',
  );

  source = replace(
    source,
    '  harnessId = antigravityHarnessId;\n  usageStatistics;',
    `  harnessId = antigravityHarnessId;
  usageStatistics;
  sessionImport = {
    listCandidates: () => this.#closed ? Promise.resolve({ ok: false, error: invalidState("Antigravity Adapter is closed") }) : dshListAntigravityImportCandidates(this.#environment),
    resolveCandidate: (nativeSessionId) => this.#closed ? Promise.resolve({ ok: false, error: invalidState("Antigravity Adapter is closed") }) : dshResolveAntigravityImportCandidate(this.#environment, nativeSessionId)
  };`,
    'expose native Antigravity sessionImport capability on AntigravityAdapter',
  );

  source = replace(
    source,
    '  #write = Promise.resolve();',
    '  #write = Promise.resolve();\n  #writeTimer = null;\n  #writeDirty = false;',
    'track coalesced Antigravity history writes',
  );

  source = replace(
    source,
    '      if (!entry.endsWith(".json"))\n        continue;',
    '      if (!entry.endsWith(".json") || entry.startsWith("."))\n        continue;',
    'ignore temporary dotfiles when scanning Antigravity history',
  );

  source = replace(
    source,
    '          changed = true;\n          return state;',
    '          changed = true;\n          return jsonTurn(state);',
    'clone updated subagent state on mutation only',
  );

  source = replace(
    source,
    '    if (changed)\n      this.#queueWrite();',
    '    if (changed)\n      this.#queueWrite({ debounceMs: 500 });',
    'coalesce frequent subagent history writes',
  );

  source = replace(
    source,
    `    const turn = {
      nativeTurnRef: input.nativeTurnRef,
      ...input.checkpoint ? { checkpoint: input.checkpoint } : {},
      input: input.turnInput,
      items: input.items,
      outcome: input.outcome,
      ...input.model ? { model: input.model } : {}
    };`,
    `    const turn = jsonTurn({
      nativeTurnRef: input.nativeTurnRef,
      ...input.checkpoint ? { checkpoint: input.checkpoint } : {},
      input: input.turnInput,
      items: input.items,
      outcome: input.outcome,
      ...input.model ? { model: input.model } : {}
    });`,
    'clone appended Antigravity turn once instead of deep-cloning all history per write',
  );

  source = replace(
    source,
    `  async flush() {
    await this.#write;
  }
  #queueWrite() {
    if (!this.#file || !this.#nativeSessionId)
      return;
    const file2 = this.#file;
    const nativeSessionId = this.#nativeSessionId;
    const turns = this.#turns.map(jsonTurn);
    const model2 = this.#model;
    const thinkingOptionId = this.#thinkingOptionId;
    this.#write = this.#write.catch(() => void 0).then(async () => {
      const directory = path5.dirname(file2);
      await mkdir(directory, { recursive: true, mode: 448 });
      const temporary = path5.join(directory, \`.\${path5.basename(file2)}.\${randomUUID()}.tmp\`);
      try {
        await writeFile2(temporary, \`\${JSON.stringify({
          formatVersion: HISTORY_VERSION,
          nativeSessionId,
          turns,
          ...model2 ? { model: model2 } : {},
          ...thinkingOptionId ? { thinkingOptionId } : {}
        })}
\`, { mode: 384 });
        await rename(temporary, file2);
      } finally {
        await rm2(temporary, { force: true }).catch(() => void 0);
      }
    });
  }`,
    `  async flush() {
    if (this.#writeTimer !== null) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    if (this.#writeDirty) {
      this.#writeDirty = false;
      this.#enqueueWriteNow();
    }
    await this.#write;
  }
  #queueWrite(options = {}) {
    if (!this.#file || !this.#nativeSessionId)
      return;
    const debounceMs = options.debounceMs ?? 0;
    if (debounceMs > 0) {
      this.#writeDirty = true;
      if (this.#writeTimer === null) {
        this.#writeTimer = setTimeout(() => {
          this.#writeTimer = null;
          if (this.#writeDirty) {
            this.#writeDirty = false;
            this.#enqueueWriteNow();
          }
        }, debounceMs);
        this.#writeTimer.unref?.();
      }
      return;
    }
    if (this.#writeTimer !== null) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    this.#writeDirty = false;
    this.#enqueueWriteNow();
  }
  #enqueueWriteNow() {
    if (!this.#file || !this.#nativeSessionId)
      return;
    this.#turns = dshCompactAntigravityTurns(this.#turns);
    const file2 = this.#file;
    const payload = \`\${JSON.stringify({
      formatVersion: HISTORY_VERSION,
      nativeSessionId: this.#nativeSessionId,
      turns: this.#turns,
      ...this.#model ? { model: this.#model } : {},
      ...this.#thinkingOptionId ? { thinkingOptionId: this.#thinkingOptionId } : {}
    })}
\`;
    this.#write = this.#write.catch(() => void 0).then(async () => {
      const directory = path5.dirname(file2);
      await mkdir(directory, { recursive: true, mode: 448 });
      const temporary = path5.join(directory, \`.\${path5.basename(file2)}.\${randomUUID()}.tmp\`);
      try {
        await writeFile2(temporary, payload, { mode: 384 });
        await rename(temporary, file2);
      } finally {
        await rm2(temporary, { force: true }).catch(() => void 0);
      }
    });
  }`,
    'compact older Antigravity history payloads and coalesce writes',
  );

  // 2. GetCascadeTrajectorySteps: bounded response, terminal-only fetch, per-turn cache & circuit breaker.
  source = replace(
    source,
    `function requestAntigravityTrajectorySteps(port, conversationId, timeoutMs) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port,
      path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
      method: "POST",
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { "content-type": "application/json" }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200)
          return resolve([]);
        try {
          resolve(parseAntigravityCodeActions(JSON.parse(body)));
        } catch {
          resolve([]);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve([]));
    request.end(JSON.stringify({ cascadeId: conversationId }));
  });
}`,
    `function requestAntigravityTrajectorySteps(port, conversationId, timeoutMs) {
  return dshRequestAntigravityTrajectorySteps(port, conversationId, timeoutMs, parseAntigravityCodeActions).then((result) => result.actions);
}`,
    'bound GetCascadeTrajectorySteps response size with Buffer chunking',
  );

  source = replace(
    source,
    '      codeActionCursor: 0,\n      fileChanges: /* @__PURE__ */ new Map(),',
    '      codeActionCursor: 0,\n      cachedCodeActions: null,\n      trajectoryTimeouts: 0,\n      trajectoryDegraded: false,\n      fileChanges: /* @__PURE__ */ new Map(),',
    'track per-turn trajectory cache and degradation circuit breaker',
  );

  source = replace(
    source,
    `  async #startToolItem(active, step) {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      const change = await this.#claimFileChange(active, step, toolName);
      if (change) {
        return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
      }
      if (step.state !== "DONE" && step.state !== "ERROR")
        return null;
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }
  async #claimFileChange(active, step, toolName) {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed)
      return claimed;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (!target)
      return null;
    const port = await this.#languageServerPort(active);
    if (port === null)
      return null;
    const actions = await requestAntigravityTrajectorySteps(port, step.conversation_id, TRAJECTORY_TIMEOUT_MS);
    const index = actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target));
    const action = index === -1 ? void 0 : actions[index];
    if (!action)
      return null;
    const change = codeActionFileChange(action, this.#cwd);
    if (!change)
      return null;
    active.codeActionCursor = index + 1;
    active.fileChanges.set(step.step_index, change);
    return change;
  }`,
    `  async #startToolItem(active, step) {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      if (step.state !== "DONE" && step.state !== "ERROR")
        return null;
      if (step.state === "DONE") {
        const change = await this.#claimFileChange(active, step, toolName);
        if (change) {
          return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
        }
      }
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }
  async #claimFileChange(active, step, toolName) {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed)
      return claimed;
    if (active.trajectoryDegraded)
      return null;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (!target)
      return null;
    let actions = active.cachedCodeActions;
    let index = Array.isArray(actions) ? actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target)) : -1;
    if (index === -1) {
      const port = await this.#languageServerPort(active);
      if (port === null)
        return null;
      const fetched = await dshRequestAntigravityTrajectorySteps(port, step.conversation_id, TRAJECTORY_TIMEOUT_MS, parseAntigravityCodeActions);
      if (!fetched.ok) {
        if (fetched.reason === "oversize") {
          active.trajectoryDegraded = true;
        } else if (fetched.reason === "timeout") {
          active.trajectoryTimeouts += 1;
          if (active.trajectoryTimeouts >= 2)
            active.trajectoryDegraded = true;
        }
        return null;
      }
      active.trajectoryTimeouts = 0;
      actions = fetched.actions;
      active.cachedCodeActions = actions;
      index = actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target));
    }
    const action = index === -1 ? void 0 : actions[index];
    if (!action)
      return null;
    const change = codeActionFileChange(action, this.#cwd);
    if (!change)
      return null;
    active.codeActionCursor = index + 1;
    active.fileChanges.set(step.step_index, change);
    return change;
  }`,
    'fetch trajectory diffs only on DONE with cache reuse and degradation breaker',
  );

  // 3. AntigravityAdapter.inspect: global cache key + disk cache + background SWR refresh.
  source = replace(
    source,
    '  #quotaAbort = new AbortController();',
    '  #quotaAbort = new AbortController();\n  #dshRefreshAbort = new AbortController();\n  #dshBgRefreshStarted = false;\n  #dshBgRefresh = null;',
    'track background Antigravity catalog refresh abort controller',
  );

  source = replace(
    source,
    `  async inspect(input = {}) {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path11.resolve(input.cwd ?? process.cwd());
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight)
      return inFlight;
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cwd);
      if (cached2)
        return cached2;
    }
    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") {
        this.#inspectionCache.set(cwd, result);
        this.#quotaCwd = cwd;
        void this.refreshCredits().catch(() => void 0);
      }
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }
  async #inspectCwd(cwd) {
    const executable = resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    try {
      const { stdout } = await runBuffered(executable, ["models"], cwd, this.#environment, this.#inspectTimeoutMs);
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES
      };
    } catch (error51) {
      const message = errorMessage(error51);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" }
      };
    }
  }`,
    `  async inspect(input = {}) {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path11.resolve(input.cwd ?? process.cwd());
    const executable = resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      this.#inspectionCache.clear();
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    const cacheKey = "*";
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cacheKey);
      if (cached2)
        return cached2;
      const disk = dshReadAntigravityCatalogCache(this.#environment, executable, harnessModelCatalogSchema);
      if (disk) {
        const result = {
          status: "ready",
          catalog: disk.catalog,
          permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
          capabilities: CAPABILITIES
        };
        this.#inspectionCache.set(cacheKey, result);
        this.#quotaCwd = cwd;
        this.#dshStartBackgroundRefresh(cwd, executable);
        return result;
      }
    }
    const inFlight = this.#inspectionInFlight.get(cacheKey);
    if (inFlight)
      return inFlight;
    const inspection = this.#inspectCwd(cwd, executable).then(async (result) => {
      if (!this.#closed && result.status === "ready") {
        this.#inspectionCache.set(cacheKey, result);
        this.#quotaCwd = cwd;
        await dshWriteAntigravityCatalogCache(this.#environment, executable, result.catalog);
        void this.refreshCredits().catch(() => void 0);
      }
      return result;
    });
    this.#inspectionInFlight.set(cacheKey, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cacheKey) === inspection) {
        this.#inspectionInFlight.delete(cacheKey);
      }
    });
  }
  #dshStartBackgroundRefresh(cwd, executable) {
    if (this.#closed || this.#dshBgRefreshStarted)
      return;
    this.#dshBgRefreshStarted = true;
    this.#dshBgRefresh = this.#inspectCwd(cwd, executable, this.#dshRefreshAbort.signal).then(async (result) => {
      if (!this.#closed && result.status === "ready") {
        this.#inspectionCache.set("*", result);
        await dshWriteAntigravityCatalogCache(this.#environment, executable, result.catalog);
        void this.refreshCredits().catch(() => void 0);
      }
    }).catch(() => void 0).finally(() => {
      this.#dshBgRefresh = null;
    });
  }
  async #inspectCwd(cwd, resolvedExecutable, signal) {
    const executable = resolvedExecutable ?? resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    try {
      const { stdout } = await runBuffered(executable, ["models"], cwd, this.#environment, this.#inspectTimeoutMs, signal);
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES
      };
    } catch (error51) {
      const message = errorMessage(error51);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" }
      };
    }
  }`,
    'share global Antigravity model catalog with disk cache and background refresh',
  );

  source = replace(
    source,
    '    const cwd = path11.resolve(input.cwd);\n    let catalog = this.#inspectionCache.get(cwd)?.catalog;',
    '    let catalog = this.#inspectionCache.get("*")?.catalog;',
    'read global Antigravity catalog cache on session open',
  );

  source = replace(
    source,
    '    this.#quotaAbort.abort();\n    await Promise.all([...this.#sessions].map((session) => session.close()));',
    '    this.#quotaAbort.abort();\n    this.#dshRefreshAbort.abort();\n    await Promise.all([...this.#sessions].map((session) => session.close()));\n    await Promise.allSettled([this.#dshBgRefresh, this.#quotaRefresh].filter(Boolean));',
    'abort and settle background Antigravity refreshes on adapter close',
  );

  // 4. Live visibility: stream thinking, API retry/error logs, and actionable system notifications as native reasoning blocks.
  source = replace(
    source,
    `      logPath,
      agentItem: null,
      agentText: "",
      turnAgentText: "",`,
    `      logPath,
      agentItem: null,
      agentText: "",
      turnAgentText: "",
      reasoningItem: null,
      reasoningText: "",
      liveObserver: null,
      deferredVisibility: [],
      flushedSteps: /* @__PURE__ */ new Set(),`,
    'track live reasoning and visibility observer state on active Antigravity turn',
  );

  source = replace(
    source,
    `    this.#active = active;
    this.#subagentObservers.add(active.subagents);`,
    `    this.#active = active;
    this.#subagentObservers.add(active.subagents);
    active.liveObserver = new DshAntigravityLiveObserver({
      environment: this.#environment,
      logPath,
      initialConversationId: this.#nativeRef?.nativeSessionId,
      onReady: () => {
        this.#enqueue(active, () => {
          if (this.#active !== active)
            return;
          this.#dshDrainVisibility(active);
        });
      }
    });
    active.liveObserver.start();`,
    'start incremental Antigravity log and transcript live observer per turn',
  );

  source = replace(
    source,
    `    child.once("close", (code) => {
      this.#enqueue(active, () => {
        void unlink(active.logPath).catch(() => void 0);`,
    `    child.once("close", (code) => {
      this.#enqueue(active, async () => {
        if (this.#active === active && !active.receivedResult) {
          await active.liveObserver?.flush();
          this.#dshDrainVisibility(active);
        }
        active.liveObserver?.stop();
        void unlink(active.logPath).catch(() => void 0);`,
    'flush and stop live visibility observer before removing Antigravity temp log',
  );

  source = replace(
    source,
    `    active.liveObserver?.attachConversation(convId);
    await active.liveObserver?.flush();`,
    `    active.liveObserver?.attachConversation(convId);
    await active.liveObserver?.flush();
    if (this.#active === active)
      this.#dshDrainVisibility(active);`,
    'drain final visibility events before completing Antigravity turn',
  );

  source = replace(
    source,
    `  async #handleStep(active, step) {
    if (step.step_type === "subagent") {
      if (active.agentItem) {
        this.#completeItem(active, active.agentItem, { status: "succeeded" });
        active.agentItem = null;
        active.agentText = "";
      }
      if (active.subagents.handle(step))
        return;
      step = { ...step, step_type: "tool" };
    }
    if (step.step_type === "agent_response") {
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        this.#appendOrSyncAgentText(active, step.text_delta, true);
        return;
      }
      const fullOrDelta = step.text ?? (typeof step.content === "string" ? step.content : void 0) ?? (typeof step.message === "string" ? step.message : void 0);
      if (typeof fullOrDelta === "string" && fullOrDelta.length > 0) {
        this.#appendOrSyncAgentText(active, fullOrDelta, false);
        return;
      }
      return;
    }
    if (step.step_type !== "tool")
      return;
    if (active.agentItem) {
      this.#completeItem(active, active.agentItem, { status: "succeeded" });
      active.agentItem = null;
      active.agentText = "";
    }`,
    `  async #handleStep(active, step) {
    const directThinking = typeof step.thinking_delta === "string" && step.thinking_delta.length > 0
      ? step.thinking_delta
      : ((step.step_type === "thinking" || step.step_type === "reasoning")
        ? (typeof step.text_delta === "string" ? step.text_delta : typeof step.thinking === "string" ? step.thinking : typeof step.text === "string" ? step.text : "")
        : "");
    if (directThinking) {
      this.#dshHandleVisibilityEvent(active, { kind: "thinking-delta", text: directThinking });
      if (step.step_type === "thinking" || step.step_type === "reasoning")
        return;
    }
    if (step.step_type === "system_message" || step.step_type === "error_message") {
      const raw = typeof step.error === "string" ? step.error : typeof step.text === "string" ? step.text : typeof step.content === "string" ? step.content : typeof step.message === "string" ? step.message : "";
      const text = step.step_type === "error_message"
        ? (raw.trim() ? \`[AGY 错误] \${raw.trim().slice(0, 320)}\` : null)
        : dshExtractAntigravitySystemMessage(raw);
      if (text)
        this.#dshHandleVisibilityEvent(active, { kind: step.step_type === "error_message" ? "error" : "system", text });
      return;
    }
    if (step.step_type === "subagent") {
      if (!active.flushedSteps.has(step.step_index)) {
        active.flushedSteps.add(step.step_index);
        await active.liveObserver?.flush();
        if (this.#active !== active)
          return;
        this.#dshDrainVisibility(active);
      }
      this.#dshCloseAgentAndDeferred(active);
      this.#dshFlushReasoning(active);
      if (active.subagents.handle(step))
        return;
      step = { ...step, step_type: "tool" };
    }
    if (step.step_type === "agent_response") {
      if (!active.agentItem && !active.flushedSteps.has(step.step_index)) {
        active.flushedSteps.add(step.step_index);
        await active.liveObserver?.flush();
        if (this.#active !== active)
          return;
        this.#dshDrainVisibility(active);
      }
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        this.#appendOrSyncAgentText(active, step.text_delta, true);
        return;
      }
      const fullOrDelta = step.text ?? (typeof step.content === "string" ? step.content : void 0) ?? (typeof step.message === "string" ? step.message : void 0);
      if (typeof fullOrDelta === "string" && fullOrDelta.length > 0) {
        this.#appendOrSyncAgentText(active, fullOrDelta, false);
        return;
      }
      return;
    }
    if (step.step_type !== "tool")
      return;
    if (!active.flushedSteps.has(step.step_index)) {
      active.flushedSteps.add(step.step_index);
      await active.liveObserver?.flush();
      if (this.#active !== active)
        return;
      this.#dshDrainVisibility(active);
    }
    this.#dshCloseAgentAndDeferred(active);
    this.#dshFlushReasoning(active);`,
    'handle Antigravity thinking, system, and error steps and flush live observer in order',
  );

  source = replace(
    source,
    `  #appendAgentText(active, text) {
    active.turnAgentText += text;
    if (!active.agentItem) {
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };`,
    `  #dshDrainVisibility(active) {
    const events = active.liveObserver?.drain() ?? [];
    for (const visEvent of events) {
      if (visEvent?.kind === "auth-refresh-network-stalled") {
        const msg = \`OAuth token refresh failed due to network error: \${visEvent.reason}\`;
        if (this.#dshMaybeRetryPreTurn(active, msg, { safeTurnId: null, repliedThisTurn: false }))
          return;
        continue;
      }
      this.#dshHandleVisibilityEvent(active, visEvent);
    }
  }
  #dshHandleVisibilityEvent(active, visEvent) {
    if (!visEvent || typeof visEvent.text !== "string" || !visEvent.text.trim())
      return;
    if (active.agentItem) {
      active.deferredVisibility.push(visEvent);
      return;
    }
    if (visEvent.kind === "thinking") {
      this.#dshFlushReasoning(active);
      const text = visEvent.text.replace(/[\\r\\n]+$/u, "");
      if (!text)
        return;
      this.#dshAppendReasoningText(active, text);
      this.#dshFlushReasoning(active);
      return;
    }
    if (visEvent.kind === "thinking-delta") {
      this.#dshAppendReasoningText(active, visEvent.text);
      return;
    }
    const line = visEvent.text.replace(/[\\r\\n]+$/u, "");
    if (!line)
      return;
    const prefix = active.reasoningText ? "\\n" : "";
    this.#dshAppendReasoningText(active, prefix + line);
  }
  #dshAppendReasoningText(active, text) {
    if (!text)
      return;
    if (!active.reasoningItem) {
      active.reasoningItem = { type: "reasoning", itemId: this.#newItemId(), text };
      active.reasoningText = text;
      this.#event({ type: "item.started", turnId: active.command.turnId, item: active.reasoningItem });
      return;
    }
    active.reasoningText += text;
    active.reasoningItem = { ...active.reasoningItem, text: active.reasoningText };
    this.#event({
      type: "item.updated",
      turnId: active.command.turnId,
      itemId: active.reasoningItem.itemId,
      update: { type: "text.append", text }
    });
  }
  #dshFlushReasoning(active, outcome = { status: "succeeded" }) {
    if (!active.reasoningItem)
      return;
    const item = active.reasoningItem;
    active.reasoningItem = null;
    active.reasoningText = "";
    this.#completeItem(active, item, outcome);
  }
  #dshCloseAgentAndDeferred(active, outcome = { status: "succeeded" }) {
    if (active.agentItem) {
      this.#completeItem(active, active.agentItem, outcome);
      active.agentItem = null;
      active.agentText = "";
    }
    if (active.deferredVisibility.length > 0) {
      const pending = active.deferredVisibility.splice(0);
      for (const visEvent of pending)
        this.#dshHandleVisibilityEvent(active, visEvent);
    }
  }
  #appendAgentText(active, text) {
    active.turnAgentText += text;
    if (!active.agentItem) {
      this.#dshFlushReasoning(active);
      active.agentItem = { type: "agentMessage", itemId: this.#newItemId(), text };`,
    'emit live Antigravity reasoning and runtime status blocks without splitting assistant messages',
  );

  source = replace(
    source,
    `    active.questions.stop();
    this.#questionCleanup = this.#questionCleanup.then(async () => {`,
    `    active.liveObserver?.stop();
    active.questions.stop();
    this.#questionCleanup = this.#questionCleanup.then(async () => {`,
    'stop live visibility observer when Antigravity turn completes',
  );

  source = replace(
    source,
    `    active.subagents.finish(itemOutcome);
    if (active.agentItem)
      this.#completeItem(active, active.agentItem, itemOutcome);`,
    `    active.subagents.finish(itemOutcome);
    this.#dshCloseAgentAndDeferred(active, itemOutcome);
    this.#dshFlushReasoning(active, itemOutcome);`,
    'settle open Antigravity reasoning and deferred visibility blocks on turn completion',
  );

  // 5. Turn identity collision guard: never persist turn:0 or duplicate nativeTurnKey on failed/cancelled turns,
  //    and always allocate a fresh unique positive key on succeeded turns.
  source = replace(
    source,
    `  #write = Promise.resolve();
  #writeTimer = null;
  #writeDirty = false;
  constructor(input) {
    this.#file = input.file;
    this.#nativeSessionId = input.nativeSessionId;
    this.#turns = input.turns;
    this.#model = input.model;
    this.#thinkingOptionId = input.thinkingOptionId;
  }`,
    `  #write = Promise.resolve();
  #writeTimer = null;
  #writeDirty = false;
  #dshKnownTurnKeys = /* @__PURE__ */ new Set();
  constructor(input) {
    this.#file = input.file;
    this.#nativeSessionId = input.nativeSessionId;
    this.#turns = input.turns;
    this.#model = input.model;
    this.#thinkingOptionId = input.thinkingOptionId;
    for (const turn of input.turns) {
      if (turn?.nativeTurnRef?.nativeTurnKey)
        this.#dshKnownTurnKeys.add(turn.nativeTurnRef.nativeTurnKey);
    }
    for (const ref of input.knownTurnRefs ?? []) {
      if (ref?.nativeTurnKey)
        this.#dshKnownTurnKeys.add(ref.nativeTurnKey);
    }
  }
  dshKnownTurnKeys() {
    return new Set(this.#dshKnownTurnKeys);
  }`,
    'track all known nativeTurnKeys from history and MappingStore on AntigravityHistory',
  );

  source = replace(
    source,
    `    return new _AntigravityHistory({
      file: file2,
      nativeSessionId,
      turns,
      ...model2 ? { model: model2 } : {},
      ...thinkingOptionId ? { thinkingOptionId } : {}
    });`,
    `    return new _AntigravityHistory({
      file: file2,
      nativeSessionId,
      turns,
      ...input.knownTurnRefs ? { knownTurnRefs: input.knownTurnRefs } : {},
      ...model2 ? { model: model2 } : {},
      ...thinkingOptionId ? { thinkingOptionId } : {}
    });`,
    'preserve knownTurnRefs from MappingStore when opening AntigravityHistory',
  );

  source = replace(
    source,
    `    const index = this.#turns.findIndex(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey === input.nativeTurnRef.nativeTurnKey);`,
    `    this.#dshKnownTurnKeys.add(input.nativeTurnRef.nativeTurnKey);
    const index = this.#turns.findIndex(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey === input.nativeTurnRef.nativeTurnKey);`,
    'record appended nativeTurnKey in AntigravityHistory known-key set',
  );

  source = replace(
    source,
    `    const safeTurnId = event.result.num_turns !== void 0 && event.result.num_turns !== null ? \`turn:\${event.result.num_turns}\` : \`turn:\${this.#history.snapshot().length + 1}\`;
    const nativeTurnRef = nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: convId,
      nativeTurnKey: safeTurnId,
      formatVersion: 1
    });
    const checkpoint = nativeCheckpointRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: convId,
      checkpointId: safeTurnId,
      formatVersion: 1
    });
    active.liveObserver?.attachConversation(convId);
    await active.liveObserver?.flush();
    if (this.#active === active)
      this.#dshDrainVisibility(active);
    await this.#dshSyncTranscriptUsage(convId, active.model?.id, false, event.result.usage, safeTurnId, active);
    if (this.#active !== active)
      return;
    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", checkpoint }, nativeTurnRef);
    } else if (event.result.status === "SUCCESS") {
      if (active.permissionDenial !== null && !active.agentItem) {
        this.#completeTurn(active, {
          status: "failed",
          error: permissionDeniedTurnError(active.nativePermissionMode, active.permissionDenial),
          checkpoint
        }, nativeTurnRef);
      } else {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      }
    } else {
      const error51 = this.#resultError(active, event);
      if (repliedThisTurn && event.result.error?.trim() && this.#reportedEarlier(error51)) {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      } else {
        this.#completeTurn(active, { status: "failed", error: error51, checkpoint }, nativeTurnRef);
      }
    }`,
    `    active.liveObserver?.attachConversation(convId);
    await active.liveObserver?.flush();
    if (this.#active === active)
      this.#dshDrainVisibility(active);
    const willCancel = active.cancellationRequested;
    const willPermissionFail = !willCancel && event.result.status === "SUCCESS" && active.permissionDenial !== null && !active.agentItem;
    const rawResultError = !willCancel && event.result.status !== "SUCCESS" ? this.#resultError(active, event) : null;
    const willSucceed = !willCancel && (event.result.status === "SUCCESS" ? !willPermissionFail : Boolean(repliedThisTurn && event.result.error?.trim() && this.#reportedEarlier(rawResultError)));
    const safeTurnId = dshResolveAntigravityTurnKey({
      numTurns: event.result.num_turns,
      existingKeys: this.#history.dshKnownTurnKeys(),
      willSucceed
    });
    const nativeTurnRef = safeTurnId ? nativeTurnRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: convId,
      nativeTurnKey: safeTurnId,
      formatVersion: 1
    }) : void 0;
    const checkpoint = safeTurnId ? nativeCheckpointRefSchema.parse({
      harnessId: this.harnessId,
      nativeSessionId: convId,
      checkpointId: safeTurnId,
      formatVersion: 1
    }) : void 0;
    await this.#dshSyncTranscriptUsage(convId, active.model?.id, false, event.result.usage, safeTurnId, active);
    if (this.#active !== active)
      return;
    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", ...checkpoint ? { checkpoint } : {} }, nativeTurnRef);
    } else if (event.result.status === "SUCCESS") {
      if (active.permissionDenial !== null && !active.agentItem) {
        this.#completeTurn(active, {
          status: "failed",
          error: permissionDeniedTurnError(active.nativePermissionMode, active.permissionDenial),
          ...checkpoint ? { checkpoint } : {}
        }, nativeTurnRef);
      } else {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      }
    } else {
      const error51 = rawResultError ?? this.#resultError(active, event);
      if (repliedThisTurn && event.result.error?.trim() && this.#reportedEarlier(error51)) {
        this.#completeTurn(active, { status: "succeeded", checkpoint }, nativeTurnRef);
      } else {
        this.#completeTurn(active, { status: "failed", error: error51, ...checkpoint ? { checkpoint } : {} }, nativeTurnRef);
      }
    }`,
    'prevent duplicate or zero nativeTurnKey collisions on Antigravity result completion',
  );

  // 6. Zero-side-effect pre-turn transient retry (e.g. proxy EOF during Eligibility check).
  source = replace(
    source,
    `      reasoningItem: null,
      reasoningText: "",
      liveObserver: null,
      deferredVisibility: [],
      flushedSteps: /* @__PURE__ */ new Set(),`,
    `      reasoningItem: null,
      reasoningText: "",
      liveObserver: null,
      deferredVisibility: [],
      flushedSteps: /* @__PURE__ */ new Set(),
      attemptSeq: 1,
      preTurnRetryCount: 0,
      retryAbort: null,
      retryText: text,
      retryEnvironment: environment,`,
    'track pre-turn retry state on active Antigravity turn',
  );

  source = replace(
    source,
    `    this.#active = active;
    this.#subagentObservers.add(active.subagents);
    active.liveObserver = new DshAntigravityLiveObserver({
      environment: this.#environment,
      logPath,
      initialConversationId: this.#nativeRef?.nativeSessionId,
      onReady: () => {
        this.#enqueue(active, () => {
          if (this.#active !== active)
            return;
          this.#dshDrainVisibility(active);
        });
      }
    });
    active.liveObserver.start();
    child.stdin.on("error", () => void 0);
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      active.stderr = (active.stderr + chunk).slice(-8e3);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const event = parseAntigravityStreamLine(line);
      if (event)
        this.#enqueue(active, () => this.#handleEvent(active, event));
      else if (line.trim())
        active.stderr = (active.stderr + \`
\${line}\`).slice(-8e3);
    });
    child.once("error", (error51) => {
      this.#enqueue(active, () => {
        if (this.#active !== active)
          return;
        this.#completeTurn(active, {
          status: "failed",
          error: { code: "nativeFailure", message: error51.message, retryable: true }
        });
      });
    });
    child.once("close", (code) => {
      this.#enqueue(active, async () => {
        if (this.#active === active && !active.receivedResult) {
          await active.liveObserver?.flush();
          this.#dshDrainVisibility(active);
        }
        active.liveObserver?.stop();
        void unlink(active.logPath).catch(() => void 0);
        if (active.subagents.running)
          void active.subagents.cancel();
        else
          active.subagents.stop();
        if (this.#active !== active || active.receivedResult)
          return;
        if (active.cancellationRequested) {
          this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
        } else {
          this.#completeTurn(active, {
            status: "failed",
            error: normalizedProcessError(active.stderr, \`Antigravity CLI exited before a result event (code \${String(code)})\`)
          });
        }
      });
    });`,
    `    this.#active = active;
    this.#subagentObservers.add(active.subagents);
    this.#dshAttachAntigravityChild(active, child, logPath, 1);`,
    'attach Antigravity child process listeners with per-attempt sequence guard',
  );

  source = replace(
    source,
    `    const active = this.#active;
    active.cancellationRequested = true;
    active.questions.stop();`,
    `    const active = this.#active;
    active.cancellationRequested = true;
    active.retryAbort?.abort();
    active.questions.stop();`,
    'abort pending pre-turn retry backoff immediately on turn cancellation',
  );

  source = replace(
    source,
    `    if (this.#active) {
      const active = this.#active;
      active.cancellationRequested = true;
      await active.subagents.cancel();`,
    `    if (this.#active) {
      const active = this.#active;
      active.cancellationRequested = true;
      active.retryAbort?.abort();
      await active.subagents.cancel();`,
    'abort pending pre-turn retry backoff immediately on session close',
  );

  source = replace(
    source,
    `    active.liveObserver?.stop();
    active.questions.stop();`,
    `    active.retryAbort?.abort();
    active.retryAbort = null;
    active.liveObserver?.stop();
    active.questions.stop();`,
    'clear pre-turn retry abort controller when Antigravity turn completes',
  );

  source = replace(
    source,
    `      } else {
        this.#completeTurn(active, { status: "failed", error: error51, ...checkpoint ? { checkpoint } : {} }, nativeTurnRef);
      }
    }`,
    `      } else {
        const authRefreshReason = active.liveObserver?.authRefreshNetworkReason;
        const retryMessage = /authentication failed or timed out/iu.test(error51.message) && authRefreshReason
          ? \`OAuth token refresh failed due to network error: \${authRefreshReason}\`
          : error51.message;
        if (this.#dshMaybeRetryPreTurn(active, retryMessage, { safeTurnId, repliedThisTurn }))
          return;
        this.#completeTurn(active, { status: "failed", error: error51, ...checkpoint ? { checkpoint } : {} }, nativeTurnRef);
      }
    }`,
    'retry zero-side-effect pre-turn transient Antigravity result failures',
  );

  source = replace(
    source,
    `  #dshDrainVisibility(active) {`,
    `  #dshAttachAntigravityChild(active, child, attemptLogPath, attempt) {
    active.liveObserver?.stop();
    active.liveObserver = new DshAntigravityLiveObserver({
      environment: this.#environment,
      logPath: attemptLogPath,
      initialConversationId: this.#nativeRef?.nativeSessionId,
      onReady: () => {
        this.#enqueue(active, () => {
          if (this.#active !== active || active.attemptSeq !== attempt)
            return;
          this.#dshDrainVisibility(active);
        });
      }
    });
    active.liveObserver.start();
    child.stdin.on("error", () => void 0);
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (this.#active !== active || active.attemptSeq !== attempt)
        return;
      active.stderr = (active.stderr + chunk).slice(-8e3);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.#active !== active || active.attemptSeq !== attempt)
        return;
      const event = parseAntigravityStreamLine(line);
      if (event)
        this.#enqueue(active, () => {
          if (this.#active !== active || active.attemptSeq !== attempt)
            return;
          return this.#handleEvent(active, event);
        });
      else if (line.trim())
        active.stderr = (active.stderr + \`
\${line}\`).slice(-8e3);
    });
    child.once("error", (error51) => {
      this.#enqueue(active, () => {
        if (this.#active !== active || active.attemptSeq !== attempt)
          return;
        this.#completeTurn(active, {
          status: "failed",
          error: { code: "nativeFailure", message: error51.message, retryable: true }
        });
      });
    });
    child.once("close", (code) => {
      this.#enqueue(active, async () => {
        void unlink(attemptLogPath).catch(() => void 0);
        if (this.#active !== active || active.attemptSeq !== attempt)
          return;
        if (!active.receivedResult) {
          await active.liveObserver?.flush();
          this.#dshDrainVisibility(active);
        }
        active.liveObserver?.stop();
        if (active.receivedResult)
          return;
        if (active.cancellationRequested) {
          if (active.subagents.running)
            void active.subagents.cancel();
          else
            active.subagents.stop();
          this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user" });
          return;
        }
        const closeError = normalizedProcessError(active.stderr, \`Antigravity CLI exited before a result event (code \${String(code)})\`);
        const authRefreshReason = active.liveObserver?.authRefreshNetworkReason;
        const closeRetryMessage = /authentication failed or timed out/iu.test(closeError.message) && authRefreshReason
          ? \`OAuth token refresh failed due to network error: \${authRefreshReason}\`
          : closeError.message;
        if (this.#dshMaybeRetryPreTurn(active, closeRetryMessage, { safeTurnId: null, repliedThisTurn: false }))
          return;
        if (active.subagents.running)
          void active.subagents.cancel();
        else
          active.subagents.stop();
        this.#completeTurn(active, {
          status: "failed",
          error: closeError
        });
      });
    });
  }
  #dshHasSideEffects(active, repliedThisTurn) {
    if (repliedThisTurn || active.agentItem || active.turnAgentText)
      return true;
    if (active.tools.size > 0 || active.pendingSteps.size > 0 || active.subagents.running)
      return true;
    return active.completedItems.some(({ item }) => item.type !== "contextCompaction" && item.type !== "reasoning");
  }
  #dshMaybeRetryPreTurn(active, message, { safeTurnId = null, repliedThisTurn = false } = {}) {
    if (this.#closed || this.#active !== active || active.cancellationRequested)
      return false;
    if (safeTurnId !== null)
      return false;
    if (this.#dshHasSideEffects(active, repliedThisTurn))
      return false;
    if (!dshIsPreTurnRetryableAntigravityError(message))
      return false;
    const delays = dshAntigravityPreTurnRetryDelays(this.#environment);
    if (active.preTurnRetryCount >= delays.length)
      return false;
    const delayMs = delays[active.preTurnRetryCount];
    active.preTurnRetryCount += 1;
    active.attemptSeq += 1;
    const nextAttempt = active.attemptSeq;
    const prevProcess = active.process;
    const prevLogPath = active.logPath;
    active.liveObserver?.stop();
    void unlink(prevLogPath).catch(() => void 0);
    try {
      if (prevProcess?.stdin?.writable)
        prevProcess.stdin.end();
      prevProcess?.kill();
    } catch {
    }
    const brief = message.replace(/^Antigravity Turn ended with status ERROR:\s*/iu, "").slice(0, 180);
    const delayLabel = delayMs >= 1e3 ? \`\${(delayMs / 1e3).toFixed(delayMs % 1e3 === 0 ? 0 : 1)}s\` : \`\${delayMs}ms\`;
    this.#dshHandleVisibilityEvent(active, {
      kind: "retry",
      text: \`[AGY 启动前瞬断] \${brief}，\${delayLabel} 后自动重试（第 \${active.preTurnRetryCount}/\${delays.length} 次）\`
    });
    const controller = new AbortController();
    active.retryAbort = controller;
    void (async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          if (controller.signal.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      this.#enqueue(active, () => {
        if (this.#active !== active || active.attemptSeq !== nextAttempt)
          return;
        if (active.retryAbort === controller)
          active.retryAbort = null;
        if (this.#closed || active.cancellationRequested) {
          this.#completeTurn(active, {
            status: "cancelled",
            reason: this.#closed ? "Session closed" : "Cancelled by user"
          });
          return;
        }
        const nextLogPath = path11.join(os6.tmpdir(), \`dsh-host-antigravity-\${randomUUID6()}.log\`);
        const arguments_ = [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--print-timeout",
          this.#printTimeout
        ];
        if (this.#nativeRef)
          arguments_.unshift("--conversation", this.#nativeRef.nativeSessionId);
        arguments_.push(...antigravityModelArguments(this.#model, this.#thinkingOptionId));
        arguments_.push("--dangerously-skip-permissions");
        arguments_.push("--add-dir", this.#cwd);
        arguments_.push("--add-dir", active.questions.directory);
        arguments_.push("--log-file", nextLogPath);
        const invocation = commandInvocation(this.#executable, arguments_, active.retryEnvironment);
        let nextChild;
        try {
          nextChild = spawn(invocation.command, invocation.arguments, {
            cwd: this.#cwd,
            env: active.retryEnvironment,
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            stdio: ["pipe", "pipe", "pipe"]
          });
        } catch (error51) {
          this.#completeTurn(active, {
            status: "failed",
            error: { code: "nativeFailure", message: errorMessage(error51), retryable: true }
          });
          return;
        }
        active.process = nextChild;
        active.exited = new Promise((resolve) => nextChild.once("close", () => resolve()));
        active.logPath = nextLogPath;
        active.stderr = "";
        active.receivedResult = false;
        active.httpsPort = null;
        active.flushedSteps.clear();
        this.#dshAttachAntigravityChild(active, nextChild, nextLogPath, nextAttempt);
        try {
          const turnPrompt = formatAntigravityTurnPrompt(active.retryText, this.#cwd);
          if (nextChild.stdin.writable) {
            nextChild.stdin.write(\`\${JSON.stringify({ event: "user", message: { content: turnPrompt } })}
\`, () => void 0);
          }
        } catch (error51) {
          nextChild.kill();
          this.#completeTurn(active, {
            status: "failed",
            error: { code: "nativeFailure", message: errorMessage(error51), retryable: true }
          });
        }
      });
    })();
    return true;
  }
  #dshDrainVisibility(active) {`,
    'implement bounded zero-side-effect pre-turn transient retry for Antigravity CLI',
  );

  // 7. WAL-safe SQLite snapshot (VACUUM INTO) for Antigravity fork + allow forking from completed checkpoints while a turn is active.
  source = replace(
    source,
    `  try {
    await mkdir2(path6.dirname(targetDb), { recursive: true });
    await copyFile(sourceDb, targetDb);
  } catch {
    return false;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return false;
  }`,
    `  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return false;
  }
  try {
    await mkdir2(path6.dirname(targetDb), { recursive: true });
    let clonedByVacuum = false;
    try {
      const srcDb = new DatabaseSync(sourceDb, { readOnly: true, timeout: 5e3 });
      try {
        srcDb.exec(\`VACUUM INTO '\${targetDb.replace(/'/g, "''")}'\`);
        clonedByVacuum = true;
      } finally {
        srcDb.close();
      }
    } catch {
      clonedByVacuum = false;
    }
    if (!clonedByVacuum) {
      await copyFile(sourceDb, targetDb);
      await copyFile(\`\${sourceDb}-wal\`, \`\${targetDb}-wal\`).catch(() => void 0);
      await copyFile(\`\${sourceDb}-shm\`, \`\${targetDb}-shm\`).catch(() => void 0);
    }
  } catch {
    return false;
  }`,
    'use WAL-safe SQLite VACUUM INTO snapshot when cloning Antigravity conversation DB for fork',
  );

  source = replace(
    source,
    `  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot fork while a Turn is active",
        retryable: true
      }
    };
  }`,
    `  // Allow forking from any completed checkpoint even while the source Turn is active:
  // sourceHistory.snapshot() only contains settled turns and cloneNativeConversationDb
  // takes an isolated WAL-safe snapshot truncated to retainedTurns.length.`,
    'allow Antigravity fork from settled checkpoints while source Turn is active',
  );

  return source;
}
